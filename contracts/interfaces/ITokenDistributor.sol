// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

/**
 * @title TokenDistributor interface
 * @dev The interface of the contract for token distribution among multiple accounts.
 */
interface ITokenDistributor {
    /// @dev Emitted when a new token distribution is executed.
    event DistributeTokens(
        address indexed token, // The address of the token contract whose coins has been distributed.
        uint256 total          // The total amount of distributed tokens.
    );

    /**
     * @dev Executes token distribution/airdrop among multiple accounts.
     *
     * Emits a {DistributeTokens} event.
     *
     * @param token The address of the token contract whose coins are being distributed.
     * @param recipients Token recipient addresses.
     * @param balances Token recipient target balances.
     */
    function distributeTokens(
        address token,
        address[] memory recipients,
        uint256[] memory balances
    ) external;
}
