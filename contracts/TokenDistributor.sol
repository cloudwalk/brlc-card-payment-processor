// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { ITokenDistributor } from "./interfaces/ITokenDistributor.sol";
import { PauseControlUpgradeable } from "./base/PauseControlUpgradeable.sol";
import { RescueControlUpgradeable } from "./base/RescueControlUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder.sol";

/**
 * @title TokenDistributor contract
 * @dev The contract for token distribution among multiple accounts.
 *
 * Only accounts that have {DISTRIBUTOR_ROLE} role can execute the distribution operations.
 * About roles see https://docs.openzeppelin.com/contracts/4.x/api/access#AccessControl.
 */
contract TokenDistributor is
    AccessControlUpgradeable,
    PauseControlUpgradeable,
    RescueControlUpgradeable,
    StoragePlaceholder200,
    ITokenDistributor
{
    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of distributor that is allowed to execute the distribution operations.
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    /// @dev The zero token contract address has been provided as a function parameter.
    error ZeroToken();

    /// @dev Empty array of recipients has been passed as a function argument.
    error EmptyRecipientsArray();

    /// @dev The length of the array of balances is mismatched with the one of the recipients array.
    error BalancesArrayLengthMismatch();

    /// @dev The zero recipient address has been found in the input array of the recipients.
    error ZeroRecipient();

    /// @dev The zero balance has been found in the input array of the balances.
    error ZeroBalance();

    /**
     * @dev The initialize function of the upgradable contract.
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable
     */
    function initialize() public initializer {
        __TokenDistributor_init();
    }

    function __TokenDistributor_init() internal onlyInitializing {
        __AccessControl_init_unchained();
        __Context_init_unchained();
        __ERC165_init_unchained();
        __Pausable_init_unchained();
        __PauseControl_init_unchained(OWNER_ROLE);
        __RescueControl_init_unchained(OWNER_ROLE);

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
     * - The provided `recipients`, `balances` arrays must not be empty and each of their element must not be zero.
     * - The length of the `recipients`, `balances` arrays must be the same.
     */
    function distributeTokens(
        address token,
        address[] memory recipients,
        uint256[] memory balances
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) {
        if (token == address(0)) {
            revert ZeroToken();
        }
        if (recipients.length == 0) {
            revert EmptyRecipientsArray();
        }
        if (recipients.length != balances.length) {
            revert BalancesArrayLengthMismatch();
        }

        IERC20Upgradeable erc20 = IERC20Upgradeable(token);
        uint256 total = 0;

        for (uint8 i = 0; i < recipients.length; i++) {
            address recipient = recipients[i];
            uint256 balance = balances[i];

            if (recipient == address(0)) {
                revert ZeroRecipient();
            }
            if (balance == 0) {
                revert ZeroBalance();
            }

            erc20.transfer(recipient, balance);
            total += balance;
        }
        emit DistributeTokens(token, total);
    }
}
