// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { AccessControlExtUpgradeable } from "./AccessControlExtUpgradeable.sol";

/**
 * @title RescuableUpgradeable base contract
 * @author CloudWalk Inc.
 * @dev Allows to rescue ERC20 tokens locked up in the contract using the {RESCUER_ROLE} role.
 *
 * This contract is used through inheritance. It introduces the {RESCUER_ROLE} role that is allowed to
 * rescue tokens locked up in the contract that is inherited from this one.
 */
abstract contract RescuableUpgradeable is AccessControlExtUpgradeable {
    using SafeERC20 for IERC20;

    /// @dev The role of rescuer that is allowed to rescue tokens locked up in the contract.
    bytes32 public constant RESCUER_ROLE = keccak256("RESCUER_ROLE");

    // ------------------ Initializers ---------------------------- //

    /**
     * @dev The internal initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable.
     */
    function __Rescuable_init(bytes32 rescuerRoleAdmin) internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();
        __AccessControlExt_init_unchained();

        __Rescuable_init_unchained(rescuerRoleAdmin);
    }

    /**
     * @dev The unchained internal initializer of the upgradable contract.
     *
     * See {RescuableUpgradeable-__Rescuable_init}.
     */
    function __Rescuable_init_unchained(bytes32 rescuerRoleAdmin) internal onlyInitializing {
        _setRoleAdmin(RESCUER_ROLE, rescuerRoleAdmin);
    }

    // ------------------ Functions ------------------------------- //

    /**
     * @dev Withdraws ERC20 tokens locked up in the contract.
     *
     * Requirements:
     *
     * - The caller must have the {RESCUER_ROLE} role.
     *
     * @param token The address of the ERC20 token contract.
     * @param to The address of the recipient of tokens.
     * @param amount The amount of tokens to withdraw.
     */
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) public onlyRole(RESCUER_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }
}
