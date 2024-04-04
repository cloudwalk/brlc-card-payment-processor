// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { AccessControlExtUpgradeable } from "../../base/AccessControlExtUpgradeable.sol";

/**
 * @title AccessControlExtUpgradeableMock contract
 * @author CloudWalk Inc.
 * @dev An implementation of the {AccessControlExtUpgradeable} contract for test purposes.
 */
contract AccessControlExtUpgradeableMock is AccessControlExtUpgradeable, UUPSUpgradeable {
    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant USER_ROLE = keccak256("USER_ROLE");

    // ------------------ Initializers ---------------------------- //

    /**
     * @dev The initialize function of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable.
     */
    function initialize() public initializer {
        _grantRole(OWNER_ROLE, _msgSender());
        _setRoleAdmin(USER_ROLE, OWNER_ROLE);
        __AccessControlExt_init();

        // Only to provide the 100 % test coverage
        _authorizeUpgrade(address(0));
    }

    // ------------------ Functions ------------------------------- //

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

    // ------------------ Internal functions ---------------------- //

    /// @dev The upgrade authorization function for UUPSProxy.
    function _authorizeUpgrade(address newImplementation) internal pure override {
        newImplementation; // Suppresses a compiler warning about the unused variable
    }
}
