// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { AccessControlExtUpgradeable } from "./AccessControlExtUpgradeable.sol";

/**
 * @title BlocklistableUpgradeable base contract
 * @author CloudWalk Inc.
 * @dev Allows to blocklist and unblocklist accounts using the {BLOCKLISTER_ROLE} role.
 *
 * This contract is used through inheritance. It makes available the modifier `notBlocklisted`,
 * which can be applied to functions to restrict their usage to not blocklisted accounts only.
 */
abstract contract BlocklistableUpgradeable is AccessControlExtUpgradeable {
    /// @dev The role of the blocklister that is allowed to blocklist and unblocklist accounts.
    bytes32 public constant BLOCKLISTER_ROLE = keccak256("BLOCKLISTER_ROLE");

    /// @dev Mapping of presence in the blocklist for a given address.
    mapping(address => bool) private _blocklisted;

    // -------------------- Events -----------------------------------

    /// @dev Emitted when an account is blocklisted.
    event Blocklisted(address indexed account);

    /// @dev Emitted when an account is unblocklisted.
    event UnBlocklisted(address indexed account);

    /// @dev Emitted when an account is self blocklisted.
    event SelfBlocklisted(address indexed account);

    // -------------------- Errors -----------------------------------

    /// @dev The account is blocklisted.
    error BlocklistedAccount(address account);

    // -------------------- Modifiers --------------------------------

    /**
     * @dev Throws if called by a blocklisted account.
     * @param account The address to check for presence in the blocklist.
     */
    modifier notBlocklisted(address account) {
        if (_blocklisted[account]) {
            revert BlocklistedAccount(account);
        }
        _;
    }

    // -------------------- Functions --------------------------------

    /**
     * @dev The internal initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable.
     */
    function __Blocklistable_init(bytes32 blocklisterRoleAdmin) internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();
        __AccessControlExt_init_unchained();

        __Blocklistable_init_unchained(blocklisterRoleAdmin);
    }

    /**
     * @dev The unchained internal initializer of the upgradable contract.
     *
     * See {BlocklistableUpgradeable-__Blocklistable_init}.
     */
    function __Blocklistable_init_unchained(bytes32 blocklisterRoleAdmin) internal onlyInitializing {
        _setRoleAdmin(BLOCKLISTER_ROLE, blocklisterRoleAdmin);
    }

    /**
     * @dev Adds an account to the blocklist.
     *
     * Requirements:
     *
     * - The caller must have the {BLOCKLISTER_ROLE} role.
     *
     * Emits a {Blocklisted} event.
     *
     * @param account The address to blocklist.
     */
    function blocklist(address account) public onlyRole(BLOCKLISTER_ROLE) {
        if (_blocklisted[account]) {
            return;
        }

        _blocklisted[account] = true;

        emit Blocklisted(account);
    }

    /**
     * @dev Removes an account from the blocklist.
     *
     * Requirements:
     *
     * - The caller must have the {BLOCKLISTER_ROLE} role.
     *
     * Emits an {UnBlocklisted} event.
     *
     * @param account The address to remove from the blocklist.
     */
    function unBlocklist(address account) public onlyRole(BLOCKLISTER_ROLE) {
        if (!_blocklisted[account]) {
            return;
        }

        _blocklisted[account] = false;

        emit UnBlocklisted(account);
    }

    /**
     * @dev Adds the message sender to the blocklist.
     *
     * Emits a {SelfBlocklisted} event.
     * Emits a {Blocklisted} event.
     */
    function selfBlocklist() public {
        address sender = _msgSender();

        if (_blocklisted[sender]) {
            return;
        }

        _blocklisted[sender] = true;

        emit SelfBlocklisted(sender);
        emit Blocklisted(sender);
    }

    /**
     * @dev Checks if an account is blocklisted.
     * @param account The address to check for presence in the blocklist.
     * @return True if the account is present in the blocklist.
     */
    function isBlocklisted(address account) public view returns (bool) {
        return _blocklisted[account];
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     */
    uint256[49] private __gap;
}
