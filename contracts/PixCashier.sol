// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { BlacklistControlUpgradeable } from "./base/BlacklistControlUpgradeable.sol";
import { IERC20Mintable } from "./interfaces/IERC20Mintable.sol";
import { IPixCashier } from "./interfaces/IPixCashier.sol";
import { PauseControlUpgradeable } from "./base/PauseControlUpgradeable.sol";
import { PixCashierStorage } from "./PixCashierStorage.sol";
import { RescueControlUpgradeable } from "./base/RescueControlUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder.sol";

/**
 * @title PixCashier contract
 * @dev Wrapper for PIX cash-in and cash-out transactions.
 *
 * Only accounts that have {CASHIER_ROLE} role can execute the cash-in operations.
 * About roles see https://docs.openzeppelin.com/contracts/4.x/api/access#AccessControl.
 */
contract PixCashier is
    AccessControlUpgradeable,
    BlacklistControlUpgradeable,
    PauseControlUpgradeable,
    RescueControlUpgradeable,
    StoragePlaceholder200,
    PixCashierStorage,
    IPixCashier
{
    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of cashier that is allowed to execute the cash-in operations.
    bytes32 public constant CASHIER_ROLE = keccak256("CASHIER_ROLE");

    /// @dev The zero account has been provided as a function parameter.
    error ZeroAccount();

    /// @dev The zero token amount has been provided as a function parameter.
    error ZeroAmount();

    /// @dev The zero off-chain transaction identifier has been provided as a function parameter.
    error ZeroTxId();

    /// @dev The cash-out balance of the caller is not enough to execute the function.
    error InsufficientCashOutBalance();

    /**
     * @dev The initialize function of the upgradable contract.
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable
     */
    function initialize(address token_) public initializer {
        __PixCashier_init(token_);
    }

    function __PixCashier_init(address token_) internal onlyInitializing {
        __AccessControl_init_unchained();
        __Context_init_unchained();
        __ERC165_init_unchained();
        __Pausable_init_unchained();
        __BlacklistControl_init_unchained(OWNER_ROLE);
        __PauseControl_init_unchained(OWNER_ROLE);
        __RescueControl_init_unchained(OWNER_ROLE);

        __PixCashier_init_unchained(token_);
    }

    function __PixCashier_init_unchained(address token_) internal onlyInitializing {
        _token = token_;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(CASHIER_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /// @dev See {IPixCashier-underlyingToken}.
    function underlyingToken() external view returns (address) {
        return _token;
    }

    /// @dev See {IPixCashier-cashOutBalanceOf}.
    function cashOutBalanceOf(address account) external view returns (uint256) {
        return _cashOutBalances[account];
    }

    /**
     * @dev See {IPixCashier-cashIn}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {CASHIER_ROLE} role.
     * - The provided `account`, `amount`, `txId` values must not be zero.
     * - Requirements to the `account` and `amount` values of the underlying token's `mint()` function.
     */
    function cashIn(
        address account,
        uint256 amount,
        bytes32 txId
    ) external whenNotPaused onlyRole(CASHIER_ROLE) {
        if (account == address(0)) {
            revert ZeroAccount();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (txId == 0) {
            revert ZeroTxId();
        }
        IERC20Mintable(_token).mint(account, amount);
        emit CashIn(account, amount, txId);
    }

    /**
     * @dev See {IPixCashier-cashOut}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must must not be blacklisted.
     * - The provided `amount`, `txId` values must not be zero.
     * - Requirements to the `_msgSender()` and `amount` values of the underlying token's `transferFrom()` function.
     */
    function cashOut(uint256 amount, bytes32 txId) external whenNotPaused notBlacklisted(_msgSender()) {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (txId == 0) {
            revert ZeroTxId();
        }
        address sender = _msgSender();
        IERC20Upgradeable(_token).transferFrom(
            sender,
            address(this),
            amount
        );
        uint256 newCashOutBalance = _cashOutBalances[_msgSender()] + amount;
        _cashOutBalances[_msgSender()] = newCashOutBalance;
        emit CashOut(
            sender,
            amount,
            newCashOutBalance,
            txId
        );
    }

    /**
     * @dev See {IPixCashier-cashOutConfirm}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must must not be blacklisted.
     * - The provided `amount`, `txId` values must not be zero.
     * - The cash-out balance of the caller must be not less then the provided `amount` value.
     * - Requirements to the `amount` value of the underlying token's `burn()` function.
     */
    function cashOutConfirm(uint256 amount, bytes32 txId) external whenNotPaused notBlacklisted(_msgSender()) {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (txId == 0) {
            revert ZeroTxId();
        }
        address sender = _msgSender();
        uint256 cashOutBalance = _cashOutBalances[sender];
        if (cashOutBalance < amount) {
            revert InsufficientCashOutBalance();
        }
        IERC20Mintable(_token).burn(amount);
        cashOutBalance -= amount;
        _cashOutBalances[sender] = cashOutBalance;
        emit CashOutConfirm(
            sender,
            amount,
            cashOutBalance,
            txId
        );
    }

    /**
     * @dev See {IPixCashier-cashOutReverse}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must must not be blacklisted.
     * - The provided `amount`, `txId` values must not be zero.
     * - The cash-out balance of the caller must be not less than the provided `amount` value.
     * - Requirements to the `_msgSender()` and `amount` values of the underlying token's `transfer()` function.
     */
    function cashOutReverse(uint256 amount, bytes32 txId) external whenNotPaused notBlacklisted(_msgSender()) {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (txId == 0) {
            revert ZeroTxId();
        }
        address sender = _msgSender();
        uint256 cashOutBalance = _cashOutBalances[sender];
        if (cashOutBalance < amount) {
            revert InsufficientCashOutBalance();
        }
        IERC20Upgradeable(_token).transfer(sender, amount);
        cashOutBalance -= amount;
        _cashOutBalances[sender] = cashOutBalance;
        emit CashOutReverse(
            sender,
            amount,
            cashOutBalance,
            txId
        );
    }
}
