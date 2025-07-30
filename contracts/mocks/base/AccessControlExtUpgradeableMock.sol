// SPDX-License-Identifier: MIT

pragma solidity ^0.8.2;

import { AccessControlExtUpgradeable } from "../../base/AccessControlExtUpgradeable.sol";

/**
 * @title AccessControlExtUpgradeableMock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev An implementation of the {AccessControlExtUpgradeable} contract for test purposes.
 */
contract AccessControlExtUpgradeableMock is AccessControlExtUpgradeable {
    /// @dev The role of a user of this contract.
    bytes32 public constant USER_ROLE = keccak256("USER_ROLE");

    // ------------------ Initializers ---------------------------- //

    /**
     * @dev Initializer of the upgradeable contract.
     *
     * See details: https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable
     */
    function initialize() public initializer {
        __AccessControlExt_init_unchained();

        _setRoleAdmin(USER_ROLE, GRANTOR_ROLE);
        _grantRole(OWNER_ROLE, _msgSender());
    }

    // ------------------ Transactional functions ----------------- //

    /// @dev Calls the parent internal unchained initialization function to verify the 'onlyInitializing' modifier.
    function callParentInitializerUnchained() external {
        __AccessControlExt_init_unchained();
    }
}
