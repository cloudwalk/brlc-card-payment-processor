// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title IERC20Mintable interface
 * @dev The interface of a token that supports mint and burn operations.
 */
interface IERC20Mintable {
    /**
     * @dev Mints tokens.
     *
     * @param account The address of a tokens recipient.
     * @param amount The amount of tokens to mint.
     * @return True if the operation was successful.
     */
    function mint(address account, uint256 amount) external returns (bool);

    /**
     * @dev Burns tokens.
     *
     * @param amount The amount of tokens to burn.
     */
    function burn(uint256 amount) external;
}
