// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ICardPaymentProcessor, CardPaymentProcessor } from "./interfaces/ICardPaymentProcessor.sol";
import { PauseControlUpgradeable } from "./base/PauseControlUpgradeable.sol";
import { CardPaymentProcessorStorage } from "./CardPaymentProcessorStorage.sol";

/**
 * @title CardPaymentProcessorUpgradeable contract
 * @dev Wrapper for the card payment operations.
 */
contract CardPaymentProcessorUpgradeable is
    AccessControlUpgradeable,
    PauseControlUpgradeable,
    CardPaymentProcessorStorage,
    ICardPaymentProcessor
{
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    using SafeERC20Upgradeable for IERC20Upgradeable;

    event SetRevocationLimit(uint8 oldLimit, uint8 newLimit);

    /// @dev Zero amount of tokens has been passed when making a payment.
    error ZeroPaymentAmount();

    /// @dev Zero authorization ID has been passed as a function argument.
    error ZeroAuthorizationId();

    /// @dev The payment with the provided authorization ID already exists and is not revoked.
    error PaymentAlreadyExists();

    /// @dev Payment with the provided authorization ID is uncleared, but it must be cleared.
    error PaymentAlreadyUncleared();

    /// @dev Payment with the provided authorization ID is cleared, but it must be uncleared.
    error PaymentAlreadyCleared();

    /// @dev The payment with the provided authorization ID does not exist.
    error PaymentDoesNotExit();

    /// @dev Empty array of authorization IDs has been passed as a function argument.
    error EmptyAuthorizationIdsArray();

    /// @dev Zero parent transaction has been passed as a function argument.
    error ZeroParentTransactionHash();

    /// @dev Zero cash out account has been passed as a function argument.
    error ZeroCashOutAccount();

    /**
     * @dev The payment with the provided authorization ID has an inappropriate status.
     * @param currentStatus The current status of payment with the provided authorization ID.
     */
    error InappropriatePaymentStatus(CardPaymentProcessor.PaymentStatus currentStatus);

    /**
     * @dev Revocation counter of the payment reached the configured limit.
     * @param configuredRevocationLimit The configured revocation limit.
     */
    error RevocationLimitReached(uint8 configuredRevocationLimit);

    function initialize(address token_) public initializer {
        __CardPaymentProcessor_init(token_);
    }

    function __CardPaymentProcessor_init(address token_) internal onlyInitializing {
        __AccessControl_init_unchained();
        __Context_init_unchained();
        __ERC165_init_unchained();
        __Pausable_init_unchained();
        __PauseControl_init_unchained(OWNER_ROLE);

        __CardPaymentProcessor_init_unchained(token_);
    }

    function __CardPaymentProcessor_init_unchained(address token_) internal onlyInitializing {
        _token = token_;
        _revocationLimit = type(uint8).max;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(EXECUTOR_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /**
     * @dev See {ICardPaymentProcessor-underlyingToken}.
     */
    function underlyingToken() external view returns (address) {
        return _token;
    }

    /**
     * @dev See {ICardPaymentProcessor-totalUnclearedBalance}.
     */
    function totalUnclearedBalance() external view returns (uint256) {
        return _totalUnclearedBalance;
    }

    /**
     * @dev See {ICardPaymentProcessor-totalClearedBalance}.
     */
    function totalClearedBalance() external view returns (uint256) {
        return _totalClearedBalance;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearedBalanceOf}.
     */
    function unclearedBalanceOf(address account) external view returns (uint256) {
        return _unclearedBalances[account];
    }

    /**
     * @dev See {ICardPaymentProcessor-clearedBalanceOf}.
     */
    function clearedBalanceOf(address account) external view returns (uint256) {
        return _clearedBalances[account];
    }

    /**
     * @dev See {ICardPaymentProcessor-paymentFor}.
     */
    function paymentFor(bytes16 authorizationId) external view returns (CardPaymentProcessor.Payment memory) {
        return _payments[authorizationId];
    }

    /**
     * @dev See {ICardPaymentProcessor-isPaymentRevoked}.
     */
    function isPaymentRevoked(bytes32 parentTxHash) external view returns (bool) {
        return _paymentRevocationFlags[parentTxHash];
    }

    /**
     * @dev See {ICardPaymentProcessor-isPaymentReversed}.
     */
    function isPaymentReversed(bytes32 parentTxHash) external view returns (bool) {
        return _paymentReversionFlags[parentTxHash];
    }

    /**
     * @dev See {ICardPaymentProcessor-revocationLimit}.
     */
    function revocationLimit() external view returns (uint8) {
        return _revocationLimit;
    }

    /**
     * @dev See {ICardPaymentProcessor-makePayment}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     */
    function makePayment(
        uint256 amount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused {
        CardPaymentProcessor.Payment storage payment = _payments[authorizationId];
        address sender = _msgSender();

        if (amount == 0) {
            revert ZeroPaymentAmount();
        }
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        CardPaymentProcessor.PaymentStatus status = payment.status;
        if (
            status != CardPaymentProcessor.PaymentStatus.Nonexistent &&
            status != CardPaymentProcessor.PaymentStatus.Revoked
        ) {
            revert PaymentAlreadyExists();
        }

        uint8 revocationCounter = payment.revocationCounter;
        if (revocationCounter != 0 && revocationCounter >= _revocationLimit) {
            revert RevocationLimitReached(_revocationLimit);
        }

        IERC20Upgradeable(_token).safeTransferFrom(sender, address(this), amount);

        payment.account = sender;
        payment.amount = amount;
        payment.status = CardPaymentProcessor.PaymentStatus.Uncleared;

        _unclearedBalances[sender] = _unclearedBalances[sender] + amount;
        _totalUnclearedBalance = _totalUnclearedBalance + amount;

        emit MakePayment(authorizationId, correlationId, sender, amount, revocationCounter);
    }

    /**
     * @dev See {ICardPaymentProcessor-clearPayment}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function clearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = clearPaymentInternal(authorizationId);

        _totalUnclearedBalance = _totalUnclearedBalance - amount;
        _totalClearedBalance = _totalClearedBalance + amount;
    }

    /**
     * @dev See {ICardPaymentProcessor-clearPayments}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function clearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            totalAmount += clearPaymentInternal(authorizationIds[i]);
        }
        _totalUnclearedBalance = _totalUnclearedBalance - totalAmount;
        _totalClearedBalance = _totalClearedBalance + totalAmount;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearPayment}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function unclearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = unclearPaymentInternal(authorizationId);

        _totalClearedBalance = _totalClearedBalance - amount;
        _totalUnclearedBalance = _totalUnclearedBalance + amount;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearPayments}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function unclearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            totalAmount = totalAmount + unclearPaymentInternal(authorizationIds[i]);
        }
        _totalClearedBalance = _totalClearedBalance - totalAmount;
        _totalUnclearedBalance = _totalUnclearedBalance + totalAmount;
    }

    /**
     * @dev See {ICardPaymentProcessor-reversePayment}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function reversePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        cancelPaymentInternal(
            authorizationId,
            correlationId,
            parentTxHash,
            CardPaymentProcessor.PaymentStatus.Reversed
        );
    }

    /**
     * @dev See {ICardPaymentProcessor-revokePayment}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function revokePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (_revocationLimit == 0) {
            revert RevocationLimitReached(0);
        }
        cancelPaymentInternal(
            authorizationId,
            correlationId,
            parentTxHash,
            CardPaymentProcessor.PaymentStatus.Revoked
        );
    }

    /**
     * @dev See {ICardPaymentProcessor-confirmPayment}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function confirmPayment(bytes16 authorizationId, address cashOutAccount)
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        if (cashOutAccount == address(0)) {
            revert ZeroCashOutAccount();
        }

        uint256 amount = confirmPaymentInternal(authorizationId);
        _totalClearedBalance = _totalClearedBalance - amount;
        IERC20Upgradeable(_token).safeTransfer(cashOutAccount, amount);
    }

    /**
     * @dev See {ICardPaymentProcessor-confirmPayments}.
     *
     * Additional requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     */
    function confirmPayments(bytes16[] memory authorizationIds, address cashOutAccount)
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }
        if (cashOutAccount == address(0)) {
            revert ZeroCashOutAccount();
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            totalAmount += confirmPaymentInternal(authorizationIds[i]);
        }

        _totalClearedBalance = _totalClearedBalance - totalAmount;
        IERC20Upgradeable(_token).safeTransfer(cashOutAccount, totalAmount);
    }

    /**
     * @dev Sets a new value for the revocation limit.
     * If the limit equals 0 or 1 a payment with the same authorization ID cannot be repeated after the revocation.
     *
     * Requirements:
     *
     * - The caller must have the {EXECUTOR_ROLE} role.
     *
     * Emits a {SetRevocationLimit} event if the new limit differs from the old value.
     *
     * @param newLimit The new revocation limit value to be set.
     */
    function setRevocationLimit(uint8 newLimit) external onlyRole(OWNER_ROLE) {
        uint8 oldLimit = _revocationLimit;
        if (oldLimit == newLimit) {
            return;
        }

        _revocationLimit = newLimit;
        emit SetRevocationLimit(oldLimit, newLimit);
    }

    function clearPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        CardPaymentProcessor.Payment storage payment = _payments[authorizationId];

        checkUnclearedStatus(payment.status);
        payment.status = CardPaymentProcessor.PaymentStatus.Cleared;

        address account = payment.account;
        amount = payment.amount;

        uint256 newUnclearedBalance = _unclearedBalances[account] - amount;
        _unclearedBalances[account] = newUnclearedBalance;
        uint256 newClearedBalance = _clearedBalances[account] + amount;
        _clearedBalances[account] = newClearedBalance;

        emit ClearPayment(
            authorizationId,
            account,
            amount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );
    }

    function unclearPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        CardPaymentProcessor.Payment storage payment = _payments[authorizationId];

        checkClearedStatus(payment.status);
        payment.status = CardPaymentProcessor.PaymentStatus.Uncleared;

        address account = payment.account;
        amount = payment.amount;

        uint256 newClearedBalance = _clearedBalances[account] - amount;
        _clearedBalances[account] = newClearedBalance;
        uint256 newUnclearedBalance = _unclearedBalances[account] + amount;
        _unclearedBalances[account] = newUnclearedBalance;

        emit UnclearPayment(
            authorizationId,
            account,
            amount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );
    }

    function confirmPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        CardPaymentProcessor.Payment storage payment = _payments[authorizationId];

        checkClearedStatus(payment.status);
        payment.status = CardPaymentProcessor.PaymentStatus.Confirmed;

        address account = payment.account;
        amount = payment.amount;
        uint256 newClearedBalance = _clearedBalances[account] - amount;
        _clearedBalances[account] = newClearedBalance;

        emit ConfirmPayment(authorizationId, account, amount, newClearedBalance, payment.revocationCounter);
    }

    function cancelPaymentInternal(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash,
        CardPaymentProcessor.PaymentStatus targetStatus
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }
        if (parentTxHash == 0) {
            revert ZeroParentTransactionHash();
        }

        CardPaymentProcessor.Payment storage payment = _payments[authorizationId];
        CardPaymentProcessor.PaymentStatus status = payment.status;

        if (status == CardPaymentProcessor.PaymentStatus.Nonexistent) {
            revert PaymentDoesNotExit();
        }

        address account = payment.account;
        uint256 amount = payment.amount;

        if (status == CardPaymentProcessor.PaymentStatus.Uncleared) {
            _unclearedBalances[account] = _unclearedBalances[account] - amount;
            _totalUnclearedBalance = _totalUnclearedBalance - amount;
        } else if (status == CardPaymentProcessor.PaymentStatus.Cleared) {
            _clearedBalances[account] = _clearedBalances[account] - amount;
            _totalClearedBalance = _totalClearedBalance - amount;
        } else {
            revert InappropriatePaymentStatus(status);
        }

        IERC20Upgradeable(_token).safeTransfer(account, amount);

        if (targetStatus == CardPaymentProcessor.PaymentStatus.Revoked) {
            payment.status = CardPaymentProcessor.PaymentStatus.Revoked;
            uint8 newRevocationCounter = payment.revocationCounter + 1;
            payment.revocationCounter = newRevocationCounter;
            _paymentRevocationFlags[parentTxHash] = true;

            emit RevokePayment(
                authorizationId,
                correlationId,
                account,
                amount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == CardPaymentProcessor.PaymentStatus.Cleared,
                parentTxHash,
                newRevocationCounter
            );
        } else {
            payment.status = CardPaymentProcessor.PaymentStatus.Reversed;
            _paymentReversionFlags[parentTxHash] = true;

            emit ReversePayment(
                authorizationId,
                correlationId,
                account,
                amount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == CardPaymentProcessor.PaymentStatus.Cleared,
                parentTxHash,
                payment.revocationCounter
            );
        }
    }

    function checkClearedStatus(CardPaymentProcessor.PaymentStatus status) internal pure {
        if (status == CardPaymentProcessor.PaymentStatus.Nonexistent) {
            revert PaymentDoesNotExit();
        }
        if (status == CardPaymentProcessor.PaymentStatus.Uncleared) {
            revert PaymentAlreadyUncleared();
        }
        if (status != CardPaymentProcessor.PaymentStatus.Cleared) {
            revert InappropriatePaymentStatus(status);
        }
    }

    function checkUnclearedStatus(CardPaymentProcessor.PaymentStatus status) internal pure {
        if (status == CardPaymentProcessor.PaymentStatus.Nonexistent) {
            revert PaymentDoesNotExit();
        }
        if (status == CardPaymentProcessor.PaymentStatus.Cleared) {
            revert PaymentAlreadyCleared();
        }
        if (status != CardPaymentProcessor.PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
    }
}
