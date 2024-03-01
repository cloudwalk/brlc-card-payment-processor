// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title ERC20TokenMock contract
 * @dev An implementation of the {ERC20Upgradeable} contract for testing purposes
 */
contract ERC20TokenMock is ERC20Upgradeable, UUPSUpgradeable {
    /// @dev A special amount when the transfer functions should return `false`.
    uint256 public specialAmountToReturnFalse;

    /// @dev A special amount when the transfer functions should revert.
    uint256 public specialAmountToRevert;

    /**
     * @dev The initialize function of the upgradable contract.
     * @param name_ The name of the token to set for this ERC20-comparable contract.
     * @param symbol_ The symbol of the token to set for this ERC20-comparable contract.
     */
    function initialize(string memory name_, string memory symbol_) public initializer {
        __ERC20_init(name_, symbol_);
        specialAmountToReturnFalse = type(uint256).max;
        specialAmountToRevert = type(uint256).max;

        // Only to provide the 100 % test coverage
        _authorizeUpgrade(address(0));
    }

    /**
     * @dev Calls the appropriate internal function to mint needed amount of tokens for an account.
     * @param account The address of an account to mint for.
     * @param amount The amount of tokens to mint.
     */
    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    /**
     * @dev The variation of the standard transfer function that returns `false` if the special amount is passed.
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (amount == specialAmountToRevert) {
            revert("ERC20TokenMock: The special amount has been used inside the 'transfer()' function");
        } else if (amount == specialAmountToReturnFalse) {
            return false;
        } else {
            return super.transfer(to, amount);
        }
    }

    /**
     * @dev The variation of the standard transfer from function that returns `false` if the special amount is passed.
     */
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (amount == specialAmountToRevert) {
            revert("ERC20TokenMock: The special amount has been used inside the 'transferFrom()' function");
        } else if (amount == specialAmountToReturnFalse) {
            return false;
        } else {
            return super.transferFrom(from, to, amount);
        }
    }

    /**
     * @dev Configures the special amount when the transfer functions should return `false`.
     */
    function setSpecialAmountToReturnFalse(uint256 newSpecialAmount) external {
        specialAmountToReturnFalse = newSpecialAmount;
    }

    /**
     * @dev Configures the special amount when the transfer functions should revert.
     */
    function setSpecialAmountToRevert(uint256 newSpecialAmount) external {
        specialAmountToRevert = newSpecialAmount;
    }

    /**
     * @dev The upgrade authorization function for UUPSProxy.
     */
    function _authorizeUpgrade(address newImplementation) internal pure override {
        newImplementation; // Suppresses a compiler warning about the unused variable
    }
}
