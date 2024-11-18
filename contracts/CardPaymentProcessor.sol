// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { UUPSExtUpgradeable } from "./base/UUPSExtUpgradeable.sol";

import { BlocklistableUpgradeable } from "./base/BlocklistableUpgradeable.sol";
import { PausableExtUpgradeable } from "./base/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "./base/RescuableUpgradeable.sol";
import { AccessControlExtUpgradeable } from "./base/AccessControlExtUpgradeable.sol";
import { Versionable } from "./base/Versionable.sol";

import { CardPaymentProcessorStorage } from "./CardPaymentProcessorStorage.sol";
import { ICardPaymentProcessor } from "./interfaces/ICardPaymentProcessor.sol";
import { ICardPaymentCashback } from "./interfaces/ICardPaymentCashback.sol";

/**
 * @title CardPaymentProcessor contract
 * @dev A wrapper contract for the card payment operations.
 */
contract CardPaymentProcessor is
    CardPaymentProcessorStorage,
    AccessControlExtUpgradeable,
    BlocklistableUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    UUPSExtUpgradeable,
    ICardPaymentProcessor,
    ICardPaymentCashback,
    Versionable
{
    using SafeERC20 for IERC20;

    // ------------------ Constants ------------------------------- //

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of executor that is allowed to execute the card payment operations.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev The number of decimals that is used in the underlying token contract.
    uint256 public constant TOKE_DECIMALS = 6;

    /**
     * @dev The factor to represent the cashback rates in the contract, e.g. number 15 means 1.5% cashback rate.
     *
     * The formula to calculate cashback by an amount: `cashbackAmount = cashbackRate * amount / CASHBACK_FACTOR`.
     */
    uint256 public constant CASHBACK_FACTOR = 1000;

    /// @dev The maximum allowable cashback rate in units of `CASHBACK_FACTOR`.
    uint256 public constant MAX_CASHBACK_RATE = 500;

    /**
     * @dev The coefficient used to round the cashback according to the formula:
     *      `roundedCashback = ((cashback + coef / 2) / coef) * coef`.
     *
     * Currently, it can only be changed by deploying a new implementation of the contract.
     */
    uint256 public constant CASHBACK_ROUNDING_COEF = 10 ** (TOKE_DECIMALS - 2);

    /// @dev The cashback cap reset period.
    uint256 public constant CASHBACK_CAP_RESET_PERIOD = 30 days;

    /// @dev The maximum cashback for a cap period.
    uint256 public constant MAX_CASHBACK_FOR_CAP_PERIOD = 300 * 10 ** TOKE_DECIMALS;

    /// @dev Event addendum flag mask defining whether the payment is sponsored.
    uint256 internal constant EVENT_ADDENDUM_FLAG_MASK_SPONSORED = 1;

    /// @dev Default version of the event addendum.
    uint8 internal constant EVENT_ADDENDUM_DEFAULT_VERSION = 1;

    // ------------------ Events ---------------------------------- //

    /// @dev Emitted when the cash-out account is changed.
    event CashOutAccountChanged(
        address oldCashOutAccount,
        address newCashOutAccount
    );

    // ------------------ Errors ---------------------------------- //

    /// @dev The zero payer address has been passed as a function argument.
    error AccountZeroAddress();

    /// @dev The cashback operations are already enabled.
    error CashbackAlreadyEnabled();

    /// @dev The cashback operations are already disabled.
    error CashbackAlreadyDisabled();

    /// @dev The cashback treasury address is the same as previously set one.
    error CashbackTreasuryUnchanged();

    /// @dev The cashback treasury address is not configured.
    error CashbackTreasuryNotConfigured();

    /// @dev The zero cashback treasury address has been passed as a function argument.
    error CashbackTreasuryZeroAddress();

    /// @dev The provided cashback rate exceeds the allowed maximum.
    error CashbackRateExcess();

    /// @dev A new cashback rate is the same as previously set one.
    error CashbackRateUnchanged();

    /// @dev The cash-out account is not configured.
    error CashOutAccountNotConfigured();

    /// @dev A new cash-out account is the same as the previously set one.
    error CashOutAccountUnchanged();

    /// @dev Thrown if the provided new implementation address is not of a card payment processor contract.
    error ImplementationAddressInvalid();

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

    /// @dev The requested subsidy limit is greater than the allowed maximum to store.
    error OverflowOfSubsidyLimit();

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

    /// @dev Zero payment ID has been passed as a function argument.
    error PaymentZeroId();

    /// @dev The sponsor address is zero while the subsidy limit is non-zero.
    error SponsorZeroAddress();

    /// @dev The zero token address has been passed as a function argument.
    error TokenZeroAddress();

    // ------------------ Initializers ---------------------------- //

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
        __AccessControlExt_init_unchained();
        __Blocklistable_init_unchained(OWNER_ROLE);
        __Pausable_init_unchained();
        __PausableExt_init_unchained(OWNER_ROLE);
        __Rescuable_init_unchained(OWNER_ROLE);
        __UUPSUpgradeable_init_unchained();

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

        _grantRole(OWNER_ROLE, _msgSender());
    }

    // ------------------ Functions ------------------------------- //

    /// @dev Contains parameters of a payment making operation.
    struct MakingOperation {
        bytes32 paymentId;
        address payer;
        address sponsor;
        uint256 cashbackRate;
        uint256 baseAmount;
        uint256 extraAmount;
        uint256 subsidyLimit;
        uint256 cashbackAmount;
        uint256 payerSumAmount;
        uint256 sponsorSumAmount;
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The payment account address must not be zero.
     * - The payment ID must not be zero.
     * - The payment linked with the provided ID must be revoked or not exist.
     * - The requested cashback rate must not exceed the maximum allowable cashback rate defined in the contract.
     * - The sum of the provided base and extra amounts must not exceed the max 64-bit unsigned integer.
     * - The provided subsidy limit must not exceed the max 64-bit unsigned integer.
     * - The provided confirmation amount must not exceed the sum amount of the payment.
     */
    function makePaymentFor(
        bytes32 paymentId,
        address payer,
        uint256 baseAmount,
        uint256 extraAmount,
        address sponsor,
        uint256 subsidyLimit,
        int256 cashbackRate_,
        uint256 confirmationAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (payer == address(0)) {
            revert PayerZeroAddress();
        }
        uint256 cashbackRateActual;
        if (cashbackRate_ < 0) {
            cashbackRateActual = _cashbackRate;
        } else {
            cashbackRateActual = uint256(cashbackRate_);
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
            _confirmPaymentWithTransfer(paymentId, confirmationAmount);
        }
    }

    /**
     * @inheritdoc ICardPaymentProcessor
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
        uint256 baseAmount,
        uint256 extraAmount
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
     * @inheritdoc ICardPaymentProcessor
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
        uint256 newBaseAmount,
        uint256 newExtraAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePayment(
            paymentId,
            newBaseAmount,
            newExtraAmount,
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
     * - The input payment ID must not be zero.
     */
    function reversePayment(bytes32 paymentId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _cancelPayment(paymentId, PaymentStatus.Reversed);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     */
    function revokePayment(bytes32 paymentId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _cancelPayment(paymentId, PaymentStatus.Revoked);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input payment ID must not be zero.
     */
    function confirmPayment(
        bytes32 paymentId,
        uint256 confirmationAmount
    ) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _confirmPaymentWithTransfer(paymentId, confirmationAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
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

        uint256 totalConfirmedAmount = 0;
        for (uint256 i = 0; i < paymentConfirmations.length; i++) {
            totalConfirmedAmount += _confirmPayment(
                paymentConfirmations[i].paymentId,
                paymentConfirmations[i].amount
            );
        }

        _paymentStatistics.totalUnconfirmedRemainder = uint128(
            uint256(_paymentStatistics.totalUnconfirmedRemainder) - totalConfirmedAmount
        );
        IERC20(_token).safeTransfer(_requireCashOutAccount(), totalConfirmedAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
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
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        uint256 confirmationAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _updatePayment(
            paymentId,
            newBaseAmount,
            newExtraAmount,
            UpdatingOperationKind.Lazy
        );
        _confirmPaymentWithTransfer(paymentId, confirmationAmount);
    }

    /**
     * @inheritdoc ICardPaymentProcessor
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
        uint256 refundingAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        _refundPayment(paymentId, refundingAmount);
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
        uint256 refundingAmount
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert AccountZeroAddress();
        }

        emit AccountRefunded(
            account,
            refundingAmount,
            bytes("")
        );

        IERC20(_token).safeTransferFrom(_requireCashOutAccount(), account, refundingAmount);
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

        emit CashOutAccountChanged(oldCashOutAccount, newCashOutAccount);
    }

    /**
     * @inheritdoc ICardPaymentCashback
     *
     * @dev Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new cashback treasury address must not be zero.
     * - The new cashback treasury address must not be equal to the current set one.
     */
    function setCashbackTreasury(address newCashbackTreasury) external onlyRole(OWNER_ROLE) {
        address oldCashbackTreasury = _cashbackTreasury;

        // This is needed to allow cashback changes for any existing active payments.
        if (newCashbackTreasury == address(0)) {
            revert CashbackTreasuryZeroAddress();
        }
        if (oldCashbackTreasury == newCashbackTreasury) {
            revert CashbackTreasuryUnchanged();
        }

        _cashbackTreasury = newCashbackTreasury;

        emit CashbackTreasuryChanged(oldCashbackTreasury, newCashbackTreasury);
    }

    /**
     * @inheritdoc ICardPaymentCashback
     *
     * @dev Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new rate must differ from the previously set one.
     * - The new rate must not exceed the allowable maximum specified in the {MAX_CASHBACK_RATE} constant.
     */
    function setCashbackRate(uint256 newCashbackRate) external onlyRole(OWNER_ROLE) {
        uint256 oldCashbackRate = _cashbackRate;
        if (newCashbackRate == oldCashbackRate) {
            revert CashbackRateUnchanged();
        }
        if (newCashbackRate > MAX_CASHBACK_RATE) {
            revert CashbackRateExcess();
        }

        _cashbackRate = uint16(newCashbackRate);

        emit CashbackRateChanged(oldCashbackRate, newCashbackRate);
    }

    /**
     * @inheritdoc ICardPaymentCashback
     *
     * @dev Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The cashback operations must not be already enabled.
     * - The address of the current cashback treasury must not be zero.
     */
    function enableCashback() external onlyRole(OWNER_ROLE) {
        if (_cashbackEnabled) {
            revert CashbackAlreadyEnabled();
        }
        if (_cashbackTreasury == address(0)) {
            revert CashbackTreasuryNotConfigured();
        }

        _cashbackEnabled = true;

        emit CashbackEnabled();
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

        emit CashbackDisabled();
    }

    // ------------------ View functions -------------------------- //

    /// @inheritdoc ICardPaymentProcessor
    function cashOutAccount() external view returns (address) {
        return _cashOutAccount;
    }

    /// @inheritdoc ICardPaymentProcessor
    function token() external view returns (address) {
        return _token;
    }

    /// @inheritdoc ICardPaymentProcessor
    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return _payments[paymentId];
    }

    /// @inheritdoc ICardPaymentProcessor
    function getPaymentStatistics() external view returns (PaymentStatistics memory) {
        return _paymentStatistics;
    }

    /// @inheritdoc ICardPaymentCashback
    function cashbackTreasury() external view returns (address) {
        return _cashbackTreasury;
    }

    /// @inheritdoc ICardPaymentCashback
    function cashbackEnabled() external view returns (bool) {
        return _cashbackEnabled;
    }

    /// @inheritdoc ICardPaymentCashback
    function cashbackRate() external view returns (uint256) {
        return _cashbackRate;
    }

    /// @inheritdoc ICardPaymentCashback
    function getAccountCashbackState(address account) external view returns (AccountCashbackState memory) {
        return _accountCashbackStates[account];
    }
    // ------------------ Pure functions -------------------------- //

     /// @inheritdoc ICardPaymentProcessor
    function proveCardPaymentProcessor() external pure {}

    // ------------------ Internal functions ---------------------- //

    /// @dev Making a payment internally.
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
        bytes memory addendum = abi.encodePacked(
            EVENT_ADDENDUM_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(operation.baseAmount),
            uint64(operation.extraAmount),
            uint64(operation.payerSumAmount)
        );
        if (eventFlags & EVENT_ADDENDUM_FLAG_MASK_SPONSORED != 0) {
            addendum = abi.encodePacked(
                addendum,
                sponsor,
                uint64(operation.sponsorSumAmount)
            );
        }
        emit PaymentMade(
            operation.paymentId,
            operation.payer,
            addendum
        );
    }

    /// @dev Kind of a payment updating operation.
    enum UpdatingOperationKind {
        Full, // 0 The operation is executed fully regardless of the new values of the base amount and extra amount.
        Lazy  // 1 The operation is executed only if the new amounts differ from the current ones of the payment.
    }

    /// @dev Updates the base amount and extra amount of a payment internally.
    function _updatePayment(
        bytes32 paymentId,
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        UpdatingOperationKind kind
    ) internal {
        if (paymentId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[paymentId];
        Payment memory payment = storedPayment;

        if (
            kind == UpdatingOperationKind.Lazy &&
            payment.baseAmount == newBaseAmount &&
            payment.extraAmount == newExtraAmount
        ) {
            return;
        }

        _checkActivePaymentStatus(paymentId, payment.status);
        _checkPaymentSumAmount(newBaseAmount + newExtraAmount, payment.refundAmount);

        PaymentDetails memory oldPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.None);
        uint256 oldBaseAmount = payment.baseAmount;
        uint256 oldExtraAmount = payment.extraAmount;
        payment.baseAmount = uint64(newBaseAmount);
        payment.extraAmount = uint64(newExtraAmount);
        PaymentDetails memory newPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.Full);

        _processPaymentChange(paymentId, payment, oldPaymentDetails, newPaymentDetails);
        _storeChangedPayment(storedPayment, payment, newPaymentDetails);
        _updatePaymentStatistics(oldPaymentDetails, newPaymentDetails);

        address sponsor = payment.sponsor;
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory addendum = abi.encodePacked(
            EVENT_ADDENDUM_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(oldBaseAmount),
            uint64(newBaseAmount),
            uint64(oldExtraAmount),
            uint64(newExtraAmount),
            uint64(oldPaymentDetails.payerSumAmount),
            uint64(newPaymentDetails.payerSumAmount)
        );
        if (eventFlags & EVENT_ADDENDUM_FLAG_MASK_SPONSORED != 0) {
            addendum = abi.encodePacked(
                addendum,
                sponsor,
                uint64(oldPaymentDetails.sponsorSumAmount),
                uint64(newPaymentDetails.sponsorSumAmount)
            );
        }
        emit PaymentUpdated(
            paymentId,
            payment.payer,
            addendum
        );
    }

    /// @dev Cancels a payment internally.
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
        PaymentDetails memory newPaymentDetails; // All fields are zero

        _processPaymentChange(paymentId, payment, oldPaymentDetails, newPaymentDetails);
        _updatePaymentStatistics(oldPaymentDetails, newPaymentDetails);

        storedPayment.status = targetStatus;

        address sponsor = payment.sponsor;
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory addendum = abi.encodePacked(
            EVENT_ADDENDUM_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(payment.baseAmount),
            uint64(payment.extraAmount),
            uint64(oldPaymentDetails.payerRemainder)
        );
        if (eventFlags & EVENT_ADDENDUM_FLAG_MASK_SPONSORED != 0) {
            addendum = abi.encodePacked(
                addendum,
                sponsor,
                uint64(oldPaymentDetails.sponsorRemainder)
            );
        }

        if (targetStatus == PaymentStatus.Revoked) {
            emit PaymentRevoked(
                paymentId,
                payment.payer,
                addendum
            );
        } else {
            emit PaymentReversed(
                paymentId,
                payment.payer,
                addendum
            );
        }
    }

    /// @dev Confirms a payment internally.
    function _confirmPayment(
        bytes32 paymentId,
        uint256 confirmationAmount
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

    /// @dev Confirms a payment internally with the token transfer to the cash-out account.
    function _confirmPaymentWithTransfer(
        bytes32 paymentId,
        uint256 confirmationAmount
    ) internal {
        confirmationAmount = _confirmPayment(paymentId, confirmationAmount);
        _paymentStatistics.totalUnconfirmedRemainder = uint128(
            uint256(_paymentStatistics.totalUnconfirmedRemainder) - confirmationAmount
        );
        IERC20(_token).safeTransfer(_requireCashOutAccount(), confirmationAmount);
    }

    /// @dev Makes a refund for a payment internally.
    function _refundPayment(
        bytes32 paymentId,
        uint256 refundingAmount
    ) internal {
        if (paymentId == 0) {
            revert PaymentZeroId();
        }

        Payment storage storedPayment = _payments[paymentId];
        Payment memory payment = storedPayment;
        _checkActivePaymentStatus(paymentId, payment.status);

        uint256 newRefundAmount = uint256(payment.refundAmount) + refundingAmount;
        if (newRefundAmount > uint256(payment.baseAmount) + uint256(payment.extraAmount)) {
            revert InappropriateRefundingAmount();
        }

        PaymentDetails memory oldPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.None);
        payment.refundAmount = uint64(newRefundAmount);
        PaymentDetails memory newPaymentDetails = _definePaymentDetails(payment, PaymentRecalculationKind.Full);

        _processPaymentChange(paymentId, payment, oldPaymentDetails, newPaymentDetails);
        _storeChangedPayment(storedPayment, payment, newPaymentDetails);
        _updatePaymentStatistics(oldPaymentDetails, newPaymentDetails);

        address sponsor = payment.sponsor;
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory addendum = abi.encodePacked(
            EVENT_ADDENDUM_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(oldPaymentDetails.payerSumAmount - oldPaymentDetails.payerRemainder), // oldPayerRefundAmount
            uint64(newPaymentDetails.payerSumAmount - newPaymentDetails.payerRemainder)  // newPayerRefundAmount
        );
        if (eventFlags & EVENT_ADDENDUM_FLAG_MASK_SPONSORED != 0) {
            addendum = abi.encodePacked(
                addendum,
                sponsor,
                uint64(oldPaymentDetails.sponsorSumAmount - oldPaymentDetails.sponsorRemainder),//oldSponsorRefundAmount
                uint64(newPaymentDetails.sponsorSumAmount - newPaymentDetails.sponsorRemainder) //newSponsorRefundAmount
            );
        }

        emit PaymentRefunded(
            paymentId,
            payment.payer,
            addendum
        );
    }

    /// @dev Executes token transfers related to a new payment.
    function _processPaymentMaking(MakingOperation memory operation) internal {
        uint256 sumAmount = operation.baseAmount + operation.extraAmount;
        if (sumAmount > type(uint64).max) {
            revert OverflowOfSumAmount();
        }
        if (operation.sponsor == address(0) && operation.subsidyLimit != 0) {
            revert SponsorZeroAddress();
        }
        if (operation.subsidyLimit > type(uint64).max) {
            revert OverflowOfSubsidyLimit();
        }
        (uint256 payerSumAmount, uint256 sponsorSumAmount) = _defineSumAmountParts(sumAmount, operation.subsidyLimit);
        IERC20 erc20Token = IERC20(_token);
        operation.payerSumAmount = payerSumAmount;
        operation.sponsorSumAmount = sponsorSumAmount;

        erc20Token.safeTransferFrom(operation.payer, address(this), payerSumAmount);
        if (operation.sponsor != address(0)) {
            erc20Token.safeTransferFrom(operation.sponsor, address(this), sponsorSumAmount);
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

    /// @dev Checks if the payment sum amount and the refund amount meet the requirements.
    function _checkPaymentSumAmount(uint256 sumAmount, uint256 refundAmount) internal pure {
        if (refundAmount > sumAmount) {
            revert InappropriateSumAmount();
        }
        if (sumAmount > type(uint64).max) {
            revert OverflowOfSumAmount();
        }
    }

    /// @dev Executes token transfers related to changes of a payment and emits additional events.
    function _processPaymentChange(
        bytes32 paymentId,
        Payment memory payment,
        PaymentDetails memory oldPaymentDetails,
        PaymentDetails memory newPaymentDetails
    ) internal {
        IERC20 erc20Token = IERC20(_token);

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
            CashbackOperationStatus status;
            (status, amount) = _increaseCashback(payment.payer, amount);
            newPaymentDetails.cashbackAmount = oldPaymentDetails.cashbackAmount + amount;
            emit CashbackIncreased(
                paymentId,
                payment.payer,
                status,
                oldPaymentDetails.cashbackAmount,
                newPaymentDetails.cashbackAmount
            );
        }

        // Payer token transferring
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
            CashbackOperationStatus status;
            (status, amount) = _revokeCashback(payment.payer, amount);
            newPaymentDetails.cashbackAmount = oldPaymentDetails.cashbackAmount - amount;
            emit CashbackRevoked(
                paymentId,
                payment.payer,
                status,
                oldPaymentDetails.cashbackAmount,
                newPaymentDetails.cashbackAmount
            );
        }

        // Sponsor token transferring
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

    /// @dev Emits an appropriate event when the confirmed amount is changed for a payment.
    function _emitPaymentConfirmedAmountChanged(
        bytes32 paymentId,
        address payer,
        address sponsor,
        uint256 oldConfirmedAmount,
        uint256 newConfirmedAmount
    ) internal {
        uint256 eventFlags = _defineEventFlags(sponsor);
        bytes memory addendum = abi.encodePacked(
            EVENT_ADDENDUM_DEFAULT_VERSION,
            uint8(eventFlags),
            uint64(oldConfirmedAmount),
            uint64(newConfirmedAmount)
        );
        if (eventFlags & EVENT_ADDENDUM_FLAG_MASK_SPONSORED != 0) {
            addendum = abi.encodePacked(
                addendum,
                sponsor
            );
        }

        emit PaymentConfirmedAmountChanged(
            paymentId,
            payer,
            addendum
        );
    }

    /// @dev Sends cashback related to a payment.
    function _sendCashback(MakingOperation memory operation) internal {
        if (operation.cashbackRate == 0) {
            return;
        }
        // Condition (treasury != address(0)) is guaranteed by the current contract logic. So it is not checked here
        if (_cashbackEnabled) {
            uint256 basePaymentAmount = _definePayerBaseAmount(operation.baseAmount, operation.subsidyLimit);
            uint256 amount = _calculateCashback(basePaymentAmount, operation.cashbackRate);
            CashbackOperationStatus status;
            (status, amount) = _increaseCashback(operation.payer, amount);
            emit CashbackSent(
                operation.paymentId,
                operation.payer,
                status,
                amount
            );
            operation.cashbackAmount = amount;
        } else {
            operation.cashbackRate = 0;
        }
    }

    /// @dev Revokes partially or fully cashback related to a payment.
    function _revokeCashback(
        address payer,
        uint256 amount
    ) internal returns (CashbackOperationStatus status, uint256 revokedAmount) {
        address treasury = _cashbackTreasury;
        // Condition (treasury != address(0)) is guaranteed by the current contract logic. So it is not checked here
        status = CashbackOperationStatus.Success;
        (bool success, bytes memory returnData) = _token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, treasury, amount)
        );
        bool transferred = success && (returnData.length == 0 || abi.decode(returnData, (bool))); // Test coverage tip
        if (transferred) {
            _reduceTotalCashback(payer, amount);
            revokedAmount = amount;
        } else {
            status = CashbackOperationStatus.Failed;
            revokedAmount = 0;
        }
    }

    /// @dev Increases cashback related to a payment.
    function _increaseCashback(
        address payer,
        uint256 amount
    ) internal returns (CashbackOperationStatus status, uint256 increasedAmount) {
        address treasury = _cashbackTreasury;
        // Condition (treasury != address(0)) is guaranteed by the current contract logic. So it is not checked here
        (status, increasedAmount) = _updateAccountCashbackState(payer, amount);
        if (status == CashbackOperationStatus.Success || status == CashbackOperationStatus.Partial) {
            (bool success, bytes memory returnData) = _token.call(
                abi.encodeWithSelector(IERC20.transferFrom.selector, treasury, payer, increasedAmount)
            );
            bool transferred = success && (returnData.length == 0 || abi.decode(returnData, (bool)));
            if (!transferred) {
                _reduceTotalCashback(payer, increasedAmount);
                status = CashbackOperationStatus.Failed;
                increasedAmount = 0;
            }
        }
    }

    /// @dev Updates the account cashback state and checks the cashback cap.
    function _updateAccountCashbackState(
        address account,
        uint256 amount
    ) internal returns (CashbackOperationStatus cashbackStatus, uint256 acceptedAmount) {
        AccountCashbackState storage state = _accountCashbackStates[account];

        uint256 totalAmount = state.totalAmount;
        uint256 capPeriodStartTime = state.capPeriodStartTime;
        uint256 capPeriodStartAmount = state.capPeriodStartAmount;
        uint256 capPeriodCollectedCashback = 0;

        unchecked {
            uint256 blockTimeStamp = uint32(block.timestamp); // take only last 32 bits of the block timestamp
            if (uint32(blockTimeStamp - capPeriodStartTime) > CASHBACK_CAP_RESET_PERIOD) {
                capPeriodStartTime = blockTimeStamp;
            } else {
                capPeriodCollectedCashback = totalAmount - capPeriodStartAmount;
            }

            if (capPeriodCollectedCashback < MAX_CASHBACK_FOR_CAP_PERIOD) {
                uint256 leftAmount = MAX_CASHBACK_FOR_CAP_PERIOD - capPeriodCollectedCashback;
                if (leftAmount >= amount) {
                    acceptedAmount = amount;
                    cashbackStatus = CashbackOperationStatus.Success;
                } else {
                    acceptedAmount = leftAmount;
                    cashbackStatus = CashbackOperationStatus.Partial;
                }
            } else {
                cashbackStatus = CashbackOperationStatus.Capped;
            }
        }

        if (capPeriodCollectedCashback == 0) {
            capPeriodStartAmount = totalAmount;
        }

        state.totalAmount = uint72(totalAmount) + uint72(acceptedAmount);
        state.capPeriodStartAmount = uint72(capPeriodStartAmount);
        state.capPeriodStartTime = uint32(capPeriodStartTime);
    }

    /// @dev Reduces the total cashback amount for an account.
    function _reduceTotalCashback(address account, uint256 amount) internal {
        AccountCashbackState storage state = _accountCashbackStates[account];
        state.totalAmount = uint72(uint256(state.totalAmount) - amount);
    }

    /// @dev Stores the data of a newly created payment.
    function _storeNewPayment(
        Payment storage storedPayment,
        MakingOperation memory operation
    ) internal {
        PaymentStatus oldStatus = storedPayment.status;
        storedPayment.status = PaymentStatus.Active;
        storedPayment.payer = operation.payer;
        storedPayment.cashbackRate = uint16(operation.cashbackRate);
        storedPayment.confirmedAmount = 0;
        if (oldStatus != PaymentStatus.Nonexistent || operation.sponsor != address(0)) {
            storedPayment.sponsor = operation.sponsor;
            storedPayment.subsidyLimit = uint64(operation.subsidyLimit);
        }
        storedPayment.baseAmount = uint64(operation.baseAmount);
        storedPayment.extraAmount = uint64(operation.extraAmount);
        storedPayment.cashbackAmount = uint64(operation.cashbackAmount);
        storedPayment.refundAmount = 0;

        _paymentStatistics.totalUnconfirmedRemainder += uint128(operation.baseAmount + operation.extraAmount);
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

    /// @dev Updates statistics of all payments.
    function _updatePaymentStatistics(
        PaymentDetails memory oldPaymentDetails,
        PaymentDetails memory newPaymentDetails
    ) internal {
        int256 paymentReminderChange =
            (int256(newPaymentDetails.payerRemainder) + int256(newPaymentDetails.sponsorRemainder)) -
            (int256(oldPaymentDetails.payerRemainder) + int256(oldPaymentDetails.sponsorRemainder));
        int256 paymentConfirmedAmountChange =
            int256(newPaymentDetails.confirmedAmount) - int256(oldPaymentDetails.confirmedAmount);

        int256 unconfirmedReminderChange = paymentReminderChange - paymentConfirmedAmountChange;

        // This is done to protect against possible overflow/underflow of the `totalUnconfirmedRemainder` variable
        if (unconfirmedReminderChange >= 0) {
            _paymentStatistics.totalUnconfirmedRemainder += uint128(uint256(unconfirmedReminderChange));
        } else {
            _paymentStatistics.totalUnconfirmedRemainder = uint128(
                uint256(_paymentStatistics.totalUnconfirmedRemainder) - uint256(-unconfirmedReminderChange)
            );
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
        if (paymentBaseAmount > subsidyLimit) {
            return paymentBaseAmount - subsidyLimit;
        } else {
            return 0;
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
        if (baseAmount > subsidyLimit) {
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
            eventFlags |= EVENT_ADDENDUM_FLAG_MASK_SPONSORED;
        }
        return eventFlags;
    }

    /**
     * @dev The upgrade validation function for the UUPSExtUpgradeable contract.
     * @param newImplementation The address of the new implementation.
     */
    function _validateUpgrade(address newImplementation) internal view override onlyRole(OWNER_ROLE) {
        try ICardPaymentProcessor(newImplementation).proveCardPaymentProcessor() {} catch {
            revert ImplementationAddressInvalid();
        }
    }

    // ------------------ Service functions ----------------------- //

    /**
     * @dev The version of the standard upgrade function without the second parameter for backward compatibility.
     * @custom:oz-upgrades-unsafe-allow-reachable delegatecall
     */
    function upgradeTo(address newImplementation) external {
        upgradeToAndCall(newImplementation, "");
    }
}
