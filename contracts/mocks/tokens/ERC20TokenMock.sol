// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ERC20TokenMock contract
 * @dev An implementation of the {ERC20Upgradeable} contract for testing purposes
 */
contract ERC20TokenMock is ERC20 {
    /// @dev A special amount when the transfer functions should return `false`.
    uint256 public specialAmountToReturnFalse;

    /// @dev A special amount when the transfer functions should revert.
    uint256 public specialAmountToRevert;

    // ------------------ Constructor ----------------------------- //

    /**
     * @dev The initialize function of the upgradable contract.
     * @param name_ The name of the token to set for this ERC20-comparable contract.
     * @param symbol_ The symbol of the token to set for this ERC20-comparable contract.
     */
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        specialAmountToReturnFalse = type(uint256).max;
        specialAmountToRevert = type(uint256).max;
    }

    // ------------------ Functions ------------------------------- //

    /**
     * @dev Calls the appropriate internal function to mint needed amount of tokens for an account.
     * @param account The address of an account to mint for.
     * @param amount The amount of tokens to mint.
     */
    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    /// @dev The variation of the standard transfer function that returns `false` if the special amount is passed.
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (amount == specialAmountToRevert) {
            revert("ERC20TokenMock: The special amount has been used inside the 'transfer()' function");
        } else if (amount == specialAmountToReturnFalse) {
            return false;
        } else {
            return super.transfer(to, amount);
        }
    }

    /// @dev The variation of the standard transfer from function that returns `false` if the special amount is passed.
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (amount == specialAmountToRevert) {
            revert("ERC20TokenMock: The special amount has been used inside the 'transferFrom()' function");
        } else if (amount == specialAmountToReturnFalse) {
            return false;
        } else {
            return super.transferFrom(from, to, amount);
        }
    }

    /// @dev Configures the special amount when the transfer functions should return `false`.
    function setSpecialAmountToReturnFalse(uint256 newSpecialAmount) external {
        specialAmountToReturnFalse = newSpecialAmount;
    }

    /// @dev Configures the special amount when the transfer functions should revert.
    function setSpecialAmountToRevert(uint256 newSpecialAmount) external {
        specialAmountToRevert = newSpecialAmount;
    }
}
