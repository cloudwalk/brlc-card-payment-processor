// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

/**
 * @title CardPaymentProcessor library
 */
library CardPaymentProcessor {
    /**
     * @dev Possible statuses of a payment as an enum.
     *
     * The possible values:
     * - Nonexistent - The payment does not exist (the default value).
     * - Uncleared --- The status immediately after the payment making.
     * - Cleared ----- The payment has been cleared and is ready to be confirmed.
     * - Revoked ----- The payment was revoked due to some technical reason.
     *                 The related tokens have been transferred back to a customer.
     *                 The payment can be made again with the same authorizationId.
     * - Reversed ---- The payment was reversed due to the decision of the off-chain card processing service.
     *                 The related tokens have been transferred back to a customer.
     *                 The payment cannot be made again with the same authorizationId.
     */
    enum PaymentStatus {
        Nonexistent, // 0
        Uncleared, // 1
        Cleared, // 2
        Revoked, // 3
        Reversed, // 4
        Confirmed // 5
    }

    /**
     * @dev Structure with data of a single payment.
     */
    struct Payment {
        // Account who made the payment
        address account;
        // Amount of tokens in the payment
        uint256 amount;
        // Current status of the payment according to the {PaymentStatus} enum
        PaymentStatus status;
        // Number of payment revocations
        uint8 revocationCounter;
    }
}

/**
 * @title CardPaymentProcessor interface
 */
interface ICardPaymentProcessor {
    /**
     * @dev Emitted when payment is made.
     */
    event MakePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 amount,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted when payment is cleared.
     */
    event ClearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted when payment is uncleared.
     */
    event UnclearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted when payment is revoked.
     */
    event RevokePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        bool wasPaymentCleared,
        bytes32 parentTransactionHash,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted when payment is reversed.
     */
    event ReversePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        bool wasPaymentCleared,
        bytes32 parentTransactionHash,
        uint8 revocationCounter
    );

    /**
     * @dev Emitted when payment is confirmed.
     */
    event ConfirmPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint8 revocationCounter
    );

    /**
     * @dev Returns the address of the underlying token.
     */
    function underlyingToken() external view returns (address);

    /**
     * @dev Returns the total uncleared amount of tokens locked in the contract.
     */
    function totalUnclearedBalance() external view returns (uint256);

    /**
     * @dev Returns the total cleared amount of tokens locked in the contract.
     */
    function totalClearedBalance() external view returns (uint256);

    /**
     * @dev Returns the uncleared balance for an account.
     * @param account The address of the account.
     */
    function unclearedBalanceOf(address account) external view returns (uint256);

    /**
     * @dev Returns the cleared balance for an account.
     * @param account The address of the account.
     */
    function clearedBalanceOf(address account) external view returns (uint256);

    /**
     * @dev Returns payment data for a card transaction authorization ID.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function paymentFor(bytes16 authorizationId) external view returns (CardPaymentProcessor.Payment memory);

    /**
     * @dev Checks if a payment related to a parent transaction hash has been revoked.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function isPaymentRevoked(bytes32 parentTxHash) external view returns (bool);

    /**
     * @dev Checks if a payment related to a parent transaction hash has been reversed.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function isPaymentReversed(bytes32 parentTxHash) external view returns (bool);

    /**
     * @dev Returns the limit on the number of payment revocations.
     */
    function revocationLimit() external view returns (uint8);

    /**
     * @dev Makes a card payment.
     *
     * Transfers the underlying tokens from the payer (who is the caller of the function) to this contract.
     *
     * Requirements:
     *
     * - The amount of tokens must be greater then zero.
     * - The authorization ID of the payment must not be zero.
     * - The payment with the authorization ID must not exist or be revoked.
     *
     * Emits a {MakePayment} event.
     *
     * @param amount The amount of tokens to be transferred to this contract because of the payment.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to call of this function in the off-chain card processing backend.
     */
    function makePayment(
        uint256 amount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external;

    /**
     * @dev Executes a clearing operation for a single previously made card payment.
     *
     * Requirements:
     *
     * - The payment must have the "uncleared" status.
     * - The input authorization ID of the payment must not be zero.
     *
     * Emits a {ClearPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function clearPayment(bytes16 authorizationId) external;

    /**
     * @dev Executes a clearing operation for several previously made card payments.
     *
     * Requirements:
     *
     * - Each payment must have the "uncleared" status or the call will be reverted.
     * - The input array of the the authorization IDs must not be empty.
     * - All the authorization IDs of the payments must not be zero.
     *
     * Emits a {ClearPayment} event for each payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function clearPayments(bytes16[] memory authorizationIds) external;

    /**
     * @dev Cancels a previously executed clearing operation for a single card payment.
     *
     * Requirements:
     *
     * - The payment must have the "cleared" status or the call will be reverted.
     * - The input authorization ID of the payment must not be zero.
     *
     * Emits a {UnclearPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function unclearPayment(bytes16 authorizationId) external;

    /**
     * @dev Cancels a previously executed clearing operation for several card payments.
     *
     * Requirements:
     *
     * - Each payment must have the "cleared" status or the call will be reverted.
     * - The input array of the the authorization IDs must not be empty.
     * - All the authorization IDs of the payments must not be zero.
     *
     * Emits a {UnclearPayment} event for the payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function unclearPayments(bytes16[] memory authorizationIds) external;

    /**
     * @dev Performs the reverse of a previously made card payment.
     * Finalizes the payment: no other operations can be done for the payment.
     * Transfers tokens back from this contract to the payer.
     *
     * Requirements:
     *
     * - The payment must have "cleared" or "uncleared" statuses.
     * - The input authorization ID and parent transaction hash of the payment must not be zero.
     *
     * Emits a {ReversePayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to call of this function in the off-chain card processing backend.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function reversePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external;

    /**
     * @dev Performs the revocation of a previously made card payment and increase its revocation counter.
     * Does not finalize the payment: it can be made again until revocation counter reaches the configured maximum.
     * Transfers tokens back from this contract to the payer.
     *
     * Requirements:
     *
     * - The payment must have "cleared" or "uncleared" statuses.
     * - The input authorization ID and parent transaction hash of the payment must not be zero.
     *
     * Emits a {RevokePayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to call of this function in the off-chain card processing backend.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function revokePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external;

    /**
     * @dev Executes the final step of single card payments processing with token transferring.
     * Finalizes the payment: no other operations can be done for the payment.
     * Transfers previously cleared tokens gotten from a payer to a dedicated cash-out account for further operations.
     *
     * Requirements:
     *
     * - The payment must have the "cleared" status.
     * - The input authorization ID and cash out account of the payment must not be zero.
     *
     * Emits a {ConfirmPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param cashOutAccount The account to transfer cleared tokens to.
     */
    function confirmPayment(bytes16 authorizationId, address cashOutAccount) external;

    /**
     * @dev Executes the final step of several card payments processing with token transferring.
     * Finalizes the payment: no other operations can be done for the payments.
     * Transfers previously cleared tokens gotten from payers to a dedicated cash-out account for further operations.
     *
     * Requirements:
     *
     * - Each payment must have the "cleared" status or the call will be reverted.
     *
     * Emits a {ConfirmPayment} event for the payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     * @param cashOutAccount The account to transfer cleared tokens to.
     */
    function confirmPayments(bytes16[] memory authorizationIds, address cashOutAccount) external;
}
