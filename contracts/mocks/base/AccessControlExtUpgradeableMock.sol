// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { AccessControlExtUpgradeable } from "../../base/AccessControlExtUpgradeable.sol";

/**
 * @title AccessControlExtUpgradeableMock contract
 * @author CloudWalk Inc.
 * @dev An implementation of the {AccessControlExtUpgradeable} contract for test purposes.
 */
contract AccessControlExtUpgradeableMock is AccessControlExtUpgradeable {
    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant USER_ROLE = keccak256("USER_ROLE");

    /**
     * @dev The initialize function of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable.
     */
    function initialize() public initializer {
        _setupRole(OWNER_ROLE, _msgSender());
        _setRoleAdmin(USER_ROLE, OWNER_ROLE);
        __AccessControlExt_init();
    }

    /**
     * @dev Needed to check that the initialize function of the ancestor contract
     * has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize() public {
        __AccessControlExt_init();
    }

    /**
     * @dev Needed to check that the unchained initialize function of the ancestor contract
     * has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize_unchained() public {
        __AccessControlExt_init_unchained();
    }
}
