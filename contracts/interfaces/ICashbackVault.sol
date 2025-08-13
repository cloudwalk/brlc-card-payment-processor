// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title ICashbackVaultPrimary interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev The primary part of the cashback vault smart contract interface.
 */
interface ICashbackVault {
    function grantCashback(address user, uint256 amount) external;

    function revokeCashback(address user, uint256 amount) external;

    // --- View functions ----- //

    /**
     * @dev Returns the cashback balance of a specific user.
     * @param user The user to check the cashback balance of.
     * @return The current cashback balance of the user.
     */
    function getCashbackBalance(address user) external view returns (uint256);
}
