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
    /// @dev Emitted when a payment is made.
    event PaymentMade(
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 payerSumAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    // DEV Merge several events into a single one for each operation

    /// @dev Emitted along with the {PaymentMade} event when a subsidized payment is made.
    event PaymentMadeSubsidized(
        bytes32 indexed paymentId,
        address indexed sponsor,
        uint256 subsidyLimit,
        uint256 sponsorSumAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is updated.
    event PaymentUpdated(
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 oldBaseAmount,
        uint256 newBaseAmount,
        uint256 oldExtraAmount,
        uint256 newExtraAmount,
        uint256 oldPayerSumAmount,
        uint256 newPayerSumAmount,
        bytes addendum // Empty. Reserved for future possible additional information
    );

    /// @dev Emitted along with the {PaymentUpdated} event when the amount of a subsidized payment is updated.
    event PaymentUpdatedSubsidized(
        bytes32 indexed paymentId,
        address indexed sponsor,
        uint256 oldSponsorSumAmount,
        uint256 newSponsorSumAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is revoked.
    event PaymentRevoked(
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 payerReminder,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted along with the {PaymentRevoked} event when a subsidized payment is revoked.
    event PaymentRevokedSubsidized(
        bytes32 indexed paymentId,
        address indexed sponsor,
        uint256 sponsorReminder,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is reversed.
    event PaymentReversed(
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 payerReminder,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted along with the {PaymentReversed} event when a subsidized payment is reversed.
    event PaymentReversedSubsidized(
        bytes32 indexed paymentId,
        address indexed sponsor,
        uint256 sponsorReminder,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /**
     * @dev Emitted when the confirmed amount of a payment is changed.
     *      It can be emitted during any operation except payment making
     */
    event PaymentConfirmedAmountChanged(
        bytes32 indexed paymentId,
        address indexed payer,
        address sponsor,
        uint64 oldConfirmedAmount,
        uint64 newConfirmedAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is refunded.
    event PaymentRefunded(
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 oldPayerRefundAmount,
        uint256 newPayerRefundAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted along with the {PaymentRefunded} event when a subsidized payment is refunded.
    event PaymentRefundedSubsidized(
        bytes32 indexed paymentId,
        address indexed sponsor,
        uint256 oldSponsorRefundAmount,
        uint256 newSponsorRefundAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is merged.
    event PaymentMerged(
        bytes32 indexed mergedPaymentId,
        bytes32 indexed targetPaymentId,
        address indexed payer,
        bytes addendum // Empty. Reserved for future possible additional information.
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
