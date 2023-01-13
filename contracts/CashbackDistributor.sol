// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { BlacklistControlUpgradeable } from "./base/BlacklistControlUpgradeable.sol";
import { PauseControlUpgradeable } from "./base/PauseControlUpgradeable.sol";
import { RescueControlUpgradeable } from "./base/RescueControlUpgradeable.sol";
import { CashbackDistributorStorage } from "./CashbackDistributorStorage.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder.sol";
import { ICashbackDistributor } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CashbackDistributor contract
 * @dev Wrapper contract for the cashback operations.
 */
contract CashbackDistributor is
    AccessControlUpgradeable,
    BlacklistControlUpgradeable,
    PauseControlUpgradeable,
    RescueControlUpgradeable,
    StoragePlaceholder200,
    CashbackDistributorStorage,
    ICashbackDistributor
{
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.Bytes32Set;

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of distributor that is allowed to execute the cashback operations.
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    // -------------------- Errors -----------------------------------

    /// @dev The cashback operations are already enabled.
    error CashbackAlreadyEnabled();

    /// @dev The cashback operations are already disabled.
    error CashbackAlreadyDisabled();

    /// @dev The zero token address has been passed as a function argument.
    error ZeroTokenAddress();

    /// @dev Zero external identifier has been passed as a function argument.
    error ZeroExternalId();

    /// @dev The zero account address has been passed as a function argument.
    error ZeroRecipientAddress();

    // ------------------- Functions ---------------------------------

    /**
     * @dev The initialize function of the upgradable contract.
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable
     */
    function initialize() external initializer {
        __CashbackDistributor_init();
    }

    function __CashbackDistributor_init() internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();
        __BlacklistControl_init_unchained(OWNER_ROLE);
        __Pausable_init_unchained();
        __PauseControl_init_unchained(OWNER_ROLE);
        __RescueControl_init_unchained(OWNER_ROLE);

        __CashbackDistributor_init_unchained();
    }

    function __CashbackDistributor_init_unchained() internal onlyInitializing {
        _nextNonce = 1;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(DISTRIBUTOR_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /**
     * @dev See {ICashbackDistributor-sendCashback}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {DISTRIBUTOR_ROLE} role.
     * - The external cashback identifier must not be zero.
     * - The cashback recipient address must not be zero.
     * - The token contract address must not be zero.
     */
    function sendCashback(
        address token,
        CashbackKind kind,
        bytes32 externalId,
        address recipient,
        uint256 amount
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) returns (bool success, uint256 nonce) {
        if (token == address(0)) {
            revert ZeroTokenAddress();
        }
        if (recipient == address(0)) {
            revert ZeroRecipientAddress();
        }
        if (externalId == 0) {
            revert ZeroExternalId();
        }

        CashbackStatus status = CashbackStatus.Success;

        if (!_enabled) {
            status = CashbackStatus.Disabled;
        } else if (isBlacklisted(recipient)) {
            status = CashbackStatus.Blacklisted;
        } else if (IERC20Upgradeable(token).balanceOf(address(this)) < amount) {
            status = CashbackStatus.OutOfFunds;
        }

        address sender = _msgSender();
        nonce = _nextNonce++;

        Cashback storage cashback = _cashbacks[nonce];
        cashback.token = token;
        cashback.kind = kind;
        cashback.status = status;
        cashback.externalId = externalId;
        cashback.recipient = recipient;
        cashback.amount = amount;
        cashback.sender = sender;

        _nonceCollectionByExternalId[externalId].push(nonce);

        emit SendCashback(
            token,
            kind,
            status,
            externalId,
            recipient,
            amount,
            sender,
            nonce
        );

        if (status == CashbackStatus.Success) {
            _totalCashbackByTokenAndRecipient[token][recipient] += amount;
            _totalCashbackByTokenAndExternalId[token][externalId] += amount;
            IERC20Upgradeable(token).safeTransfer(recipient, amount);
            success = true;
        }
    }

    /**
     * @dev See {ICashbackDistributor-revokeCashback}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {DISTRIBUTOR_ROLE} role.
     */
    function revokeCashback(
        uint256 nonce,
        uint256 amount
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) returns (bool success) {
        Cashback storage cashback = _cashbacks[nonce];

        address sender = _msgSender();
        RevocationStatus revocationStatus = RevocationStatus.Success;

        if (cashback.status != CashbackStatus.Success) {
            revocationStatus = RevocationStatus.Inapplicable;
        } else if (amount > IERC20Upgradeable(cashback.token).balanceOf(sender)) {
            revocationStatus = RevocationStatus.OutOfFunds;
        } else if (amount > IERC20Upgradeable(cashback.token).allowance(sender, address(this))) {
            revocationStatus = RevocationStatus.OutOfAllowance;
        } else if (amount > cashback.amount - cashback.revokedAmount) {
            revocationStatus = RevocationStatus.OutOfBalance;
        }

        emit RevokeCashback(
            cashback.token,
            cashback.kind,
            cashback.status,
            revocationStatus,
            cashback.externalId,
            cashback.recipient,
            amount,
            sender,
            nonce
        );

        if (revocationStatus == RevocationStatus.Success) {
            cashback.revokedAmount += amount;
            _totalCashbackByTokenAndRecipient[cashback.token][cashback.recipient] -= amount;
            _totalCashbackByTokenAndExternalId[cashback.token][cashback.externalId] -= amount;
            IERC20Upgradeable(cashback.token).safeTransferFrom(sender, address(this), amount);
            success = true;
        }
    }

    /**
     * @dev See {ICashbackDistributor-enable}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     */
    function enable() external onlyRole(OWNER_ROLE) {
        if (_enabled) {
            revert CashbackAlreadyEnabled();
        }

        _enabled = true;

        emit Enable(_msgSender());
    }

    /**
     * @dev See {ICashbackDistributor-disable}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     */
    function disable() external onlyRole(OWNER_ROLE) {
        if (!_enabled) {
            revert CashbackAlreadyDisabled();
        }

        _enabled = false;

        emit Disable(_msgSender());
    }

    /**
     * @dev See {ICashbackDistributor-enabled}.
     */
    function enabled() external view returns (bool) {
        return _enabled;
    }

    /**
     * @dev See {ICashbackDistributor-nextNonce}.
     */
    function nextNonce() external view returns (uint256) {
        return _nextNonce;
    }

    /**
     * @dev See {ICashbackDistributor-getCashback}.
     */
    function getCashback(uint256 nonce) external view returns (Cashback memory cashback) {
        cashback = _cashbacks[nonce];
    }

    /**
     * @dev See {ICashbackDistributor-getCashbacks}.
     */
    function getCashbacks(uint256[] calldata nonces) external view returns (Cashback[] memory cashbacks) {
        uint256 len = nonces.length;
        cashbacks = new Cashback[](len);
        for (uint256 i = 0; i < len; i++) {
            cashbacks[i] = _cashbacks[nonces[i]];
        }
    }

    /**
     * @dev See {ICashbackDistributor-getCashbackNonces}.
     */
    function getCashbackNonces(
        bytes32 externalId,
        uint256 index,
        uint256 limit
    ) external view returns (uint256[] memory nonces) {
        uint256[] storage nonceArray = _nonceCollectionByExternalId[externalId];
        uint256 len = nonceArray.length;
        if (len <= index || limit == 0) {
            nonces = new uint256[](0);
        } else {
            len -= index;
            if (len > limit) {
                len = limit;
            }
            nonces = new uint256[](len);
            for (uint256 i = 0; i < len; i++) {
                nonces[i] = nonceArray[index];
                index++;
            }
        }
    }

    /**
     * @dev See {ICashbackDistributor-getTotalCashbackByTokenAndExternalId}.
     */
    function getTotalCashbackByTokenAndExternalId(address token, bytes32 externalId) external view returns (uint256) {
        return _totalCashbackByTokenAndExternalId[token][externalId];
    }

    /**
     * @dev See {ICashbackDistributor-getTotalCashbackByTokenAndRecipient}.
     */
    function getTotalCashbackByTokenAndRecipient(address token, address recipient) external view returns (uint256){
        return _totalCashbackByTokenAndRecipient[token][recipient];
    }

    /**
     * @dev Service function.
     */
    function updateRevokeAmount(uint256 fromNonce, uint256 count) external onlyRole(OWNER_ROLE) {
        uint256 len = fromNonce + count;
        for (uint256 i = fromNonce; i < len; ++i) {
            Cashback storage cashback = _cashbacks[i];
            if (cashback.status == CashbackStatus.Revoked) {
                cashback.status = CashbackStatus.Success;
                cashback.revokedAmount = cashback.amount;
            }
        }
    }
}