// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title BlocklistableUpgradeable base contract interface
 * @author CloudWalk Inc.
 */
interface IERC20Blocklistable {
    /**
     * @dev Adds an account to the blocklist
     * @param account The address to blocklist
     */
    function blacklist(address account) external;

    /**
     * @dev Removes an account from the blocklist
     * @param account The address to remove from blocklist
     */
    function unBlacklist(address account) external;

    /**
     * @dev Checks if an account is present in the blocklist
     * @param account The address to check for presence in the blocklist
     * @return True if the account is present in the blocklist, false otherwise
     */
    function isBlacklisted(address account) external returns (bool);
}
