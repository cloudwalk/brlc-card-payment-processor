// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { BlacklistableUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/BlacklistableUpgradeable.sol";
import { PausableExtUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "@cloudwalkinc/brlc-contracts/contracts/storage/StoragePlaceholder200.sol";

import { CardPaymentProcessorV2Storage } from "./CardPaymentProcessorV2Storage.sol";
import { ICardPaymentProcessorV2 } from "./interfaces/ICardPaymentProcessorV2.sol";
import { ICardPaymentCashbackV2 } from "./interfaces/ICardPaymentCashbackV2.sol";
import { ICashbackDistributor, ICashbackDistributorTypes } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CardPaymentProcessorV2 contract
 * @dev Wrapper contract for the card payment operations.
 */
contract CardPaymentProcessorV2 is
    AccessControlUpgradeable,
    BlacklistableUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    StoragePlaceholder200,
    CardPaymentProcessorV2Storage,
    ICardPaymentProcessorV2,
    ICardPaymentCashbackV2
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of executor that is allowed to execute the card payment operations.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    // -------------------- Events -----------------------------------

    /// @dev Emitted when the cash-out account is changed.
    event SetCashOutAccount(
        address oldCashOutAccount,
        address newCashOutAccount
    );

    // -------------------- Errors -----------------------------------

    /// @dev The zero payer address has been passed as a function argument.
    error AccountZeroAddress();

    /// @dev The cashback operations are already enabled.
    error CashbackAlreadyEnabled();

    /// @dev The cashback operations are already disabled.
    error CashbackAlreadyDisabled();

    /// @dev The cashback distributor contract is already configured.
    error CashbackDistributorAlreadyConfigured();

    /// @dev The cashback distributor contract is not configured.
    error CashbackDistributorNotConfigured();

    /// @dev The zero cashback distributor address has been passed as a function argument.
    error CashbackDistributorZeroAddress();

    /// @dev The provided cashback rate exceeds the allowed maximum.
    error CashbackRateExcess();

    /// @dev A new cashback rate is the same as previously set one.
    error CashbackRateUnchanged();

    /// @dev The cash-out account is not configured.
    error CashOutAccountNotConfigured();

    /// @dev A new cash-out account is the same as the previously set one.
    error CashOutAccountUnchanged();

    /// @dev The requested refund amount does not meet the requirements.
    error InappropriateRefundAmount();

    /// @dev The new amount of the payment does not meet the requirements.
    error InappropriateNewBasePaymentAmount();

    /// @dev The new extra amount of the payment does not meet the requirements.
    error InappropriateNewExtraPaymentAmount();

    /**
     * @dev The payment with the provided ID has an inappropriate status.
     * @param currentStatus The current status of payment with the provided ID.
     */
    error InappropriatePaymentStatus(PaymentStatus currentStatus);

    /// @dev The zero payer address has been passed as a function argument.
    error PayerZeroAddress();

    /// @dev The payment with the provided ID already exists and is not revoked.
    error PaymentAlreadyExistent();

    /// @dev The array of payment confirmations is empty.
    error PaymentConfirmationArrayEmpty();

    /// @dev The payment with the provided ID does not exist.
    error PaymentNonExistent();

    /// @dev Zero payment ID has been passed as a function argument.
    error PaymentZeroId();

    /// @dev The function cannot be executed for a subsidized payment with the non-zero refund amount.
    error SubsidizedPaymentWithNonZeroRefundAmount();

    /// @dev The zero token address has been passed as a function argument.
    error TokenZeroAddress();

    // ------------------- Functions ---------------------------------

    /**
     * @dev The initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable .
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

    /**
     * @dev The internal initializer of the upgradable contract.
     *
     * See {CardPaymentProcessor-initialize}.
     */
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

    /**
     * @dev The internal unchained initializer of the upgradable contract.
     *
     * See {CardPaymentProcessor-initialize}.
     */
    function __CardPaymentProcessor_init_unchained(address token_) internal onlyInitializing {
        if (token_ == address(0)) {
            revert TokenZeroAddress();
        }

        _token = token_;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(EXECUTOR_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /// @dev Contains parameters of a payment making operation.
    struct MakingOperation {
        bytes32 authorizationId;
        bytes32 correlationId;
        address payer;
        address sponsor;
        uint16 cashbackRate;
        uint64 baseAmount;
        uint64 extraAmount;
        uint64 subsidyLimit;
        uint64 cashbackAmount;
        uint256 payerSumAmount;
        uint256 sponsorSumAmount;
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must must not be blacklisted.
     * - The payment ID must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked or be finalized.
     */
    function makePayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 baseAmount,
        uint64 extraAmount
    ) external whenNotPaused notBlacklisted(_msgSender()) {
        MakingOperation memory operation = MakingOperation({
            authorizationId: authorizationId,
            correlationId: correlationId,
            payer: _msgSender(),
            sponsor: address(0),
            cashbackRate: _cashbackRate,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            subsidyLimit: 0,
            cashbackAmount : 0,
            payerSumAmount: 0,
            sponsorSumAmount: 0
        });
        _makePayment(operation);
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The payment account address must not be zero.
     * - The payment ID must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked or be finalized.
     * - The requested cashback rate must not exceed the maximum allowable cashback rate defined in the contract.
     */
    function makePaymentFor(
        bytes32 authorizationId,
        bytes32 correlationId,
        address payer,
        uint64 baseAmount,
        uint64 extraAmount,
        address sponsor,
        uint64 subsidyLimit,
        int16 cashbackRate_
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (payer == address(0)) {
            revert PayerZeroAddress();
        }
        uint16 cashbackRateActual;
        if (cashbackRate_ < 0) {
            cashbackRateActual = _cashbackRate;
        } else {
            cashbackRateActual = uint16(cashbackRate_);
            if (cashbackRateActual > MAX_CASHBACK_RATE) {
                revert CashbackRateExcess();
            }
        }
        MakingOperation memory operation = MakingOperation({
            authorizationId: authorizationId,
            correlationId: correlationId,
            payer: payer,
            sponsor: sponsor,
            cashbackRate: cashbackRateActual,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            subsidyLimit: subsidyLimit,
            cashbackAmount : 0,
            payerSumAmount: 0,
            sponsorSumAmount: 0
        });
        _makePayment(operation);
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     * - The new base amount must not exceed the existing refund amount.
     * - If the base amount of the payment increases the extra amount must increase too or keep unchanged.
     * - If the base amount of the payment decreases the extra amount must decrease too or keep unchanged.
     * - If the base amount of the payment does not change the extra amount is allowed to change in any way.
     */
    function updatePayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 newBaseAmount,
        uint64 newExtraAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePayment(
            authorizationId,
            correlationId,
            newBaseAmount,
            newExtraAmount,
            UpdatingOperationKind.Full
        );
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     * - The
     */
    function reversePayment(
        bytes32 authorizationId,
        bytes32 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _cancelPayment(
            authorizationId,
            correlationId,
            PaymentStatus.Reversed
        );
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     * -
     */
    function revokePayment(
        bytes32 authorizationId,
        bytes32 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _cancelPayment(
            authorizationId,
            correlationId,
            PaymentStatus.Revoked
        );
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     */
    function confirmPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 amount
    ) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 transferAmount = _confirmPayment(
            authorizationId,
            correlationId,
            amount
        );
        IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), transferAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array must not be empty.
     * - All payment IDs in the input array must not be zero.
     */
    function confirmPayments(
        PaymentConfirmation[] calldata paymentConfirmations
    ) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (paymentConfirmations.length == 0) {
            revert PaymentConfirmationArrayEmpty();
        }

        uint256 totalTransferAmount = 0;
        for (uint256 i = 0; i < paymentConfirmations.length; i++) {
            totalTransferAmount += _confirmPayment(
                paymentConfirmations[i].authorizationId,
                paymentConfirmations[i].correlationId,
                paymentConfirmations[i].amount
            );
        }

        IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), totalTransferAmount);
    }


    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     * - The new base amount must not exceed the existing refund amount.
     * - If the base amount of the payment is increased the extra amount must be increased too or kept unchanged.
     * - If the base amount of the payment is decreased the extra amount must be decreased too or kept unchanged.
     * - If the base amount of the payment is not changed the extra amount is allowed to be changed in any way.
     */
    function updateLazyAndConfirmPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 newBaseAmount,
        uint64 newExtraAmount,
        uint64 confirmationAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePayment(
            authorizationId,
            correlationId,
            newBaseAmount,
            newExtraAmount,
            UpdatingOperationKind.Lazy
        );
        uint256 transferAmount = _confirmPayment(
            authorizationId,
            correlationId,
            confirmationAmount
        );
        IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), transferAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     * - The new extra amount must not be greater than the current one of the payment.
     */
    function refundPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 refundAmount,
        uint64 newExtraAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _refundPayment(authorizationId, correlationId, refundAmount, newExtraAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The account address must not be zero.
     */
    function refundAccount(
        bytes32 correlationId,
        address account,
        uint64 refundAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert AccountZeroAddress();
        }

        emit RefundAccount(
            correlationId,
            account,
            refundAmount,
            bytes("")
        );

        IERC20Upgradeable(_token).safeTransferFrom(_requireCashOutAccount(), account, refundAmount);
    }

    /**
     * @dev Sets the cash-out account address.
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

    /**
     * @inheritdoc ICardPaymentCashbackV2
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
     * @inheritdoc ICardPaymentCashbackV2
     *
     * @dev Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new rate must differ from the previously set one.
     * - The new rate must not exceed the allowable maximum specified in the {MAX_CASHBACK_RATE_IN_PERMIL} constant.
     */
    function setCashbackRate(uint16 newCashbackRate) external onlyRole(OWNER_ROLE) {
        uint16 oldCashbackRate = _cashbackRate;
        if (newCashbackRate == oldCashbackRate) {
            revert CashbackRateUnchanged();
        }
        if (newCashbackRate > MAX_CASHBACK_RATE) {
            revert CashbackRateExcess();
        }

        _cashbackRate = newCashbackRate;

        emit SetCashbackRate(oldCashbackRate, newCashbackRate);
    }

    /**
     * @inheritdoc ICardPaymentCashbackV2
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
     * @inheritdoc ICardPaymentCashbackV2
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

    /**
     * @inheritdoc ICardPaymentProcessorV2
     */
    function cashOutAccount() external view returns (address) {
        return _cashOutAccount;
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     */
    function token() external view returns (address) {
        return _token;
    }


    /**
     * @inheritdoc ICardPaymentProcessorV2
     */
    function getPayment(bytes32 authorizationId) external view returns (Payment memory) {
        return _payments[authorizationId];
    }

    /**
     * @inheritdoc ICardPaymentCashbackV2
     */
    function cashbackDistributor() external view returns (address) {
        return _cashbackDistributor;
    }

    /**
     * @inheritdoc ICardPaymentCashbackV2
     */
    function cashbackEnabled() external view returns (bool) {
        return _cashbackEnabled;
    }

    /**
     * @inheritdoc ICardPaymentCashbackV2
     */
    function cashbackRate() external view returns (uint256) {
        return _cashbackRate;
    }

    /**
     * @inheritdoc ICardPaymentCashbackV2
     */
    function getCashback(bytes32 authorizationId) external view returns (Cashback memory) {
        return _cashbacks[authorizationId];
    }


    /// @dev Making a payment internally
    function _makePayment(MakingOperation memory operation) internal {
        if (operation.authorizationId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[operation.authorizationId];

        PaymentStatus status = storedPayment.status;
        if (status != PaymentStatus.Nonexistent && status != PaymentStatus.Revoked) {
            revert PaymentAlreadyExistent();
        }

        _transferTokensForPaymentMaking(operation);
        _sendCashback(operation);
        _storeNewPayment(storedPayment, operation);

        emit PaymentMade(
            operation.authorizationId,
            operation.correlationId,
            operation.payer,
            operation.payerSumAmount,
            bytes("")
        );

        if (operation.sponsor != address(0)) {
            emit PaymentMadeSubsidized(
                operation.authorizationId,
                operation.correlationId,
                operation.sponsor,
                operation.sponsorSumAmount,
                operation.subsidyLimit,
                bytes("")
            );
        }
    }

    /// @dev Contains parameters for a payment updating operation.
    struct UpdatingOperation {
        uint256 oldBaseAmount;
        uint256 newBaseAmount;
        uint256 oldExtraAmount;
        uint256 newExtraAmount;
        uint256 oldPayerSumAmount;
        uint256 newPayerSumAmount;
        uint256 oldSponsorSumAmount;
        uint256 newSponsorSumAmount;
        Payment oldPayment;
    }

    /// @dev Kind of a payment updating operation
    enum UpdatingOperationKind {
        Full, // 0 The operation is executed fully regardless of the new values of the base amount and extra amount.
        Lazy  // 1 The operation is executed only if the new amounts differ from the current ones of the payment.
    }

    /// @dev Updates the base amount and extra amount of a payment. See {ICardPaymentCashback-updatePaymentAmount}.
    function _updatePayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 newBaseAmount,
        uint64 newExtraAmount,
        UpdatingOperationKind kind
    ) internal {
        if (authorizationId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[authorizationId];
        Payment memory payment = storedPayment;

        if (kind != UpdatingOperationKind.Full) {
            if (payment.baseAmount == newBaseAmount && payment.extraAmount == newExtraAmount) {
                return;
            }
        }

        if (payment.status == PaymentStatus.Nonexistent) {
            revert PaymentNonExistent();
        }
        if (payment.refundAmount > newBaseAmount) {
            revert InappropriateNewBasePaymentAmount();
        }

        UpdatingOperation memory operation = _defineUpdatingOperation(
            newBaseAmount,
            newExtraAmount,
            payment
        );
        _transferTokensForPaymentUpdating(operation);
        _storeUpdatedPayment(storedPayment, operation);

        /// @dev Emitted when a payment is updated.
        emit PaymentUpdated(
            authorizationId,
            correlationId,
            operation.oldPayment.payer,
            operation.oldBaseAmount,
            operation.newBaseAmount,
            operation.oldExtraAmount,
            operation.newExtraAmount,
            operation.oldPayerSumAmount,
            operation.newPayerSumAmount,
            bytes("")
        );

        if (payment.sponsor != address(0)) {
            emit PaymentUpdatedSubsidized(
                authorizationId,
                correlationId,
                operation.oldPayment.sponsor,
                operation.oldSponsorSumAmount,
                operation.newSponsorSumAmount,
                bytes("")
            );
        }
    }

    /// @dev Confirms a payment. See {ICardPaymentCashback-confirmPayment}.
    function _confirmPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 amount
    ) internal returns (uint256) {
        if (authorizationId == 0) {
            revert PaymentZeroId();
        }
        return 0;
    }

    /// @dev Contains parameters of a payment canceling operation.
    struct CancelingOperation {
        uint256 paymentTotalAmount;
        uint256 accountSentAmount;
        uint256 sponsorSentAmount;
        uint256 totalSentAmount;
        uint256 revokedCashbackAmount;
    }

    /// @dev Cancels a payment. For parameters see {ICardPaymentCashback-revokePayment}.
    function _cancelPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        PaymentStatus targetStatus
    ) internal {

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

    /// @dev Makes a refund for a payment. See {ICardPaymentCashback-refundPayment}.
    function _refundPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 refundAmount,
        uint64 newExtraAmount
    ) internal {

    }

    function _transferTokensForPaymentMaking(MakingOperation memory operation) internal {
        uint256 sumAmount = operation.baseAmount + operation.extraAmount;
        (uint256 payerSumAmount, uint256 sponsorSumAmount) = _defineSumAmountParts(sumAmount, operation.subsidyLimit);
        IERC20Upgradeable erc20Token = IERC20Upgradeable(_token);
        operation.payerSumAmount = payerSumAmount;
        operation.sponsorSumAmount = sponsorSumAmount;

        erc20Token.safeTransferFrom(operation.payer, address(this), payerSumAmount);
        if (operation.sponsor != address(0)) {
            erc20Token.safeTransferFrom(operation.sponsor, address(this), sponsorSumAmount);
        } else {
            operation.subsidyLimit = 0;
        }
    }

    function _transferTokensForPaymentUpdating(UpdatingOperation memory operation) internal {
    }

    /// @dev Sends cashback related to a payment.
    function _sendCashback(MakingOperation memory operation) internal {
        if (operation.cashbackRate == 0) {
            return;
        }
        address distributor = _cashbackDistributor;
        if (_cashbackEnabled && distributor != address(0)) {
            uint256 basePaymentAmount = _definePayerBaseAmount(operation.baseAmount, operation.subsidyLimit);
            uint256 cashbackAmount = _calculateCashback(basePaymentAmount, operation.cashbackRate);
            (bool success, uint256 sentAmount, uint256 cashbackNonce) = ICashbackDistributor(distributor).sendCashback(
                _token,
                ICashbackDistributorTypes.CashbackKind.CardPayment,
                operation.authorizationId,
                operation.payer,
                cashbackAmount
            );
            _cashbacks[operation.authorizationId].lastCashbackNonce = cashbackNonce;
            if (success) {
                emit SendCashbackSuccess(distributor, sentAmount, cashbackNonce);
                operation.cashbackAmount = uint64(sentAmount);
            } else {
                emit SendCashbackFailure(distributor, cashbackAmount, cashbackNonce);
                operation.cashbackRate = 0;
            }
        }
    }

    function _storeNewPayment(
        Payment storage storedPayment,
        MakingOperation memory operation
    ) internal {
        PaymentStatus oldStatus = storedPayment.status;
        storedPayment.status = PaymentStatus.Active;
        storedPayment.payer = operation.payer;
        storedPayment.cashbackRate = operation.cashbackRate;
        storedPayment.confirmedAmount = 0;
        if (oldStatus != PaymentStatus.Nonexistent || operation.sponsor != address(0)) {
            storedPayment.sponsor = operation.sponsor;
            storedPayment.subsidyLimit = operation.subsidyLimit;
        }
        storedPayment.baseAmount = operation.baseAmount;
        storedPayment.extraAmount = operation.extraAmount;
        storedPayment.cashbackAmount = operation.cashbackAmount;
        storedPayment.refundAmount = 0;
    }

    function _storeUpdatedPayment(
        Payment storage storedPayment,
        UpdatingOperation memory operation
    ) internal {
    }



    /// @dev Calculates cashback according to the amount and the rate.
    function _calculateCashback(uint256 amount, uint256 cashbackRate_) internal pure returns (uint256) {
        uint256 cashback = amount * cashbackRate_ / CASHBACK_FACTOR;
        return ((cashback + CASHBACK_ROUNDING_COEF / 2) / CASHBACK_ROUNDING_COEF) * CASHBACK_ROUNDING_COEF;
    }

    function _defineUpdatingOperation(
        uint64 newBaseAmount,
        uint64 newExtraAmount,
        Payment memory payment
    ) internal returns (UpdatingOperation memory) {
        UpdatingOperation memory operation;
        return operation;
    }

    /// @dev Defines the payer part of a payment base amount according to a subsidy limit.
    function _definePayerBaseAmount(uint256 paymentBaseAmount, uint256 subsidyLimit) internal pure returns (uint256) {
        if (subsidyLimit >= paymentBaseAmount) {
            return 0;
        } else {
            return paymentBaseAmount - subsidyLimit;
        }
    }

    /// @dev Defines the payer and sponsor parts of a payment sum amount according to a subsidy limit.
    function _defineSumAmountParts(
        uint256 paymentSumAmount,
        uint256 subsidyLimit
    ) internal pure returns (
        uint256 payerSumAmount,
        uint256 sponsorSumAmount
    ) {
        if (subsidyLimit >= paymentSumAmount) {
            sponsorSumAmount = paymentSumAmount;
            payerSumAmount = 0;
        } else {
            sponsorSumAmount = subsidyLimit;
            payerSumAmount = paymentSumAmount - subsidyLimit;
        }
    }

    /// @dev Checks if the cash-out account exists and returns if it does. Otherwise reverts the execution.
    function _requireCashOutAccount() internal view returns (address account) {
        account = _cashOutAccount;
        if (account == address(0)) {
            revert CashOutAccountNotConfigured();
        }
    }

    /// @dev Resets the payment structure fields related to the subsidy part of a payment.
    function _resetSubsidizedPaymentFields(Payment storage payment) internal {
        if (payment.sponsor != address(0) || payment.subsidyLimit != 0) {
            payment.sponsor = address(0);
            payment.subsidyLimit = 0;
        }
    }
}
