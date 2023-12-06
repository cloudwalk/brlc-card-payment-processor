// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { PausableExtUpgradeable } from "../../base/PausableExtUpgradeable.sol";

/**
 * @title PausableExtUpgradeableMock contract
 * @author CloudWalk Inc.
 * @dev An implementation of the {PausableExtUpgradeable} contract for test purposes.
 */
contract PausableExtUpgradeableMock is PausableExtUpgradeable {
    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /**
     * @dev The initialize function of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable.
     */
    function initialize() public initializer {
        _setupRole(OWNER_ROLE, _msgSender());
        __PausableExt_init(OWNER_ROLE);
    }

    /**
     * @dev Needed to check that the initialize function of the ancestor contract
     * has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize() public {
        __PausableExt_init(OWNER_ROLE);
    }

    /**
     * @dev Needed to check that the unchained initialize function of the ancestor contract
     * has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize_unchained() public {
        __PausableExt_init_unchained(OWNER_ROLE);
    }
}
