// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { BlacklistControlUpgradeable } from "./base/BlacklistControlUpgradeable.sol";
import { PauseControlUpgradeable } from "./base/PauseControlUpgradeable.sol";
import { RescueControlUpgradeable } from "./base/RescueControlUpgradeable.sol";
import { CardPaymentProcessorStorage } from "./CardPaymentProcessorStorage.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder.sol";
import { ICardPaymentProcessor } from "./interfaces/ICardPaymentProcessor.sol";

/**
 * @title CardPaymentProcessor contract
 * @dev Wrapper contract for the card payment operations.
 */
contract CardPaymentProcessor is
    AccessControlUpgradeable,
    BlacklistControlUpgradeable,
    PauseControlUpgradeable,
    RescueControlUpgradeable,
    StoragePlaceholder200,
    CardPaymentProcessorStorage,
    ICardPaymentProcessor
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of executor that is allowed to execute the card payment operations.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    // -------------------- Events -----------------------------------

    /// @dev Emitted when the revocation limit is changed.
    event SetRevocationLimit(uint8 oldLimit, uint8 newLimit);

    // -------------------- Errors -----------------------------------

    /// @dev The zero token address has been passed as a function argument.
    error ZeroTokenAddress();

    /// @dev The zero account address has been passed as a function argument.
    error ZeroAccount();

    /// @dev Zero authorization ID has been passed as a function argument.
    error ZeroAuthorizationId();

    /// @dev The payment with the provided authorization ID already exists and is not revoked.
    error PaymentAlreadyExists();

    /// @dev Payment with the provided authorization ID is uncleared, but it must be cleared.
    error PaymentAlreadyUncleared();

    /// @dev Payment with the provided authorization ID is cleared, but it must be uncleared.
    error PaymentAlreadyCleared();

    /// @dev The payment with the provided authorization ID does not exist.
    error PaymentNotExist();

    /// @dev Empty array of authorization IDs has been passed as a function argument.
    error EmptyAuthorizationIdsArray();

    /// @dev Zero parent transaction hash has been passed as a function argument.
    error ZeroParentTransactionHash();

    /// @dev Zero cash out account has been passed as a function argument.
    error ZeroCashOutAccount();

    /**
     * @dev The payment with the provided authorization ID has an inappropriate status.
     * @param currentStatus The current status of payment with the provided authorization ID.
     */
    error InappropriatePaymentStatus(PaymentStatus currentStatus);

    /**
     * @dev Revocation counter of the payment reached the configured limit.
     * @param configuredRevocationLimit The configured revocation limit.
     */
    error RevocationLimitReached(uint8 configuredRevocationLimit);

    // ------------------- Functions ---------------------------------

    /**
     * @dev The initialize function of the upgradable contract.
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable
     *
     * Requirements:
     *
     * - The passed token address must not be zero.
     *
     * @param token_ The address of a token to set as the underlying one.
     */
    function initialize(address token_) external initializer {
        __CardPaymentProcessor_init(token_);
    }

    function __CardPaymentProcessor_init(address token_) internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();
        __BlacklistControl_init_unchained(OWNER_ROLE);
        __Pausable_init_unchained();
        __PauseControl_init_unchained(OWNER_ROLE);
        __RescueControl_init_unchained(OWNER_ROLE);

        __CardPaymentProcessor_init_unchained(token_);
    }

    function __CardPaymentProcessor_init_unchained(address token_) internal onlyInitializing {
        if (token_ == address(0)) {
            revert ZeroTokenAddress();
        }

        _token = token_;
        _revocationLimit = type(uint8).max;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(EXECUTOR_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /**
     * @dev See {ICardPaymentProcessor-makePayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must must not be blacklisted.
     * - The authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked.
     * - The payment's revocation counter must be equal to zero or less than the configured revocation limit.
     */
    function makePayment(
        uint256 amount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused notBlacklisted(_msgSender()) {
        address sender = _msgSender();
        makePaymentInternal(sender, sender, amount, authorizationId, correlationId);
    }

    /**
     * @dev See {ICardPaymentProcessor-makePaymentFor}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The payment account address must not be zero.
     * - The authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked.
     * - The payment's revocation counter must be equal to zero or less than the configured revocation limit.
     */
    function makePaymentFrom(
        address account,
        uint256 amount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert ZeroAccount();
        }
        makePaymentInternal(_msgSender(), account, amount, authorizationId, correlationId);
    }

    /**
     * @dev See {ICardPaymentProcessor-clearPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     */
    function clearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = clearPaymentInternal(authorizationId);

        _totalUnclearedBalance = _totalUnclearedBalance - amount;
        _totalClearedBalance = _totalClearedBalance + amount;
    }

    /**
     * @dev See {ICardPaymentProcessor-clearPayments}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "uncleared" status.
     */
    function clearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 totalAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; i++) {
            totalAmount += clearPaymentInternal(authorizationIds[i]);
        }

        _totalUnclearedBalance = _totalUnclearedBalance - totalAmount;
        _totalClearedBalance = _totalClearedBalance + totalAmount;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" status.
     */
    function unclearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = unclearPaymentInternal(authorizationId);

        _totalClearedBalance = _totalClearedBalance - amount;
        _totalUnclearedBalance = _totalUnclearedBalance + amount;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearPayments}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "cleared" status.
     */
    function unclearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 totalAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; i++) {
            totalAmount = totalAmount + unclearPaymentInternal(authorizationIds[i]);
        }

        _totalClearedBalance = _totalClearedBalance - totalAmount;
        _totalUnclearedBalance = _totalUnclearedBalance + totalAmount;
    }

    /**
     * @dev See {ICardPaymentProcessor-reversePayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and parent transaction hash of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" or "uncleared" status.
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
            PaymentStatus.Reversed
        );
    }

    /**
     * @dev See {ICardPaymentProcessor-revokePayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and parent transaction hash of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" or "uncleared" status.
     * - The revocation limit of payments should not be zero.
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
            PaymentStatus.Revoked
        );
    }

    /**
     * @dev See {ICardPaymentProcessor-confirmPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and cash out account of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" status.
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
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "cleared" status.
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
    function paymentFor(bytes16 authorizationId) external view returns (Payment memory) {
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

    function makePaymentInternal(
        address sender,
        address account,
        uint256 amount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        PaymentStatus status = payment.status;
        if (
            status != PaymentStatus.Nonexistent &&
            status != PaymentStatus.Revoked
        ) {
            revert PaymentAlreadyExists();
        }

        uint8 revocationCounter = payment.revocationCounter;
        if (revocationCounter != 0 && revocationCounter >= _revocationLimit) {
            revert RevocationLimitReached(_revocationLimit);
        }

        payment.account = account;
        payment.amount = amount;
        payment.status = PaymentStatus.Uncleared;

        _unclearedBalances[account] = _unclearedBalances[account] + amount;
        _totalUnclearedBalance = _totalUnclearedBalance + amount;

        emit MakePayment(
            authorizationId,
            correlationId,
            account,
            amount,
            revocationCounter,
            sender
        );

        IERC20Upgradeable(_token).safeTransferFrom(account, address(this), amount);
    }

    function clearPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        checkUnclearedStatus(payment.status);
        payment.status = PaymentStatus.Cleared;

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

        Payment storage payment = _payments[authorizationId];

        checkClearedStatus(payment.status);
        payment.status = PaymentStatus.Uncleared;

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

        Payment storage payment = _payments[authorizationId];

        checkClearedStatus(payment.status);
        payment.status = PaymentStatus.Confirmed;

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
        PaymentStatus targetStatus
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }
        if (parentTxHash == 0) {
            revert ZeroParentTransactionHash();
        }

        Payment storage payment = _payments[authorizationId];
        PaymentStatus status = payment.status;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }

        address account = payment.account;
        uint256 amount = payment.amount;

        if (status == PaymentStatus.Uncleared) {
            _unclearedBalances[account] = _unclearedBalances[account] - amount;
            _totalUnclearedBalance = _totalUnclearedBalance - amount;
        } else if (status == PaymentStatus.Cleared) {
            _clearedBalances[account] = _clearedBalances[account] - amount;
            _totalClearedBalance = _totalClearedBalance - amount;
        } else {
            revert InappropriatePaymentStatus(status);
        }

        IERC20Upgradeable(_token).safeTransfer(account, amount);

        if (targetStatus == PaymentStatus.Revoked) {
            payment.status = PaymentStatus.Revoked;
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
                status == PaymentStatus.Cleared,
                parentTxHash,
                newRevocationCounter
            );
        } else {
            payment.status = PaymentStatus.Reversed;
            _paymentReversionFlags[parentTxHash] = true;

            emit ReversePayment(
                authorizationId,
                correlationId,
                account,
                amount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                payment.revocationCounter
            );
        }
    }

    function checkClearedStatus(PaymentStatus status) internal pure {
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status == PaymentStatus.Uncleared) {
            revert PaymentAlreadyUncleared();
        }
        if (status != PaymentStatus.Cleared) {
            revert InappropriatePaymentStatus(status);
        }
    }

    function checkUnclearedStatus(PaymentStatus status) internal pure {
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status == PaymentStatus.Cleared) {
            revert PaymentAlreadyCleared();
        }
        if (status != PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
    }
}
