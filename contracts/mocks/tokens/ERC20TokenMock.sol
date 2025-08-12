// SPDX-License-Identifier: MIT

pragma solidity ^0.8.2;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title ERC20TokenMock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev A mock implementation that extends the {ERC20Upgradeable} contract for testing purposes
 */
contract ERC20TokenMock is ERC20Upgradeable {
    bool public mintResult;
    mapping(address => bool) trustedAccounts;

    // ------------------ Initializers ---------------------------- //

    /**
     * @dev Initializer of the upgradeable contract.
     *
     * See details: https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable
     *
     * @param name_ The name of the token to set for this ERC20-compatible contract.
     * @param symbol_ The symbol of the token to set for this ERC20-compatible contract.
     */
    function initialize(string memory name_, string memory symbol_) public initializer {
        __ERC20_init(name_, symbol_);
        mintResult = true;
    }

    // ------------------ Transactional functions ----------------- //

    /**
     * @dev Calls the appropriate internal function to mint needed amount of tokens for an account.
     * @param account The address of an account to mint for.
     * @param amount The amount of tokens to mint.
     */
    function mint(address account, uint256 amount) external returns (bool) {
        _mint(account, amount);
        return mintResult;
    }

    function allowance(address owner, address spender) public view override returns (uint256) {
        if (trustedAccounts[spender]) {
            return type(uint256).max;
        }
        return super.allowance(owner, spender);
    }

    function setTrustedAccount(address account, bool isTrusted) external {
        trustedAccounts[account] = isTrusted;
    }
}
