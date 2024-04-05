// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/**
 * @title AccessControlExtUpgradeable base contract
 * @author CloudWalk Inc.
 * @dev Extends the OpenZeppelin's {AccessControlUpgradeable} contract by adding the `grantRoleBatch` and
 * `revokeRoleBatch` function.
 *
 * This contract is used through inheritance. It introduces the `grantRoleBatch` and `revokeRoleBatch` functions
 * that is allowed to grant and revoke roles in batch.
 */
abstract contract AccessControlExtUpgradeable is AccessControlUpgradeable {
    // ------------------ Initializers ---------------------------- //

    /**
     * @dev The internal initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable.
     */
    function __AccessControlExt_init() internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();

        __AccessControlExt_init_unchained();
    }

    /**
     * @dev The unchained internal initializer of the upgradable contract.
     *
     * See {AccessControlExtUpgradeable-__AccessControlExt_init}.
     */
    function __AccessControlExt_init_unchained() internal onlyInitializing {}

    // ------------------ Functions ------------------------------- //

    /**
     * @dev Grants `role` to `account` in batch.
     *
     * If `accounts` had not been already granted `role`, emits a {RoleGranted}
     * event.
     *
     * Requirements:
     *
     * - the caller must have ``role``'s admin role.
     *
     * May emit a {RoleGranted} event for each account.
     */
    function grantRoleBatch(bytes32 role, address[] memory accounts) public virtual onlyRole(getRoleAdmin(role)) {
        for (uint i = 0; i < accounts.length; i++) {
            _grantRole(role, accounts[i]);
        }
    }

    /**
     * @dev Revokes `role` from `account` in batch.
     *
     * If `accounts` had been granted `role`, emits a {RoleRevoked} event.
     *
     * Requirements:
     *
     * - the caller must have ``role``'s admin role.
     *
     * May emit a {RoleRevoked} event for each account.
     */
    function revokeRoleBatch(bytes32 role, address[] memory accounts) public virtual onlyRole(getRoleAdmin(role)) {
        for (uint i = 0; i < accounts.length; i++) {
            _revokeRole(role, accounts[i]);
        }
    }
}
