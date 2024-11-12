// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/// @title CardPaymentProcessor types interface
interface ICardPaymentProcessorTypes {
    /**
     * @dev Possible statuses of a payment as an enum.
     *
     * The possible values:
     *
     * - Nonexistent - The payment does not exist (the default value).
     * - Active ------ The status immediately after the payment making.
     * - Revoked ----- The payment was cancelled due to some technical reason.
     *                 The related tokens have been transferred back to the payer and (optionally) sponsor.
     *                 The payment can be made again with the same ID.
     *                 All further operations with this payment except making again are prohibited.
     * - Reversed ---- The payment was cancelled due to the decision of the off-chain card processing service.
     *                 The related tokens have been transferred back to the payer and (optionally) sponsor.
     *                 The payment cannot be made again with the same ID.
     *                 All further operations with this payment are prohibited.
     */
    enum PaymentStatus {
        Nonexistent, // 0
        Active,      // 1
        Revoked,     // 2
        Reversed     // 3
    }

    /** @dev Structure with data of a single payment.
     *
     *  The following additional payment parameters can be derived from the structure fields:
     *
     *  - sumAmount = baseAmount + extraAmount = payerSumAmount + sponsorSumAmount.
     *  - commonRemainder = sumAmount - refundAmount = payerRemainder + sponsorRemainder.
     *  - unconfirmedAmount = commonRemainder - confirmedAmount.
     *  - payerBaseAmount = (baseAmount > subsidyLimit) ? (baseAmount - subsidyLimit) : 0.
     *  - payerSumAmount = (sumAmount > subsidyLimit) ? (sumAmount - subsidyLimit) : 0.
     *  - sponsorSumAmount = sumAmount - payerSumAmount.
     *  - assumedSponsorRefundAmount = (baseAmount > subsidyLimit)
     *                                 ? (refundAmount * subsidyLimit / baseAmount)
     *                                 : refundAmount.
     *  - sponsorRefundAmount = (assumedSponsorRefundAmount < subsidyLimit) ? assumedSponsorRefundAmount : subsidyLimit.
     *  - payerRefundAmount = refundAmount - sponsorRefundAmount.
     *  - payerRemainder = payerSumAmount - payerRefundAmount.
     *  - sponsorRemainder = sponsorSumAmount - sponsorRefundAmount.
     *  - cashbackAmount = (payerBaseAmount > payerRefundAmount)
     *                     ? (payerBaseAmount - payerRefundAmount) * cashbackRate
     *                     : 0.
     *
     *  The following restrictions are applied to a payment:
     *  - `refundAmount <= sumAmount`.
     *  - `commonReminder >= confirmedAmount`.
     */
    struct Payment {
        // Slot1
        PaymentStatus status;   // The current status of the payment.
        uint8 reserve1;         // The reserved filed for future changes.
        address payer;          // The account who made the payment.
        uint16 cashbackRate;    // The cashback rate in units of `CASHBACK_FACTOR`.
        uint64 confirmedAmount; // The confirmed amount that was transferred to the cash-out account.
        // Slot2
        address sponsor;        // The sponsor of the payment if it is subsidized. Otherwise the zero address.
        uint64 subsidyLimit;    // The subsidy limit of the payment if it is subsidized. Otherwise zero.
        uint32 reserve2;        // The reserved filed for future changes.
        // Slot3
        uint64 baseAmount;      // The base amount of tokens in the payment.
        uint64 extraAmount;     // The extra amount of tokens in the payment, without a cashback.
        uint64 cashbackAmount;  // The cumulative cashback amount that was granted to payer related to the payment.
        uint64 refundAmount;    // The total amount of all refunds related to the payment.
    }

    /// @dev Structure with data of a single confirmation operation.
    struct PaymentConfirmation {
        bytes32 paymentId; // The card transaction payment ID from the off-chain card processing backend.
        uint256 amount;    // The amount to confirm for the payment.
    }

    /// @dev Structure with statistics of all payments.
    struct PaymentStatistics {
        uint128 totalUnconfirmedRemainder; // The total remainder of all payments that are not confirmed yet.
        uint128 reserve1;                  // The reserved filed for future changes.
        uint256 reserve2;                  // The reserved filed for future changes.
    }
}

/**
 * @title CardPaymentProcessor interface
 * @dev The interface of the wrapper contract for the card payment operations.
 */
interface ICardPaymentProcessor is ICardPaymentProcessorTypes {
    // ------------------ Events ---------------------------------- //

    /**
     * @dev Emitted when a payment is made.
     *
     * Some data is encoded in the `addendum` parameter as the result of calling of the `abi.encodePacked()`
     * function as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments (addendum fields):
     *
     * - uint8(version) -- the version of the event addendum, for now it equals `0x01`.
     * - uint8(flags) -- the flags that for now define whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(baseAmount) -- the base amount of the payment.
     * - uint64(extraAmount) -- the extra amount of the payment.
     * - uint64(payerSumAmount) -- the payer sum amount part.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(sponsorSumAmount) -- the sponsor sum amount part or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param addendum The data of the event as described above.
     */
    event PaymentMade(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is updated inside a function whose name started with the `update` word.
     *
     * Some data is encoded in the `addendum` parameter as the result of calling of the `abi.encodePacked()`
     * function as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments (addendum fields):
     *
     * - uint8(version) -- the version of the event addendum, for now it equals `0x01`.
     * - uint8(flags) -- the flags that for now define whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(oldBaseAmount) -- the old base amount of the payment.
     * - uint64(newBaseAmount) -- the new base amount of the payment.
     * - uint64(oldExtraAmount) -- the old extra amount of the payment.
     * - uint64(newExtraAmount) -- the new extra amount of the payment.
     * - uint64(oldPayerSumAmount) -- the old payer sum amount part.
     * - uint64(newPayerSumAmount) -- the new payer sum amount part.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(oldSponsorSumAmount) -- the old sponsor sum amount part or skipped if the payment is not subsidized.
     * - uint64(newSponsorSumAmount) -- the new sponsor sum amount part or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param addendum The data of the event as described above.
     */
    event PaymentUpdated(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is revoked.
     *
     * Some data is encoded in the `addendum` parameter as the result of calling of the `abi.encodePacked()`
     * function as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments (addendum fields):
     *
     * - uint8(version) -- the version of the event addendum, for now it equals `0x01`.
     * - uint8(flags) -- the flags that for now define whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(baseAmount) -- the base amount of the payment.
     * - uint64(extraAmount) -- the extra amount of the payment.
     * - uint64(payerRemainder) -- the payer remainder part of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(sponsorRemainder) -- the sponsor remainder part or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param addendum The data of the event as described above.
     */
    event PaymentRevoked(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is reversed.
     *
     * Some data is encoded in the `addendum` parameter as the result of calling of the `abi.encodePacked()`
     * function as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments (addendum fields):
     *
     * - uint8(version) -- the version of the event addendum, for now it equals `0x01`.
     * - uint8(flags) -- the flags that for now define whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(baseAmount) -- the base amount of the payment.
     * - uint64(extraAmount) -- the extra amount of the payment.
     * - uint64(payerRemainder) -- the payer remainder part of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(sponsorRemainder) -- the sponsor remainder part or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param addendum The data of the event as described above.
     */
    event PaymentReversed(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes addendum
    );

    /**
     * @dev Emitted when the confirmed amount of a payment is changed. It can be emitted during any operation.
     *
     * Some data is encoded in the `addendum` parameter as the result of calling of the `abi.encodePacked()`
     * function as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments (addendum fields):
     *
     * - uint8(version) -- the version of the event addendum, for now it equals `0x01`.
     * - uint8(flags) -- the flags that for now define whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(oldConfirmedAmount) -- the old confirmed amount of the payment.
     * - uint64(newConfirmedAmount) -- the new confirmed amount of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param addendum The data of the event as described above.
     */
    event PaymentConfirmedAmountChanged(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is refunded inside a function whose name started with the `refund` word.
     *
     * Some data is encoded in the `addendum` parameter as the result of calling of the `abi.encodePacked()`
     * function as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments (addendum fields):
     *
     * - uint8(version) -- the version of the event addendum, for now it equals `0x01`.
     * - uint8(flags) -- the flags that for now define whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(oldPayerRefundAmount) -- the old payer refund amount of the payment.
     * - uint64(newPayerRefundAmount) -- the new payer refund amount of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(oldSponsorRefundAmount) -- the old sponsor refund amount or skipped if the payment is not subsidized.
     * - uint64(newSponsorRefundAmount) -- the new sponsor refund amount or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param addendum The data of the event as described above.
     */
    event PaymentRefunded(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes addendum
    );

    /**
     * @dev Emitted when an account is refunded inside the `refundAccount()` function.
     * @param account The account that is refunded.
     * @param refundingAmount The amount of tokens to refund.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event AccountRefunded(
        address indexed account,
        uint256 refundingAmount,
        bytes addendum
    );

    // ------------------ Functions ------------------------------- //

    /**
     * @dev Makes a card payment for a given account initiated by a service account.
     *
     * The payment can be subsidized with full or partial reimbursement from a specified sponsor account.
     * If cashback is disabled in the contract it will not be sent in any case.
     *
     * Transfers the underlying tokens from the payer and/or sponsor to this contract.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentMade} event.
     * Emits a {PaymentConfirmedAmountChanged} event if the payment is confirmed immediately after making.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param baseAmount The base amount of tokens to transfer because of the payment.
     * @param extraAmount The extra amount of tokens to transfer because of the payment. No cashback is applied.
     * @param sponsor The address of a sponsor if the payment is subsidized, otherwise zero.
     * @param subsidyLimit The amount of tokens that the sponsor is compensating for the payment.
     * @param cashbackRate If positive then it is a special cashback rate for the payment in units of `CASHBACK_FACTOR`.
     *                     If negative then the contract settings are used to determine cashback.
     *                     If zero then cashback is not sent.
     * @param confirmationAmount The amount to confirm for the payment immediately after making.
     *                           Zero if confirmation is not needed.
     */
    function makePaymentFor(
        bytes32 paymentId,
        address payer,
        uint256 baseAmount,
        uint256 extraAmount,
        address sponsor,
        uint256 subsidyLimit,
        int256 cashbackRate,
        uint256 confirmationAmount
    ) external;

    /**
     * @dev Makes a common card payment for a given account initiated by a service account.
     *
     * It is the same as the `makePaymentFor()` function but with less parameters.
     * The payment is not subsidized, with the cashback defined by the contract settings, and without a confirmation.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param baseAmount The base amount of tokens to transfer because of the payment.
     * @param extraAmount The extra amount of tokens to transfer because of the payment. No cashback is applied.
     */
    function makeCommonPaymentFor(
        bytes32 paymentId,
        address payer,
        uint256 baseAmount,
        uint256 extraAmount
    ) external;

    /**
     * @dev Updates a previously made payment.
     *
     * Transfers the underlying tokens from the payer and/or sponsor to this contract or vise versa.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentUpdated} event.
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param newBaseAmount The new base amount of the payment.
     * @param newExtraAmount The new extra amount of the payment.
     */
    function updatePayment(
        bytes32 paymentId,
        uint256 newBaseAmount,
        uint256 newExtraAmount
    ) external;

    /**
     * @dev Performs the revocation of a previously made card payment.
     *
     * Does not finalize the payment: it can be made again with the same paymentId.
     * Transfers tokens back from this contract or cash-out account to the payer and/or sponsor.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentRevoked} event.
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     */
    function revokePayment(bytes32 paymentId) external;

    /**
     * @dev Performs the reverse of a previously made card payment.
     *
     * Finalizes the payment: no other operations can be done for the payment after this one.
     * Transfers tokens back from this contract or cash-out account to the payer and/or sponsor.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentReversed} event.
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     */
    function reversePayment(bytes32 paymentId) external;

    /**
     * @dev Confirms a single previously made card payment.
     *
     * Does mot finalizes the payment: any other operations can be done for the payment after this one.
     * Transfers tokens gotten from a payer and a sponsor to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentConfirmedAmountChanged} event.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param confirmationAmount The amount to confirm for the payment.
     */
    function confirmPayment(
        bytes32 paymentId,
        uint256 confirmationAmount
    ) external;

    /**
     * @dev Confirms multiple previously made card payment.
     *
     * Does mot finalizes the payments: any other operations can be done for the payments after this one.
     * Transfers tokens gotten from payers and sponsors to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentConfirmedAmountChanged} event for each payment.
     *
     * @param paymentConfirmations The array of structures with payment confirmation parameters.
     */
    function confirmPayments(PaymentConfirmation[] calldata paymentConfirmations) external;

    /**
     * @dev Executes updating and confirmation operations for a single previously made card payment.
     *
     * Updating of the base amount and extra amount executes lazy, i.e. only if any of the provided new amounts differ
     * from the current once of the payment. Otherwise the update operation is skipped.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentUpdated} event if the update operation is executed.
     * Emits a {PaymentConfirmedAmountChanged} event.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param newBaseAmount The new base amount of the payment.
     * @param newExtraAmount The new extra amount of the payment.
     * @param confirmationAmount The amount to confirm for the payment.
     */
    function updateLazyAndConfirmPayment(
        bytes32 paymentId,
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        uint256 confirmationAmount
    ) external;

    /**
     * @dev Makes a refund for a previously made card payment.
     *
     * Emits a {PaymentRefunded} event.
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param refundingAmount The amount of tokens to refund.
     */
    function refundPayment(
        bytes32 paymentId,
        uint256 refundingAmount
    ) external;

    /**
     * @dev Makes a refund for an account where the refund cannot be associated with any card payment.
     *
     * During this operation the needed amount of tokens is transferred from the cash-out account to the target account.
     *
     * Emits a {AccountRefunded} event.
     *
     * @param account The address of the account to refund.
     * @param refundingAmount The amount of tokens to refund.
     */
    function refundAccount(
        address account,
        uint256 refundingAmount
    ) external;

    // ------------------ View functions -------------------------- //

    /// @dev Returns the address of the underlying token.
    function token() external view returns (address);

    /// @dev Returns the address of the cash-out account.
    function cashOutAccount() external view returns (address);

    /**
     * @dev Returns payment data for a card transaction payment ID.
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     */
    function getPayment(bytes32 paymentId) external view returns (Payment memory);

    /// @dev Returns statistics of all payments.
    function getPaymentStatistics() external view returns (PaymentStatistics memory);

    /// @dev Proves the contract is the card payment processor one. A marker function.
    function proveCardPaymentProcessor() external pure;
}
