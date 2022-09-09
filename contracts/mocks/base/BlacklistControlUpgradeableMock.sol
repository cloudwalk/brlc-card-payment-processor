// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { BlacklistControlUpgradeable } from "../../base/BlacklistControlUpgradeable.sol";

/**
 * @title BlacklistControlUpgradeableMock contract
 * @dev An implementation of the {BlacklistControlUpgradeable} contract for test purposes.
 */
contract BlacklistControlUpgradeableMock is BlacklistControlUpgradeable {
    /// @dev The role of this contract owner
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev Emitted when a test function of the `notBlacklisted` modifier executes successfully
    event TestNotBlacklistedModifierSucceeded();

    /// @dev The initialize function of the upgradable contract.
    function initialize() public initializer {
        _setupRole(OWNER_ROLE, _msgSender());
        __BlacklistControl_init(OWNER_ROLE);
    }

    /// @dev To check that the initialize function of the ancestor contract has the 'onlyInitializing' modifier.
    function call_parent_initialize() public {
        __BlacklistControl_init(OWNER_ROLE);
    }

    /**
     * @dev To check that the unchained initialize function of the ancestor contract
     * has the 'onlyInitializing' modifier.
     */
    function call_parent_initialize_unchained() public {
        __BlacklistControl_init_unchained(OWNER_ROLE);
    }

    /**
     * @dev Checks the execution of the {notBlacklisted} modifier.
     * If that modifier executed without reverting emits an event {TestNotBlacklistedModifierSucceeded}.
     */
    function testNotBlacklistedModifier() external notBlacklisted(_msgSender()) {
        emit TestNotBlacklistedModifierSucceeded();
    }
}
