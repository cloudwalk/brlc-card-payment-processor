// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { BlacklistableUpgradeable } from "./base/BlacklistableUpgradeable.sol";
import { PausableExtUpgradeable } from "./base/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "./base/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder200.sol";
import { AccessControlExtUpgradeable } from "./base/AccessControlExtUpgradeable.sol";

import { CardPaymentProcessorV2Storage } from "./CardPaymentProcessorV2Storage.sol";
import { ICardPaymentProcessorV2 } from "./interfaces/ICardPaymentProcessorV2.sol";
import { ICardPaymentCashbackV2 } from "./interfaces/ICardPaymentCashbackV2.sol";
import { ICashbackDistributor, ICashbackDistributorTypes } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CardPaymentProcessorV2 contract
 * @dev A wrapper contract for the card payment operations.
 */
contract CardPaymentProcessorV2 is
    AccessControlExtUpgradeable,
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

    /**
     * @dev The factor to represent the cashback rates in the contract, e.g. number 15 means 1.5% cashback rate.
     *
     * The formula to calculate cashback by an amount: cashbackAmount = cashbackRate * amount / CASHBACK_FACTOR
     */
    uint16 public constant CASHBACK_FACTOR = 1000;

    /// @dev The maximum allowable cashback rate in units of `CASHBACK_FACTOR`.
    uint16 public constant MAX_CASHBACK_RATE = 250;

    /**
     * @dev The coefficient used to round the cashback according to the formula:
     *      `roundedCashback = ((cashback + coef / 2) / coef) * coef`.
     *
     * Currently, it can only be changed by deploying a new implementation of the contract.
     */
    uint16 public constant CASHBACK_ROUNDING_COEF = 10000;

    /// @dev Event data flag mask defining whether the payment is sponsored.
    uint256 internal constant EVENT_FLAG_MASK_SPONSORED = 1;

    /// @dev Default version of the event data.
    uint8 internal constant EVENT_DEFAULT_VERSION = 1;

    /**
     * @dev The kind of a cashback merging failure during a payment merging.
     *
     * The following values are possible:
     *
     * - NotEnoughBalance = 0 -- not enough balance of this contract to make a cashback merge.
     * - RevocationError = 1 --- an error occurred during revocation of merged payment cashback.
     * - IncreaseError = 2 ----- an error occurred during increasing the target payment cashback.
     */
    enum CashbackMergingFailureKind {
        NotEnoughBalance,
        RevocationError,
        IncreaseError
    }

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

    /**
     * @dev There is a cashback merging failure during a payment merging.
     * @param mergedPaymentId The ID of the merged payment.
     * @param kind The kind of failure:
     */
    error CashbackMergingFailure(bytes32 mergedPaymentId, CashbackMergingFailureKind kind);

    /// @dev The provided cashback rate exceeds the allowed maximum.
    error CashbackRateExcess();

    /// @dev A new cashback rate is the same as previously set one.
    error CashbackRateUnchanged();

    /// @dev The cash-out account is not configured.
    error CashOutAccountNotConfigured();

    /// @dev A new cash-out account is the same as the previously set one.
    error CashOutAccountUnchanged();

    /// @dev The requested confirmation amount does not meet the requirements.
    error InappropriateConfirmationAmount();

    /**
     * @dev The payment with the provided ID has an inappropriate status.
     * @param paymentId The ID of the payment that does not exist.
     * @param currentStatus The current status of the payment.
     */
    error InappropriatePaymentStatus(bytes32 paymentId, PaymentStatus currentStatus);

    /// @dev The requested refunding amount does not meet the requirements.
    error InappropriateRefundingAmount();

    /// @dev The requested or result or updated sum amount (base + extra) does not meet the requirements.
    error InappropriateSumAmount();

    /**
     * @dev The cashback rate of a merged payment is greater the rate of the target payment.
     * @param mergedPaymentId The ID of the merged payment with a mismatched payer.
     * @param mergedPaymentCashbackRate The cashback rate of the merged payment.
     * @param targetPaymentCashbackRate The cashback rate of the target payment.
     */
    error MergedPaymentCashbackRateMismatch(
        bytes32 mergedPaymentId,
        uint16 mergedPaymentCashbackRate,
        uint16 targetPaymentCashbackRate
    );

    /// @dev The merged payment ID equals the target payment ID.
    error MergedPaymentIdAndTargetPaymentIdEquality();

    /// @dev The array of merged payment Ids is empty.
    error MergedPaymentIdArrayEmpty();

    /**
     * @dev The payer of a merged payment does not match the payer of the target payment.
     * @param mergedPaymentId The ID of the merged payment with a mismatched payer.
     * @param mergedPaymentPayer The payer address of the merged payment.
     * @param targetPaymentPayer The payer address of the target payment.
     */
    error MergedPaymentPayerMismatch(
        bytes32 mergedPaymentId,
        address mergedPaymentPayer,
        address targetPaymentPayer
    );

    /// @dev The requested or result or updated sum amount (base + extra) is greater than the allowed maximum to store.
    error OverflowOfSumAmount();

    /// @dev The zero payer address has been passed as a function argument.
    error PayerZeroAddress();

    /// @dev The payment with the provided ID already exists and is not revoked.
    error PaymentAlreadyExistent();

    /// @dev The array of payment confirmations is empty.
    error PaymentConfirmationArrayEmpty();

    /**
     * @dev The payment with the provided ID does not exist.
     * @param paymentId The ID of the payment that does not exist.
     */
    error PaymentNonExistent(bytes32 paymentId);

    /**
     * @dev The payment is subsidized, but this is prohibited by the terms of the function.
     * @param paymentId The ID of the payment that is subsidized.
     */
    error PaymentSubsidized(bytes32 paymentId);

    /// @dev Zero payment ID has been passed as a function argument.
    error PaymentZeroId();

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
    // DEV Maybe it is worth to make all the numeric fields uint256 for lower gas consumption. It should be checked after testing.
    struct MakingOperation {
        bytes32 paymentId;
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
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The payment account address must not be zero.
     * - The payment ID must not be zero.
     * - The payment linked with the provided ID must be revoked or not exist.
     * - The requested cashback rate must not exceed the maximum allowable cashback rate defined in the contract.
     * - The provided confirmation amount must not exceed the sum amount of the payment.
     */
    function makePaymentFor(
        bytes32 paymentId,
        address payer,
        uint64 baseAmount,
        uint64 extraAmount,
        address sponsor,
        uint64 subsidyLimit,
        int16 cashbackRate_,
        uint64 confirmationAmount
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
            paymentId: paymentId,
            payer: payer,
            sponsor: sponsor,
            cashbackRate: cashbackRateActual,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            subsidyLimit: subsidyLimit,
            cashbackAmount: 0,
            payerSumAmount: 0,
            sponsorSumAmount: 0
        });

        _makePayment(operation);
        if (confirmationAmount > 0) {
            uint256 transferAmount = _confirmPayment(paymentId, confirmationAmount);
            IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), transferAmount);
        }
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
     * - The payment linked with the provided ID must be revoked or not exist.
     */
    function makeCommonPaymentFor(
        bytes32 paymentId,
        address payer,
        uint64 baseAmount,
        uint64 extraAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (payer == address(0)) {
            revert PayerZeroAddress();
        }

        MakingOperation memory operation = MakingOperation({
            paymentId: paymentId,
            payer: payer,
            sponsor: address(0),
            cashbackRate: _cashbackRate,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            subsidyLimit: 0,
            cashbackAmount: 0,
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
     * - The the new base amount plus the new extra amount must not be less than the the existing refund amount.
     */
    function updatePayment(
        bytes32 paymentId,
        uint64 newBaseAmount,
        uint64 newExtraAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePayment(
            paymentId,
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
     */
    function reversePayment(
        bytes32 paymentId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _cancelPayment(
            paymentId,
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
     */
    function revokePayment(
        bytes32 paymentId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _cancelPayment(
            paymentId,
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
        bytes32 paymentId,
        uint64 confirmationAmount
    ) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 transferAmount = _confirmPayment(paymentId, confirmationAmount);
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
                paymentConfirmations[i].paymentId,
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
     * - The the new base amount plus the new extra amount must not be less than the the existing refund amount.
     */
    function updateLazyAndConfirmPayment(
        bytes32 paymentId,
        uint64 newBaseAmount,
        uint64 newExtraAmount,
        uint64 confirmationAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePayment(
            paymentId,
            newBaseAmount,
            newExtraAmount,
            UpdatingOperationKind.Lazy
        );
        uint256 transferAmount = _confirmPayment(paymentId, confirmationAmount);
        if (transferAmount > 0) {
            IERC20Upgradeable(_token).safeTransfer(_requireCashOutAccount(), transferAmount);
        }
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     * - The result refund amount of the payment must not be higher than the new extra amount plus the base amount.
     */
    function refundPayment(
        bytes32 paymentId,
        uint64 refundingAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _refundPayment(paymentId, refundingAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessorV2
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The target payment ID and the merged payment ones must not be zero.
     * - The target payment ID and the merged payment ones must not be equal.
     * - The target payment and the merged ones must be active.
     * - The target payment and the merged ones must have the same payer address.
     * - The target payment and the merged ones must not be subsidized.
     * - The cashback rate of the target payment must not be less than the cashback rate of merged payments.
     * - The contract must have enough token balance to make a cashback merge during the payment merging.
     * - The cashback revocation of the merged payments must succeed.
     * - The cashback increase of the target payment must succeed.
     */
    function mergePayments(
        bytes32 targetPaymentId,
        bytes32[] calldata sourcePaymentIds
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _mergePayments(targetPaymentId, sourcePaymentIds);
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
        address account,
        uint64 refundingAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert AccountZeroAddress();
        }

        emit AccountRefunded(
            account,
            refundingAmount,
            bytes("")
        );

        IERC20Upgradeable(_token).safeTransferFrom(_requireCashOutAccount(), account, refundingAmount);
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
    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return _payments[paymentId];
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
    function getCashback(bytes32 paymentId) external view returns (Cashback memory) {
        return _cashbacks[paymentId];
    }

    /// @dev Making a payment internally
    function _makePayment(MakingOperation memory operation) internal {
        if (operation.paymentId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[operation.paymentId];

        PaymentStatus status = storedPayment.status;
        if (status != PaymentStatus.Nonexistent && status != PaymentStatus.Revoked) {
            revert PaymentAlreadyExistent();
        }

        _processPaymentMaking(operation);
        _sendCashback(operation);
        _storeNewPayment(storedPayment, operation);

        address sponsor = operation.sponsor;
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory eventData = abi.encodePacked(
            EVENT_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(operation.baseAmount),
            uint64(operation.extraAmount),
            uint64(operation.payerSumAmount)
        );
        if (eventFlags & EVENT_FLAG_MASK_SPONSORED != 0) {
            eventData = abi.encodePacked(
                eventData,
                sponsor,
                uint64(operation.sponsorSumAmount)
            );
        }
        emit PaymentMade(
            operation.paymentId,
            operation.payer,
            eventData
        );
    }

    /// @dev Kind of a payment updating operation
    enum UpdatingOperationKind {
        Full, // 0 The operation is executed fully regardless of the new values of the base amount and extra amount.
        Lazy  // 1 The operation is executed only if the new amounts differ from the current ones of the payment.
    }

    /// @dev Updates the base amount and extra amount of a payment internally
    function _updatePayment(
        bytes32 paymentId,
        uint64 newBaseAmount,
        uint64 newExtraAmount,
        UpdatingOperationKind kind
    ) internal {
        if (paymentId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[paymentId];
        Payment memory payment = storedPayment;

        if (kind != UpdatingOperationKind.Full) {
            if (payment.baseAmount == newBaseAmount && payment.extraAmount == newExtraAmount) {
                return;
            }
        }

        _checkActivePaymentStatus(paymentId, payment.status);

        if (payment.refundAmount > uint256(newBaseAmount) + uint256(newExtraAmount)) {
            revert InappropriateSumAmount();
        }

        PaymentDetails memory oldPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.None);
        uint64 oldBaseAmount = payment.baseAmount;
        uint64 oldExtraAmount = payment.extraAmount;
        payment.baseAmount = newBaseAmount;
        payment.extraAmount = newExtraAmount;
        PaymentDetails memory newPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.Full);

        _processPaymentChange(paymentId, payment, oldPaymentDetails, newPaymentDetails);
        _storeChangedPayment(storedPayment, payment, newPaymentDetails);

        address sponsor = payment.sponsor;
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory eventData = abi.encodePacked(
            EVENT_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(oldBaseAmount),
            uint64(newBaseAmount),
            uint64(oldExtraAmount),
            uint64(newExtraAmount),
            uint64(oldPaymentDetails.payerSumAmount),
            uint64(newPaymentDetails.payerSumAmount)
        );
        if (eventFlags & EVENT_FLAG_MASK_SPONSORED != 0) {
            eventData = abi.encodePacked(
                eventData,
                sponsor,
                uint64(oldPaymentDetails.sponsorSumAmount),
                uint64(newPaymentDetails.sponsorSumAmount)
            );
        }
        emit PaymentUpdated(
            paymentId,
            payment.payer,
            eventData
        );
    }

    /// @dev Cancels a payment internally
    function _cancelPayment(
        bytes32 paymentId,
        PaymentStatus targetStatus
    ) internal {
        if (paymentId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[paymentId];
        Payment memory payment = storedPayment;

        _checkActivePaymentStatus(paymentId, payment.status);

        PaymentDetails memory oldPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.None);
        PaymentDetails memory newPaymentDetails; //all fields are zero

        _processPaymentChange(paymentId, payment, oldPaymentDetails, newPaymentDetails);

        storedPayment.status = targetStatus;

        address sponsor = payment.sponsor;
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory eventData = abi.encodePacked(
            EVENT_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(oldPaymentDetails.payerRemainder)
        );
        if (eventFlags & EVENT_FLAG_MASK_SPONSORED != 0) {
            eventData = abi.encodePacked(
                eventData,
                sponsor,
                uint64(oldPaymentDetails.sponsorRemainder)
            );
        }

        if (targetStatus == PaymentStatus.Revoked) {
            emit PaymentRevoked(
                paymentId,
                payment.payer,
                eventData
            );
        } else {
            emit PaymentReversed(
                paymentId,
                payment.payer,
                eventData
            );
        }
    }

    /// @dev Confirms a payment internally
    function _confirmPayment(
        bytes32 paymentId,
        uint64 confirmationAmount
    ) internal returns (uint256) {
        if (paymentId == 0) {
            revert PaymentZeroId();
        }
        Payment storage payment = _payments[paymentId];
        _checkActivePaymentStatus(paymentId, payment.status);

        if (confirmationAmount == 0) {
            return confirmationAmount;
        }

        uint256 remainder = uint256(payment.baseAmount) + uint256(payment.extraAmount) - uint256(payment.refundAmount);
        uint256 oldConfirmedAmount = payment.confirmedAmount;
        uint256 newConfirmedAmount = oldConfirmedAmount + confirmationAmount;
        if (newConfirmedAmount > remainder) {
            revert InappropriateConfirmationAmount();
        }

        payment.confirmedAmount = uint64(newConfirmedAmount);
        _emitPaymentConfirmedAmountChanged(
            paymentId,
            payment.payer,
            payment.sponsor,
            oldConfirmedAmount,
            newConfirmedAmount
        );

        return confirmationAmount;
    }

    /// @dev Makes a refund for a payment internally
    function _refundPayment(
        bytes32 paymentId,
        uint64 refundingAmount
    ) internal {
        if (paymentId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[paymentId];
        Payment memory payment = storedPayment;
        _checkActivePaymentStatus(paymentId, payment.status);

        uint256 newRefundAmount = uint256(payment.refundAmount) + uint256(refundingAmount);
        if (newRefundAmount > uint256(payment.baseAmount) + uint256(payment.extraAmount)) {
            revert InappropriateRefundingAmount();
        }

        PaymentDetails memory oldPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.None);
        payment.refundAmount = uint64(newRefundAmount);
        PaymentDetails memory newPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.Full);

        _processPaymentChange(paymentId, payment, oldPaymentDetails, newPaymentDetails);
        _storeChangedPayment(storedPayment, payment, newPaymentDetails);

        address sponsor = payment.sponsor;
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory eventData = abi.encodePacked(
            EVENT_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(oldPaymentDetails.payerSumAmount - oldPaymentDetails.payerRemainder), // oldPayerRefundAmount
            uint64(newPaymentDetails.payerSumAmount - newPaymentDetails.payerRemainder)  // newPayerRefundAmount
        );
        if (eventFlags & EVENT_FLAG_MASK_SPONSORED != 0) {
            eventData = abi.encodePacked(
                eventData,
                sponsor,
                uint64(oldPaymentDetails.sponsorSumAmount - oldPaymentDetails.sponsorRemainder), //oldSponsorRefundAmount
                uint64(newPaymentDetails.sponsorSumAmount - newPaymentDetails.sponsorRemainder)  //newSponsorRefundAmount
            );
        }

        emit PaymentRefunded(
            paymentId,
            payment.payer,
            eventData
        );
    }

    /// @dev Defines the payment merge operation details
    // DEV Maybe old values are redundant and it is less gas consuming to use stored values instead.
    // DEV Maybe fields of type uint64 are less gas consuming. The same for other structs.
    struct MergeOperation {
        uint256 oldBaseAmount;
        uint256 newBaseAmount;
        uint256 oldExtraAmount;
        uint256 newExtraAmount;
        uint256 oldCashbackAmount;
        uint256 newCashbackAmount;
        uint256 oldRefundAmount;
        uint256 newRefundAmount;
        uint256 oldConfirmedAmount;
        uint256 newConfirmedAmount;
    }

    /// @dev Merge payments internally
    function _mergePayments(
        bytes32 targetPaymentId,
        bytes32[] calldata mergedPaymentIds
    ) internal {
        if (targetPaymentId == 0) {
            revert PaymentZeroId();
        }
        if (mergedPaymentIds.length == 0) {
            revert MergedPaymentIdArrayEmpty();
        }

        Payment storage storedTargetPayment = _payments[targetPaymentId];
        _checkActivePaymentStatus(targetPaymentId, storedTargetPayment.status);
        if (storedTargetPayment.sponsor != address(0)) {
            revert PaymentSubsidized(targetPaymentId);
        }

        // DEV Check if the compiler optimizes the double reading of the stored payment structure
        MergeOperation memory operation = MergeOperation({
            oldBaseAmount: storedTargetPayment.baseAmount,
            newBaseAmount: storedTargetPayment.baseAmount,
            oldExtraAmount: storedTargetPayment.extraAmount,
            newExtraAmount: storedTargetPayment.extraAmount,
            oldCashbackAmount: storedTargetPayment.cashbackAmount,
            newCashbackAmount: storedTargetPayment.cashbackAmount,
            oldRefundAmount: storedTargetPayment.refundAmount,
            newRefundAmount: storedTargetPayment.refundAmount,
            oldConfirmedAmount: storedTargetPayment.confirmedAmount,
            newConfirmedAmount: storedTargetPayment.confirmedAmount
        });

        address payer = storedTargetPayment.payer;
        for (uint256 i = 0; i < mergedPaymentIds.length; i++) {
            bytes32 mergedPaymentId = mergedPaymentIds[i];
            if (mergedPaymentId == 0) {
                revert PaymentZeroId();
            }
            if (mergedPaymentId == targetPaymentId) {
                revert MergedPaymentIdAndTargetPaymentIdEquality();
            }

            Payment storage mergedPayment = _payments[mergedPaymentId];
            _checkActivePaymentStatus(mergedPaymentId, mergedPayment.status);

            address mergedPaymentPayer = mergedPayment.payer;
            if (mergedPaymentPayer != payer) {
                revert MergedPaymentPayerMismatch(mergedPaymentId, mergedPaymentPayer, payer);
            }
            if (mergedPayment.sponsor != address(0)) {
                revert PaymentSubsidized(mergedPaymentId);
            }
            if (mergedPayment.cashbackRate > storedTargetPayment.cashbackRate) {
                revert MergedPaymentCashbackRateMismatch(
                    mergedPaymentId,
                    mergedPayment.cashbackRate,
                    storedTargetPayment.cashbackRate
                );
            }
            uint256 newBaseAmount;
            uint256 newExtraAmount;
            uint256 sumAmount;
            unchecked {
                newBaseAmount = operation.newBaseAmount + mergedPayment.baseAmount;
                newExtraAmount = operation.newExtraAmount + mergedPayment.extraAmount;
                sumAmount = newBaseAmount + newExtraAmount;
            }
            if (sumAmount > type(uint64).max) {
                revert OverflowOfSumAmount();
            }
            uint256 cashbackAmount = mergedPayment.cashbackAmount;
            if (cashbackAmount > 0) {
                _mergeCashback(targetPaymentId, mergedPaymentId, cashbackAmount, payer);
            }
            operation.newBaseAmount = newBaseAmount;
            operation.newExtraAmount = newExtraAmount;
            unchecked {
                operation.newRefundAmount += mergedPayment.refundAmount;
                operation.newCashbackAmount += cashbackAmount;
                operation.newConfirmedAmount += mergedPayment.confirmedAmount;
            }
            mergedPayment.status = PaymentStatus.Merged;

            emit PaymentMerged(
                mergedPaymentId,
                payer,
                targetPaymentId,
                abi.encodePacked(
                    EVENT_DEFAULT_VERSION,
                    uint8(0),
                    uint64(mergedPayment.baseAmount + mergedPayment.extraAmount - mergedPayment.refundAmount)
                )
            );
        }

        emit PaymentExpanded(
            targetPaymentId,
            payer,
            mergedPaymentIds,
            abi.encodePacked(
                EVENT_DEFAULT_VERSION,
                uint8(0),
                uint64(operation.oldBaseAmount),
                uint64(operation.newBaseAmount),
                uint64(operation.oldExtraAmount),
                uint64(operation.newExtraAmount),
                uint64(operation.oldCashbackAmount),
                uint64(operation.newCashbackAmount),
                uint64(operation.oldRefundAmount),
                uint64(operation.newRefundAmount)
            )
        );

        storedTargetPayment.baseAmount = uint64(operation.newBaseAmount);
        storedTargetPayment.extraAmount = uint64(operation.newExtraAmount);
        storedTargetPayment.cashbackAmount = uint64(operation.newCashbackAmount);
        storedTargetPayment.refundAmount = uint64(operation.newRefundAmount);

        if (operation.newConfirmedAmount != operation.oldConfirmedAmount) {
            storedTargetPayment.confirmedAmount = uint64(operation.newConfirmedAmount);
            _emitPaymentConfirmedAmountChanged(
                targetPaymentId,
                payer,
                address(0), //sponsor
                operation.oldConfirmedAmount,
                operation.newConfirmedAmount
            );
        }
    }

    /// @dev Executes token transfers related to a new payment.
    function _processPaymentMaking(MakingOperation memory operation) internal {
        uint256 sumAmount;
        unchecked {
            sumAmount = uint256(operation.baseAmount) + uint256(operation.extraAmount);
        }
        if (sumAmount > type(uint64).max) {
            revert OverflowOfSumAmount();
        }
        if (operation.sponsor == address(0)) {
            operation.subsidyLimit = 0;
        }
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

    /// @dev Checks if the status of a payment is active. Otherwise reverts with an appropriate error.
    function _checkActivePaymentStatus(bytes32 paymentId, PaymentStatus status) internal pure {
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNonExistent(paymentId);
        }
        if (status != PaymentStatus.Active) {
            revert InappropriatePaymentStatus(paymentId, status);
        }
    }

    /// @dev Executes token transfers related to changes of a payment and emits additional events.
    function _processPaymentChange(
        bytes32 paymentId,
        Payment memory payment,
        PaymentDetails memory oldPaymentDetails,
        PaymentDetails memory newPaymentDetails
    ) internal {
        IERC20Upgradeable erc20Token = IERC20Upgradeable(_token);

        // Cash-out account token transferring
        if (newPaymentDetails.confirmedAmount < oldPaymentDetails.confirmedAmount) {
            uint256 amount = oldPaymentDetails.confirmedAmount - newPaymentDetails.confirmedAmount;
            erc20Token.safeTransferFrom(_requireCashOutAccount(), address(this), amount);
            _emitPaymentConfirmedAmountChanged(
                paymentId,
                payment.payer,
                payment.sponsor,
                oldPaymentDetails.confirmedAmount,
                newPaymentDetails.confirmedAmount
            );
        }

        // Increase cashback ahead of payer token transfers to avoid conner cases with lack of payer balance
        if (newPaymentDetails.cashbackAmount > oldPaymentDetails.cashbackAmount) {
            uint256 amount = newPaymentDetails.cashbackAmount - oldPaymentDetails.cashbackAmount;
            amount = _increaseCashback(paymentId, amount);
            newPaymentDetails.cashbackAmount = oldPaymentDetails.cashbackAmount + amount;
        }

        //Payer token transferring
        {
            int256 amount = -(int256(newPaymentDetails.payerRemainder) - int256(oldPaymentDetails.payerRemainder));
            int256 cashbackChange = int256(newPaymentDetails.cashbackAmount) - int256(oldPaymentDetails.cashbackAmount);
            if (cashbackChange < 0) {
                amount += cashbackChange;
            }
            if (amount < 0) {
                erc20Token.safeTransferFrom(payment.payer, address(this), uint256(-amount));
            } else if (amount > 0) {
                erc20Token.safeTransfer(payment.payer, uint256(amount));
            }
        }

        // Cashback processing if the cashback amount decreases
        if (newPaymentDetails.cashbackAmount < oldPaymentDetails.cashbackAmount) {
            uint256 amount = oldPaymentDetails.cashbackAmount - newPaymentDetails.cashbackAmount;
            amount = _revokeCashback(paymentId, amount);
            newPaymentDetails.cashbackAmount = oldPaymentDetails.cashbackAmount - amount;
        }

        //Sponsor token transferring
        address sponsor = payment.sponsor;
        if (payment.sponsor != address(0)) {
            if (newPaymentDetails.sponsorRemainder > oldPaymentDetails.sponsorRemainder) {
                uint256 amount = newPaymentDetails.sponsorRemainder - oldPaymentDetails.sponsorRemainder;
                erc20Token.safeTransferFrom(sponsor, address(this), amount);
            } else if (newPaymentDetails.sponsorRemainder < oldPaymentDetails.sponsorRemainder) {
                uint256 amount = oldPaymentDetails.sponsorRemainder - newPaymentDetails.sponsorRemainder;
                erc20Token.safeTransfer(sponsor, amount);
            }
        }
    }

    function _emitPaymentConfirmedAmountChanged(
        bytes32 paymentId,
        address payer,
        address sponsor,
        uint256 oldConfirmedAmount,
        uint256 newConfirmedAmount
    ) internal {
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory eventData = abi.encodePacked(
            EVENT_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(oldConfirmedAmount),
            uint64(newConfirmedAmount)
        );
        if (eventFlags & EVENT_FLAG_MASK_SPONSORED != 0) {
            eventData = abi.encodePacked(
                eventData,
                sponsor
            );
        }

        emit PaymentConfirmedAmountChanged(
            paymentId,
            payer,
            eventData
        );
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
                operation.paymentId,
                operation.payer,
                cashbackAmount
            );
            _cashbacks[operation.paymentId].lastCashbackNonce = cashbackNonce;
            if (success) {
                emit SendCashbackSuccess(distributor, sentAmount, cashbackNonce);
                operation.cashbackAmount = uint64(sentAmount);
            } else {
                emit SendCashbackFailure(distributor, cashbackAmount, cashbackNonce);
                operation.cashbackRate = 0;
            }
        } else {
            operation.cashbackRate = 0;
        }
    }

    /// @dev Revokes partially or fully cashback related to a payment.
    function _revokeCashback(bytes32 paymentId, uint256 amount) internal returns (uint256) {
        address distributor = _cashbackDistributor;
        uint256 cashbackNonce = _cashbacks[paymentId].lastCashbackNonce;
        uint256 revokedAmount = 0;
        // Condition (cashbackNonce != 0 && distributor != address(0)) is guaranteed by the current contract logic.
        // So it is not checked here.
        if (ICashbackDistributor(distributor).revokeCashback(cashbackNonce, amount)) {
            emit RevokeCashbackSuccess(distributor, amount, cashbackNonce);
            revokedAmount = amount;
        } else {
            emit RevokeCashbackFailure(distributor, amount, cashbackNonce);
        }
        return revokedAmount;
    }

    /// @dev Increases cashback related to a payment.
    function _increaseCashback(
        bytes32 paymentId,
        uint256 amount
    ) internal returns (uint256) {
        address distributor = _cashbackDistributor;
        uint256 cashbackNonce = _cashbacks[paymentId].lastCashbackNonce;
        // Condition (cashbackNonce != 0 && distributor != address(0)) is guaranteed by the current contract logic.
        // So it is not checked here.
        (bool success, uint256 increaseAmount) = ICashbackDistributor(distributor).increaseCashback(
            cashbackNonce,
            amount
        );
        if (success) {
            emit IncreaseCashbackSuccess(distributor, increaseAmount, cashbackNonce);
        } else {
            emit IncreaseCashbackFailure(distributor, amount, cashbackNonce);
        }
        return increaseAmount;
    }

    function _mergeCashback(
        bytes32 targetPaymentId,
        bytes32 mergedPaymentId,
        uint256 cashbackAmount,
        address payer
    ) internal {
        uint256 balance = IERC20Upgradeable(_token).balanceOf(address(this));
        if (balance < cashbackAmount) {
            revert CashbackMergingFailure(mergedPaymentId, CashbackMergingFailureKind.NotEnoughBalance);
        }
        cashbackAmount = _revokeCashback(mergedPaymentId, cashbackAmount);
        if (cashbackAmount > 0) {
            uint256 increaseCashbackAmount = _increaseCashback(targetPaymentId, cashbackAmount);
            if (increaseCashbackAmount != cashbackAmount) {
                revert CashbackMergingFailure(mergedPaymentId, CashbackMergingFailureKind.IncreaseError);
            }
            IERC20Upgradeable(_token).safeTransferFrom(payer, address(this), cashbackAmount);
        } else {
            revert CashbackMergingFailure(mergedPaymentId, CashbackMergingFailureKind.RevocationError);
        }
    }

    /// @dev Stores the data of a newly created payment.
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

    /// @dev Stores the data of a changed payment.
    function _storeChangedPayment(
        Payment storage storedPayment,
        Payment memory changedPayment,
        PaymentDetails memory newPaymentDetails
    ) internal {
        storedPayment.baseAmount = changedPayment.baseAmount;
        storedPayment.extraAmount = changedPayment.extraAmount;
        storedPayment.cashbackAmount = uint64(newPaymentDetails.cashbackAmount);
        storedPayment.refundAmount = changedPayment.refundAmount;

        if (newPaymentDetails.confirmedAmount != changedPayment.confirmedAmount) {
            storedPayment.confirmedAmount = uint64(newPaymentDetails.confirmedAmount);
        }
    }

    /// @dev Calculates cashback according to the amount and the rate.
    function _calculateCashback(uint256 amount, uint256 cashbackRate_) internal pure returns (uint256) {
        uint256 cashback = (amount * cashbackRate_) / CASHBACK_FACTOR;
        return ((cashback + CASHBACK_ROUNDING_COEF / 2) / CASHBACK_ROUNDING_COEF) * CASHBACK_ROUNDING_COEF;
    }

    /// @dev Contains details of a payment.
    struct PaymentDetails {
        uint256 confirmedAmount;
        uint256 cashbackAmount;
        uint256 payerSumAmount;
        uint256 sponsorSumAmount;
        uint256 payerRemainder;
        uint256 sponsorRemainder;
    }

    /// @dev Kind of a payment recalculation operation.
    enum PaymentRecalculationKind {
        None,
        Full
    }

    /// @dev Defines details of a payment.
    function _definePaymentDetails(
        Payment memory payment,
        PaymentRecalculationKind kind
    ) internal pure returns (PaymentDetails memory) {
        uint256 sumAmount;
        unchecked {
            sumAmount = uint256(payment.baseAmount) + uint256(payment.extraAmount);
        }
        if (kind != PaymentRecalculationKind.None && sumAmount > type(uint64).max) {
            revert OverflowOfSumAmount();
        }
        uint256 payerBaseAmount = _definePayerBaseAmount(payment.baseAmount, payment.subsidyLimit);
        (uint256 payerSumAmount, uint256 sponsorSumAmount) = _defineSumAmountParts(sumAmount, payment.subsidyLimit);
        uint256 sponsorRefund = _defineSponsorRefund(payment.refundAmount, payment.baseAmount, payment.subsidyLimit);
        uint256 payerRefund = uint256(payment.refundAmount) - sponsorRefund;
        uint256 cashbackAmount = payment.cashbackAmount;
        uint256 confirmedAmount = payment.confirmedAmount;
        if (kind != PaymentRecalculationKind.None) {
            confirmedAmount = _defineNewConfirmedAmount(confirmedAmount, sumAmount - payment.refundAmount);
            cashbackAmount = _defineNewCashback(payerBaseAmount, payerRefund, payment.cashbackRate);
        }
        PaymentDetails memory details = PaymentDetails({
            confirmedAmount: confirmedAmount,
            cashbackAmount: cashbackAmount,
            payerSumAmount: payerSumAmount,
            sponsorSumAmount: sponsorSumAmount,
            payerRemainder: payerSumAmount - payerRefund,
            sponsorRemainder: sponsorSumAmount - sponsorRefund
        });
        return details;
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
    ) internal pure returns (uint256 payerSumAmount, uint256 sponsorSumAmount) {
        if (subsidyLimit >= paymentSumAmount) {
            sponsorSumAmount = paymentSumAmount;
            payerSumAmount = 0;
        } else {
            sponsorSumAmount = subsidyLimit;
            payerSumAmount = paymentSumAmount - subsidyLimit;
        }
    }

    /// @dev Defines the sponsor refund amount according to a subsidy limit.
    function _defineSponsorRefund(
        uint256 refundAmount,
        uint256 baseAmount,
        uint256 subsidyLimit
    ) internal pure returns (uint256) {
        if (subsidyLimit < baseAmount) {
            refundAmount = (refundAmount * subsidyLimit) / baseAmount;
        }
        if (refundAmount > subsidyLimit) {
            refundAmount = subsidyLimit;
        }
        return refundAmount;
    }

    /// @dev Defines the new confirmed amount of a payment according to the new old confirmed amount and the remainder.
    function _defineNewConfirmedAmount(
        uint256 oldConfirmedAmount,
        uint256 commonRemainder
    ) internal pure returns (uint256) {
        if (oldConfirmedAmount > commonRemainder) {
            return commonRemainder;
        } else {
            return oldConfirmedAmount;
        }
    }

    /// @dev Defines the new cashback amount of a payment according to the payer base amount and refund amount.
    function _defineNewCashback(
        uint256 payerBaseAmount,
        uint256 payerRefund,
        uint256 cashbackRate_
    ) internal pure returns (uint256) {
        if (cashbackRate_ == 0 || payerBaseAmount <= payerRefund) {
            return 0;
        }
        return _calculateCashback(payerBaseAmount - payerRefund, cashbackRate_);
    }

    /// @dev Checks if the cash-out account exists and returns if it does. Otherwise reverts the execution.
    function _requireCashOutAccount() internal view returns (address account) {
        account = _cashOutAccount;
        if (account == address(0)) {
            revert CashOutAccountNotConfigured();
        }
    }

    /// @dev Defines event flags according to the input parameters.
    function _defineEventFlags(address sponsor) internal pure returns (uint256) {
        uint256 eventFlags = 0;
        if (sponsor != address(0)) {
            eventFlags |= EVENT_FLAG_MASK_SPONSORED;
        }
        return eventFlags;
    }
}
