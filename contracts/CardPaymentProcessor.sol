// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { BlacklistableUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/BlacklistableUpgradeable.sol";
import { PausableExtUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "@cloudwalkinc/brlc-contracts/contracts/storage/StoragePlaceholder200.sol";

import { CardPaymentProcessorStorage } from "./CardPaymentProcessorStorage.sol";
import { ICardPaymentProcessor } from "./interfaces/ICardPaymentProcessor.sol";
import { ICardPaymentCashback } from "./interfaces/ICardPaymentCashback.sol";
import { ICashbackDistributor, ICashbackDistributorTypes } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CardPaymentProcessor contract
 * @dev Wrapper contract for the card payment operations.
 */
contract CardPaymentProcessor is
    AccessControlUpgradeable,
    BlacklistableUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    StoragePlaceholder200,
    CardPaymentProcessorStorage,
    ICardPaymentProcessor,
    ICardPaymentCashback
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of executor that is allowed to execute the card payment operations.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev The maximum allowable cashback rate in permil (1 permil = 0.1 %).
    uint16 public constant MAX_CASHBACK_RATE_IN_PERMIL = 250;

    // -------------------- Events -----------------------------------

    /**
     * @dev Emitted when the revocation limit is changed.
     * @param oldLimit The old value of the revocation limit.
     * @param newLimit The new value of the revocation limit.
     */
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

    /// @dev The cash-out account is not configured.
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

    /// @dev A new cash-out account is the same as the previously set one.
    error CashOutAccountUnchanged();

    /// @dev A new cashback rate is the same as previously set one.
    error CashbackRateUnchanged();

    /// @dev A new cashback rate exceeds the allowed maximum.
    error CashbackRateExcess();

    /// @dev The cashback operations are already enabled.
    error CashbackAlreadyEnabled();

    /// @dev The cashback operations are already disabled.
    error CashbackAlreadyDisabled();

    /// @dev The zero cashback distributor address has been passed as a function argument.
    error CashbackDistributorZeroAddress();

    /// @dev The cashback distributor contract is not configured.
    error CashbackDistributorNotConfigured();

    /// @dev The cashback distributor contract is already configured.
    error CashbackDistributorAlreadyConfigured();

    /// @dev The requested refund amount does not meet the requirements.
    error InappropriateRefundAmount();

    /// @dev The new amount of the payment does not meet the requirements.
    error InappropriateNewPaymentAmount();

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
        __Blacklistable_init_unchained(OWNER_ROLE);
        __Pausable_init_unchained();
        __PausableExt_init_unchained(OWNER_ROLE);
        __Rescuable_init_unchained(OWNER_ROLE);

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
     * @dev See {ICardPaymentProcessor-updatePaymentAmount}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     * - The new amount must not exceed the existing refund amount.
     */
    function updatePaymentAmount(uint256 newAmount, bytes16 authorizationId)
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];
        PaymentStatus status = payment.status;
        address account = payment.account;
        uint256 oldPaymentAmount = payment.amount;
        uint256 refundAmount = payment.refundAmount;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
        if (refundAmount > newAmount) {
            revert InappropriateNewPaymentAmount();
        }

        uint256 newCompensationAmount = refundAmount +
            calculateCashback(newAmount - refundAmount, payment.cashbackRate);
        payment.amount = newAmount;

        if (newAmount >= oldPaymentAmount) {
            uint256 cashbackIncreaseAmount = newCompensationAmount - payment.compensationAmount;
            uint256 paymentAmountDiff = newAmount - oldPaymentAmount;

            payment.compensationAmount = newCompensationAmount;

            _totalUnclearedBalance += paymentAmountDiff;
            _unclearedBalances[account] += paymentAmountDiff;
            IERC20Upgradeable(_token).safeTransferFrom(account, address(this), paymentAmountDiff);

            increaseCashbackInternal(authorizationId, cashbackIncreaseAmount);
        } else {
            uint256 cashbackRevocationAmount = payment.compensationAmount - newCompensationAmount;
            uint256 paymentAmountDiff = oldPaymentAmount - newAmount;
            uint256 sentAmount =  paymentAmountDiff - cashbackRevocationAmount;

            payment.compensationAmount = newCompensationAmount;

            _totalUnclearedBalance -= paymentAmountDiff;
            _unclearedBalances[account] -= paymentAmountDiff;
            IERC20Upgradeable(_token).safeTransfer(account, sentAmount);

            revokeCashbackInternal(authorizationId, cashbackRevocationAmount);
        }

        emit UpdatePaymentAmount(
            authorizationId,
            account,
            oldPaymentAmount,
            newAmount
        );
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
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" status.
     */
    function confirmPayment(bytes16 authorizationId)
        public
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        uint256 amount = confirmPaymentInternal(authorizationId);
        _totalClearedBalance -= amount;
        IERC20Upgradeable(_token).safeTransfer(requireCashOutAccount(), amount);
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
    function confirmPayments(bytes16[] memory authorizationIds)
        public
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            totalAmount += confirmPaymentInternal(authorizationIds[i]);
        }

        _totalClearedBalance -= totalAmount;
        IERC20Upgradeable(_token).safeTransfer(requireCashOutAccount(), totalAmount);
    }

    /**
     * @dev See {ICardPaymentProcessor-refundPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     */
    function refundPayment(uint256 amount, bytes16 authorizationId)
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];
        PaymentStatus status = payment.status;
        address account = payment.account;
        uint256 paymentAmount = payment.amount;
        uint256 newRefundAmount = payment.refundAmount + amount;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Uncleared && status != PaymentStatus.Cleared && status != PaymentStatus.Confirmed) {
            revert InappropriatePaymentStatus(status);
        }
        if (newRefundAmount > paymentAmount) {
            revert InappropriateRefundAmount();
        }

        uint256 newCompensationAmount = newRefundAmount +
        calculateCashback(paymentAmount - newRefundAmount, payment.cashbackRate);
        uint256 sentAmount = newCompensationAmount - payment.compensationAmount;
        uint256 revokedCashbackAmount = amount - sentAmount;

        payment.refundAmount = newRefundAmount;
        payment.compensationAmount = newCompensationAmount;

        if (status == PaymentStatus.Uncleared) {
            _totalUnclearedBalance -= amount;
            _unclearedBalances[account] -= amount;
            IERC20Upgradeable(_token).safeTransfer(account, sentAmount);
        } else if (status == PaymentStatus.Cleared) {
            _totalClearedBalance -= amount;
            _clearedBalances[account] -= amount;
            IERC20Upgradeable(_token).safeTransfer(account, sentAmount);
        } else { // status == PaymentStatus.ConfirmPayment
            address cashOutAccount_ = requireCashOutAccount();
            IERC20Upgradeable token = IERC20Upgradeable(_token);
            token.safeTransferFrom(cashOutAccount_, account, sentAmount);
            token.safeTransferFrom(cashOutAccount_, address(this), revokedCashbackAmount);
        }

        revokeCashbackInternal(authorizationId, revokedCashbackAmount);

        emit RefundPayment(
            authorizationId,
            account,
            amount,
            sentAmount,
            status
        );
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
     * @dev See {ICardPaymentProcessor-cashOutAccount}.
     */
    function cashOutAccount() external view returns (address) {
        return _cashOutAccount;
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

    /**
     * @dev See {ICardPaymentCashback-cashbackDistributor}.
     */
    function cashbackDistributor() external view returns (address) {
        return _cashbackDistributor;
    }

    /**
     * @dev See {ICardPaymentCashback-cashbackEnabled}.
     */
    function cashbackEnabled() external view returns (bool) {
        return _cashbackEnabled;
    }

    /**
     * @dev See {ICardPaymentCashback-cashbackRate}.
     */
    function cashbackRate() external view returns (uint256) {
        return _cashbackRateInPermil;
    }

    /**
     * @dev See {ICardPaymentCashback-getCashback}.
     */
    function getCashback(bytes16 authorizationId) external view returns (Cashback memory) {
        return _cashbacks[authorizationId];
    }

    /**
     * @dev See {ICardPaymentCashback-setCashbackDistributor}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new cashback distributor address must not be zero.
     * - The new cashback distributor can be set only once.
     */
    function setCashbackDistributor(address newCashbackDistributor) external onlyRole(OWNER_ROLE) {
        address oldCashbackDistributor = _cashbackDistributor;

        if (newCashbackDistributor == address(0)) {
            revert CashbackDistributorZeroAddress();
        }
        if (oldCashbackDistributor != address(0)) {
            revert CashbackDistributorAlreadyConfigured();
        }

        _cashbackDistributor = newCashbackDistributor;

        emit SetCashbackDistributor(oldCashbackDistributor, newCashbackDistributor);

        IERC20Upgradeable(_token).approve(newCashbackDistributor, type(uint256).max);
    }

    /**
     * @dev See {ICardPaymentCashback-setCashbackRate}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new rate must differ from the previously set one.
     * - The new rate must not exceed the allowable maximum specified in the {MAX_CASHBACK_RATE_IN_PERMIL} constant.
     */
    function setCashbackRate(uint16 newCashbackRateInPermil) external onlyRole(OWNER_ROLE) {
        uint16 oldCashbackRateInPermil = _cashbackRateInPermil;
        if (newCashbackRateInPermil == oldCashbackRateInPermil) {
            revert CashbackRateUnchanged();
        }
        if (newCashbackRateInPermil > MAX_CASHBACK_RATE_IN_PERMIL) {
            revert CashbackRateExcess();
        }

        _cashbackRateInPermil = newCashbackRateInPermil;

        emit SetCashbackRate(oldCashbackRateInPermil, newCashbackRateInPermil);
    }

    /**
     * @dev See {ICardPaymentCashback-enableCashback}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The cashback operations must not be already enabled.
     * - The address of the current cashback distributor must not be zero.
     */
    function enableCashback() external onlyRole(OWNER_ROLE) {
        if (_cashbackEnabled) {
            revert CashbackAlreadyEnabled();
        }
        if (_cashbackDistributor == address(0)) {
            revert CashbackDistributorNotConfigured();
        }

        _cashbackEnabled = true;

        emit EnableCashback();
    }

    /**
     * @dev See {ICardPaymentCashback-disableCashback}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The cashback operations must not be already disabled.
     */
    function disableCashback() external onlyRole(OWNER_ROLE) {
        if (!_cashbackEnabled) {
            revert CashbackAlreadyDisabled();
        }

        _cashbackEnabled = false;

        emit DisableCashback();
    }

    /**
     * @dev See {ICardPaymentCashback-setCashOutAccount}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new cash-out account must differ from the previously set one.
     */
    function setCashOutAccount(address newCashOutAccount) external onlyRole(OWNER_ROLE) {
        address oldCashOutAccount = _cashOutAccount;

        if (newCashOutAccount == oldCashOutAccount) {
            revert CashOutAccountUnchanged();
        }

        _cashOutAccount = newCashOutAccount;

        emit SetCashOutAccount(oldCashOutAccount, newCashOutAccount);
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
        (
            payment.compensationAmount,
            payment.cashbackRate
        ) = sendCashbackInternal(account, amount, authorizationId);
    }

    function clearPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        PaymentStatus status = payment.status;
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status == PaymentStatus.Cleared) {
            revert PaymentAlreadyCleared();
        }
        if (status != PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
        payment.status = PaymentStatus.Cleared;

        address account = payment.account;
        amount = payment.amount - payment.refundAmount;

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

        PaymentStatus status = payment.status;
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status == PaymentStatus.Uncleared) {
            revert PaymentAlreadyUncleared();
        }
        if (status != PaymentStatus.Cleared) {
            revert InappropriatePaymentStatus(status);
        }
        payment.status = PaymentStatus.Uncleared;

        address account = payment.account;
        amount = payment.amount - payment.refundAmount;

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

        PaymentStatus status = payment.status;
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Cleared) {
            revert InappropriatePaymentStatus(status);
        }
        payment.status = PaymentStatus.Confirmed;

        address account = payment.account;
        amount = payment.amount - payment.refundAmount;
        uint256 newClearedBalance = _clearedBalances[account] - amount;
        _clearedBalances[account] = newClearedBalance;

        emit ConfirmPayment(authorizationId, account, amount, newClearedBalance, payment.revocationCounter);
    }

    struct CancelPaymentVars {
        address account;
        uint256 remainingPaymentAmount;
        uint256 revokedCashbackAmount;
        uint256 sentAmount;
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

        CancelPaymentVars memory cancellation;
        cancellation.account = payment.account;
        cancellation.sentAmount = payment.amount - payment.compensationAmount;
        cancellation.remainingPaymentAmount = payment.amount - payment.refundAmount;
        cancellation.revokedCashbackAmount = cancellation.remainingPaymentAmount - cancellation.sentAmount;

        if (status == PaymentStatus.Uncleared) {
            _totalUnclearedBalance -= cancellation.remainingPaymentAmount;
            _unclearedBalances[cancellation.account] -= cancellation.remainingPaymentAmount;
        } else if (status == PaymentStatus.Cleared) {
            _totalClearedBalance -= cancellation.remainingPaymentAmount;
            _clearedBalances[cancellation.account] -= cancellation.remainingPaymentAmount;
        } else {
            revert InappropriatePaymentStatus(status);
        }

        payment.compensationAmount = 0;
        payment.refundAmount = 0;

        if (targetStatus == PaymentStatus.Revoked) {
            payment.status = PaymentStatus.Revoked;
            _paymentRevocationFlags[parentTxHash] = true;
            uint8 newRevocationCounter = payment.revocationCounter + 1;
            payment.revocationCounter = newRevocationCounter;

            emit RevokePayment(
                authorizationId,
                correlationId,
                cancellation.account,
                cancellation.sentAmount,
                _clearedBalances[cancellation.account],
                _unclearedBalances[cancellation.account],
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
                cancellation.account,
                cancellation.sentAmount,
                _clearedBalances[cancellation.account],
                _unclearedBalances[cancellation.account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                payment.revocationCounter
            );
        }

        IERC20Upgradeable(_token).safeTransfer(cancellation.account, cancellation.sentAmount);
        revokeCashbackInternal(authorizationId, cancellation.revokedCashbackAmount);
    }

    function sendCashbackInternal(
        address account,
        uint256 paymentAmount,
        bytes16 authorizationId
    ) internal returns (uint256 cashbackAmount, uint16 cashbackRate_) {
        address distributor = _cashbackDistributor;
        if (_cashbackEnabled && distributor != address(0)) {
            cashbackRate_ = _cashbackRateInPermil;
            cashbackAmount = calculateCashback(paymentAmount, cashbackRate_);
            (bool success, uint256 cashbackNonce) = ICashbackDistributor(distributor).sendCashback(
                _token,
                ICashbackDistributorTypes.CashbackKind.CardPayment,
                authorizationId,
                account,
                cashbackAmount
            );
            _cashbacks[authorizationId].lastCashbackNonce = cashbackNonce;
            if (success) {
                emit SendCashbackSuccess(distributor, cashbackAmount, cashbackNonce);
            } else {
                emit SendCashbackFailure(distributor, cashbackAmount, cashbackNonce);
                cashbackAmount = 0;
                cashbackRate_ = 0;
            }
        }
    }

    function revokeCashbackInternal(bytes16 authorizationId, uint256 amount) internal {
        address distributor = _cashbackDistributor;
        uint256 cashbackNonce = _cashbacks[authorizationId].lastCashbackNonce;
        if (cashbackNonce != 0 && distributor != address(0)) {
            if (ICashbackDistributor(distributor).revokeCashback(cashbackNonce, amount)) {
                emit RevokeCashbackSuccess(distributor, amount, cashbackNonce);
            } else {
                emit RevokeCashbackFailure(distributor, amount, cashbackNonce);
            }
        }
    }

    function increaseCashbackInternal(bytes16 authorizationId, uint256 amount) internal {
        address distributor = _cashbackDistributor;
        uint256 cashbackNonce = _cashbacks[authorizationId].lastCashbackNonce;
        if (cashbackNonce != 0 && distributor != address(0)) {
            if (ICashbackDistributor(distributor).increaseCashback(cashbackNonce, amount)) {
                emit IncreaseCashbackSuccess(distributor, amount, cashbackNonce);
            } else {
                emit IncreaseCashbackFailure(distributor, amount, cashbackNonce);
            }
        }
    }

    function requireCashOutAccount() internal view returns (address account) {
        account = _cashOutAccount;
        if (account == address(0)) {
            revert ZeroCashOutAccount();
        }
    }

    function calculateCashback(uint256 amount, uint256 cashbackRateInPermil) internal pure returns (uint256) {
        return amount * cashbackRateInPermil / 1000;
    }
}
