// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../../base/PausableExUpgradeable.sol";

/**
 * @title PausableExUpgradeableMock contract
 * @dev An implementation of the {PausableExUpgradeable} contract for test purposes.
 */
contract PausableExUpgradeableMock is PausableExUpgradeable {

    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /**
     * @dev The initialize function of the upgradable contract
     * but without modifier {initializer} to test that the ancestor contract has it.
     */
    function initialize() public {
        _setupRole(OWNER_ROLE, _msgSender());
        __PausableEx_init(OWNER_ROLE);
    }

    /**
     * @dev The unchained initialize function of the upgradable contract
     * but without modifier {initializer} to test that the ancestor contract has it.
     */
    function initialize_unchained() public {
        _setupRole(OWNER_ROLE, _msgSender());
        __PausableEx_init_unchained(OWNER_ROLE);
    }
}
