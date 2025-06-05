// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title ICardPaymentProcessorTypes interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the types used in the wrapper contract for the card payment operations.
 */
interface ICardPaymentProcessorTypes {
    /**
     * @dev Possible statuses of a payment as an enum.
     *
     * The possible values:
     * - Nonexistent = 0 -- The payment does not exist (the default value).
     * - Uncleared = 1 ---- The status immediately after the payment making.
     * - Cleared = 2 ------ The payment has been cleared and is ready to be confirmed.
     * - Revoked = 3 ------ The payment was revoked due to some technical reason.
     *                      The related tokens have been transferred back to the customer.
     *                      The payment can be made again with the same authorizationId
     *                      if its revocation counter does not reach the configure limit.
     * - Reversed = 4 ----- The payment was reversed due to the decision of the off-chain card processing service.
     *                      The related tokens have been transferred back to the customer.
     *                      The payment cannot be made again with the same authorizationId.
     * - Confirmed = 5 ---- The payment was confirmed.
     *                      The related tokens have been transferred to a special cash-out address.
     *                      The payment cannot be made again with the same authorizationId.
     */
    enum PaymentStatus {
        Nonexistent,
        Uncleared,
        Cleared,
        Revoked,
        Reversed,
        Confirmed
    }

    /**
     * @dev Possible kinds of a payment as an enum.
     *
     * The possible values:
     * - Common = 0 ------ The payment is not subsidized.
     * - Subsidized = 1 -- The payment is subsidized.
     */
    enum PaymentKind {
        Common,
        Subsidized
    }

    /**
     * @dev The data of a single payment.
     *
     * The fields:
     * - account ------------- The account who made the payment.
     * - baseAmount ---------- The base amount of tokens in the payment.
     * - status -------------- The current status of the payment.
     * - revocationCounter --- The number of payment revocations.
     * - compensationAmount -- The total amount of compensation to the account related to the payment.
     * - refundAmount -------- The total amount of all refunds related to the payment.
     * - cashbackRate -------- The rate of cashback of the payment.
     * - extraAmount --------- The extra amount of tokens in the payment, without a cashback.
     * - sponsor ------------- The sponsor of the payment if it is subsidized. Otherwise the zero address.
     * - subsidyLimit -------- The subsidy limit of the payment if it is subsidized. Otherwise zero.
     */
    struct Payment {
        address account;
        uint256 baseAmount;
        PaymentStatus status;
        uint8 revocationCounter;
        uint256 compensationAmount;
        uint256 refundAmount;
        uint16 cashbackRate;
        uint256 extraAmount;
        address sponsor;
        uint256 subsidyLimit;
    }
}

/**
 * @title ICardPaymentProcessor interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the interface of the wrapper contract for the card payment operations.
 */
interface ICardPaymentProcessor is ICardPaymentProcessorTypes {
    // -------------------- Events -------------------------------- //

    /**
     * @dev Emitted when a payment is made.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param sumAmount The sum amount of tokens in the payment.
     * @param revocationCounter The number of payment revocations.
     * @param sender The address of the account who made the payment.
     */
    event MakePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 sumAmount,
        uint8 revocationCounter,
        address sender
    );

    /**
     * @dev Emitted when the extra amount of a payment is changed or set as non-zero during payment making.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param sumAmount The sum amount of tokens in the payment.
     * @param newExtraAmount The new extra amount of tokens in the payment.
     * @param oldExtraAmount The old extra amount of tokens in the payment.
     */
    event PaymentExtraAmountChanged(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 sumAmount,
        uint256 newExtraAmount,
        uint256 oldExtraAmount
    );

    /**
     * @dev Emitted along with the {MakePayment} event when a subsidized payment is made.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param subsidyLimit The subsidy limit of the payment.
     * @param sponsorSumAmount The sum amount of tokens in the payment.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event MakePaymentSubsidized(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed sponsor,
        uint256 subsidyLimit,
        uint256 sponsorSumAmount,
        bytes addendum
    );

    /**
     * @dev Emitted when the amount of a payment is updated.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param oldSumAmount The old sum amount of tokens in the payment.
     * @param newSumAmount The new sum amount of tokens in the payment.
     * @param oldBaseAmount The old base amount of tokens in the payment.
     * @param newBaseAmount The new base amount of tokens in the payment.
     */
    event UpdatePaymentAmount(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 oldSumAmount,
        uint256 newSumAmount,
        uint256 oldBaseAmount,
        uint256 newBaseAmount
    );

    /**
     * @dev Emitted along with the {UpdatePaymentAmount} event when the amount of a subsidized payment is updated.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param oldSponsorSumAmount The old sum amount of tokens in the payment.
     * @param newSponsorSumAmount The new sum amount of tokens in the payment.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event UpdatePaymentSubsidized(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed sponsor,
        uint256 oldSponsorSumAmount,
        uint256 newSponsorSumAmount,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is cleared.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param totalAmount The total amount of tokens in the payment.
     * @param clearedBalance The balance of cleared tokens of the account.
     * @param unclearedBalance The balance of uncleared tokens of the account.
     * @param revocationCounter The number of payment revocations.
     */
    event ClearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 totalAmount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted along with the {ClearPayment} event when a subsidized payment is cleared.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event ClearPaymentSubsidized(
        bytes16 indexed authorizationId,
        address indexed sponsor,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is uncleared.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param totalAmount The total amount of tokens in the payment.
     * @param clearedBalance The balance of cleared tokens of the account.
     * @param unclearedBalance The balance of uncleared tokens of the account.
     * @param revocationCounter The number of payment revocations.
     */
    event UnclearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 totalAmount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted along with the {UnclearPayment} event when a subsidized payment is uncleared.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event UnclearPaymentSubsidized(
        bytes16 indexed authorizationId,
        address indexed sponsor,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is revoked.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param sentAmount The amount of tokens sent back to the account.
     * @param clearedBalance The balance of cleared tokens of the account.
     * @param unclearedBalance The balance of uncleared tokens of the account.
     * @param wasPaymentCleared Whether the payment was cleared before revocation.
     * @param parentTransactionHash The hash of the parent transaction where the payment was made.
     * @param revocationCounter The number of payment revocations.
     */
    event RevokePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 sentAmount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        bool wasPaymentCleared,
        bytes32 parentTransactionHash,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted along with the {RevokePayment} event when a subsidized payment is revoked.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param sponsorSentAmount The amount of tokens sent back to the sponsor.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event RevokePaymentSubsidized(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed sponsor,
        uint256 sponsorSentAmount,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is reversed.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param sentAmount The amount of tokens sent back to the account.
     * @param clearedBalance The balance of cleared tokens of the account.
     * @param unclearedBalance The balance of uncleared tokens of the account.
     * @param wasPaymentCleared Whether the payment was cleared before reversal.
     * @param parentTransactionHash The hash of the parent transaction where the payment was made.
     * @param revocationCounter The number of payment revocations.
     */
    event ReversePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 sentAmount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        bool wasPaymentCleared,
        bytes32 parentTransactionHash,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted along with the {ReversePayment} event when a subsidized payment is reversed.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param sponsorSentAmount The amount of tokens sent back to the sponsor.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event ReversePaymentSubsidized(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed sponsor,
        uint256 sponsorSentAmount,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is confirmed.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param totalAmount The total amount of tokens in the payment.
     * @param clearedBalance The balance of cleared tokens of the account.
     * @param revocationCounter The number of payment revocations.
     */
    event ConfirmPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 totalAmount,
        uint256 clearedBalance,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted along with the {ConfirmPayment} event when a subsidized payment is confirmed.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event ConfirmPaymentSubsidized(
        bytes16 indexed authorizationId,
        address indexed sponsor,
        bytes addendum
    );

    /**
     * @dev Emitted when a payment is refunded.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param refundAmount The amount of tokens refunded to the account.
     * @param sentAmount The amount of tokens sent back to the account.
     * @param status The status of the payment.
     */
    event RefundPayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 refundAmount,
        uint256 sentAmount,
        PaymentStatus status
    );

    /**
     * @dev Emitted along with the {RefundPayment} event when a subsidized payment is refunded.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param sponsor The address of the sponsor of the payment.
     * @param sponsorRefundAmount The amount of tokens refunded to the sponsor.
     * @param sponsorSentAmount The amount of tokens sent back to the sponsor.
     * @param addendum Empty. Reserved for future possible additional information.
     */
    event RefundPaymentSubsidized(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed sponsor,
        uint256 sponsorRefundAmount,
        uint256 sponsorSentAmount,
        bytes addendum
    );

    /**
     * @dev Emitted when an account is refunded.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param account The account who made the payment.
     * @param refundAmount The amount of tokens refunded to the account.
     */
    event RefundAccount(
        bytes16 indexed correlationId,
        address indexed account,
        uint256 refundAmount
    );

    /**
     * @dev Emitted when the cash-out account is changed.
     * @param oldCashOutAccount The old address of the cash-out account.
     * @param newCashOutAccount The new address of the cash-out account.
     */
    event SetCashOutAccount(
        address oldCashOutAccount,
        address newCashOutAccount
    );

    // -------------------- View functions ------------------------ //

    /**
     * @dev Returns the address of the cash-out account.
     */
    function cashOutAccount() external view returns (address);

    /**
     * @dev Returns the address of the underlying token.
     */
    function underlyingToken() external view returns (address);

    /**
     * @dev Returns the total balance of uncleared tokens locked in the contract.
     */
    function totalUnclearedBalance() external view returns (uint256);

    /**
     * @dev Returns the total balance of cleared tokens locked in the contract.
     */
    function totalClearedBalance() external view returns (uint256);

    /**
     * @dev Returns the balance of uncleared tokens for an account.
     * @param account The address of the account.
     */
    function unclearedBalanceOf(address account) external view returns (uint256);

    /**
     * @dev Returns the balance of cleared tokens for an account.
     * @param account The address of the account.
     */
    function clearedBalanceOf(address account) external view returns (uint256);

    /**
     * @dev Returns payment data for a card transaction authorization ID.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function paymentFor(bytes16 authorizationId) external view returns (Payment memory);

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

    /**
     * @dev Returns the configured limit of revocations for a single payment.
     */
    function revocationLimit() external view returns (uint8);

    // -------------------- Transactional functions --------------- //

    /**
     * @dev Makes a card payment.
     *
     * Transfers the underlying tokens from the payer (who is the caller of the function) to this contract.
     * This function is expected to be called by any account.
     *
     * Emits a {MakePayment} event.
     * Emits a {PaymentExtraAmountChanged} event if `extraAmount` is not zero.
     *
     * @param baseAmount The base amount of tokens to transfer because of the payment.
     * @param extraAmount The extra amount of tokens to transfer because of the payment. No cashback is applied.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     */
    function makePayment(
        uint256 baseAmount,
        uint256 extraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external;

    /**
     * @dev Makes a card payment for a given account initiated by a service account.
     *
     * The payment can be subsidized with full or partial reimbursement from a specified sponsor account.
     * The payment cashback rate can be taken from the contract settings or specified at the call.
     * If cashback is disabled in the contract it will not be sent in any case.
     *
     * Transfers the underlying tokens from the account and/or sponsor to this contract.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {MakePayment} event.
     * Emits a {MakePaymentSubsidized} event if the payment is subsidized.
     * Emits a {PaymentExtraAmountChanged} event if `extraAmount` is not zero.
     *
     * @param account The account on that behalf the payment is made.
     * @param baseAmount The base amount of tokens to transfer because of the payment.
     * @param extraAmount The extra amount of tokens to transfer because of the payment. No cashback is applied.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param sponsor The address of a sponsor if the payment is subsidized, otherwise zero.
     * @param subsidyLimit The maximum amount of tokens that the sponsor is willing to compensate for the payment.
     * @param cashbackRateInPermil The cashback rate in permil for the payment or a negative value if
     *                             the contract settings are used to determine cashback. If zero cashback is not sent.
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
    ) external;

    /**
     * @dev Updates the base amount and extra amount of a previously made payment.
     *
     * Transfers the underlying tokens from the account to this contract or vise versa.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {UpdatePaymentAmount} event.
     * Emits a {UpdatePaymentAmountSubsidized} event if the payment is subsidized.
     * Emits a {PaymentExtraAmountChanged} event if `extraAmount` of the payment is changed.
     *
     * @param newBaseAmount The new base amount of the payment.
     * @param newExtraAmount The new extra amount of the payment. No cashback is applied.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     */
    function updatePaymentAmount(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external;

    /**
     * @dev Executes a clearing operation for a single previously made card payment.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ClearPayment} event.
     * Emits a {ClearPaymentSubsidized} event if the payment is subsidized.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function clearPayment(bytes16 authorizationId) external;

    /**
     * @dev Executes a clearing operation for several previously made card payments.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ClearPayment} event for each payment.
     * Emits a {ClearPaymentSubsidized} event for each subsidized payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function clearPayments(bytes16[] memory authorizationIds) external;

    /**
     * @dev Cancels a previously executed clearing operation for a single card payment.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {UnclearPayment} event.
     * Emits a {UnclearPaymentSubsidized} event if the payment is subsidized.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function unclearPayment(bytes16 authorizationId) external;

    /**
     * @dev Cancels a previously executed clearing operation for several card payments.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {UnclearPayment} event for each payment.
     * Emits a {UnclearPaymentSubsidized} event for each subsidized payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function unclearPayments(bytes16[] memory authorizationIds) external;

    /**
     * @dev Performs the reverse of a previously made card payment.
     *
     * Finalizes the payment: no other operations can be done for the payment after this one.
     * Transfers tokens back from this contract to the payer.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ReversePayment} event.
     * Emits a {ReversePaymentSubsidized} event if the payment is subsidized.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function reversePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external;

    /**
     * @dev Performs the revocation of a previously made card payment and increase its revocation counter.
     *
     * Does not finalize the payment: it can be made again until revocation counter reaches the configured limit.
     * Transfers tokens back from this contract to the payer.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {RevokePayment} event.
     * Emits a {RevokePaymentSubsidized} event if the payment is subsidized.
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
     * @dev Executes the final step of a single card payment processing with token transferring.
     *
     * Finalizes the payment: no other operations can be done for the payment after this one.
     * Transfers previously cleared tokens gotten from a payer to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ConfirmPayment} event.
     * Emits a {ConfirmPaymentSubsidized} event if the payment is subsidized.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function confirmPayment(bytes16 authorizationId) external;

    /**
     * @dev Executes the final step of several card payments processing with token transferring.
     *
     * Finalizes the payment: no other operations can be done for the payment after this one.
     * Transfers previously cleared tokens gotten from payers to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ConfirmPayment} event for each payment.
     * Emits a {ConfirmPaymentSubsidized} for each subsidized payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function confirmPayments(bytes16[] memory authorizationIds) external;

    /**
     * @dev Executes clearing and confirmation operations for a single previously made card payment.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ClearPayment} event.
     * Emits a {ClearPaymentSubsidized} event if the payment is subsidized.
     * Emits a {ConfirmPayment} event.
     * Emits a {ConfirmPaymentSubsidized} event if the payment is subsidized.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function clearAndConfirmPayment(bytes16 authorizationId) external;

    /**
     * @dev Executes updating, clearing and confirmation operations for a single previously made card payment.
     *
     * Updating of the base amount and extra amount executes lazy, i.e. only if
     * the provided new amounts differ from the current once of the payment. Otherwise the update operation is skipped.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {UpdatePaymentAmount} event if the update operation is executed.
     * Emits a {UpdatePaymentAmountSubsidized} event if the update operation is executed and the payment is subsidized.
     * Emits a {PaymentExtraAmountChanged} event if `extraAmount` of the payment is changed.
     * Emits a {ClearPayment} event.
     * Emits a {ClearPaymentSubsidized} event if the payment is subsidized.
     * Emits a {ConfirmPayment} event.
     * Emits a {ConfirmPaymentSubsidized} event if the payment is subsidized.
     *
     * @param newBaseAmount The new base amount of the payment.
     * @param newExtraAmount The new extra amount of the payment. No cashback is applied.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     */
    function updateLazyClearConfirmPayment(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external;

    /**
     * @dev Executes clearing and confirmation operations for several previously made card payments.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ClearPayment} event for each payment.
     * Emits a {ClearPaymentSubsidized} event for each subsidized payment.
     * Emits a {ConfirmPayment} event for each payment.
     * Emits a {ConfirmPaymentSubsidized} for each subsidized payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function clearAndConfirmPayments(bytes16[] memory authorizationIds) external;

    /**
     * @dev Makes a refund for a previously made card payment.
     *
     * Emits a {RefundPayment} event.
     * Emits a {RefundPaymentSubsidized} event if the payment is subsidized.
     * Emits a {PaymentExtraAmountChanged} event if `extraAmount` of the payment is changed.
     *
     * @param refundAmount The amount of tokens to refund.
     * @param newExtraAmount. A new extra amount of the payment after the refund operation.
     * @param authorizationId The card transaction authorization ID.
     * @param correlationId The ID that is correlated to this function call in the off-chain card processing backend.
     */
    function refundPayment(
        uint256 refundAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
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
        address account,
        uint256 refundAmount,
        bytes16 correlationId
    ) external;
}
