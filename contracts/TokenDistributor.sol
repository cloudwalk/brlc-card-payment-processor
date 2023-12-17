// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { PausableExtUpgradeable } from "./base/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "./base/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder200.sol";
import { AccessControlExtUpgradeable } from "./base/AccessControlExtUpgradeable.sol";

import { ITokenDistributor } from "./interfaces/ITokenDistributor.sol";

/**
 * @title TokenDistributor contract
 * @dev The contract for token distribution among multiple accounts.
 *
 * Only accounts that have {DISTRIBUTOR_ROLE} role can execute the distribution operations.
 * About roles see https://docs.openzeppelin.com/contracts/4.x/api/access#AccessControl.
 */
contract TokenDistributor is
    AccessControlExtUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    StoragePlaceholder200,
    ITokenDistributor
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of distributor that is allowed to execute the distribution operations.
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    // -------------------- Errors -----------------------------------

    /// @dev The zero token address has been passed as a function argument.
    error ZeroTokenAddress();

    /// @dev An empty array of recipients has been passed as a function argument.
    error EmptyRecipientsArray();

    /// @dev The length of the array of balances is mismatched with the one of the recipients array.
    error BalancesArrayLengthMismatch();

    /// @dev The zero recipient address has been found in the input array of recipients.
    error ZeroRecipientAddress();

    /// @dev The zero balance has been found in the input array of the balances.
    error ZeroRecipientBalance();

    // ------------------- Functions ---------------------------------

    /**
     * @dev The initialize function of the upgradable contract.
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable
     */
    function initialize() external initializer {
        __TokenDistributor_init();
    }

    function __TokenDistributor_init() internal onlyInitializing {
        __AccessControl_init_unchained();
        __AccessControlExt_init_unchained();
        __Context_init_unchained();
        __ERC165_init_unchained();
        __Pausable_init_unchained();
        __PausableExt_init_unchained(OWNER_ROLE);
        __Rescuable_init_unchained(OWNER_ROLE);

        __TokenDistributor_init_unchained();
    }

    function __TokenDistributor_init_unchained() internal onlyInitializing {
        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(DISTRIBUTOR_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /**
     * @dev See {ITokenDistributor-distributeTokens}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {DISTRIBUTOR_ROLE} role.
     * - The provided `token` argument must not be zero.
     * - The provided `recipients` and `balances` arrays must not be empty,
     *   and each of their elements must not be zero.
     * - The length of the `recipients` and `balances` arrays must be the same.
     */
    function distributeTokens(
        address token,
        address[] memory recipients,
        uint256[] memory balances
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) {
        if (token == address(0)) {
            revert ZeroTokenAddress();
        }
        if (recipients.length == 0) {
            revert EmptyRecipientsArray();
        }
        if (recipients.length != balances.length) {
            revert BalancesArrayLengthMismatch();
        }

        IERC20Upgradeable erc20 = IERC20Upgradeable(token);
        uint256 totalBalance = 0;

        for (uint8 i = 0; i < recipients.length; i++) {
            address recipient = recipients[i];
            uint256 balance = balances[i];

            if (recipient == address(0)) {
                revert ZeroRecipientAddress();
            }
            if (balance == 0) {
                revert ZeroRecipientBalance();
            }

            erc20.safeTransfer(recipient, balance);
            totalBalance += balance;
        }

        emit DistributeTokens(token, totalBalance);
    }
}
