// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/**
 * @title BlacklistableUpgradeable base contract
 * @author CloudWalk Inc.
 * @dev Allows to blacklist and unblacklist accounts using the {BLACKLISTER_ROLE} role.
 *
 * This contract is used through inheritance. It makes available the modifier `notBlacklisted`,
 * which can be applied to functions to restrict their usage to not blacklisted accounts only.
 */
abstract contract BlacklistableUpgradeable is AccessControlUpgradeable {
    /// @dev The role of the blacklister that is allowed to blacklist and unblacklist accounts.
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");

    /// @dev Mapping of presence in the blacklist for a given address.
    mapping(address => bool) private _blacklisted;

    // -------------------- Events -----------------------------------

    /// @dev Emitted when an account is blacklisted.
    event Blacklisted(address indexed account);

    /// @dev Emitted when an account is unblacklisted.
    event UnBlacklisted(address indexed account);

    /// @dev Emitted when an account is self blacklisted.
    event SelfBlacklisted(address indexed account);

    // -------------------- Errors -----------------------------------

    /// @dev The account is blacklisted.
    error BlacklistedAccount(address account);

    // -------------------- Modifiers --------------------------------

    /**
     * @dev Throws if called by a blacklisted account.
     * @param account The address to check for presence in the blacklist.
     */
    modifier notBlacklisted(address account) {
        if (_blacklisted[account]) {
            revert BlacklistedAccount(account);
        }
        _;
    }

    // -------------------- Functions --------------------------------

    /**
     * @dev The internal initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable.
     */
    function __Blacklistable_init(bytes32 blacklisterRoleAdmin) internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();

        __Blacklistable_init_unchained(blacklisterRoleAdmin);
    }

    /**
     * @dev The unchained internal initializer of the upgradable contract.
     *
     * See {BlacklistableUpgradeable-__Blacklistable_init}.
     */
    function __Blacklistable_init_unchained(bytes32 blacklisterRoleAdmin) internal onlyInitializing {
        _setRoleAdmin(BLACKLISTER_ROLE, blacklisterRoleAdmin);
    }

    /**
     * @dev Adds an account to the blacklist.
     *
     * Requirements:
     *
     * - The caller must have the {BLACKLISTER_ROLE} role.
     *
     * Emits a {Blacklisted} event.
     *
     * @param account The address to blacklist.
     */
    function blacklist(address account) public onlyRole(BLACKLISTER_ROLE) {
        if (_blacklisted[account]) {
            return;
        }

        _blacklisted[account] = true;

        emit Blacklisted(account);
    }

    /**
     * @dev Removes an account from the blacklist.
     *
     * Requirements:
     *
     * - The caller must have the {BLACKLISTER_ROLE} role.
     *
     * Emits an {UnBlacklisted} event.
     *
     * @param account The address to remove from the blacklist.
     */
    function unBlacklist(address account) public onlyRole(BLACKLISTER_ROLE) {
        if (!_blacklisted[account]) {
            return;
        }

        _blacklisted[account] = false;

        emit UnBlacklisted(account);
    }

    /**
     * @dev Adds the message sender to the blacklist.
     *
     * Emits a {SelfBlacklisted} event.
     * Emits a {Blacklisted} event.
     */
    function selfBlacklist() public {
        address sender = _msgSender();

        if (_blacklisted[sender]) {
            return;
        }

        _blacklisted[sender] = true;

        emit SelfBlacklisted(sender);
        emit Blacklisted(sender);
    }

    /**
     * @dev Checks if an account is blacklisted.
     * @param account The address to check for presence in the blacklist.
     * @return True if the account is present in the blacklist.
     */
    function isBlacklisted(address account) public view returns (bool) {
        return _blacklisted[account];
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     */
    uint256[49] private __gap;
}
