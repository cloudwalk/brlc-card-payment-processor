// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title CardPaymentProcessor types interface
 */
interface ICardPaymentProcessorTypes {
    /**
     * @dev Possible statuses of a payment as an enum.
     *
     * The possible values:
     * - Nonexistent - The payment does not exist (the default value).
     * - Active ------ The status immediately after the payment making.
     * - Reserve ----- The unused status, reserved for future changes.
     * - Revoked ----- The payment was revoked due to some technical reason.
     *                 The related tokens have been transferred back to the customer.
     *                 The payment can be made again with the same authorizationId
     *                 if its revocation counter does not reach the configure limit.
     * - Reversed ---- The payment was reversed due to the decision of the off-chain card processing service.
     *                 The related tokens have been transferred back to the customer.
     *                 The payment cannot be made again with the same authorizationId.
     * - Confirmed --- The payment was fully confirmed.
     *                 The related tokens have been transferred to a special cash-out address.
     *                 The payment cannot be made again with the same authorizationId.
     */
    enum PaymentStatus {
        Nonexistent, // 0
        Active,      // 1
        Reserve,     // 2
        Revoked,     // 3
        Reversed,    // 4
        Confirmed    // 5 // DEV Maybe this status is redundant.
    }

    /**
     * @dev Possible kinds of a payment as an enum.
     *
     * The possible values:
     * - Common ----- The payment is common, not subsidized.
     * - Subsidized - The payment is subsidized.
     */
    enum PaymentKind {
        Common,
        Subsidized
    }

    /// @dev Structure with data of a single payment.
    // DEV Type `uint64` allows us execute payments up to 1.8E13 BRLC. I believe, instead of that, we can use `uint56` (up to 72E9 BRLC) or even `uint48` (up to 281M BRLC). It will save more storage.
    struct Payment {
        //slot1
        PaymentStatus status;       // Current status of the payment.
        uint8 reserve1;             // Reserved filed for future changes.
        address payer;              // The account who made the payment.
        uint80 reserve2;            // Reserved filed for future changes.
        //slot2
        address sponsor;             // The sponsor of the payment if it is subsidized. Otherwise the zero address.
        uint64 subsidyAmount;        // The subsidy amount of the payment if it is subsidized. Otherwise zero.
        uint32 reserve3;             // Reserved filed for future changes.
        //slot3
        uint64 baseAmount;           // Base amount of tokens in the payment.
        uint64 extraAmount;          // The extra amount of tokens in the payment, without a cashback.
        uint64 cashbackAmount;       // The cashback amount of the payment.
        uint64 balance;              // The balance of the payment on the contract account.
        //slot4
        uint64 payerRefundAmount;    // The amount of all refunds to the payer related to the payment.
        uint64 sponsorRefundAmount;  // The amount of all refunds to the sponsor related to the payment.
    }
}

/**
 * @title CardPaymentProcessor interface
 * @dev The interface of the wrapper contract for the card payment operations.
 */
interface ICardPaymentProcessor is ICardPaymentProcessorTypes {
    /// @dev Emitted when a payment is made.
    event PaymentMade(
        bytes32 indexed authorizationId,
        bytes32 indexed correlationId, // DEV Do we need this field?
        address indexed payer,
        address sponsor,
        uint64 baseAmount,
        uint64 extraAmount,
        uint64 requestedCashbackAmount, // DEV This field is redundant if we decide to exclude CashbackDistributor and control the cashback cap on the backend side
        uint64 actualCashbackAmount,
        uint64 subsidyAmount,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is updated.
    event PaymentUpdated(
        bytes32 indexed authorizationId,
        bytes32 indexed correlationId,
        address indexed payer,
        address sponsor,
        int64 baseAmountChange,
        int64 extraAmountChange,
        int64 requestedCashbackAmountChange,
        int64 actualCashbackAmountChange,
        int64 subsidyAmountChange,
        bytes addendum // Empty. Reserved for future possible additional information
    );

    /// @dev Emitted when a payment is revoked.
    event PaymentRevoked(
        bytes32 indexed authorizationId,
        bytes32 indexed correlationId,
        address indexed payer,
        address sponsor,
        uint64 baseAmount,
        uint64 extraAmount,
        uint64 cashbackAmount,
        uint64 subsidyAmount,
        uint64 payerRefundAmount,
        uint64 sponsorRefundAmount,
        bytes32 parentTransactionHash,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is reversed.
    event PaymentReversed(
        bytes32 indexed authorizationId,
        bytes32 indexed correlationId,
        address indexed payer,
        address sponsor,
        uint64 baseAmount,
        uint64 extraAmount,
        uint64 cashbackAmount,
        uint64 subsidyAmount,
        uint64 payerRefundAmount,
        uint64 sponsorRefundAmount,
        bytes32 parentTransactionHash,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is confirmed or partially confirmed.
    event PaymentConfirmed(
        bytes32 indexed authorizationId,
        bytes32 indexed correlationId,
        address indexed payer,
        address sponsor,
        uint64  confirmedAmount,
        uint64  paymentBalance,
        bytes addendum // Empty. Reserved for future possible additional information.
    );

    /// @dev Emitted when a payment is refunded.
    event PaymentRefunded(
        bytes32 indexed authorizationId,
        bytes32 indexed correlationId,
        address indexed payer,
        address sponsor,
        uint64 payerRefundAmountIncrease,
        uint64 sponsorRefundAmountIncrease,
        int64 requestedCashbackAmountChange,
        int64 actualCashbackAmountChange
    );

    /// @dev Emitted when an account is refunded.
    event RefundAccount(
        bytes32 indexed correlationId,
        address indexed account,
        uint64 refundAmount
    );

    /// @dev Emitted when the cash-out account is changed.
    event SetCashOutAccount(
        address oldCashOutAccount,
        address newCashOutAccount
    );

    /**
     * @dev Makes a card payment for a given account initiated by a service account.
     *
     * The payment can be subsidized with full or partial reimbursement from a specified sponsor account.
     * If cashback is disabled in the contract it will not be sent in any case.
     *
     * Transfers the underlying tokens from the account and/or sponsor to this contract.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentMade} event.
     *
     * @param payer The account on that behalf the payment is made.
     * @param baseAmount The base amount of tokens to transfer because of the payment.
     * @param extraAmount The extra amount of tokens to transfer because of the payment. No cashback is applied.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param sponsor The address of a sponsor if the payment is subsidized, otherwise zero.
     * @param subsidyAmount The amount of tokens that the sponsor is compensating for the payment.
     * @param cashbackAmount The requested cashback amount for the payment, the actual cashback can be less.
     */
    function makePaymentFor(
        bytes32 authorizationId,
        bytes32 correlationId, // DEV Do we need this field?
        address payer,
        uint64 baseAmount,
        uint64 extraAmount,
        address sponsor,
        uint64 subsidyAmount,
        uint64 cashbackAmount
    ) external;


    /**
     * @dev Updates a previously made payment.
     *
     * Transfers the underlying tokens from the account to this contract or vise versa.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentUpdated} event.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param baseAmountChange The change in the base amount of the payment.
     * @param extraAmountChange The change in the extra amount of the payment.
     * @param cashbackAmountChange The requested change in the cashback amount of the payment.
     * @param subsidyAmountChange The change in the subsidy amount of the payment if it is subsidized.
     */
    function updatePayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        int64 baseAmountChange,
        int64 extraAmountChange,
        int64 cashbackAmountChange,
        int64 subsidyAmountChange
    ) external;

    /**
     * @dev Performs the reverse of a previously made card payment.
     *
     * Finalizes the payment: no other operations can be done for the payment after this one.
     * Transfers tokens back from this contract or cash-out account to the payer.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentReversed} event.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function reversePayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        bytes32 parentTxHash // DEV Do we need this field?
    ) external;

    /**
     * @dev Performs the revocation of a previously made card payment.
     *
     * Does not finalize the payment: it can be made again with the same authorizationId.
     * Transfers tokens back from this contract or cash-out account to the payer.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentRevoked} event.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function revokePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external;

    /**
     * @dev Confirms a single previously made card payment.
     *
     * Does mot finalizes the payment: any other operations can be done for the payment after this one.
     * Transfers tokens gotten from a payer and a sponsor to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentConfirmed} event.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param amount The amount to confirm for the payment.
     */
    function confirmPayment(
        bytes32 authorizationId,
        uint64  amount
    ) external;

    /**
     * @dev Confirms multiple previously made card payment.
     *
     * Does mot finalizes the payments: any other operations can be done for the payments after this one.
     * Transfers tokens gotten from payers and sponsors to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentConfirmed} event for each payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     * @param amounts The amounts to confirm for each payment.
     */
    function confirmPayments(
        bytes32[] calldata authorizationIds,
        uint64[] calldata amounts
    ) external;

    /**
     * @dev Executes updating and confirmation operations for a single previously made card payment.
     *
     * Updating the payment executes lazy, i.e. only if one of the provided amount changes is non-zero.
     * Otherwise the update operation is skipped.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {PaymentUpdated} event if the update operation is executed.
     * Emits a {ConfirmPayment} event.
     * Emits a {ConfirmPaymentSubsidized} event if the payment is subsidized.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param baseAmountChange The change in the base amount of the payment.
     * @param extraAmountChange The change in the extra amount of the payment.
     * @param cashbackAmountChange The requested change in the cashback amount of the payment.
     * @param subsidyAmountChange The change in the subsidy amount of the payment if it is subsidized.
     * @param amountToConfirm The amount to confirm for the payment.
     */
    function updateLazyAndConfirmPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        int64 baseAmountChange,
        int64 extraAmountChange,
        int64 cashbackAmountChange,
        int64 subsidyAmountChange,
        uint64 amountToConfirm
    ) external;


    /**
     * @dev Makes a refund for a previously made card payment.
     *
     * Emits a {PaymentRefunded} event.
     *
     * @param authorizationId The card transaction authorization ID.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param payerRefundAmount The amount of tokens to refund for the payer.
     * @param sponsorRefundAmount The amount of tokens to refund for the sponsor.
     * @param extraAmountChange The change in the extra amount of the payment.
     * @param cashbackAmountChange The requested change in the cashback amount of the payment.
     */
    function refundPayment(
        bytes32 authorizationId,
        bytes32 correlationId,
        uint64 payerRefundAmount,
        uint64 sponsorRefundAmount,
        int64 extraAmountChange,
        int64 cashbackAmountChange
    ) external;

    /**
     * @dev Makes a refund for an account where the refund cannot be associated with any card payment.
     *
     * During this operation the needed amount of tokens is transferred from the cash-out account to the target account.
     *
     * Emits a {RefundAccount} event.
     *
     * @param account The address of the account to refund.
     * @param refundAmount The amount of tokens to refund.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     */
    function refundAccount(
        bytes32 correlationId,
        address account,
        uint256 refundAmount
    ) external;


    /**
   * @dev Returns the address of the cash-out account.
     */
    function cashOutAccount() external view returns (address);

    /**
     * @dev Returns the address of the underlying token.
     */
    function underlyingToken() external view returns (address);

    /**
     * @dev Returns payment data for a card transaction authorization ID.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function paymentFor(bytes32 authorizationId) external view returns (Payment memory);

    /**
     * @dev Checks if the payment associated with the hash of a parent transaction has been revoked.
     * @param parentTxHash The hash of the parent transaction where the payment was made.
     */
    function isPaymentRevoked(bytes32 parentTxHash) external view returns (bool);

    /**
     * @dev Checks if the payment associated with the hash of a parent transaction has been reversed.
     * @param parentTxHash The hash of the parent transaction where the payment was made.
     */
    function isPaymentReversed(bytes32 parentTxHash) external view returns (bool);
}
