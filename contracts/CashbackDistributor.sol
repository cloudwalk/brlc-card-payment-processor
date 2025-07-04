// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { BlocklistableUpgradeable } from "./base/BlocklistableUpgradeable.sol";
import { PausableExtUpgradeable } from "./base/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "./base/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "./base/StoragePlaceholder200.sol";
import { AccessControlExtUpgradeable } from "./base/AccessControlExtUpgradeable.sol";
import { Versionable } from "./base/Versionable.sol";

import { CashbackDistributorStorage } from "./CashbackDistributorStorage.sol";
import { ICashbackDistributor } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CashbackDistributor contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Wrapper contract for the cashback operations.
 */
contract CashbackDistributor is
    AccessControlExtUpgradeable,
    BlocklistableUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    StoragePlaceholder200,
    CashbackDistributorStorage,
    ICashbackDistributor,
    Versionable
{
    // ------------------ Types ----------------------------------- //

    using SafeERC20Upgradeable for IERC20Upgradeable;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.Bytes32Set;

    /// @dev A helper structure to store context of function execution and avoid stack overflow error.
    struct ExecutionContext {
        address token;
        CashbackStatus cashbackStatus;
        bytes32 externalId;
        address recipient;
        address sender;
        uint256 nonce;
        uint256 newAmount;
    }

    // ------------------ Constants ------------------------------- //

    /// @dev The role of a distributor that is allowed to execute the cashback operations.
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    // ------------------ Errors ---------------------------------- //

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

    // ------------------ Constructor ----------------------------- //

    /**
     * @dev Constructor that prohibits the initialization of the implementation of the upgradeable contract.
     *
     * See details:
     * https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable#initializing_the_implementation_contract
     *
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    // ------------------ Initializers ---------------------------- //

    /**
     * @dev The initialize function of the upgradeable contract.
     *
     * See details: https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable
     */
    function initialize() external initializer {
        __AccessControlExt_init_unchained();
        __Blocklistable_init_unchained();
        __Pausable_init_unchained();
        __PausableExt_init_unchained();
        __Rescuable_init_unchained();

        _nextNonce = 1;

        _setRoleAdmin(DISTRIBUTOR_ROLE, GRANTOR_ROLE);
        _grantRole(OWNER_ROLE, _msgSender());
    }

    // ------------------ Transactional functions ----------------- //

    /**
     * @inheritdoc ICashbackDistributor
     *
     * @dev Requirements:
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
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) returns (bool success, uint256 sentAmount, uint256 nonce) {
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
        } else if (isBlocklisted(recipient)) {
            status = CashbackStatus.Blocklisted;
        } else if (IERC20Upgradeable(token).balanceOf(address(this)) < amount) {
            status = CashbackStatus.OutOfFunds;
        } else {
            (bool accepted, uint256 acceptedAmount) = _updateCashbackCap(token, recipient, amount);
            if (!accepted) {
                status = CashbackStatus.Capped;
            } else if (acceptedAmount < amount) {
                status = CashbackStatus.Partial;
                amount = acceptedAmount;
            }
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
            token, // Tools: this comment prevents Prettier from formatting into a single line.
            kind,
            status,
            externalId,
            recipient,
            amount,
            sender,
            nonce
        );

        if (status == CashbackStatus.Success || status == CashbackStatus.Partial) {
            _totalCashbackByTokenAndRecipient[token][recipient] += amount;
            _totalCashbackByTokenAndExternalId[token][externalId] += amount;
            IERC20Upgradeable(token).safeTransfer(recipient, amount);
            sentAmount = amount;
            success = true;
        }
    }

    /**
     * @inheritdoc ICashbackDistributor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {DISTRIBUTOR_ROLE} role.
     */
    function revokeCashback(
        uint256 nonce,
        uint256 amount
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) returns (bool success) {
        Cashback storage cashback = _cashbacks[nonce];
        ExecutionContext memory context = ExecutionContext({
            token: cashback.token,
            cashbackStatus: cashback.status,
            externalId: cashback.externalId,
            recipient: cashback.recipient,
            sender: _msgSender(),
            nonce: nonce,
            newAmount: cashback.revokedAmount
        });

        RevocationStatus revocationStatus = RevocationStatus.Success;

        if (context.cashbackStatus != CashbackStatus.Success && context.cashbackStatus != CashbackStatus.Partial) {
            revocationStatus = RevocationStatus.Inapplicable;
        } else if (amount > IERC20Upgradeable(context.token).balanceOf(context.sender)) {
            revocationStatus = RevocationStatus.OutOfFunds;
        } else if (amount > IERC20Upgradeable(context.token).allowance(context.sender, address(this))) {
            revocationStatus = RevocationStatus.OutOfAllowance;
        } else if (amount > cashback.amount - context.newAmount) {
            revocationStatus = RevocationStatus.OutOfBalance;
        } else {
            context.newAmount += amount;
        }

        emit RevokeCashback(
            context.token,
            cashback.kind,
            context.cashbackStatus,
            revocationStatus,
            context.externalId,
            context.recipient,
            amount,
            revocationStatus == RevocationStatus.Inapplicable ? 0 : cashback.amount - context.newAmount, // totalAmount
            context.sender,
            context.nonce
        );

        if (revocationStatus == RevocationStatus.Success) {
            cashback.revokedAmount = context.newAmount;
            _reduceOverallCashback(context.token, context.recipient, amount);
            _totalCashbackByTokenAndRecipient[context.token][context.recipient] -= amount;
            _totalCashbackByTokenAndExternalId[context.token][context.externalId] -= amount;
            IERC20Upgradeable(context.token).safeTransferFrom(context.sender, address(this), amount);
            success = true;
        }
    }

    /**
     * @inheritdoc ICashbackDistributor
     *
     * @dev Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {DISTRIBUTOR_ROLE} role.
     */
    function increaseCashback(
        uint256 nonce,
        uint256 amount
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) returns (bool success, uint256 sentAmount) {
        Cashback storage cashback = _cashbacks[nonce];
        ExecutionContext memory context = ExecutionContext({
            token: cashback.token,
            cashbackStatus: cashback.status,
            externalId: cashback.externalId,
            recipient: cashback.recipient,
            sender: _msgSender(),
            nonce: nonce,
            newAmount: cashback.amount
        });

        IncreaseStatus status = IncreaseStatus.Success;

        if (context.cashbackStatus != CashbackStatus.Success) {
            status = IncreaseStatus.Inapplicable;
        } else if (!_enabled) {
            status = IncreaseStatus.Disabled;
        } else if (isBlocklisted(context.recipient)) {
            status = IncreaseStatus.Blocklisted;
        } else if (IERC20Upgradeable(context.token).balanceOf(address(this)) < amount) {
            status = IncreaseStatus.OutOfFunds;
        } else {
            (bool accepted, uint256 acceptedAmount) = _updateCashbackCap(context.token, context.recipient, amount);
            if (!accepted) {
                status = IncreaseStatus.Capped;
            } else {
                if (acceptedAmount < amount) {
                    status = IncreaseStatus.Partial;
                    amount = acceptedAmount;
                }
                context.newAmount += amount;
            }
        }

        emit IncreaseCashback(
            context.token,
            cashback.kind,
            context.cashbackStatus,
            status,
            context.externalId,
            context.recipient,
            amount,
            status == IncreaseStatus.Inapplicable ? 0 : context.newAmount - cashback.revokedAmount, // totalAmount
            context.sender,
            context.nonce
        );

        if (status == IncreaseStatus.Success || status == IncreaseStatus.Partial) {
            cashback.amount = context.newAmount;
            _totalCashbackByTokenAndRecipient[context.token][context.recipient] += amount;
            _totalCashbackByTokenAndExternalId[context.token][context.externalId] += amount;
            IERC20Upgradeable(context.token).safeTransfer(context.recipient, amount);
            sentAmount = amount;
            success = true;
        }
    }

    /**
     * @inheritdoc ICashbackDistributor
     *
     * @dev Requirements:
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
     * @inheritdoc ICashbackDistributor
     *
     * @dev Requirements:
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

    // ------------------ View functions -------------------------- //

    /**
     * @inheritdoc ICashbackDistributor
     */
    function enabled() external view returns (bool) {
        return _enabled;
    }

    /**
     * @inheritdoc ICashbackDistributor
     */
    function nextNonce() external view returns (uint256) {
        return _nextNonce;
    }

    /**
     * @inheritdoc ICashbackDistributor
     */
    function getCashback(uint256 nonce) external view returns (Cashback memory cashback) {
        cashback = _cashbacks[nonce];
    }

    /**
     * @inheritdoc ICashbackDistributor
     */
    function getCashbacks(uint256[] calldata nonces) external view returns (Cashback[] memory cashbacks) {
        uint256 len = nonces.length;
        cashbacks = new Cashback[](len);
        for (uint256 i = 0; i < len; i++) {
            cashbacks[i] = _cashbacks[nonces[i]];
        }
    }

    /**
     * @inheritdoc ICashbackDistributor
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
     * @inheritdoc ICashbackDistributor
     */
    function getTotalCashbackByTokenAndExternalId(address token, bytes32 externalId) external view returns (uint256) {
        return _totalCashbackByTokenAndExternalId[token][externalId];
    }

    /**
     * @inheritdoc ICashbackDistributor
     */
    function getTotalCashbackByTokenAndRecipient(address token, address recipient) external view returns (uint256) {
        return _totalCashbackByTokenAndRecipient[token][recipient];
    }

    /**
     * @inheritdoc ICashbackDistributor
     */
    function getCashbackSinceLastReset(address token, address recipient) external view returns (uint256) {
        return _cashbackSinceLastReset[token][recipient];
    }

    /**
     * @inheritdoc ICashbackDistributor
     */
    function getCashbackLastTimeReset(address token, address recipient) external view returns (uint256) {
        return _cashbackLastTimeReset[token][recipient];
    }

    /**
     * @inheritdoc ICashbackDistributor
     */
    function previewCashbackCap(
        address token,
        address recipient
    ) external view returns (uint256 cashbackPeriodStart, uint256 overallCashbackForPeriod) {
        (cashbackPeriodStart, overallCashbackForPeriod, ) = _previewCashbackCap(token, recipient);
    }

    // ------------------ Internal functions ---------------------- //

    /**
     * @dev Previews the cashback cap.
     *
     * @param token The token address.
     * @param recipient The recipient address.
     */
    function _previewCashbackCap(
        address token,
        address recipient
    ) internal view returns (uint256 cashbackPeriodStart, uint256 overallCashbackForPeriod, uint256 isPeriodReset) {
        overallCashbackForPeriod = 0;
        isPeriodReset = 0;
        cashbackPeriodStart = _cashbackLastTimeReset[token][recipient];

        if (block.timestamp - cashbackPeriodStart > CASHBACK_RESET_PERIOD) {
            cashbackPeriodStart = block.timestamp;
            isPeriodReset = 1;
        } else {
            overallCashbackForPeriod = _cashbackSinceLastReset[token][recipient];
        }
    }

    /**
     * @dev Updates the cashback cap.
     *
     * @param token The token address.
     * @param recipient The recipient address.
     */
    function _updateCashbackCap(
        address token,
        address recipient,
        uint256 amount
    ) internal returns (bool accepted, uint256 acceptedAmount) {
        (uint256 cashbackPeriodStart, uint256 overallCashbackForPeriod, uint256 isPeriodReset) = _previewCashbackCap(
            token,
            recipient
        );
        if (isPeriodReset != 0) {
            _cashbackLastTimeReset[token][recipient] = cashbackPeriodStart;
        }

        if (overallCashbackForPeriod < MAX_CASHBACK_FOR_PERIOD) {
            uint256 leftAmount = MAX_CASHBACK_FOR_PERIOD - overallCashbackForPeriod;
            acceptedAmount = leftAmount >= amount ? amount : leftAmount;
            _cashbackSinceLastReset[token][recipient] = overallCashbackForPeriod + acceptedAmount;
            accepted = true;
        }
    }

    /**
     * @dev Reduces the overall cashback.
     *
     * @param token The token address.
     * @param recipient The recipient address.
     * @param amount The amount to reduce.
     */
    function _reduceOverallCashback(
        address token, // Tools: this comment prevents Prettier from formatting into a single line.
        address recipient,
        uint256 amount
    ) internal {
        uint256 overallCashback = _cashbackSinceLastReset[token][recipient];
        if (overallCashback > amount) {
            overallCashback -= amount;
        } else {
            overallCashback = 0;
        }
        _cashbackSinceLastReset[token][recipient] = overallCashback;
    }
}
