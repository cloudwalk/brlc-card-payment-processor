// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title CardPaymentProcessorV2 types interface
 */
interface ICardPaymentProcessorV2Types {
    /**
     * @dev Possible statuses of a payment as an enum.
     *
     * The possible values:
     * - Nonexistent - The payment does not exist (the default value).
     * - Active ------ The status immediately after the payment making.
     * - Merged ------ The payment was merged to another payment.
     * - Revoked ----- The payment was revoked due to some technical reason.
     *                 The related tokens have been transferred back to the customer.
     *                 The payment can be made again with the same ID
     *                 if its revocation counter does not reach the configure limit.
     * - Reversed ---- The payment was reversed due to the decision of the off-chain card processing service.
     *                 The related tokens have been transferred back to the customer.
     *                 The payment cannot be made again with the same ID.
     */
    enum PaymentStatus {
        Nonexistent, // 0
        Active,      // 1
        Merged,      // 2
        Revoked,     // 3
        Reversed     // 4
    }

    // DEV Think about removing the cash-out account

    /** @dev Structure with data of a single payment.
     *
     *  The following additional payment parameters can be derived from the structure fields:
     *
     *  - sumAmount = baseAmount + extraAmount.
     *  - commonReminder = sumAmount - refundAmount.
     *  - unconfirmedAmount = commonReminder - confirmedAmount.
     *  - payerBaseAmount = (baseAmount > subsidyLimit) ? (baseAmount - subsidyLimit) : 0.
     *  - payerSumAmount = (sumAmount > subsidyLimit) ? (sumAmount - subsidyLimit) : 0.
     *  - assumedSponsorRefundAmount = (baseAmount > subsidyLimit)
     *                                 ? (refundAmount * subsidyLimit / baseAmount)
     *                                 : refundAmount.
     *  - sponsorRefundAmount = (assumedSponsorRefundAmount < subsidyLimit) ? assumedSponsorRefundAmount : subsidyLimit.
     *  - payerRefundAmount = refundAmount - sponsorRefundAmount.
     *  - payerRemainder = payerSumAmount - payerRefundAmount.
     *  - sponsorReminder = sumAmount - payerSumAmount - payerRemainder.
     */
    // DEV Type `uint64` allows us execute payments up to 1.8E13 BRLC. I believe, instead of that, we can use `uint56` (up to 72E9 BRLC) or even `uint48` (up to 281M BRLC). It will save more storage.
    struct Payment {
        //slot1
        PaymentStatus status;   // The Current status of the payment.
        uint8 reserve1;         // The reserved filed for future changes.
        address payer;          // The account who made the payment.
        uint16 cashbackRate;    // The cashback rate in units of `CASHBACK_FACTOR`.
        uint64 confirmedAmount; // The confirmed amount that was transferred to the cash-out account.
        //slot2
        address sponsor;        // The sponsor of the payment if it is subsidized. Otherwise the zero address.
        uint64 subsidyLimit;    // The subsidy limit of the payment if it is subsidized. Otherwise zero.
        uint32 reserve2;        // The reserved filed for future changes.
        //slot3
        uint64 baseAmount;      // The base amount of tokens in the payment.
        uint64 extraAmount;     // The extra amount of tokens in the payment, without a cashback.
        uint64 cashbackAmount;  // The cumulative cashback amount that was granted to payer related to the payment.
        uint64 refundAmount;    // The total amount of all refunds related to the payment.
    }

    /// @dev Structure with data of a single confirmation operation
    struct PaymentConfirmation {
        bytes32 paymentId;      // The card transaction payment ID from the off-chain card processing backend.
        uint64 amount;          // The amount to confirm for the payment.
    }
}

/**
 * @title CardPaymentProcessorV2 interface
 * @dev The interface of the wrapper contract for the card payment operations.
 */
interface ICardPaymentProcessorV2 is ICardPaymentProcessorV2Types {
    /**
     * @dev Emitted when a payment is made.
     *
     * The main data is encoded in the `data` field as the result of calling of the `abi.encodePacked()` function
     * with the following arguments:
     *
     * - uint8(version) -- the version of the event data, for now it equals `0x01`.
     * - bool(isSubsidized) -- whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(payerSumAmount) -- the payer sum amount part.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(sponsorSumAmount) -- the sponsor sum amount part or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param data The main data of the event as described above.
     */
    event PaymentMade(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes data
    );

    /**
     * @dev Emitted when a payment is updated.
     *
     * The main data is encoded in the `data` field as the result of calling of the `abi.encodePacked()` function
     * as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments:
     *
     * - uint8(version) -- the version of the event data, for now it equals `0x01`.
     * - bool(isSubsidized) -- whether the payment is subsidized (`0x01`) or not (`0x00`).
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
     * @param data The main data of the event as described above.
     */
    event PaymentUpdated(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes data
    );

    /**
     * @dev Emitted when a payment is revoked.
     *
     * The main data is encoded in the `data` field as the result of calling of the `abi.encodePacked()` function
     * as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments:
     *
     * - uint8(version) -- the version of the event data, for now it equals `0x01`.
     * - bool(isSubsidized) -- whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(payerReminder) -- the payer reminder part of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(sponsorReminder) -- the sponsor reminder part or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param data The main data of the event as described above.
     */
    event PaymentRevoked(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes data
    );

    /**
     * @dev Emitted when a payment is reversed.
     *
     * The main data is encoded in the `data` field as the result of calling of the `abi.encodePacked()` function
     * as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments:
     *
     * - uint8(version) -- the version of the event data, for now it equals `0x01`.
     * - bool(isSubsidized) -- whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(payerReminder) -- the payer reminder part of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(sponsorReminder) -- the sponsor reminder part or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param data The main data of the event as described above.
     */
    event PaymentReversed(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes data
    );

    /**
     * @dev Emitted when the confirmed amount of a payment is changed. It can be emitted during any operation.
     *
     * The main data is encoded in the `data` field as the result of calling of the `abi.encodePacked()` function
     * as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments:
     *
     * - uint8(version) -- the version of the event data, for now it equals `0x01`.
     * - bool(isSubsidized) -- whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(oldConfirmedAmount) -- the old confirmed amount of the payment.
     * - uint64(newConfirmedAmount) -- the new confirmed amount of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param data The main data of the event as described above.
     */
    event PaymentConfirmedAmountChanged(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes data
    );

    /**
     * @dev Emitted when a payment is refunded.
     *
     * The main data is encoded in the `data` field as the result of calling of the `abi.encodePacked()` function
     * as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments:
     *
     * - uint8(version) -- the version of the event data, for now it equals `0x01`.
     * - bool(isSubsidized) -- whether the payment is subsidized (`0x01`) or not (`0x00`).
     * - uint64(oldPayerRefundAmount) -- the old payer refund amount of the payment.
     * - uint64(newPayerRefundAmount) -- the new payer refund amount of the payment.
     * - address(sponsor) -- the address of the sponsor or skipped if the payment is not subsidized.
     * - uint64(oldSponsorRefundAmount) -- the old sponsor refund amount or skipped if the payment is not subsidized.
     * - uint64(newSponsorRefundAmount) -- the new sponsor refund amount or skipped if the payment is not subsidized.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param payer The account on that behalf the payment is made.
     * @param data The main data of the event as described above.
     */
    event PaymentRefunded(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes data
    );

    /**
     * @dev Emitted when a payment is merged.
     *
     * The main data is encoded in the `data` field as the result of calling of the `abi.encodePacked()` function
     * as described in https://docs.soliditylang.org/en/latest/abi-spec.html#non-standard-packed-mode
     * with the following arguments:
     *
     * - uint8(version) -- the version of the event data, for now it equals `0x01`.
     *
     * @param mergedPaymentId The ID of the merged payment.
     * @param targetPaymentId  The ID of the target payment to merge with.
     * @param payer The account on that behalf the payment is made.
     * @param data The main data of the event as described above.
     */
    event PaymentMerged(
        bytes32 indexed mergedPaymentId,
        bytes32 indexed targetPaymentId,
        address indexed payer,
        bytes data
    );

    /// @dev Emitted when an account is refunded.
    event RefundAccount(
        address indexed account,
        uint64 refundingAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

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
     * Emits a {PaymentMadeSubsidized} event if the payment is subsidized.
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
     */
    function makePaymentFor(
        bytes32 paymentId,
        address payer,
        uint64 baseAmount,
        uint64 extraAmount,
        address sponsor,
        uint64 subsidyLimit,
        int16 cashbackRate,
        uint64 confirmationAmount
    ) external;

    /**
     * @dev Updates a previously made payment.
     *
     * Transfers the underlying tokens from the payer and/or sponsor to this contract or vise versa.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentUpdated} event.
     * Emits a {PaymentUpdatedSubsidized} event if the payment is subsidized.
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param newBaseAmount The new base amount of the payment.
     * @param newExtraAmount The new extra amount of the payment.
     */
    function updatePayment(
        bytes32 paymentId,
        uint64 newBaseAmount,
        uint64 newExtraAmount
    ) external;

    /**
     * @dev Performs the revocation of a previously made card payment.
     *
     * Does not finalize the payment: it can be made again with the same paymentId.
     * Transfers tokens back from this contract or cash-out account to the payer and/or sponsor.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentRevoked} event.
     * Emits a {PaymentRevokedSubsidized} event if the payment is subsidized.
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
     * Emits a {PaymentReversedSubsidized} event if the payment is subsidized.
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
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param confirmationAmount The amount to confirm for the payment.
     */
    function confirmPayment(
        bytes32 paymentId,
        uint64 confirmationAmount
    ) external;

    /**
     * @dev Confirms multiple previously made card payment.
     *
     * Does mot finalizes the payments: any other operations can be done for the payments after this one.
     * Transfers tokens gotten from payers and sponsors to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentConfirmedAmountChanged} event for each payment if the confirmed amount of the payment is changed.
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
     * Emits a {PaymentUpdatedSubsidized} event if the update operation is executed and the payment is subsidized.
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param newBaseAmount The new base amount of the payment.
     * @param newExtraAmount The new extra amount of the payment.
     * @param confirmationAmount The amount to confirm for the payment.
     */
    function updateLazyAndConfirmPayment(
        bytes32 paymentId,
        uint64 newBaseAmount,
        uint64 newExtraAmount,
        uint64 confirmationAmount
    ) external;

    /**
     * @dev Makes a refund for a previously made card payment.
     *
     * Emits a {PaymentRefunded} event.
     * Emits a {PaymentRefundedSubsidized} event if the payment is subsidized.
     * Emits a {PaymentConfirmedAmountChanged} event if the confirmed amount of the payment is changed.
     *
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     * @param refundingAmount The amount of tokens to refund.
     */
    function refundPayment(
        bytes32 paymentId,
        uint64 refundingAmount
    ) external;

    /**
     * @dev Merges several payments into a single one.
     *
     * Emits a {PaymentMerged} event for each merged payment.
     * Emits a {PaymentConfirmedAmountChanged} event for the target payment if its confirmed amount is changed.
     *
     * @param targetPaymentId The ID of the target payment to merge with.
     * @param mergedPaymentIds The IDs of payments to merge.
     */
    function mergePayments(
        bytes32 targetPaymentId,
        bytes32[] calldata mergedPaymentIds
    ) external;

    /**
     * @dev Makes a refund for an account where the refund cannot be associated with any card payment.
     *
     * During this operation the needed amount of tokens is transferred from the cash-out account to the target account.
     *
     * Emits a {RefundAccount} event.
     *
     * @param account The address of the account to refund.
     * @param refundingAmount The amount of tokens to refund.
     */
    function refundAccount(
        address account,
        uint64 refundingAmount
    ) external;

    /**
     * @dev Returns the address of the underlying token.
     */
    function token() external view returns (address);

    /**
     * @dev Returns the address of the cash-out account.
     */
    function cashOutAccount() external view returns (address);

    /**
     * @dev Returns payment data for a card transaction payment ID.
     * @param paymentId The card transaction payment ID from the off-chain card processing backend.
     */
    function getPayment(bytes32 paymentId) external view returns (Payment memory);
}
