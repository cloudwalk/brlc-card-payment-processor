// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/**
 * @title BlacklistControlUpgradeable base contract
 * @dev Allows to blacklist/unblacklist accounts using the {BLACKLISTER_ROLE} role.
 *
 * This contract is used through inheritance. It makes available the modifier `notBlacklisted`,
 * which can be applied to functions to restrict their usage to not blacklisted accounts only.
 *
 * The admins of the {BLACKLISTER_ROLE} role are accounts with the role defined in the init() function.
 *
 * There is also a possibility to any account to blacklist itself.
 */
abstract contract BlacklistControlUpgradeable is AccessControlUpgradeable {
    /// @dev The role of blacklister that is allowed to blacklist/unblacklist accounts.
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

    /// @dev The transaction sender is blacklisted.
    error BlacklistedAccount(address account);

    // ------------------- Functions ---------------------------------

    function __BlacklistControl_init(bytes32 blacklisterRoleAdmin) internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();

        __BlacklistControl_init_unchained(blacklisterRoleAdmin);
    }

    function __BlacklistControl_init_unchained(bytes32 blacklisterRoleAdmin) internal onlyInitializing {
        _setRoleAdmin(BLACKLISTER_ROLE, blacklisterRoleAdmin);
    }

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

    /**
     * @dev Checks if the account is blacklisted.
     * @param account The address to check for presence in the blacklist.
     * @return True if the account is present in the blacklist.
     */
    function isBlacklisted(address account) public view returns (bool) {
        return _blacklisted[account];
    }

    /**
     * @dev Adds the account to the blacklist.
     *
     * Requirements:
     * - The caller must have the {BLACKLISTER_ROLE} role.
     * - The account must not be already blacklisted.
     *
     * Emits a {Blacklisted} event.
     *
     * @param account The address to blacklist.
     */
    function blacklist(address account) external onlyRole(BLACKLISTER_ROLE) {
        if (_blacklisted[account]) {
            return;
        }

        _blacklisted[account] = true;

        emit Blacklisted(account);
    }

    /**
     * @dev Removes the account from the blacklist.
     *
     * Requirements:
     * - The caller must have the {BLACKLISTER_ROLE} role.
     * - The account must not be already unblacklisted.
     *
     * Emits a {UnBlacklisted} event.
     *
     * @param account The address to remove from the blacklist.
     */
    function unBlacklist(address account) external onlyRole(BLACKLISTER_ROLE) {
        if (!_blacklisted[account]) {
            return;
        }

        _blacklisted[account] = false;

        emit UnBlacklisted(account);
    }

    /**
     * @dev Adds the transaction sender to the blacklist.
     *
     * Requirements:
     * - The caller must not be already blacklisted.
     *
     * Emits a {SelfBlacklisted} event.
     * Emits a {Blacklisted} event.
     */
    function selfBlacklist() external {
        if (_blacklisted[_msgSender()]) {
            return;
        }

        _blacklisted[_msgSender()] = true;

        emit SelfBlacklisted(_msgSender());
        emit Blacklisted(_msgSender());
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     */
    uint256[49] private __gap;
}
