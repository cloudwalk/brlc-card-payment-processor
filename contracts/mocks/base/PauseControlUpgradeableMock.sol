// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { PauseControlUpgradeable } from "../../base/PauseControlUpgradeable.sol";

/**
 * @title PauseControlUpgradeableMock contract
 * @dev An implementation of the {PauseControlUpgradeable} contract for test purposes.
 */
contract PauseControlUpgradeableMock is PauseControlUpgradeable {
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /**
     * @dev The initialize function of the upgradable contract
     * but without modifier {initializer} to test that the ancestor contract has it.
     */
    function initialize() public {
        _setupRole(OWNER_ROLE, _msgSender());
        __PauseControl_init(OWNER_ROLE);
    }

    /**
     * @dev The unchained initialize function of the upgradable contract
     * but without modifier {initializer} to test that the ancestor contract has it.
     */
    function initialize_unchained() public {
        _setupRole(OWNER_ROLE, _msgSender());
        __PauseControl_init_unchained(OWNER_ROLE);
    }
}
