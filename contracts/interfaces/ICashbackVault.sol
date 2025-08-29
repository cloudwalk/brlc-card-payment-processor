// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title ICashbackVaultPrimary interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev The primary part of the cashback vault smart contract interface.
 */
interface ICashbackVault {
    function grantCashback(address user, uint64 amount) external;

    function revokeCashback(address user, uint64 amount) external;

    function getAccountCashbackBalance(address account) external view returns (uint256);

    function proveCashbackVault() external pure;

    function underlyingToken() external view returns (address);
}
