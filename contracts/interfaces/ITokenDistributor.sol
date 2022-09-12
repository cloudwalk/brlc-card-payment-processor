// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

/**
 * @title TokenDistributor interface
 * @dev The interface of the contract for token distribution among multiple accounts.
 */
interface ITokenDistributor {
    /// @dev Emitted when a new token distribution is executed.
    event DistributeTokens(
        address indexed token, // The address of the token used for distribution.
        uint256 totalAmount    // The total amount of distributed tokens.
    );

    /**
     * @dev Executes token distribution/airdrop among multiple accounts.
     *
     * Emits a {DistributeTokens} event.
     *
     * @param token The address of the token to use for distribution.
     * @param recipients An array of token recipient addresses.
     * @param balances An array of token recipient target balances.
     */
    function distributeTokens(
        address token,
        address[] memory recipients,
        uint256[] memory balances
    ) external;
}
