// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title ICashbackDistributorTypes interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev The custom types used in the wrapper contract for the cashback operations.
 */
interface ICashbackDistributorTypes {
    /**
     * @dev Kinds of a cashback operation as an enum.
     *
     * The possible values:
     * - Manual = 0 ------- The cashback is sent manually (the default value).
     * - CardPayment = 1 -- The cashback is sent through the CardPaymentProcessor contract.
     */
    enum CashbackKind {
        Manual,
        CardPayment
    }

    /**
     * @dev Statuses of a cashback operation as an enum.
     *
     * The possible values:
     * - Nonexistent = 0 -- The cashback operation does not exist (the default value).
     * - Success = 1 ------ The operation has been successfully executed (cashback sent fully).
     * - Blocklisted = 2 -- The cashback operation has been refused because the target account is blocklisted.
     * - OutOfFunds = 3 --- The cashback operation has been refused because the contract does not have enough tokens.
     * - Disabled = 4 ----- The cashback operation has been refused because cashback operations are disabled.
     * - Revoked = 5 ------ Obsolete and not in use anymore.
     * - Capped = 6 ------- The cashback operation has been refused because the cap for the period has been reached.
     * - Partial = 7 ------ The operation has been successfully executed (cashback sent partially).
     */
    enum CashbackStatus {
        Nonexistent,
        Success,
        Blocklisted,
        OutOfFunds,
        Disabled,
        Revoked,
        Capped,
        Partial
    }

    /**
     * @dev Statuses of a cashback revocation operation as an enum.
     *
     * The possible values:
     * - Unknown = 0 --------- The operation has not been initiated (the default value).
     * - Success = 1 --------- The operation has been successfully executed.
     * - Inapplicable = 2 ---- The operation has been failed because the cashback does not have a relevant status.
     * - OutOfFunds = 3 ------ The operation has been failed because the caller does not have enough tokens.
     * - OutOfAllowance = 4 -- The operation has been failed because
     *                         the caller does not have enough allowance for the contract.
     * - OutOfBalance = 5 ---- The operation has been failed because the revocation amount exceeds the cashback amount.
     */
    enum RevocationStatus {
        Unknown,
        Success,
        Inapplicable,
        OutOfFunds,
        OutOfAllowance,
        OutOfBalance
    }

    /**
     * @dev Statuses of a cashback increase operation as an enum.
     *
     * The possible values:
     * - Nonexistent = 0 --- The operation does not exist (the default value).
     * - Success = 1 ------- The operation has been successfully executed (cashback sent fully).
     * - Blocklisted = 2 --- The operation has been refused because the target account is blocklisted.
     * - OutOfFunds = 3 ---- The operation has been refused because the contract does not have enough tokens.
     * - Disabled = 4 ------ The operation has been refused because cashback operations are disabled.
     * - Inapplicable = 5 -- The operation has been failed because the cashback does not have a relevant status.
     * - Capped = 6 -------- The operation has been refused because the cap for the period has been reached.
     * - Partial = 7 ------- The operation has been successfully executed (cashback sent partially).
     */
    enum IncreaseStatus {
        Nonexistent,
        Success,
        Blocklisted,
        OutOfFunds,
        Disabled,
        Inapplicable,
        Capped,
        Partial
    }

    /**
     * @dev The data of a single cashback operation.
     *
     * Fields:
     * - token ---------- The address of the token contract that is used for the cashback operation.
     * - kind ----------- The kind of the cashback operation.
     * - status --------- The status of the cashback operation.
     * - externalId ----- The external identifier of the cashback operation.
     * - recipient ------ The account that received the cashback.
     * - amount --------- The requested or actually sent amount of cashback (see the notes below).
     * - sender --------- The account that initiated the cashback operation.
     * - revokedAmount -- The amount of cashback that has been revoked.
     *
     * NOTES:
     *  1. The `amount` field of the structure contains the actual amount of sent cashback only if
     *     the operation was successful or partially successful according to the `status` field,
     *     otherwise the `amount` field contains the requested amount of cashback to send.
     *  2. The actual cashback balance of an operation is the `amount` field minus the `revokedAmount` field.
     */
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
 * @title ICashbackDistributorPrimary interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev The primary interface of the wrapper contract for the cashback operations.
 */
interface ICashbackDistributorPrimary is ICashbackDistributorTypes {
    // ------------------ Events ---------------------------------- //

    /**
     * @dev Emitted when a cashback operation is executed.
     *
     * NOTE: The `amount` field of the event contains the actual amount of sent cashback only if
     * the operation was successful or partially successful according to the `status` field,
     * otherwise the `amount` field contains the requested amount of cashback to send.
     *
     * @param token The token contract of the cashback operation.
     * @param kind The kind of the cashback operation.
     * @param status The result of the cashback operation.
     * @param externalId The external identifier of the cashback operation.
     * @param recipient The account to which the cashback is intended.
     * @param amount The requested or actually sent amount of cashback (see the note above).
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
     * @param cashbackKind The kind of the initial cashback operation.
     * @param cashbackStatus The status of the initial cashback operation before the revocation operation.
     * @param status The status of the revocation.
     * @param externalId The external identifier of the initial cashback operation.
     * @param recipient The account that received the cashback.
     * @param amount The requested amount of cashback to revoke.
     * @param totalAmount The total amount of cashback that the recipient has after this operation.
     * @param sender The account that initiated the cashback revocation operation.
     * @param nonce The nonce of the initial cashback operation.
     */
    event RevokeCashback(
        address token,
        CashbackKind cashbackKind,
        CashbackStatus cashbackStatus,
        RevocationStatus indexed status,
        bytes32 indexed externalId,
        address indexed recipient,
        uint256 amount,
        uint256 totalAmount,
        address sender,
        uint256 nonce
    );

    /**
     * @dev Emitted when a cashback increase operation is executed.
     *
     * NOTE: The `amount` field of the event contains the actual amount of additionally sent cashback only if
     * the operation was successful or partially successful according to the `status` field,
     * otherwise the `amount` field contains the requested amount of cashback to increase.
     *
     * @param token The token contract of the cashback operation.
     * @param cashbackKind The kind of the initial cashback operation.
     * @param cashbackStatus The status of the initial cashback operation before the increase operation.
     * @param status The status of the increase operation.
     * @param externalId The external identifier of the initial cashback operation.
     * @param recipient The account that received the cashback.
     * @param amount The requested or actual amount of cashback increase (see the note above).
     * @param totalAmount The total amount of cashback that the recipient has after this operation.
     * @param sender The account that initiated the cashback increase operation.
     * @param nonce The nonce of the initial cashback operation.
     */
    event IncreaseCashback(
        address token,
        CashbackKind cashbackKind,
        CashbackStatus cashbackStatus,
        IncreaseStatus indexed status,
        bytes32 indexed externalId,
        address indexed recipient,
        uint256 amount,
        uint256 totalAmount,
        address sender,
        uint256 nonce
    );

    // ------------------ Transactional functions --------------- //

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
     * @param amount The requested amount of cashback to send.
     * @return success True if the cashback has been fully or partially sent.
     * @return sentAmount The amount of the actual cashback sent.
     * @return nonce The nonce of the newly created cashback operation.
     */
    function sendCashback(
        address token,
        CashbackKind kind,
        bytes32 externalId,
        address recipient,
        uint256 amount
    ) external returns (bool success, uint256 sentAmount, uint256 nonce);

    /**
     * @dev Revokes a previously sent cashback.
     *
     * Transfers the underlying tokens from the caller to the contract.
     * This function is expected to be called by a limited number of accounts
     * that are allowed to execute cashback operations.
     *
     * Emits a {RevokeCashback} event if the cashback is successfully revoked.
     *
     * @param nonce The nonce of the cashback operation.
     * @param amount The requested amount of cashback to revoke.
     * @return success True if the cashback revocation was successful.
     */
    function revokeCashback(uint256 nonce, uint256 amount) external returns (bool success);

    /**
     * @dev Increases a previously sent cashback.
     *
     * Transfers the underlying tokens from the contract to the recipient if there are appropriate conditions.
     * This function is expected to be called by a limited number of accounts
     * that are allowed to execute cashback operations.
     *
     * Emits a {IncreaseCashback} event if the cashback is successfully increased.
     *
     * @param nonce The nonce of the cashback operation.
     * @param amount The requested amount of cashback increase.
     * @return success True if the additional cashback has been fully or partially sent.
     * @return sentAmount The amount of the actual cashback increase.
     */
    function increaseCashback(uint256 nonce, uint256 amount) external returns (bool success, uint256 sentAmount);

    // ------------------ View functions ------------------------ //

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
     * @dev Returns the total amount of all the successful cashback operations associated with a token and an external ID.
     * @param token The token contract address of the cashback operations to define the returned total amount.
     * @param externalId The external identifier of the cashback operations to define the returned total amount.
     */
    function getTotalCashbackByTokenAndExternalId(address token, bytes32 externalId) external view returns (uint256);

    /**
     * @dev Returns the total amount of all the successful cashback operations associated with a token and a recipient.
     * @param token The token contract address of the cashback operations to define the returned total amount.
     * @param recipient The recipient address of the cashback operations to define the returned total amount.
     */
    function getTotalCashbackByTokenAndRecipient(address token, address recipient) external view returns (uint256);

    /**
     * @dev Returns the total amount of all the successful cashback operations since the last reset of the periodical cap.
     * @param token The token contract address of the cashback operations to define the returned total amount.
     * @param recipient The recipient address of the cashback operations to define the returned total amount.
     */
    function getCashbackSinceLastReset(address token, address recipient) external view returns (uint256);

    /**
     * @dev Returns the last time the cashback periodical cap was reset for a token and a recipient.
     * @param token The token contract address of the cashback operations to define the returned last time.
     * @param recipient The recipient address of the cashback operations to define the returned last time.
     */
    function getCashbackLastTimeReset(address token, address recipient) external view returns (uint256);

    /**
     * @dev Determines a preview of the cashback cap state for a token and a recipient at the current block timestamp.
     * @param token The token contract address of the cashback operations to define the returned cashback cap state.
     * @param recipient The recipient address of the cashback operations to define the returned cashback cap state.
     * @return cashbackPeriodStart The start time of the current cashback cap period.
     * @return overallCashbackForPeriod The total amount of cashback within the current cashback cap period.
     */
    function previewCashbackCap(
        address token,
        address recipient
    ) external view returns (uint256 cashbackPeriodStart, uint256 overallCashbackForPeriod);
}

/**
 * @title ICashbackDistributorConfiguration interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev The configuration interface of the wrapper contract for the cashback operations.
 */
interface ICashbackDistributorConfiguration {
    // ------------------ Events ---------------------------------- //

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

    // ------------------ Transactional functions --------------- //

    /**
     * @dev Enables the cashback operations.
     *
     * This function is expected to be called by a limited number of accounts
     * that are allowed to control cashback operations.
     *
     * Emits an {Enable} event.
     */
    function enable() external;

    /**
     * @dev Disables the cashback operations.
     *
     * This function is expected to be called by a limited number of accounts
     * that are allowed to control cashback operations.
     *
     * Emits a {Disable} event.
     */
    function disable() external;
}
/**
 * @title ICashbackDistributorErrors interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev The custom errors used in the wrapper contract for the cashback operations.
 */
interface ICashbackDistributorErrors {
    /// @dev The cashback operations are already disabled.
    error CashbackAlreadyDisabled();

    /// @dev The cashback operations are already enabled.
    error CashbackAlreadyEnabled();

    /// @dev Zero external identifier has been passed as a function argument.
    error ZeroExternalId();

    /// @dev The zero account address has been passed as a function argument.
    error ZeroRecipientAddress();

    /// @dev The zero token address has been passed as a function argument.
    error ZeroTokenAddress();
}

/**
 * @title ICashbackDistributor interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the interface of the wrapper contract for the cashback operations.
 */
interface ICashbackDistributor is
    ICashbackDistributorPrimary,
    ICashbackDistributorConfiguration,
    ICashbackDistributorErrors
{}
