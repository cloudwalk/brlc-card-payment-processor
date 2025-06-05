// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { BlocklistableUpgradeable } from "./base/BlocklistableUpgradeable.sol";
import { PausableExtUpgradeable } from "./base/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "./base/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder200.sol";
import { AccessControlExtUpgradeable } from "./base/AccessControlExtUpgradeable.sol";
import { Versionable } from "./base/Versionable.sol";

import { CardPaymentProcessorStorage } from "./CardPaymentProcessorStorage.sol";
import { ICardPaymentProcessor } from "./interfaces/ICardPaymentProcessor.sol";
import { ICardPaymentCashback } from "./interfaces/ICardPaymentCashback.sol";
import { ICashbackDistributor, ICashbackDistributorTypes } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CardPaymentProcessor contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev The wrapper contract for the card payment operations.
 */
contract CardPaymentProcessor is
    AccessControlExtUpgradeable,
    BlocklistableUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    StoragePlaceholder200,
    CardPaymentProcessorStorage,
    ICardPaymentProcessor,
    ICardPaymentCashback,
    Versionable
{
    // -------------------- Types --------------------------------- //

    using SafeERC20Upgradeable for IERC20Upgradeable;

    /**
     * @dev Kind of a payment updating operation as an enum.
     *
     * The possible values:
     * - Full = 0 -- The operation is executed fully regardless of the new values of the base amount and extra amount.
     * - Lazy = 1 -- The operation is executed only if the new amounts differ from the current ones of the payment.
     */
    enum UpdatingOperationKind {
        Full,
        Lazy
    }

    /// @dev Contains parameters of a payment making operation.
    struct MakingOperation {
        address sender;
        address account;
        uint256 baseAmount;
        uint256 extraAmount;
        bytes16 authorizationId;
        bytes16 correlationId;
        address sponsor;
        uint256 subsidyLimit;
        int16 cashbackRateInPermil;
    }

    /// @dev Contains parameters for a payment updating operation.
    struct UpdatingOperation {
        uint256 oldPaymentSumAmount;
        uint256 newPaymentSumAmount;
        uint256 oldSponsorSumAmount;
        uint256 newSponsorSumAmount;
        uint256 oldPaymentBaseAmount;
        uint256 newPaymentBaseAmount;
        uint256 oldCompensationAmount;
        uint256 paymentTotalAmountChange;
        uint256 accountBalanceChange;
        uint256 sponsorBalanceChange;
        uint256 cashbackAmountChange;
        bool paymentSumAmountDecreased;
        bool cashbackDecreased;
    }

    /// @dev Contains parameters of a payment canceling operation.
    struct CancelingOperation {
        uint256 paymentTotalAmount;
        uint256 accountSentAmount;
        uint256 sponsorSentAmount;
        uint256 totalSentAmount;
        uint256 revokedCashbackAmount;
    }

    /// @dev Contains parameters of a payment refunding operation.
    struct RefundingOperation {
        uint256 paymentRefundAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 sponsorRefundAmount;
        uint256 newPaymentRefundAmount;
        uint256 newPaymentSumAmount;
        uint256 paymentTotalAmountDiff;
        uint256 oldCashbackAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 newCashbackAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 oldCompensationAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 newCompensationAmount;
        uint256 accountSentAmount;
        uint256 sponsorSentAmount;
        uint256 totalSentAmount;
        uint256 revokedCashbackAmount;
    }

    // -------------------- Constants ----------------------------- //

    /// @dev The role of executor that is allowed to execute the card payment operations.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev The maximum allowable cashback rate in permil (1 permil = 0.1 %).
    uint16 public constant MAX_CASHBACK_RATE_IN_PERMIL = 500;

    /**
     * @dev The coefficient used to round the cashback according to the formula:
     *      `roundedCashback = [(cashback + coef / 2) / coef] * coef`.
     * Currently, it can only be changed by deploying a new implementation of the contract.
     */
    uint16 public constant CASHBACK_ROUNDING_COEF = 10000;

    // -------------------- Events -------------------------------- //

    /**
     * @dev Emitted when the revocation limit is changed.
     * @param oldLimit The old value of the revocation limit.
     * @param newLimit The new value of the revocation limit.
     */
    event SetRevocationLimit(uint8 oldLimit, uint8 newLimit);

    // -------------------- Errors -------------------------------- //

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

    /// @dev The provided cashback rate exceeds the allowed maximum.
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
    error InappropriateNewBasePaymentAmount();

    /// @dev The new extra amount of the payment does not meet the requirements.
    error InappropriateNewExtraPaymentAmount();

    /// @dev The function cannot be executed for a subsidized payment with the non-zero refund amount.
    error SubsidizedPaymentWithNonZeroRefundAmount();

    // ------------------ Initializers ---------------------------- //

    /**
     * @dev The initialize function of the upgradeable contract.
     *
     * See details: https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable
     *
     * Requirements:
     *
     * - The passed token address must not be zero.
     *
     * @param token_ The address of a token to set as the underlying one.
     */
    function initialize(address token_) external initializer {
        if (token_ == address(0)) {
            revert ZeroTokenAddress();
        }

        __AccessControlExt_init_unchained();
        __Blocklistable_init_unchained();
        __Pausable_init_unchained();
        __PausableExt_init_unchained();
        __Rescuable_init_unchained();

        _token = token_;
        _revocationLimit = type(uint8).max;

        _setRoleAdmin(EXECUTOR_ROLE, GRANTOR_ROLE);
        _grantRole(OWNER_ROLE, _msgSender());
    }

    // ------------------ Transactional functions ----------------- //

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
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

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The caller must have the {EXECUTOR_ROLE} role.
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
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must must not be blocklisted.
     * - The authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked.
     * - The payment's revocation counter must be equal to zero or less than the configured revocation limit.
     */
    function makePayment(
        uint256 baseAmount,
        uint256 extraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused notBlocklisted(_msgSender()) {
        address sender = _msgSender();
        MakingOperation memory operation = MakingOperation({
            sender: sender,
            account: sender,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            authorizationId: authorizationId,
            correlationId: correlationId,
            sponsor: address(0),
            subsidyLimit: 0,
            cashbackRateInPermil: -1
        });
        _makePayment(operation);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The payment account address must not be zero.
     * - The authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked.
     * - The payment's revocation counter must be equal to zero or less than the configured revocation limit.
     * - The requested cashback rate must not exceed the maximum allowable cashback rate defined in the contract.
     */
    function makePaymentFor(
        address account,
        uint256 baseAmount,
        uint256 extraAmount,
        bytes16 authorizationId,
        bytes16 correlationId,
        address sponsor,
        uint256 subsidyLimit,
        int16 cashbackRateInPermil
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert ZeroAccount();
        }
        if (cashbackRateInPermil > 0 && uint16(cashbackRateInPermil) > MAX_CASHBACK_RATE_IN_PERMIL) {
            revert CashbackRateExcess();
        }
        MakingOperation memory operation = MakingOperation({
            sender: _msgSender(),
            account: account,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            authorizationId: authorizationId,
            correlationId: correlationId,
            sponsor: sponsor,
            subsidyLimit: subsidyLimit,
            cashbackRateInPermil: cashbackRateInPermil
        });
        _makePayment(operation);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     * - The new base amount must not exceed the existing refund amount.
     * - If the base amount of the payment increases the extra amount must increase too or keep unchanged.
     * - If the base amount of the payment decreases the extra amount must decrease too or keep unchanged.
     * - If the base amount of the payment does not change the extra amount is allowed to change in any way.
     */
    function updatePaymentAmount(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePaymentAmount(
            newBaseAmount,
            newExtraAmount,
            authorizationId,
            correlationId,
            UpdatingOperationKind.Full
        );
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     */
    function clearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = _clearPayment(authorizationId);

        _totalUnclearedBalance -= amount;
        _totalClearedBalance += amount;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
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

        uint256 cumulativeAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; i++) {
            cumulativeAmount += _clearPayment(authorizationIds[i]);
        }

        _totalUnclearedBalance -= cumulativeAmount;
        _totalClearedBalance += cumulativeAmount;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" status.
     */
    function unclearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = _unclearPayment(authorizationId);

        _totalClearedBalance -= amount;
        _totalUnclearedBalance += amount;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
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

        uint256 cumulativeAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; i++) {
            cumulativeAmount += _unclearPayment(authorizationIds[i]);
        }

        _totalClearedBalance -= cumulativeAmount;
        _totalUnclearedBalance += cumulativeAmount;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
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
        _cancelPayment(authorizationId, correlationId, parentTxHash, PaymentStatus.Reversed);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
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

        _cancelPayment(authorizationId, correlationId, parentTxHash, PaymentStatus.Revoked);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" status.
     */
    function confirmPayment(bytes16 authorizationId) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = _confirmPayment(authorizationId);
        _totalClearedBalance -= amount;
        IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), amount);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "cleared" status.
     */
    function confirmPayments(bytes16[] memory authorizationIds) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 cumulativeAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            cumulativeAmount += _confirmPayment(authorizationIds[i]);
        }

        _totalClearedBalance -= cumulativeAmount;
        IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), cumulativeAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     */
    function clearAndConfirmPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _clearAndConfirmPayment(authorizationId);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     * - The input authorization ID of the payment must not be zero.
     * - The new base amount must not exceed the existing refund amount.
     * - If the base amount of the payment increases the extra amount must increase too or keep unchanged.
     * - If the base amount of the payment decreases the extra amount must decrease too or keep unchanged.
     * - If the base amount of the payment does not change the extra amount is allowed to change in any way.
     */
    function updateLazyClearConfirmPayment(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePaymentAmount(
            newBaseAmount,
            newExtraAmount,
            authorizationId,
            correlationId,
            UpdatingOperationKind.Lazy
        );
        _clearAndConfirmPayment(authorizationId);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "uncleared" status.
     */
    function clearAndConfirmPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 cumulativeClearedAmount = 0;
        uint256 cumulativeConfirmedAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes16 authorizationId = authorizationIds[i];
            cumulativeClearedAmount += _clearPayment(authorizationId);
            cumulativeConfirmedAmount += _confirmPayment(authorizationId);
        }

        _totalUnclearedBalance -= cumulativeClearedAmount;
        _totalClearedBalance = _totalClearedBalance + cumulativeClearedAmount - cumulativeConfirmedAmount;

        IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), cumulativeConfirmedAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The new extra amount must not be greater that the current one.
     */
    function refundPayment(
        uint256 refundAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _refundPayment(refundAmount, newExtraAmount, authorizationId, correlationId);
    }

    /**
     * @dev A version of the function above without the `newExtraAmount` parameter for backward compatibility.
     */
    function refundPayment(
        uint256 refundAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _refundPayment(refundAmount, _payments[authorizationId].extraAmount, authorizationId, correlationId);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The account address must not be zero.
     */
    function refundAccount(
        address account,
        uint256 refundAmount,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert ZeroAccount();
        }
        address cashOutAccount_ = _requireCashOutAccount();
        IERC20Upgradeable token = IERC20Upgradeable(_token);

        emit RefundAccount(correlationId, account, refundAmount);

        token.safeTransferFrom(cashOutAccount_, account, refundAmount);
    }

    /**
     * @inheritdoc ICardPaymentCashback
     *
     * @dev Requirements:
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
     * @inheritdoc ICardPaymentCashback
     *
     * @dev Requirements:
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
     * @inheritdoc ICardPaymentCashback
     *
     * @dev Requirements:
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
     * @inheritdoc ICardPaymentCashback
     *
     * @dev Requirements:
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

    // -------------------- View functions ------------------------ //

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function cashOutAccount() external view returns (address) {
        return _cashOutAccount;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function underlyingToken() external view returns (address) {
        return _token;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function totalUnclearedBalance() external view returns (uint256) {
        return _totalUnclearedBalance;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function totalClearedBalance() external view returns (uint256) {
        return _totalClearedBalance;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function unclearedBalanceOf(address account) external view returns (uint256) {
        return _unclearedBalances[account];
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function clearedBalanceOf(address account) external view returns (uint256) {
        return _clearedBalances[account];
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function paymentFor(bytes16 authorizationId) external view returns (Payment memory) {
        return _payments[authorizationId];
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function isPaymentRevoked(bytes32 parentTxHash) external view returns (bool) {
        return _paymentRevocationFlags[parentTxHash];
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function isPaymentReversed(bytes32 parentTxHash) external view returns (bool) {
        return _paymentReversionFlags[parentTxHash];
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     */
    function revocationLimit() external view returns (uint8) {
        return _revocationLimit;
    }

    /**
     * @inheritdoc ICardPaymentCashback
     */
    function cashbackDistributor() external view returns (address) {
        return _cashbackDistributor;
    }

    /**
     * @inheritdoc ICardPaymentCashback
     */
    function cashbackEnabled() external view returns (bool) {
        return _cashbackEnabled;
    }

    /**
     * @inheritdoc ICardPaymentCashback
     */
    function cashbackRate() external view returns (uint256) {
        return _cashbackRateInPermil;
    }

    /**
     * @inheritdoc ICardPaymentCashback
     */
    function getCashback(bytes16 authorizationId) external view returns (Cashback memory) {
        return _cashbacks[authorizationId];
    }

    // -------------------- Internal functions -------------------- //

    /**
     * @dev Making a payment internally.
     *
     * @param operation The operation parameters.
     */
    function _makePayment(MakingOperation memory operation) internal {
        if (operation.authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[operation.authorizationId];

        PaymentStatus status = payment.status;
        if (status != PaymentStatus.Nonexistent && status != PaymentStatus.Revoked) {
            revert PaymentAlreadyExists();
        }

        uint8 revocationCounter = payment.revocationCounter;
        if (revocationCounter != 0 && revocationCounter >= _revocationLimit) {
            revert RevocationLimitReached(_revocationLimit);
        }

        uint256 sumAmount = operation.baseAmount + operation.extraAmount;
        payment.account = operation.account;
        payment.baseAmount = operation.baseAmount;
        payment.status = PaymentStatus.Uncleared;

        if (operation.sponsor != address(0)) {
            payment.sponsor = operation.sponsor;
            payment.subsidyLimit = operation.subsidyLimit;
        } else {
            operation.subsidyLimit = 0;
            _resetSubsidizedPaymentFields(payment);
        }

        _unclearedBalances[operation.account] += sumAmount;
        _totalUnclearedBalance += sumAmount;

        emit MakePayment(
            operation.authorizationId,
            operation.correlationId,
            operation.account,
            sumAmount,
            revocationCounter,
            operation.sender
        );

        // We do not call a related existent internal function here to safe some gas and
        // because `payment.extraAmount` can be already set at this point if the payment was revoked.
        if (operation.extraAmount > 0) {
            emit PaymentExtraAmountChanged(
                operation.authorizationId,
                operation.correlationId,
                operation.account,
                sumAmount,
                operation.extraAmount,
                0
            );
            payment.extraAmount = operation.extraAmount;
        } else if (payment.extraAmount != 0) {
            payment.extraAmount = 0;
        }

        (uint256 accountSumAmount, uint256 sponsorSumAmount) = _defineSumAmountParts(sumAmount, operation.subsidyLimit);
        uint256 accountBaseAmount = _defineAccountBaseAmount(operation.baseAmount, operation.subsidyLimit);
        IERC20Upgradeable token = IERC20Upgradeable(_token);

        token.safeTransferFrom(operation.account, address(this), accountSumAmount);
        if (operation.sponsor != address(0)) {
            emit MakePaymentSubsidized(
                operation.authorizationId,
                operation.correlationId,
                operation.sponsor,
                operation.subsidyLimit,
                sponsorSumAmount,
                bytes("")
            );

            token.safeTransferFrom(operation.sponsor, address(this), sponsorSumAmount);
        }
        (payment.compensationAmount, payment.cashbackRate) = _sendCashback(
            operation.account,
            accountBaseAmount,
            operation.authorizationId,
            operation.cashbackRateInPermil
        );
    }

    /**
     * @dev Updates the base amount and extra amount of a payment internally.
     *
     * @param newBaseAmount The new base amount of the payment.
     * @param newExtraAmount The new extra amount of the payment.
     * @param authorizationId The authorization ID of the payment.
     * @param correlationId The correlation ID of the payment.
     * @param kind The kind of the payment updating operation.
     */
    function _updatePaymentAmount(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId,
        UpdatingOperationKind kind
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];
        if (kind != UpdatingOperationKind.Full) {
            if (payment.baseAmount == newBaseAmount && payment.extraAmount == newExtraAmount) {
                return;
            }
        }
        PaymentStatus status = payment.status;
        uint256 refundAmount = payment.refundAmount;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
        if (refundAmount > newBaseAmount) {
            revert InappropriateNewBasePaymentAmount();
        }
        UpdatingOperation memory operation = _defineUpdatePaymentOperation(
            newBaseAmount,
            newExtraAmount,
            refundAmount,
            payment
        );

        payment.baseAmount = newBaseAmount;

        address account = payment.account;
        address sponsor = payment.sponsor;
        IERC20Upgradeable token = IERC20Upgradeable(_token);

        emit UpdatePaymentAmount(
            authorizationId,
            correlationId,
            account,
            operation.oldPaymentSumAmount,
            operation.newPaymentSumAmount,
            operation.oldPaymentBaseAmount,
            operation.newPaymentBaseAmount
        );
        if (sponsor != address(0)) {
            emit UpdatePaymentSubsidized(
                authorizationId,
                correlationId,
                sponsor,
                operation.oldSponsorSumAmount,
                operation.newSponsorSumAmount,
                bytes("")
            );
        }

        // Increase cashback ahead any other token transfers to avoid conner cases with lack of customer balance
        if (!operation.cashbackDecreased) {
            uint256 cashbackIncreaseAmount = _increaseCashback(authorizationId, operation.cashbackAmountChange);
            payment.compensationAmount = operation.oldCompensationAmount + cashbackIncreaseAmount;
        }

        _updateExtraAmount(
            authorizationId,
            correlationId,
            account,
            operation.newPaymentSumAmount,
            newExtraAmount,
            payment
        );

        if (operation.paymentSumAmountDecreased) {
            _totalUnclearedBalance -= operation.paymentTotalAmountChange;
            _unclearedBalances[account] -= operation.paymentTotalAmountChange;
            token.safeTransfer(account, operation.accountBalanceChange);
            if (sponsor != address(0)) {
                token.safeTransfer(sponsor, operation.sponsorBalanceChange);
            }
        } else {
            _totalUnclearedBalance += operation.paymentTotalAmountChange;
            _unclearedBalances[account] += operation.paymentTotalAmountChange;
            token.safeTransferFrom(account, address(this), operation.accountBalanceChange);
            if (sponsor != address(0)) {
                token.safeTransferFrom(sponsor, address(this), operation.sponsorBalanceChange);
            }
        }
        if (operation.cashbackDecreased) {
            _revokeCashback(authorizationId, operation.cashbackAmountChange);
            payment.compensationAmount = operation.oldCompensationAmount - operation.cashbackAmountChange;
        }
    }

    /**
     * @dev Returns a structure with parameters for a payment updating operation.
     *
     * @param newPaymentBaseAmount The new base amount of the payment.
     * @param newPaymentExtraAmount The new extra amount of the payment.
     * @param paymentRefundAmount The refund amount of the payment.
     * @param payment The payment to update.
     */
    function _defineUpdatePaymentOperation(
        uint256 newPaymentBaseAmount,
        uint256 newPaymentExtraAmount,
        uint256 paymentRefundAmount,
        Payment storage payment
    ) internal view returns (UpdatingOperation memory) {
        if (payment.sponsor != address(0) && paymentRefundAmount != 0) {
            revert SubsidizedPaymentWithNonZeroRefundAmount();
        }
        uint256 oldPaymentBaseAmount = payment.baseAmount;
        uint256 oldPaymentSumAmount = oldPaymentBaseAmount + payment.extraAmount;
        uint256 newPaymentSumAmount = newPaymentBaseAmount + newPaymentExtraAmount;
        uint256 subsidyLimit = payment.subsidyLimit;
        uint256 newAccountSumAmount;
        uint256 newSponsorSumAmount;
        uint256 oldAccountSumAmount;
        uint256 oldSponsorSumAmount;
        (newAccountSumAmount, newSponsorSumAmount) = _defineSumAmountParts(newPaymentSumAmount, subsidyLimit);
        (oldAccountSumAmount, oldSponsorSumAmount) = _defineSumAmountParts(oldPaymentSumAmount, subsidyLimit);

        UpdatingOperation memory operation = UpdatingOperation({
            oldPaymentSumAmount: oldPaymentSumAmount,
            newPaymentSumAmount: newPaymentSumAmount,
            oldSponsorSumAmount: oldSponsorSumAmount,
            newSponsorSumAmount: newSponsorSumAmount,
            oldPaymentBaseAmount: oldPaymentBaseAmount,
            newPaymentBaseAmount: newPaymentBaseAmount,
            oldCompensationAmount: payment.compensationAmount,
            paymentTotalAmountChange: 0,
            accountBalanceChange: 0,
            sponsorBalanceChange: 0,
            cashbackAmountChange: 0,
            paymentSumAmountDecreased: false,
            cashbackDecreased: false
        });

        uint256 newAccountBaseAmount = _defineAccountBaseAmount(newPaymentBaseAmount, subsidyLimit);
        uint256 newCompensationAmount = paymentRefundAmount +
            _calculateCashback(newAccountBaseAmount - paymentRefundAmount, payment.cashbackRate);
        uint256 oldCompensationAmount = operation.oldCompensationAmount;

        if (operation.newPaymentBaseAmount <= operation.oldPaymentBaseAmount) {
            operation.cashbackDecreased = true;
            // If payment base amount decreases than the cashback amount can only be decreased or is not changed.
            if (newCompensationAmount <= oldCompensationAmount) {
                operation.cashbackAmountChange = oldCompensationAmount - newCompensationAmount;
            }
        } else {
            operation.cashbackAmountChange = newCompensationAmount - oldCompensationAmount;
        }

        if (newPaymentSumAmount < oldPaymentSumAmount) {
            operation.paymentSumAmountDecreased = true;
            operation.paymentTotalAmountChange = oldPaymentSumAmount - newPaymentSumAmount;
            operation.sponsorBalanceChange = oldSponsorSumAmount - newSponsorSumAmount;
            operation.accountBalanceChange = oldAccountSumAmount - newAccountSumAmount;

            if (operation.cashbackDecreased) {
                operation.accountBalanceChange -= operation.cashbackAmountChange;
            }
        } else {
            operation.paymentTotalAmountChange = newPaymentSumAmount - oldPaymentSumAmount;
            operation.sponsorBalanceChange = newSponsorSumAmount - oldSponsorSumAmount;
            operation.accountBalanceChange = newAccountSumAmount - oldAccountSumAmount;

            if (operation.cashbackDecreased) {
                operation.accountBalanceChange += operation.cashbackAmountChange;
            }
        }
        return operation;
    }

    /**
     * @dev Clears a payment internally.
     *
     * @param authorizationId The authorization ID of the payment.
     */
    function _clearPayment(bytes16 authorizationId) internal returns (uint256 totalAmount) {
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
        totalAmount = payment.baseAmount + payment.extraAmount - payment.refundAmount;

        uint256 newUnclearedBalance = _unclearedBalances[account] - totalAmount;
        _unclearedBalances[account] = newUnclearedBalance;
        uint256 newClearedBalance = _clearedBalances[account] + totalAmount;
        _clearedBalances[account] = newClearedBalance;

        emit ClearPayment(
            authorizationId,
            account,
            totalAmount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );

        address sponsor = payment.sponsor;
        if (sponsor != address(0)) {
            emit ClearPaymentSubsidized(authorizationId, sponsor, bytes(""));
        }
    }

    /**
     * @dev Unclears a payment internally.
     *
     * @param authorizationId The authorization ID of the payment.
     */
    function _unclearPayment(bytes16 authorizationId) internal returns (uint256 totalAmount) {
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
        totalAmount = payment.baseAmount + payment.extraAmount - payment.refundAmount;

        uint256 newClearedBalance = _clearedBalances[account] - totalAmount;
        _clearedBalances[account] = newClearedBalance;
        uint256 newUnclearedBalance = _unclearedBalances[account] + totalAmount;
        _unclearedBalances[account] = newUnclearedBalance;

        emit UnclearPayment(
            authorizationId,
            account,
            totalAmount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );

        address sponsor = payment.sponsor;
        if (sponsor != address(0)) {
            emit UnclearPaymentSubsidized(authorizationId, sponsor, bytes(""));
        }
    }

    /**
     * @dev Confirms a payment internally.
     *
     * @param authorizationId The authorization ID of the payment.
     */
    function _confirmPayment(bytes16 authorizationId) internal returns (uint256 totalAmount) {
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
        totalAmount = payment.baseAmount + payment.extraAmount - payment.refundAmount;
        uint256 newClearedBalance = _clearedBalances[account] - totalAmount;
        _clearedBalances[account] = newClearedBalance;

        emit ConfirmPayment(
            authorizationId,
            account,
            totalAmount,
            newClearedBalance,
            payment.revocationCounter
        );

        address sponsor = payment.sponsor;
        if (sponsor != address(0)) {
            emit ConfirmPaymentSubsidized(authorizationId, sponsor, bytes(""));
        }
    }

    /**
     * @dev Clears and confirms a payment internally.
     *
     * @param authorizationId The authorization ID of the payment.
     */
    function _clearAndConfirmPayment(bytes16 authorizationId) internal {
        uint256 clearedAmount = _clearPayment(authorizationId);
        uint256 confirmedAmount = _confirmPayment(authorizationId);

        _totalUnclearedBalance -= clearedAmount;
        _totalClearedBalance = _totalClearedBalance + clearedAmount - confirmedAmount;

        IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), confirmedAmount);
    }

    /**
     * @dev Cancels a payment.
     *
     * @param authorizationId The authorization ID of the payment.
     * @param correlationId The correlation ID of the payment.
     * @param parentTxHash The parent transaction hash.
     * @param targetStatus The target status of the payment.
     */
    function _cancelPayment(
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

        CancelingOperation memory operation = _defineCancellationOperation(payment);

        address account = payment.account;
        if (status == PaymentStatus.Uncleared) {
            _totalUnclearedBalance -= operation.paymentTotalAmount;
            _unclearedBalances[account] -= operation.paymentTotalAmount;
        } else if (status == PaymentStatus.Cleared) {
            _totalClearedBalance -= operation.paymentTotalAmount;
            _clearedBalances[account] -= operation.paymentTotalAmount;
        } else {
            revert InappropriatePaymentStatus(status);
        }

        _resetCompensationAndRefundFields(payment);

        address sponsor = payment.sponsor;
        if (targetStatus == PaymentStatus.Revoked) {
            payment.status = PaymentStatus.Revoked;
            _paymentRevocationFlags[parentTxHash] = true;
            uint8 newRevocationCounter = payment.revocationCounter + 1;
            payment.revocationCounter = newRevocationCounter;

            emit RevokePayment(
                authorizationId,
                correlationId,
                account,
                operation.totalSentAmount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                newRevocationCounter
            );

            if (sponsor != address(0)) {
                emit RevokePaymentSubsidized(
                    authorizationId,
                    correlationId,
                    sponsor,
                    operation.sponsorSentAmount,
                    bytes("")
                );
            }
        } else {
            payment.status = PaymentStatus.Reversed;
            _paymentReversionFlags[parentTxHash] = true;

            emit ReversePayment(
                authorizationId,
                correlationId,
                account,
                operation.totalSentAmount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                payment.revocationCounter
            );

            if (sponsor != address(0)) {
                emit ReversePaymentSubsidized(
                    authorizationId,
                    correlationId,
                    sponsor,
                    operation.sponsorSentAmount,
                    bytes("")
                );
            }
        }

        IERC20Upgradeable token = IERC20Upgradeable(_token);

        token.safeTransfer(account, operation.accountSentAmount);
        if (sponsor != address(0)) {
            token.safeTransfer(sponsor, operation.sponsorSentAmount);
        }
        _revokeCashback(authorizationId, operation.revokedCashbackAmount);
    }

    /**
     * @dev Returns a structure with parameters for a payment cancellation operation.
     *
     * @param payment The payment to cancel.
     */
    function _defineCancellationOperation(Payment storage payment) internal view returns (CancelingOperation memory) {
        uint256 paymentBaseAmount = payment.baseAmount;
        uint256 paymentRefundAmount = payment.refundAmount;
        uint256 subsidyLimit = payment.subsidyLimit;
        uint256 sponsorRefundAmount = _defineSponsorRefundAmount(paymentRefundAmount, paymentBaseAmount, subsidyLimit);
        uint256 paymentSumAmount = paymentBaseAmount + payment.extraAmount;
        (uint256 accountSumAmount, uint256 sponsorSumAmount) = _defineSumAmountParts(paymentSumAmount, subsidyLimit);
        uint256 paymentTotalAmount = paymentSumAmount - paymentRefundAmount;
        uint256 accountSentAmount = accountSumAmount - (payment.compensationAmount - sponsorRefundAmount);
        uint256 sponsorSentAmount = sponsorSumAmount - sponsorRefundAmount;

        CancelingOperation memory operation = CancelingOperation({
            paymentTotalAmount: paymentTotalAmount,
            accountSentAmount: accountSentAmount,
            sponsorSentAmount: sponsorSentAmount,
            totalSentAmount: accountSentAmount + sponsorSentAmount,
            revokedCashbackAmount: paymentTotalAmount - accountSentAmount - sponsorSentAmount
        });

        return operation;
    }

    /**
     * @dev Makes a refund for a payment internally.
     *
     * @param refundAmount The refund amount of the payment.
     * @param newExtraAmount The new extra amount of the payment.
     * @param authorizationId The authorization ID of the payment.
     */
    function _refundPayment(
        uint256 refundAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];
        PaymentStatus status = payment.status;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Uncleared && status != PaymentStatus.Cleared && status != PaymentStatus.Confirmed) {
            revert InappropriatePaymentStatus(status);
        }
        if (payment.refundAmount + refundAmount > payment.baseAmount) {
            revert InappropriateRefundAmount();
        }
        if (newExtraAmount > payment.extraAmount) {
            revert InappropriateNewExtraPaymentAmount();
        }

        RefundingOperation memory operation = _defineRefundingOperation(refundAmount, newExtraAmount, payment);

        payment.refundAmount = operation.newPaymentRefundAmount;
        payment.compensationAmount = operation.newCompensationAmount;

        address account = payment.account;
        address sponsor = payment.sponsor;
        IERC20Upgradeable token = IERC20Upgradeable(_token);
        if (status == PaymentStatus.Uncleared) {
            _totalUnclearedBalance -= operation.paymentTotalAmountDiff;
            _unclearedBalances[account] -= operation.paymentTotalAmountDiff;
            token.safeTransfer(account, operation.accountSentAmount);
            if (sponsor != address(0)) {
                token.safeTransfer(sponsor, operation.sponsorSentAmount);
            }
        } else if (status == PaymentStatus.Cleared) {
            _totalClearedBalance -= operation.paymentTotalAmountDiff;
            _clearedBalances[account] -= operation.paymentTotalAmountDiff;
            token.safeTransfer(account, operation.accountSentAmount);
            if (sponsor != address(0)) {
                token.safeTransfer(sponsor, operation.sponsorSentAmount);
            }
        } else { // status == PaymentStatus.ConfirmPayment
            address cashOutAccount_ = _requireCashOutAccount();
            token.safeTransferFrom(cashOutAccount_, account, operation.accountSentAmount);
            if (sponsor != address(0)) {
                token.safeTransferFrom(cashOutAccount_, sponsor, operation.sponsorSentAmount);
            }
            token.safeTransferFrom(cashOutAccount_, address(this), operation.revokedCashbackAmount);
        }

        _revokeCashback(authorizationId, operation.revokedCashbackAmount);

        emit RefundPayment(
            authorizationId,
            correlationId,
            account,
            refundAmount,
            operation.totalSentAmount,
            status
        );
        if (sponsor != address(0)) {
            emit RefundPaymentSubsidized(
                authorizationId,
                correlationId,
                sponsor,
                operation.sponsorRefundAmount,
                operation.sponsorSentAmount,
                bytes("")
            );
        }
        _updateExtraAmount(
            authorizationId,
            correlationId,
            account,
            operation.newPaymentSumAmount,
            newExtraAmount,
            payment
        );
    }

    /**
     * @dev Returns a structure with parameters for a payment updating operation.
     *
     * @param paymentRefundAmount The refund amount of the payment.
     * @param newPaymentExtraAmount The new extra amount of the payment.
     * @param payment The payment to update.
     */
    function _defineRefundingOperation(
        uint256 paymentRefundAmount,
        uint256 newPaymentExtraAmount,
        Payment storage payment
    ) internal view returns (RefundingOperation memory) {
        uint256 subsidyLimit = payment.subsidyLimit;
        uint256 paymentBaseAmount = payment.baseAmount;
        uint256 oldPaymentRefundAmount = payment.refundAmount;
        uint256 newPaymentRefundAmount = oldPaymentRefundAmount + paymentRefundAmount;
        uint256 oldSponsorRefundAmount = _defineSponsorRefundAmount(
            oldPaymentRefundAmount,
            paymentBaseAmount,
            subsidyLimit
        );
        uint256 newSponsorRefundAmount = _defineSponsorRefundAmount(
            newPaymentRefundAmount,
            paymentBaseAmount,
            subsidyLimit
        );
        uint256 accountBaseAmount = _defineAccountBaseAmount(paymentBaseAmount, subsidyLimit);

        RefundingOperation memory operation;

        operation.newPaymentSumAmount = paymentBaseAmount + newPaymentExtraAmount;
        operation.sponsorRefundAmount = newSponsorRefundAmount - oldSponsorRefundAmount;
        operation.paymentRefundAmount = paymentRefundAmount;
        operation.newPaymentRefundAmount = newPaymentRefundAmount;
        operation.oldCompensationAmount = payment.compensationAmount;
        operation.oldCashbackAmount = operation.oldCompensationAmount - oldPaymentRefundAmount;
        operation.newCashbackAmount = _calculateCashback(
            accountBaseAmount - (newPaymentRefundAmount - newSponsorRefundAmount),
            payment.cashbackRate
        );

        // The cashback cannot be increased in the refunding operation.
        if (operation.newCashbackAmount > operation.oldCashbackAmount) {
            operation.newCashbackAmount = operation.oldCashbackAmount;
        }
        operation.revokedCashbackAmount = operation.oldCashbackAmount - operation.newCashbackAmount;
        operation.newCompensationAmount = newPaymentRefundAmount + operation.newCashbackAmount;

        uint256 oldPaymentExtraAmount = payment.extraAmount;
        uint256 oldAccountExtraAmount = _defineAccountExtraAmount(
            paymentBaseAmount,
            oldPaymentExtraAmount,
            subsidyLimit
        );
        uint256 newAccountExtraAmount = _defineAccountExtraAmount(
            paymentBaseAmount,
            newPaymentExtraAmount,
            subsidyLimit
        );
        uint256 paymentExtraAmountChange = oldPaymentExtraAmount - newPaymentExtraAmount;
        uint256 accountExtraAmountChange = oldAccountExtraAmount - newAccountExtraAmount;
        operation.accountSentAmount =
            operation.newCompensationAmount -
            operation.oldCompensationAmount -
            newSponsorRefundAmount +
            accountExtraAmountChange;
        operation.sponsorSentAmount =
            operation.sponsorRefundAmount +
            paymentExtraAmountChange -
            accountExtraAmountChange;
        operation.totalSentAmount = operation.accountSentAmount + operation.sponsorSentAmount;
        operation.paymentTotalAmountDiff = operation.paymentRefundAmount + paymentExtraAmountChange;

        return operation;
    }

    /**
     * @dev Sends cashback related to a payment internally.
     *
     * @param account The account of the payment.
     * @param basePaymentAmount The base amount of the payment.
     * @param authorizationId The authorization ID of the payment.
     * @param requestedCashbackRateInPermil The requested cashback rate in permil.
     */
    function _sendCashback(
        address account,
        uint256 basePaymentAmount,
        bytes16 authorizationId,
        int16 requestedCashbackRateInPermil
    ) internal returns (uint256 sentAmount, uint16 appliedCashbackRate) {
        if (requestedCashbackRateInPermil == 0) {
            return (0, 0);
        }
        address distributor = _cashbackDistributor;
        if (_cashbackEnabled && distributor != address(0)) {
            bool success;
            uint256 cashbackNonce;
            if (requestedCashbackRateInPermil > 0) {
                appliedCashbackRate = uint16(requestedCashbackRateInPermil);
            } else {
                appliedCashbackRate = _cashbackRateInPermil;
            }
            uint256 cashbackAmount = _calculateCashback(basePaymentAmount, appliedCashbackRate);
            (success, sentAmount, cashbackNonce) = ICashbackDistributor(distributor).sendCashback(
                _token,
                ICashbackDistributorTypes.CashbackKind.CardPayment,
                authorizationId,
                account,
                cashbackAmount
            );
            _cashbacks[authorizationId].lastCashbackNonce = cashbackNonce;
            if (success) {
                emit SendCashbackSuccess(distributor, sentAmount, cashbackNonce);
            } else {
                emit SendCashbackFailure(distributor, cashbackAmount, cashbackNonce);
                appliedCashbackRate = 0;
            }
        }
    }

    /**
     * @dev Revokes partially or fully cashback related to a payment internally.
     *
     * @param authorizationId The authorization ID of the payment.
     * @param amount The amount of the cashback to revoke.
     */
    function _revokeCashback(bytes16 authorizationId, uint256 amount) internal {
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

    /**
     * @dev Increases cashback related to a payment internally.
     *
     * @param authorizationId The authorization ID of the payment.
     * @param amount The amount of the cashback to increase.
     */
    function _increaseCashback(bytes16 authorizationId, uint256 amount) internal returns (uint256 sentAmount) {
        address distributor = _cashbackDistributor;
        uint256 cashbackNonce = _cashbacks[authorizationId].lastCashbackNonce;
        if (cashbackNonce != 0 && distributor != address(0)) {
            bool success;
            (success, sentAmount) = ICashbackDistributor(distributor).increaseCashback(cashbackNonce, amount);
            if (success) {
                emit IncreaseCashbackSuccess(distributor, sentAmount, cashbackNonce);
            } else {
                emit IncreaseCashbackFailure(distributor, amount, cashbackNonce);
            }
        }
    }

    /// @dev Checks if the cash-out account exists and returns if it does. Otherwise reverts the execution.
    function _requireCashOutAccount() internal view returns (address account) {
        account = _cashOutAccount;
        if (account == address(0)) {
            revert ZeroCashOutAccount();
        }
    }

    /**
     * @dev Calculates cashback according to the amount and the rate.
     *
     * @param amount The amount of the cashback.
     * @param cashbackRateInPermil The cashback rate in permil.
     */
    function _calculateCashback(uint256 amount, uint256 cashbackRateInPermil) internal pure returns (uint256) {
        uint256 cashback = (amount * cashbackRateInPermil) / 1000;
        return ((cashback + CASHBACK_ROUNDING_COEF / 2) / CASHBACK_ROUNDING_COEF) * CASHBACK_ROUNDING_COEF;
    }

    /**
     * @dev Update the extra amount of a payment and emits the related event.
     *
     * @param authorizationId The authorization ID of the payment.
     * @param correlationId The correlation ID of the payment.
     * @param account The account of the payment.
     * @param sumAmount The sum amount of the payment.
     * @param newExtraAmount The new extra amount of the payment.
     * @param payment The payment to update.
     */
    function _updateExtraAmount(
        bytes16 authorizationId,
        bytes16 correlationId,
        address account,
        uint256 sumAmount,
        uint256 newExtraAmount,
        Payment storage payment
    ) internal {
        uint256 oldExtraAmount = payment.extraAmount;
        if (oldExtraAmount != newExtraAmount) {
            emit PaymentExtraAmountChanged(
                authorizationId,
                correlationId,
                account,
                sumAmount,
                newExtraAmount,
                oldExtraAmount
            );
            payment.extraAmount = newExtraAmount;
        }
    }

    /**
     * @dev Defines the account part of a payment base amount according to a subsidy limit.
     *
     * @param paymentBaseAmount The base amount of the payment.
     * @param subsidyLimit The subsidy limit.
     */
    function _defineAccountBaseAmount(uint256 paymentBaseAmount, uint256 subsidyLimit) internal pure returns (uint256) {
        if (subsidyLimit >= paymentBaseAmount) {
            return 0;
        } else {
            return paymentBaseAmount - subsidyLimit;
        }
    }

    /**
     * @dev Defines the account part of a payment extra amount according to a subsidy limit.
     *
     * @param paymentBaseAmount The base amount of the payment.
     * @param paymentExtraAmount The extra amount of the payment.
     * @param subsidyLimit The subsidy limit.
     */
    function _defineAccountExtraAmount(
        uint256 paymentBaseAmount,
        uint256 paymentExtraAmount,
        uint256 subsidyLimit
    ) internal pure returns (uint256) {
        if (subsidyLimit > paymentBaseAmount) {
            uint256 paymentSumAmount = paymentBaseAmount + paymentExtraAmount;
            if (subsidyLimit >= paymentSumAmount) {
                return 0;
            } else {
                return paymentSumAmount - subsidyLimit;
            }
        } else {
            return paymentExtraAmount;
        }
    }

    /**
     * @dev Defines the account and sponsor parts of a payment sum amount according to a subsidy limit.
     *
     * @param paymentSumAmount The sum amount of the payment.
     * @param subsidyLimit The subsidy limit.
     */
    function _defineSumAmountParts(
        uint256 paymentSumAmount,
        uint256 subsidyLimit
    ) internal pure returns (uint256 accountSumAmount, uint256 sponsorSumAmount) {
        if (subsidyLimit >= paymentSumAmount) {
            sponsorSumAmount = paymentSumAmount;
            accountSumAmount = 0;
        } else {
            sponsorSumAmount = subsidyLimit;
            accountSumAmount = paymentSumAmount - subsidyLimit;
        }
    }

    /**
     * @dev Defines the sponsor part of a payment refund amount according to a subsidy limit.
     *
     * @param paymentRefundAmount The refund amount of the payment.
     * @param paymentBaseAmount The base amount of the payment.
     * @param subsidyLimit The subsidy limit.
     */
    function _defineSponsorRefundAmount(
        uint256 paymentRefundAmount,
        uint256 paymentBaseAmount,
        uint256 subsidyLimit
    ) internal pure returns (uint256) {
        if (subsidyLimit >= paymentBaseAmount) {
            return paymentRefundAmount;
        } else {
            return (paymentRefundAmount * subsidyLimit) / paymentBaseAmount;
        }
    }

    /**
     * @dev Resets the payment structure fields related to the subsidy part of a payment.
     *
     * @param payment The payment to reset.
     */
    function _resetSubsidizedPaymentFields(Payment storage payment) internal {
        if (payment.sponsor != address(0)) {
            payment.sponsor = address(0);
        }
        if (payment.subsidyLimit != 0) {
            payment.subsidyLimit = 0;
        }
    }

    /**
     * @dev Resets the payment structure fields related to the compensation and refund of a payment.
     *
     * @param payment The payment to reset.
     */
    function _resetCompensationAndRefundFields(Payment storage payment) internal {
        payment.compensationAmount = 0;
        if (payment.refundAmount != 0) {
            payment.refundAmount = 0;
        }
    }
}
