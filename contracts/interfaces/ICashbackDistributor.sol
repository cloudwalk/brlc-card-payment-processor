// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title CashbackDistributor types interface
 */
interface ICashbackDistributorTypes {
    /**
     * @dev Kinds of a cashback operation as an enum.
     *
     * The possible values:
     * - Manual ------ The cashback is sent manually (the default value).
     * - CardPayment - The cashback is sent through the CardPaymentProcessor contract.
     */
    enum CashbackKind {
        Manual,     // 0
        CardPayment // 1
    }

    /**
     * @dev Statuses of a cashback operation as an enum.
     *
     * The possible values:
     * - Nonexistent - The cashback operation does not exist (the default value).
     * - Success ----- The cashback operation has been successfully sent.
     * - Blacklisted - The cashback operation has been refused because the target account is blacklisted.
     * - OutOfFunds -- The cashback operation has been refused because the contract has not enough tokens.
     * - Disabled ---- The cashback operation has been refused because the cashback operations are disabled.
     * - Revoked ----- Obsolete and not in use anymore.
     */
    enum CashbackStatus {
        Nonexistent, // 0
        Success,     // 1
        Blacklisted, // 2
        OutOfFunds,  // 3
        Disabled,    // 4
        Revoked      // 5
    }

    /**
     * @dev Statuses of a cashback revocation operation as an enum.
     *
     * The possible values:
     * - Unknown -------- The operation has not been initiated (the default value).
     * - Success -------- The operation has been successfully executed.
     * - Inapplicable --- The operation has been failed because the cashback has not relevant status.
     * - OutOfFunds ----- The operation has been failed because the caller has not enough tokens.
     * - OutOfAllowance - The operation has been failed because the caller has not enough allowance for the contract.
     * - OutOfBalance --- The operation has been failed because the revocation amount is greater than the cashback amount.
     */
    enum RevocationStatus {
        Unknown,        // 0
        Success,        // 1
        Inapplicable,   // 2
        OutOfFunds,     // 3
        OutOfAllowance, // 4
        OutOfBalance    // 5
    }

    /// @dev Structure with data of a single cashback operation.
    struct Cashback {
        address token;
        CashbackKind kind;
        CashbackStatus status;
        bytes32 externalId;
        address recipient;
        uint256 amount;
        address sender;
        uint256 revokedAmount;
    }
}

/**
 * @title CashbackDistributor interface
 * @dev The interface of the wrapper contract for the cashback operations.
 */
interface ICashbackDistributor is ICashbackDistributorTypes {
    /**
     * @dev Emitted when a cashback operation is executed.
     * @param token The token contract of the cashback operation.
     * @param kind The kind of the cashback operation.
     * @param status The result of the cashback operation.
     * @param externalId The external identifier of the cashback operation.
     * @param recipient The account to which the cashback is intended.
     * @param amount The amount of the cashback.
     * @param sender The account that initiated the cashback operation.
     * @param nonce The nonce of the cashback operation internally assigned by the contract.
     */
    event SendCashback(
        address token,
        CashbackKind kind,
        CashbackStatus indexed status,
        bytes32 indexed externalId,
        address indexed recipient,
        uint256 amount,
        address sender,
        uint256 nonce
    );

    /**
     * @dev Emitted when a cashback operation is revoked.
     * @param token The token contract of the cashback operation.
     * @param cashbackKind The kind of the cashback operation.
     * @param cashbackStatus The status of the cashback operation before the revocation.
     * @param status The status of the revocation.
     * @param externalId The external identifier of the cashback operation.
     * @param recipient The account that received the cashback.
     * @param amount The amount of the revoked cashback.
     * @param sender The account that initiated the cashback revocation operation.
     * @param nonce The nonce of the cashback operation.
     */
    event RevokeCashback(
        address token,
        CashbackKind cashbackKind,
        CashbackStatus cashbackStatus,
        RevocationStatus indexed status,
        bytes32 indexed externalId,
        address indexed recipient,
        uint256 amount,
        address sender,
        uint256 nonce
    );

    /**
     * @dev Emitted when cashback operations are enabled.
     * @param sender The account that enabled the operations.
     */
    event Enable(address sender);

    /**
     * @dev Emitted when cashback operations are disabled.
     * @param sender The account that disabled the operations.
     */
    event Disable(address sender);

    /**
     * @dev Sends a cashback to a recipient.
     *
     * Transfers the underlying tokens from the contract to the recipient if there are appropriate conditions.
     * This function is expected to be called by a limited number of accounts
     * that are allowed to execute cashback operations.
     *
     * Emits a {SendCashback} event.
     *
     * @param token The address of the cashback token.
     * @param kind The kind of the cashback operation.
     * @param externalId The external identifier of the cashback operation.
     * @param recipient The account to which the cashback is intended.
     * @param amount The amount of tokens to send.
     * @return success True if the cashback has been successfully sent.
     * @return nonce The nonce of the newly created cashback operation.
     */
    function sendCashback(
        address token,
        CashbackKind kind,
        bytes32 externalId,
        address recipient,
        uint256 amount
    ) external returns (bool success, uint256 nonce);

    /**
     * @dev Revokes a previously sent cashback.
     *
     * Transfers the underlying tokens from the caller to the contract.
     * This function is expected to be called by a limited number of accounts
     * that are allowed to execute cashback operations.
     *
     * Emits a {RevokeCashback} event if the cashback is successfully revoked.
     *
     * @param nonce The nonce of the cashback operation to revoke.
     * @param amount The amount of tokens to revoke during the operation.
     * @return success True if the cashback revocation was successful.
     */
    function revokeCashback(uint256 nonce, uint256 amount) external returns (bool success);

    /**
     * @dev Enables the cashback operations.
     *
     * This function is expected to be called by a limited number of accounts
     * that are allowed to control cashback operations.
     *
     * Emits a {EnableCashback} event.
     */
    function enable() external;

    /**
     * @dev Disables the cashback operations.
     *
     * This function is expected to be called by a limited number of accounts
     * that are allowed to control cashback operations.
     *
     * Emits a {DisableCashback} event.
     */
    function disable() external;

    /**
     * @dev Checks if the cashback operations are enabled.
     */
    function enabled() external view returns (bool);

    /**
     * @dev Returns the nonce of the next cashback operation.
     */
    function nextNonce() external view returns (uint256);

    /**
     * @dev Returns the data of a cashback operation by its nonce.
     * @param nonce The nonce of the cashback operation to return.
     */
    function getCashback(uint256 nonce) external view returns (Cashback memory cashback);

    /**
     * @dev Returns the data of cashback operations by their nonces.
     * @param nonces The array of nonces of cashback operations to return.
     */
    function getCashbacks(uint256[] calldata nonces) external view returns (Cashback[] memory cashbacks);

    /**
     * @dev Returns an array of cashback nonces associated with an external identifier.
     * @param externalId The external cashback identifier to return nonces.
     * @param index The index of the first nonce in the range to return.
     * @param limit The max number of nonces in the range to return.
     */
    function getCashbackNonces(
        bytes32 externalId,
        uint256 index,
        uint256 limit
    ) external view returns (uint256[] memory);

    /**
     * @dev Returns the total amount of all the success cashback operations associated with a token and an external ID.
     * @param token The token contract address of the cashback operations to define the returned total amount.
     * @param externalId The external identifier of the cashback operations to define the returned total amount.
     */
    function getTotalCashbackByTokenAndExternalId(address token, bytes32 externalId) external view returns (uint256);

    /**
     * @dev Returns the total amount of all the success cashback operations associated with a token and a recipient.
     * @param token The token contract address of the cashback operations to define the returned total amount.
     * @param recipient The recipient address of the cashback operations to define the returned total amount.
     */
    function getTotalCashbackByTokenAndRecipient(address token, address recipient) external view returns (uint256);
}