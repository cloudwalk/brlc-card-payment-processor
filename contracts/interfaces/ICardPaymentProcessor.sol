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
     * - Uncleared --- The status immediately after the payment making.
     * - Cleared ----- The payment has been cleared and is ready to be confirmed.
     * - Revoked ----- The payment was revoked due to some technical reason.
     *                 The related tokens have been transferred back to the customer.
     *                 The payment can be made again with the same authorizationId
     *                 if its revocation counter does not reach the configure limit.
     * - Reversed ---- The payment was reversed due to the decision of the off-chain card processing service.
     *                 The related tokens have been transferred back to the customer.
     *                 The payment cannot be made again with the same authorizationId.
     * - Confirmed --- The payment was confirmed.
     *                 The related tokens have been transferred to a special cash-out address.
     *                 The payment cannot be made again with the same authorizationId.
     */
    enum PaymentStatus {
        Nonexistent, // 0
        Uncleared,   // 1
        Cleared,     // 2
        Revoked,     // 3
        Reversed,    // 4
        Confirmed    // 5
    }

    /// @dev Structure with data of a single payment.
    struct Payment {
        address account;         // Account who made the payment
        uint256 amount;          // Amount of tokens in the payment
        PaymentStatus status;    // Current status of the payment according to the {PaymentStatus} enum
        uint8 revocationCounter; // Number of payment revocations
    }
}

/**
 * @title CardPaymentProcessor interface
 * @dev The interface of the wrapper contract for the card payment operations.
 */
interface ICardPaymentProcessor is ICardPaymentProcessorTypes {
    /// @dev Emitted when payment is made.
    event MakePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 amount,
        uint8 revocationCounter,
        address sender
    );

    /// @dev Emitted when payment is cleared.
    event ClearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    /// @dev Emitted when payment is uncleared.
    event UnclearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    /// @dev Emitted when payment is revoked.
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

    /// @dev Emitted when payment is reversed.
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

    /// @dev Emitted when payment is confirmed.
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

    /**
     * @dev Makes a card payment.
     *
     * Transfers the underlying tokens from the payer (who is the caller of the function) to this contract.
     * This function is expected to be called by any account.
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
     * @dev Makes a card payment from some other account.
     *
     * Transfers the underlying tokens from the account to this contract.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {MakePayment} event.
     *
     * @param account The account on that behalf the payment is made.
     * @param amount The amount of tokens to be transferred to this contract because of the payment.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to call of this function in the off-chain card processing backend.
     */
    function makePaymentFrom(
        address account,
        uint256 amount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external;

    /**
     * @dev Executes a clearing operation for a single previously made card payment.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ClearPayment} event for the payment.
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
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function clearPayments(bytes16[] memory authorizationIds) external;

    /**
     * @dev Cancels a previously executed clearing operation for a single card payment.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {UnclearPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function unclearPayment(bytes16 authorizationId) external;

    /**
     * @dev Cancels a previously executed clearing operation for several card payments.
     *
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {UnclearPayment} event for the payment.
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
     *
     * Does not finalize the payment: it can be made again until revocation counter reaches the configured limit.
     * Transfers tokens back from this contract to the payer.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
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
     * @dev Executes the final step of a single card payment processing with token transferring.
     *
     * Finalizes the payment: no other operations can be done for the payment after this one.
     * Transfers previously cleared tokens gotten from a payer to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ConfirmPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param cashOutAccount The account to transfer cleared tokens to.
     */
    function confirmPayment(bytes16 authorizationId, address cashOutAccount) external;

    /**
     * @dev Executes the final step of several card payments processing with token transferring.
     *
     * Finalizes the payment: no other operations can be done for the payment after this one.
     * Transfers previously cleared tokens gotten from payers to a dedicated cash-out account for further operations.
     * This function can be called by a limited number of accounts that are allowed to execute processing operations.
     *
     * Emits a {ConfirmPayment} event for each payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     * @param cashOutAccount The account to transfer cleared tokens to.
     */
    function confirmPayments(bytes16[] memory authorizationIds, address cashOutAccount) external;
}
