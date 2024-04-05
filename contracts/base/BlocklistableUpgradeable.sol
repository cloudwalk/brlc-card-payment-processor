// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

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

    /**
     * @dev The first storage slot of the contract data.
     *
     * Calculated as:
     * keccak256(abi.encode(uint256(keccak256("cloudwalk.storage.Blocklistable")) - 1)) & ~bytes32(uint256(0xff))
     */
    bytes32 private constant BlocklistableStorageLocation =
        0x9a5d41467ec00b9c4ff3b10f2ab1b7fef3c7f16bd8fba9cd308a28e3cd7ef400;

    /**
     * @dev The structure that contains all the data of the Blocklistable contract.
     * @custom:storage-location erc7201:cloudwalk.storage.Blocklistable
     */
    struct BlocklistableStorage {
        mapping(address => bool) blocklisted; // Mapping of presence in the blocklist for a given address.
    }

    // ------------------ Events ---------------------------------- //

    /// @dev Emitted when an account is blocklisted.
    event Blocklisted(address indexed account);

    /// @dev Emitted when an account is unblocklisted.
    event UnBlocklisted(address indexed account);

    /// @dev Emitted when an account is self blocklisted.
    event SelfBlocklisted(address indexed account);

    // ------------------ Errors ---------------------------------- //

    /// @dev The account is blocklisted.
    error BlocklistedAccount(address account);

    // ------------------ Modifiers ------------------------------- //

    /**
     * @dev Throws if called by a blocklisted account.
     * @param account The address to check for presence in the blocklist.
     */
    modifier notBlocklisted(address account) {
        if (_getBlocklistableStorage().blocklisted[account]) {
            revert BlocklistedAccount(account);
        }
        _;
    }

    // ------------------ Initializers ---------------------------- //

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

    // ------------------ Functions ------------------------------- //

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
        BlocklistableStorage storage s = _getBlocklistableStorage();
        if (s.blocklisted[account]) {
            return;
        }

        s.blocklisted[account] = true;

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
        BlocklistableStorage storage s = _getBlocklistableStorage();
        if (!s.blocklisted[account]) {
            return;
        }

        s.blocklisted[account] = false;

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
        BlocklistableStorage storage s = _getBlocklistableStorage();

        if (s.blocklisted[sender]) {
            return;
        }

        s.blocklisted[sender] = true;

        emit SelfBlocklisted(sender);
        emit Blocklisted(sender);
    }

    // ------------------ View functions -------------------------- //

    /**
     * @dev Checks if an account is blocklisted.
     * @param account The address to check for presence in the blocklist.
     * @return True if the account is present in the blocklist.
     */
    function isBlocklisted(address account) public view returns (bool) {
        return _getBlocklistableStorage().blocklisted[account];
    }

    // ------------------ Private functions ----------------------- //

    /**
     * @dev Returns the contract storage structure.
     */
    function _getBlocklistableStorage() private pure returns (BlocklistableStorage storage $) {
        assembly {
            $.slot := BlocklistableStorageLocation
        }
    }
}
