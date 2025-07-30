// SPDX-License-Identifier: MIT

pragma solidity ^0.8.2;

import { PausableExtUpgradeable } from "../../base/PausableExtUpgradeable.sol";

/**
 * @title PausableExtUpgradeableMock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev An implementation of the {PausableExtUpgradeable} contract for test purposes.
 */
contract PausableExtUpgradeableMock is PausableExtUpgradeable {
    // ------------------ Initializers ---------------------------- //

    /**
     * @dev Initializer of the upgradeable contract.
     *
     * See details: https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable
     */
    function initialize() public initializer {
        __AccessControlExt_init_unchained();
        __Pausable_init_unchained();
        __PausableExt_init_unchained();

        _grantRole(OWNER_ROLE, _msgSender());
    }

    // ------------------ Transactional functions ----------------- //

    /// @dev Calls the parent internal unchained initialization function to verify the 'onlyInitializing' modifier.
    function callParentInitializerUnchained() external {
        __PausableExt_init_unchained();
    }
}
