// SPDX-License-Identifier: MIT

pragma solidity ^0.8.2;

import { BlocklistableUpgradeable } from "../../base/BlocklistableUpgradeable.sol";

/**
 * @title BlocklistableUpgradeableMock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev An implementation of the {BlocklistableUpgradeable} contract for test purposes.
 */
contract BlocklistableUpgradeableMock is BlocklistableUpgradeable {
    /// @dev Emitted when a test function of the `notBlocklisted` modifier executes successfully.
    event TestNotBlocklistedModifierSucceeded();

    // ------------------ Initializers ---------------------------- //

    /**
     * @dev The initialize function of the upgradeable contract.
     *
     * See details: https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable
     */
    function initialize() public initializer {
        __AccessControlExt_init_unchained();
        __Blocklistable_init_unchained();

        _grantRole(OWNER_ROLE, _msgSender());
    }

    // ------------------ Transactional functions ----------------- //

    /// @dev Calls the parent internal unchained initialization function to verify the 'onlyInitializing' modifier.
    function callParentInitializerUnchained() external {
        __Blocklistable_init_unchained();
    }

    /**
     * @dev Checks the execution of the {notBlocklisted} modifier.
     *
     * If that modifier executed without reverting emits an event {TestNotBlocklistedModifierSucceeded}.
     */
    function testNotBlocklistedModifier() external notBlocklisted(_msgSender()) {
        emit TestNotBlocklistedModifierSucceeded();
    }
}
