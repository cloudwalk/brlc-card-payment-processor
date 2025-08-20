// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import { ICashbackVault } from "../interfaces/ICashbackVault.sol";

/**
 * @title CashbackVaultMock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev An implementation of the {ICashbackVault} interface for test purposes.
 */
contract CashbackVaultMock is ICashbackVault {
    address public token;
    mapping(address => uint256) public cashbackBalances;

    constructor(address token_) {
        token = token_;
    }

    function grantCashback(address user, uint64 amount) external {
        IERC20Upgradeable(token).transferFrom(msg.sender, address(this), amount);
        cashbackBalances[user] += amount;
    }

    function revokeCashback(address user, uint64 amount) external {
        IERC20Upgradeable(token).transfer(msg.sender, amount);
        cashbackBalances[user] -= amount;
    }

    function getAccountCashbackBalance(address user) external view returns (uint256) {
        return cashbackBalances[user];
    }

    function proveCashbackVault() external pure {}

    function underlyingToken() external view returns (address) {
        return token;
    }

    function claim(address account, uint256 amount) external {
        cashbackBalances[account] -= amount;
        IERC20Upgradeable(token).transfer(account, amount);
    }
}
