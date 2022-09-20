// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title PixCashier interface
 * @dev The interface of the wrapper contract for PIX cash-in and cash-out operations.
 */
interface IPixCashier {
    /// @dev Emitted when a new cash-in operation is executed.
    event CashIn(
        address indexed account, // The account that receives tokens.
        uint256 amount,          // The amount of tokens to receive.
        bytes32 indexed txId     // The off-chain transaction identifier.
    );

    /// @dev Emitted when a new cash-out operation is initiated.
    event CashOut(
        address indexed account, // The account that executes tokens cash-out.
        uint256 amount,          // The amount of tokens to cash-out.
        uint256 balance,         // The new pending cash-out balance of the account.
        bytes32 indexed txId     // The off-chain transaction identifier.
    );

    /// @dev Emitted when a cash-out operation is confirmed.
    event CashOutConfirm(
        address indexed account, // The account that executes tokens cash-out.
        uint256 amount,          // The amount of tokens to cash-out.
        uint256 balance,         // The new pending cash-out balance of the account.
        bytes32 indexed txId     // The off-chain transaction identifier.
    );

    /// @dev Emitted when a cash-out operation is reversed.
    event CashOutReverse(
        address indexed account, // The account that executes tokens cash-out.
        uint256 amount,          // The amount of tokens to cash-out.
        uint256 balance,         // The new pending cash-out balance of the account.
        bytes32 indexed txId     // The off-chain transaction identifier.
    );

    /**
     * @dev Returns the address of the underlying token.
     */
    function underlyingToken() external view returns (address);

    /**
     * @dev Returns the pending cash-out balance for an account.
     * @param account The address of the account.
     */
    function cashOutBalanceOf(address account) external view returns (uint256);

    /**
     * @dev Executes a cash-in operation.
     *
     * This function can be called by a limited number of accounts that are allowed to execute cash-in operations.
     *
     * Emits a {CashIn} event.
     *
     * @param account The address of the tokens recipient.
     * @param amount The amount of tokens to be received.
     * @param txId The off-chain transaction identifier.
     */
    function cashIn(
        address account,
        uint256 amount,
        bytes32 txId
    ) external;

    /**
     * @dev Initiates a cash-out operation.
     *
     * Transfers tokens from the caller to the contract.
     * This function is expected to be called by any account.
     *
     * Emits a {CashOut} event.
     *
     * @param amount The amount of tokens to be cash-outed.
     * @param txId The off-chain transaction identifier.
     */
    function cashOut(uint256 amount, bytes32 txId) external;

    /**
     * @dev Confirms a cash-out operation.
     *
     * Burns tokens previously transferred to the contract.
     * This function is expected to be called by any account.
     *
     * Emits a {CashOutConfirm} event.
     *
     * @param amount The amount of tokens to be burned.
     * @param txId The off-chain transaction identifier.
     */
    function cashOutConfirm(uint256 amount, bytes32 txId) external;

    /**
     * @dev Reverts a cash-out operation.
     *
     * Transfers tokens back from the contract to the caller.
     * This function is expected to be called by any account.
     *
     * Emits a {CashOutReverse} event.
     *
     * @param amount The amount of tokens to be transferred back.
     * @param txId The off-chain transaction identifier.
     */
    function cashOutReverse(uint256 amount, bytes32 txId) external;
}
