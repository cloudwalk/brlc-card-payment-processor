// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { PauseControlUpgradeable } from "../../base/PauseControlUpgradeable.sol";

/**
 * @title PauseControlUpgradeableMock contract
 * @dev An implementation of the {PauseControlUpgradeable} contract for test purposes.
 */
contract PauseControlUpgradeableMock is PauseControlUpgradeable {
    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /**
     * @dev The initialize function of the upgradable contract.
     */
    function initialize() public initializer {
        _setupRole(OWNER_ROLE, _msgSender());
        __PauseControl_init(OWNER_ROLE);
    }

    /**
     * @dev To check that the initialize function of the ancestor contract has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize() public {
        __PauseControl_init(OWNER_ROLE);
    }

    /**
     * @dev To check that the unchained initialize function of the ancestor contract
     * has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize_unchained() public {
        __PauseControl_init_unchained(OWNER_ROLE);
    }
}
