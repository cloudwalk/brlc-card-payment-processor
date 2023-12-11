// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import { BlacklistableUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/BlacklistableUpgradeable.sol";
import { PausableExtUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/PausableExtUpgradeable.sol";
import { RescuableUpgradeable } from "@cloudwalkinc/brlc-contracts/contracts/access-control/RescuableUpgradeable.sol";
import { StoragePlaceholder200 } from "@cloudwalkinc/brlc-contracts/contracts/storage/StoragePlaceholder200.sol";

import { CardPaymentProcessorStorage } from "./CardPaymentProcessorStorage.sol";
import { ICardPaymentProcessor } from "./interfaces/ICardPaymentProcessor.sol";
import { ICardPaymentCashback } from "./interfaces/ICardPaymentCashback.sol";
import { ICashbackDistributor, ICashbackDistributorTypes } from "./interfaces/ICashbackDistributor.sol";
import { IERC20Blocklistable } from "./interfaces/IERC20Blocklistable.sol";

/**
 * @title CardPaymentProcessor contract
 * @dev Wrapper contract for the card payment operations.
 */
contract CardPaymentProcessor is
    AccessControlUpgradeable,
    BlacklistableUpgradeable,
    PausableExtUpgradeable,
    RescuableUpgradeable,
    StoragePlaceholder200,
    CardPaymentProcessorStorage,
    ICardPaymentProcessor,
    ICardPaymentCashback
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev The role of this contract owner.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    /// @dev The role of executor that is allowed to execute the card payment operations.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @dev The maximum allowable cashback rate in permil (1 permil = 0.1 %).
    uint16 public constant MAX_CASHBACK_RATE_IN_PERMIL = 250;

    /**
     * @dev The coefficient used to round the cashback according to the formula:
     *      `roundedCashback = [(cashback + coef / 2) / coef] * coef`.
     * Currently, it can only be changed by deploying a new implementation of the contract.
     */
    uint16 public constant CASHBACK_ROUNDING_COEF = 10000;

    // -------------------- Events -----------------------------------

    /**
     * @dev Emitted when the revocation limit is changed.
     * @param oldLimit The old value of the revocation limit.
     * @param newLimit The new value of the revocation limit.
     */
    event SetRevocationLimit(uint8 oldLimit, uint8 newLimit);

    // -------------------- Errors -----------------------------------

    /// @dev The zero token address has been passed as a function argument.
    error ZeroTokenAddress();

    /// @dev The zero account address has been passed as a function argument.
    error ZeroAccount();

    /// @dev Zero authorization ID has been passed as a function argument.
    error ZeroAuthorizationId();

    /// @dev The payment with the provided authorization ID already exists and is not revoked.
    error PaymentAlreadyExists();

    /// @dev Payment with the provided authorization ID is uncleared, but it must be cleared.
    error PaymentAlreadyUncleared();

    /// @dev Payment with the provided authorization ID is cleared, but it must be uncleared.
    error PaymentAlreadyCleared();

    /// @dev The payment with the provided authorization ID does not exist.
    error PaymentNotExist();

    /// @dev Empty array of authorization IDs has been passed as a function argument.
    error EmptyAuthorizationIdsArray();

    /// @dev Zero parent transaction hash has been passed as a function argument.
    error ZeroParentTransactionHash();

    /// @dev The cash-out account is not configured.
    error ZeroCashOutAccount();

    /**
     * @dev The payment with the provided authorization ID has an inappropriate status.
     * @param currentStatus The current status of payment with the provided authorization ID.
     */
    error InappropriatePaymentStatus(PaymentStatus currentStatus);

    /**
     * @dev Revocation counter of the payment reached the configured limit.
     * @param configuredRevocationLimit The configured revocation limit.
     */
    error RevocationLimitReached(uint8 configuredRevocationLimit);

    /// @dev A new cash-out account is the same as the previously set one.
    error CashOutAccountUnchanged();

    /// @dev A new cashback rate is the same as previously set one.
    error CashbackRateUnchanged();

    /// @dev The provided cashback rate exceeds the allowed maximum.
    error CashbackRateExcess();

    /// @dev The cashback operations are already enabled.
    error CashbackAlreadyEnabled();

    /// @dev The cashback operations are already disabled.
    error CashbackAlreadyDisabled();

    /// @dev The zero cashback distributor address has been passed as a function argument.
    error CashbackDistributorZeroAddress();

    /// @dev The cashback distributor contract is not configured.
    error CashbackDistributorNotConfigured();

    /// @dev The cashback distributor contract is already configured.
    error CashbackDistributorAlreadyConfigured();

    /// @dev The requested refund amount does not meet the requirements.
    error InappropriateRefundAmount();

    /// @dev The new amount of the payment does not meet the requirements.
    error InappropriateNewBasePaymentAmount();

    /// @dev The new extra amount of the payment does not meet the requirements.
    error InappropriateNewExtraPaymentAmount();

    /// @dev The function cannot be executed for a subsidized payment with the non-zero refund amount.
    error SubsidizedPaymentWithNonZeroRefundAmount();

    // ------------------- Functions ---------------------------------

    /**
     * @dev The initializer of the upgradable contract.
     *
     * See details https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable .
     *
     * Requirements:
     *
     * - The passed token address must not be zero.
     *
     * @param token_ The address of a token to set as the underlying one.
     */
    function initialize(address token_) external initializer {
        __CardPaymentProcessor_init(token_);
    }

    /**
     * @dev The internal initializer of the upgradable contract.
     *
     * See {CardPaymentProcessor-initialize}.
     */
    function __CardPaymentProcessor_init(address token_) internal onlyInitializing {
        __Context_init_unchained();
        __ERC165_init_unchained();
        __AccessControl_init_unchained();
        __Blacklistable_init_unchained(OWNER_ROLE);
        __Pausable_init_unchained();
        __PausableExt_init_unchained(OWNER_ROLE);
        __Rescuable_init_unchained(OWNER_ROLE);

        __CardPaymentProcessor_init_unchained(token_);
    }

    /**
     * @dev The internal unchained initializer of the upgradable contract.
     *
     * See {CardPaymentProcessor-initialize}.
     */
    function __CardPaymentProcessor_init_unchained(address token_) internal onlyInitializing {
        if (token_ == address(0)) {
            revert ZeroTokenAddress();
        }

        _token = token_;
        _revocationLimit = type(uint8).max;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(EXECUTOR_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /// @dev Contains parameters of a payment making operation.
    struct MakingOperation {
        address sender;
        address account;
        uint256 baseAmount;
        uint256 extraAmount;
        bytes16 authorizationId;
        bytes16 correlationId;
        address sponsor;
        uint256 subsidyLimit;
        int16   cashbackRateInPermil;
    }

    /**
     * @dev See {ICardPaymentProcessor-makePayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must must not be blacklisted.
     * - The authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked.
     * - The payment's revocation counter must be equal to zero or less than the configured revocation limit.
     */
    function makePayment(
        uint256 baseAmount,
        uint256 extraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused notBlacklisted(_msgSender()) {
        address sender = _msgSender();
        MakingOperation memory operation = MakingOperation({
            sender: sender,
            account: sender,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            authorizationId: authorizationId,
            correlationId: correlationId,
            sponsor: address(0),
            subsidyLimit: 0,
            cashbackRateInPermil: -1
        });
        makePaymentInternal(operation);
    }

    /**
     * @dev See {ICardPaymentProcessor-makePaymentFor}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The payment account address must not be zero.
     * - The authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must not exist or be revoked.
     * - The payment's revocation counter must be equal to zero or less than the configured revocation limit.
     * - The requested cashback rate must not exceed the maximum allowable cashback rate defined in the contract.
     */
    function makePaymentFor(
        address account,
        uint256 baseAmount,
        uint256 extraAmount,
        bytes16 authorizationId,
        bytes16 correlationId,
        address sponsor,
        uint256 subsidyLimit,
        int16   cashbackRateInPermil
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert ZeroAccount();
        }
        if (cashbackRateInPermil > 0 && uint16(cashbackRateInPermil) > MAX_CASHBACK_RATE_IN_PERMIL) {
            revert CashbackRateExcess();
        }
        MakingOperation memory operation = MakingOperation({
            sender: _msgSender(),
            account: account,
            baseAmount: baseAmount,
            extraAmount: extraAmount,
            authorizationId: authorizationId,
            correlationId: correlationId,
            sponsor: sponsor,
            subsidyLimit: subsidyLimit,
            cashbackRateInPermil: cashbackRateInPermil
        });
        makePaymentInternal(operation);
    }

    /**
     * @dev See {ICardPaymentProcessor-updatePaymentAmount}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     * - The new base amount must not exceed the existing refund amount.
     * - If the base amount of the payment increases the extra amount must increase too or keep unchanged.
     * - If the base amount of the payment decreases the extra amount must decrease too or keep unchanged.
     * - If the base amount of the payment does not change the extra amount is allowed to change in any way.
     */
    function updatePaymentAmount(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        updatePaymentAmountInternal(
            newBaseAmount,
            newExtraAmount,
            authorizationId,
            correlationId,
            UpdatingOperationKind.Full
        );
    }

    /**
     * @dev See {ICardPaymentProcessor-clearPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     */
    function clearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = clearPaymentInternal(authorizationId);

        _totalUnclearedBalance -= amount;
        _totalClearedBalance += amount;
    }

    /**
     * @dev See {ICardPaymentProcessor-clearPayments}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "uncleared" status.
     */
    function clearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 cumulativeAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; i++) {
            cumulativeAmount += clearPaymentInternal(authorizationIds[i]);
        }

        _totalUnclearedBalance -= cumulativeAmount;
        _totalClearedBalance += cumulativeAmount;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" status.
     */
    function unclearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = unclearPaymentInternal(authorizationId);

        _totalClearedBalance -= amount;
        _totalUnclearedBalance += amount;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearPayments}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "cleared" status.
     */
    function unclearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 cumulativeAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; i++) {
            cumulativeAmount += unclearPaymentInternal(authorizationIds[i]);
        }

        _totalClearedBalance -= cumulativeAmount;
        _totalUnclearedBalance += cumulativeAmount;
    }

    /**
     * @dev See {ICardPaymentProcessor-reversePayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and parent transaction hash of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" or "uncleared" status.
     */
    function reversePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        cancelPaymentInternal(
            authorizationId,
            correlationId,
            parentTxHash,
            PaymentStatus.Reversed
        );
    }

    /**
     * @dev See {ICardPaymentProcessor-revokePayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and parent transaction hash of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" or "uncleared" status.
     * - The revocation limit of payments should not be zero.
     */
    function revokePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (_revocationLimit == 0) {
            revert RevocationLimitReached(0);
        }

        cancelPaymentInternal(
            authorizationId,
            correlationId,
            parentTxHash,
            PaymentStatus.Revoked
        );
    }

    /**
     * @dev See {ICardPaymentProcessor-confirmPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "cleared" status.
     */
    function confirmPayment(bytes16 authorizationId) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = confirmPaymentInternal(authorizationId);
        _totalClearedBalance -= amount;
        IERC20Upgradeable(_token).safeTransfer(requireCashOutAccount(), amount);
    }

    /**
     * @dev See {ICardPaymentProcessor-confirmPayments}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "cleared" status.
     */
    function confirmPayments(bytes16[] memory authorizationIds) public whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 cumulativeAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            cumulativeAmount += confirmPaymentInternal(authorizationIds[i]);
        }

        _totalClearedBalance -= cumulativeAmount;
        IERC20Upgradeable(_token).safeTransfer(requireCashOutAccount(), cumulativeAmount);
    }

    /**
     * @dev See {ICardPaymentProcessor-clearAndConfirmPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     */
    function clearAndConfirmPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        clearAndConfirmPaymentInternal(authorizationId);
    }

    /**
     * @dev See {ICardPaymentProcessor-updateLazyClearConfirmPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The payment linked with the authorization ID must have the "uncleared" status.
     * - The input authorization ID of the payment must not be zero.
     * - The new base amount must not exceed the existing refund amount.
     * - If the base amount of the payment increases the extra amount must increase too or keep unchanged.
     * - If the base amount of the payment decreases the extra amount must decrease too or keep unchanged.
     * - If the base amount of the payment does not change the extra amount is allowed to change in any way.
     */
    function updateLazyClearConfirmPayment(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        updatePaymentAmountInternal(
            newBaseAmount,
            newExtraAmount,
            authorizationId,
            correlationId,
            UpdatingOperationKind.Lazy
        );
        clearAndConfirmPaymentInternal(authorizationId);
    }

    /**
     * @dev See {ICardPaymentProcessor-clearAndConfirmPayments}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input array of authorization IDs must not be empty.
     * - All authorization IDs in the input array must not be zero.
     * - All payments linked with the authorization IDs must have the "uncleared" status.
     */
    function clearAndConfirmPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyAuthorizationIdsArray();
        }

        uint256 cumulativeClearedAmount = 0;
        uint256 cumulativeConfirmedAmount = 0;
        uint256 len = authorizationIds.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes16 authorizationId = authorizationIds[i];
            cumulativeClearedAmount += clearPaymentInternal(authorizationId);
            cumulativeConfirmedAmount += confirmPaymentInternal(authorizationId);
        }

        _totalUnclearedBalance -= cumulativeClearedAmount;
        _totalClearedBalance = _totalClearedBalance + cumulativeClearedAmount - cumulativeConfirmedAmount;

        IERC20Upgradeable(_token).safeTransfer(requireCashOutAccount(), cumulativeConfirmedAmount);
    }

    /**
     * @dev See {ICardPaymentProcessor-refundPayment}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment must not be zero.
     * - The new extra amount must not be greater that the current one.
     */
    function refundPayment(
        uint256 refundAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        refundPaymentInternal(refundAmount, newExtraAmount, authorizationId, correlationId);
    }

    /**
     * @dev A version of the function without the `newExtraAmount` parameter for backward compatibility.
     */
    function refundPayment(
        uint256 refundAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        refundPaymentInternal(refundAmount, _payments[authorizationId].extraAmount, authorizationId, correlationId);
    }

    /**
     * @dev See {ICardPaymentProcessor-refundAccount}.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The caller must have the {EXECUTOR_ROLE} role.
     * - The account address must not be zero.
     */
    function refundAccount(
        address account,
        uint256 refundAmount,
        bytes16 correlationId
    ) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (account == address(0)) {
            revert ZeroAccount();
        }

        address cashOutAccount_ = requireCashOutAccount();
        IERC20Upgradeable token = IERC20Upgradeable(_token);

        bool inBlocklist;
        if (IERC20Blocklistable(_token).isBlacklisted(account)) {
            inBlocklist = true;
            IERC20Blocklistable(_token).unBlacklist(account);
        }

        emit RefundAccount(
            correlationId,
            account,
            refundAmount
        );

        token.safeTransferFrom(cashOutAccount_, account, refundAmount);

        if (inBlocklist) {
            IERC20Blocklistable(_token).blacklist(account);
        }
    }

    /**
     * @dev Sets a new value for the revocation limit.
     * If the limit equals 0 or 1 a payment with the same authorization ID cannot be repeated after the revocation.
     *
     * Requirements:
     *
     * - The caller must have the {EXECUTOR_ROLE} role.
     *
     * Emits a {SetRevocationLimit} event if the new limit differs from the old value.
     *
     * @param newLimit The new revocation limit value to be set.
     */
    function setRevocationLimit(uint8 newLimit) external onlyRole(OWNER_ROLE) {
        uint8 oldLimit = _revocationLimit;
        if (oldLimit == newLimit) {
            return;
        }

        _revocationLimit = newLimit;
        emit SetRevocationLimit(oldLimit, newLimit);
    }

    /**
     * @dev See {ICardPaymentProcessor-cashOutAccount}.
     */
    function cashOutAccount() external view returns (address) {
        return _cashOutAccount;
    }

    /**
     * @dev See {ICardPaymentProcessor-underlyingToken}.
     */
    function underlyingToken() external view returns (address) {
        return _token;
    }

    /**
     * @dev See {ICardPaymentProcessor-totalUnclearedBalance}.
     */
    function totalUnclearedBalance() external view returns (uint256) {
        return _totalUnclearedBalance;
    }

    /**
     * @dev See {ICardPaymentProcessor-totalClearedBalance}.
     */
    function totalClearedBalance() external view returns (uint256) {
        return _totalClearedBalance;
    }

    /**
     * @dev See {ICardPaymentProcessor-unclearedBalanceOf}.
     */
    function unclearedBalanceOf(address account) external view returns (uint256) {
        return _unclearedBalances[account];
    }

    /**
     * @dev See {ICardPaymentProcessor-clearedBalanceOf}.
     */
    function clearedBalanceOf(address account) external view returns (uint256) {
        return _clearedBalances[account];
    }

    /**
     * @dev See {ICardPaymentProcessor-paymentFor}.
     */
    function paymentFor(bytes16 authorizationId) external view returns (Payment memory) {
        return _payments[authorizationId];
    }

    /**
     * @dev See {ICardPaymentProcessor-isPaymentRevoked}.
     */
    function isPaymentRevoked(bytes32 parentTxHash) external view returns (bool) {
        return _paymentRevocationFlags[parentTxHash];
    }

    /**
     * @dev See {ICardPaymentProcessor-isPaymentReversed}.
     */
    function isPaymentReversed(bytes32 parentTxHash) external view returns (bool) {
        return _paymentReversionFlags[parentTxHash];
    }

    /**
     * @dev See {ICardPaymentProcessor-revocationLimit}.
     */
    function revocationLimit() external view returns (uint8) {
        return _revocationLimit;
    }

    /**
     * @dev See {ICardPaymentCashback-cashbackDistributor}.
     */
    function cashbackDistributor() external view returns (address) {
        return _cashbackDistributor;
    }

    /**
     * @dev See {ICardPaymentCashback-cashbackEnabled}.
     */
    function cashbackEnabled() external view returns (bool) {
        return _cashbackEnabled;
    }

    /**
     * @dev See {ICardPaymentCashback-cashbackRate}.
     */
    function cashbackRate() external view returns (uint256) {
        return _cashbackRateInPermil;
    }

    /**
     * @dev See {ICardPaymentCashback-getCashback}.
     */
    function getCashback(bytes16 authorizationId) external view returns (Cashback memory) {
        return _cashbacks[authorizationId];
    }

    /**
     * @dev See {ICardPaymentCashback-setCashbackDistributor}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new cashback distributor address must not be zero.
     * - The new cashback distributor can be set only once.
     */
    function setCashbackDistributor(address newCashbackDistributor) external onlyRole(OWNER_ROLE) {
        address oldCashbackDistributor = _cashbackDistributor;

        if (newCashbackDistributor == address(0)) {
            revert CashbackDistributorZeroAddress();
        }
        if (oldCashbackDistributor != address(0)) {
            revert CashbackDistributorAlreadyConfigured();
        }

        _cashbackDistributor = newCashbackDistributor;

        emit SetCashbackDistributor(oldCashbackDistributor, newCashbackDistributor);

        IERC20Upgradeable(_token).approve(newCashbackDistributor, type(uint256).max);
    }

    /**
     * @dev See {ICardPaymentCashback-setCashbackRate}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new rate must differ from the previously set one.
     * - The new rate must not exceed the allowable maximum specified in the {MAX_CASHBACK_RATE_IN_PERMIL} constant.
     */
    function setCashbackRate(uint16 newCashbackRateInPermil) external onlyRole(OWNER_ROLE) {
        uint16 oldCashbackRateInPermil = _cashbackRateInPermil;
        if (newCashbackRateInPermil == oldCashbackRateInPermil) {
            revert CashbackRateUnchanged();
        }
        if (newCashbackRateInPermil > MAX_CASHBACK_RATE_IN_PERMIL) {
            revert CashbackRateExcess();
        }

        _cashbackRateInPermil = newCashbackRateInPermil;

        emit SetCashbackRate(oldCashbackRateInPermil, newCashbackRateInPermil);
    }

    /**
     * @dev See {ICardPaymentCashback-enableCashback}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The cashback operations must not be already enabled.
     * - The address of the current cashback distributor must not be zero.
     */
    function enableCashback() external onlyRole(OWNER_ROLE) {
        if (_cashbackEnabled) {
            revert CashbackAlreadyEnabled();
        }
        if (_cashbackDistributor == address(0)) {
            revert CashbackDistributorNotConfigured();
        }

        _cashbackEnabled = true;

        emit EnableCashback();
    }

    /**
     * @dev See {ICardPaymentCashback-disableCashback}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The cashback operations must not be already disabled.
     */
    function disableCashback() external onlyRole(OWNER_ROLE) {
        if (!_cashbackEnabled) {
            revert CashbackAlreadyDisabled();
        }

        _cashbackEnabled = false;

        emit DisableCashback();
    }

    /**
     * @dev See {ICardPaymentCashback-setCashOutAccount}.
     *
     * Requirements:
     *
     * - The caller must have the {OWNER_ROLE} role.
     * - The new cash-out account must differ from the previously set one.
     */
    function setCashOutAccount(address newCashOutAccount) external onlyRole(OWNER_ROLE) {
        address oldCashOutAccount = _cashOutAccount;

        if (newCashOutAccount == oldCashOutAccount) {
            revert CashOutAccountUnchanged();
        }

        _cashOutAccount = newCashOutAccount;

        emit SetCashOutAccount(oldCashOutAccount, newCashOutAccount);
    }

    /// @dev Making a payment. See {ICardPaymentCashback-makePaymentSubsidized}.
    function makePaymentInternal(MakingOperation memory operation) internal {
        if (operation.authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[operation.authorizationId];

        PaymentStatus status = payment.status;
        if (
            status != PaymentStatus.Nonexistent &&
            status != PaymentStatus.Revoked
        ) {
            revert PaymentAlreadyExists();
        }

        uint8 revocationCounter = payment.revocationCounter;
        if (revocationCounter != 0 && revocationCounter >= _revocationLimit) {
            revert RevocationLimitReached(_revocationLimit);
        }

        uint256 sumAmount = operation.baseAmount + operation.extraAmount;
        payment.account = operation.account;
        payment.baseAmount = operation.baseAmount;
        payment.status = PaymentStatus.Uncleared;

        if (operation.sponsor != address(0)) {
            payment.sponsor = operation.sponsor;
            payment.subsidyLimit = operation.subsidyLimit;
        } else {
            operation.subsidyLimit = 0;
            resetSubsidizedPaymentFields(payment);
        }

        _unclearedBalances[operation.account] += sumAmount;
        _totalUnclearedBalance += sumAmount;

        emit MakePayment(
            operation.authorizationId,
            operation.correlationId,
            operation.account,
            sumAmount,
            revocationCounter,
            operation.sender
        );

        // We do not call a related existent internal function here to safe some gas and
        // because `payment.extraAmount` can be already set at this point if the payment was revoked.
        if (operation.extraAmount > 0) {
            emit PaymentExtraAmountChanged(
                operation.authorizationId,
                operation.correlationId,
                operation.account,
                sumAmount,
                operation.extraAmount,
                0
            );
            payment.extraAmount = operation.extraAmount;
        } else if (payment.extraAmount != 0) {
            payment.extraAmount = 0;
        }

        (uint256 accountSumAmount, uint256 sponsorSumAmount) = defineSumAmountParts(sumAmount, operation.subsidyLimit);
        uint256 accountBaseAmount = defineAccountBaseAmount(operation.baseAmount, operation.subsidyLimit);
        IERC20Upgradeable token = IERC20Upgradeable(_token);

        token.safeTransferFrom(operation.account, address(this), accountSumAmount);
        if (operation.sponsor != address(0)) {
            emit MakePaymentSubsidized(
                operation.authorizationId,
                operation.correlationId,
                operation.sponsor,
                operation.subsidyLimit,
                sponsorSumAmount,
                bytes("")
            );

            token.safeTransferFrom(operation.sponsor, address(this), sponsorSumAmount);
        }
        (payment.compensationAmount, payment.cashbackRate) = sendCashbackInternal(
            operation.account,
            accountBaseAmount,
            operation.authorizationId,
            operation.cashbackRateInPermil
        );
    }

    /// @dev Contains parameters for a payment updating operation.
    struct UpdatingOperation {
        uint256 oldPaymentSumAmount;
        uint256 newPaymentSumAmount;
        uint256 oldSponsorSumAmount;
        uint256 newSponsorSumAmount;
        uint256 oldPaymentBaseAmount;
        uint256 newPaymentBaseAmount;
        uint256 oldCompensationAmount;
        uint256 paymentTotalAmountChange;
        uint256 accountBalanceChange;
        uint256 sponsorBalanceChange;
        uint256 cashbackAmountChange;
        bool paymentSumAmountDecreased;
        bool cashbackDecreased;
    }

    /// @dev Kind of a payment updating operation
    enum UpdatingOperationKind {
        Full, // 0 The operation is executed fully regardless of the new values of the base amount and extra amount.
        Lazy  // 1 The operation is executed only if the new amounts differ from the current ones of the payment.
    }

    /// @dev Updates the base amount and extra amount of a payment. See {ICardPaymentCashback-updatePaymentAmount}.
    function updatePaymentAmountInternal(
        uint256 newBaseAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId,
        UpdatingOperationKind kind
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];
        if (kind != UpdatingOperationKind.Full) {
            if (payment.baseAmount == newBaseAmount && payment.extraAmount == newExtraAmount) {
                return;
            }
        }
        PaymentStatus status = payment.status;
        uint256 refundAmount = payment.refundAmount;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
        if (refundAmount > newBaseAmount) {
            revert InappropriateNewBasePaymentAmount();
        }
        UpdatingOperation memory operation = defineUpdatePaymentOperation(
            newBaseAmount,
            newExtraAmount,
            refundAmount,
            payment
        );

        payment.baseAmount = newBaseAmount;

        address account = payment.account;
        address sponsor = payment.sponsor;
        IERC20Upgradeable token = IERC20Upgradeable(_token);

        emit UpdatePaymentAmount(
            authorizationId,
            correlationId,
            account,
            operation.oldPaymentSumAmount,
            operation.newPaymentSumAmount,
            operation.oldPaymentBaseAmount,
            operation.newPaymentBaseAmount
        );
        if (sponsor != address(0)) {
            emit UpdatePaymentSubsidized(
                authorizationId,
                correlationId,
                sponsor,
                operation.oldSponsorSumAmount,
                operation.newSponsorSumAmount,
                bytes("")
            );
        }

        // Increase cashback ahead any other token transfers to avoid conner cases with lack of customer balance
        if (!operation.cashbackDecreased) {
            uint256 cashbackIncreaseAmount = increaseCashbackInternal(authorizationId, operation.cashbackAmountChange);
            payment.compensationAmount = operation.oldCompensationAmount + cashbackIncreaseAmount;
        }

        updateExtraAmountInternal(
            authorizationId,
            correlationId,
            account,
            operation.newPaymentSumAmount,
            newExtraAmount,
            payment
        );

        if (operation.paymentSumAmountDecreased) {
            _totalUnclearedBalance -= operation.paymentTotalAmountChange;
            _unclearedBalances[account] -= operation.paymentTotalAmountChange;
            token.safeTransfer(account, operation.accountBalanceChange);
            if (sponsor != address(0)) {
                token.safeTransfer(sponsor, operation.sponsorBalanceChange);
            }
        } else {
            _totalUnclearedBalance += operation.paymentTotalAmountChange;
            _unclearedBalances[account] += operation.paymentTotalAmountChange;
            token.safeTransferFrom(account, address(this), operation.accountBalanceChange);
            if (sponsor != address(0)) {
                token.safeTransferFrom(sponsor, address(this), operation.sponsorBalanceChange);
            }
        }
        if (operation.cashbackDecreased) {
            revokeCashbackInternal(authorizationId, operation.cashbackAmountChange);
            payment.compensationAmount = operation.oldCompensationAmount - operation.cashbackAmountChange;
        }
    }

    /// @dev Returns a structure with parameters for a payment updating operation.
    function defineUpdatePaymentOperation(
        uint256 newPaymentBaseAmount,
        uint256 newPaymentExtraAmount,
        uint256 paymentRefundAmount,
        Payment storage payment
    ) internal view returns (UpdatingOperation memory) {
        if (payment.sponsor != address(0) && paymentRefundAmount != 0) {
            revert SubsidizedPaymentWithNonZeroRefundAmount();
        }
        uint256 oldPaymentBaseAmount = payment.baseAmount;
        uint256 oldPaymentSumAmount = oldPaymentBaseAmount + payment.extraAmount;
        uint256 newPaymentSumAmount = newPaymentBaseAmount + newPaymentExtraAmount;
        uint256 subsidyLimit = payment.subsidyLimit;
        uint256 newAccountSumAmount;
        uint256 newSponsorSumAmount;
        uint256 oldAccountSumAmount;
        uint256 oldSponsorSumAmount;
        (newAccountSumAmount, newSponsorSumAmount) = defineSumAmountParts(newPaymentSumAmount, subsidyLimit);
        (oldAccountSumAmount, oldSponsorSumAmount) = defineSumAmountParts(oldPaymentSumAmount, subsidyLimit);

        UpdatingOperation memory operation = UpdatingOperation({
            oldPaymentSumAmount: oldPaymentSumAmount,
            newPaymentSumAmount: newPaymentSumAmount,
            oldSponsorSumAmount: oldSponsorSumAmount,
            newSponsorSumAmount: newSponsorSumAmount,
            oldPaymentBaseAmount: oldPaymentBaseAmount,
            newPaymentBaseAmount: newPaymentBaseAmount,
            oldCompensationAmount: payment.compensationAmount,
            paymentTotalAmountChange: 0,
            accountBalanceChange: 0,
            sponsorBalanceChange: 0,
            cashbackAmountChange: 0,
            paymentSumAmountDecreased: false,
            cashbackDecreased: false
        });

        uint256 newAccountBaseAmount = defineAccountBaseAmount(newPaymentBaseAmount, subsidyLimit);
        uint256 newCompensationAmount = paymentRefundAmount +
            calculateCashback(newAccountBaseAmount - paymentRefundAmount, payment.cashbackRate);
        uint256 oldCompensationAmount = operation.oldCompensationAmount;

        if (operation.newPaymentBaseAmount <= operation.oldPaymentBaseAmount) {
            operation.cashbackDecreased = true;
            // If payment base amount decreases than the cashback amount can only be decreased or is not changed.
            if (newCompensationAmount <= oldCompensationAmount) {
                operation.cashbackAmountChange = oldCompensationAmount - newCompensationAmount;
            }
        } else {
            operation.cashbackAmountChange = newCompensationAmount - oldCompensationAmount;
        }

        if (newPaymentSumAmount < oldPaymentSumAmount) {
            operation.paymentSumAmountDecreased = true;
            operation.paymentTotalAmountChange = oldPaymentSumAmount - newPaymentSumAmount;
            operation.sponsorBalanceChange = oldSponsorSumAmount - newSponsorSumAmount;
            operation.accountBalanceChange = oldAccountSumAmount - newAccountSumAmount;

            if (operation.cashbackDecreased) {
                operation.accountBalanceChange -= operation.cashbackAmountChange;
            }
        } else {
            operation.paymentTotalAmountChange = newPaymentSumAmount - oldPaymentSumAmount;
            operation.sponsorBalanceChange = newSponsorSumAmount - oldSponsorSumAmount;
            operation.accountBalanceChange = newAccountSumAmount - oldAccountSumAmount;

            if (operation.cashbackDecreased) {
                operation.accountBalanceChange += operation.cashbackAmountChange;
            }
        }
        return operation;
    }

    /// @dev Clears a payment. See {ICardPaymentCashback-clearPayment}.
    function clearPaymentInternal(bytes16 authorizationId) internal returns (uint256 totalAmount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        PaymentStatus status = payment.status;
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status == PaymentStatus.Cleared) {
            revert PaymentAlreadyCleared();
        }
        if (status != PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
        payment.status = PaymentStatus.Cleared;

        address account = payment.account;
        totalAmount = payment.baseAmount + payment.extraAmount - payment.refundAmount;

        uint256 newUnclearedBalance = _unclearedBalances[account] - totalAmount;
        _unclearedBalances[account] = newUnclearedBalance;
        uint256 newClearedBalance = _clearedBalances[account] + totalAmount;
        _clearedBalances[account] = newClearedBalance;

        emit ClearPayment(
            authorizationId,
            account,
            totalAmount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );

        address sponsor = payment.sponsor;
        if (sponsor != address(0)) {
            emit ClearPaymentSubsidized(
                authorizationId,
                sponsor,
                bytes("")
            );
        }
    }

    /// @dev Unclears a payment. See {ICardPaymentCashback-unclearPayment}.
    function unclearPaymentInternal(bytes16 authorizationId) internal returns (uint256 totalAmount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        PaymentStatus status = payment.status;
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status == PaymentStatus.Uncleared) {
            revert PaymentAlreadyUncleared();
        }
        if (status != PaymentStatus.Cleared) {
            revert InappropriatePaymentStatus(status);
        }
        payment.status = PaymentStatus.Uncleared;

        address account = payment.account;
        totalAmount = payment.baseAmount + payment.extraAmount - payment.refundAmount;

        uint256 newClearedBalance = _clearedBalances[account] - totalAmount;
        _clearedBalances[account] = newClearedBalance;
        uint256 newUnclearedBalance = _unclearedBalances[account] + totalAmount;
        _unclearedBalances[account] = newUnclearedBalance;

        emit UnclearPayment(
            authorizationId,
            account,
            totalAmount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );

        address sponsor = payment.sponsor;
        if (sponsor != address(0)) {
            emit UnclearPaymentSubsidized(
                authorizationId,
                sponsor,
                bytes("")
            );
        }
    }

    /// @dev Confirms a payment. See {ICardPaymentCashback-confirmPayment}.
    function confirmPaymentInternal(bytes16 authorizationId) internal returns (uint256 totalAmount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        PaymentStatus status = payment.status;
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Cleared) {
            revert InappropriatePaymentStatus(status);
        }
        payment.status = PaymentStatus.Confirmed;

        address account = payment.account;
        totalAmount = payment.baseAmount + payment.extraAmount - payment.refundAmount;
        uint256 newClearedBalance = _clearedBalances[account] - totalAmount;
        _clearedBalances[account] = newClearedBalance;

        emit ConfirmPayment(authorizationId, account, totalAmount, newClearedBalance, payment.revocationCounter);

        address sponsor = payment.sponsor;
        if (sponsor != address(0)) {
            emit ConfirmPaymentSubsidized(
                authorizationId,
                sponsor,
                bytes("")
            );
        }
    }

    function clearAndConfirmPaymentInternal(bytes16 authorizationId) internal {
        uint256 clearedAmount = clearPaymentInternal(authorizationId);
        uint256 confirmedAmount = confirmPaymentInternal(authorizationId);

        _totalUnclearedBalance -= clearedAmount;
        _totalClearedBalance = _totalClearedBalance + clearedAmount - confirmedAmount;

        IERC20Upgradeable(_token).safeTransfer(requireCashOutAccount(), confirmedAmount);
    }

    /// @dev Contains parameters of a payment canceling operation.
    struct CancelingOperation {
        uint256 paymentTotalAmount;
        uint256 accountSentAmount;
        uint256 sponsorSentAmount;
        uint256 totalSentAmount;
        uint256 revokedCashbackAmount;
    }

    /// @dev Cancels a payment. For parameters see {ICardPaymentCashback-revokePayment}.
    function cancelPaymentInternal(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash,
        PaymentStatus targetStatus
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }
        if (parentTxHash == 0) {
            revert ZeroParentTransactionHash();
        }

        Payment storage payment = _payments[authorizationId];
        PaymentStatus status = payment.status;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }

        CancelingOperation memory operation = defineCancellationOperation(payment);

        address account = payment.account;
        if (status == PaymentStatus.Uncleared) {
            _totalUnclearedBalance -= operation.paymentTotalAmount;
            _unclearedBalances[account] -= operation.paymentTotalAmount;
        } else if (status == PaymentStatus.Cleared) {
            _totalClearedBalance -= operation.paymentTotalAmount;
            _clearedBalances[account] -= operation.paymentTotalAmount;
        } else {
            revert InappropriatePaymentStatus(status);
        }

        resetCompensationAndRefundFields(payment);

        address sponsor = payment.sponsor;
        if (targetStatus == PaymentStatus.Revoked) {
            payment.status = PaymentStatus.Revoked;
            _paymentRevocationFlags[parentTxHash] = true;
            uint8 newRevocationCounter = payment.revocationCounter + 1;
            payment.revocationCounter = newRevocationCounter;

            emit RevokePayment(
                authorizationId,
                correlationId,
                account,
                operation.totalSentAmount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                newRevocationCounter
            );

            if (sponsor != address(0)) {
                emit RevokePaymentSubsidized(
                    authorizationId,
                    correlationId,
                    sponsor,
                    operation.sponsorSentAmount,
                    bytes("")
                );
            }
        } else {
            payment.status = PaymentStatus.Reversed;
            _paymentReversionFlags[parentTxHash] = true;

            emit ReversePayment(
                authorizationId,
                correlationId,
                account,
                operation.totalSentAmount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                payment.revocationCounter
            );

            if (sponsor != address(0)) {
                emit ReversePaymentSubsidized(
                    authorizationId,
                    correlationId,
                    sponsor,
                    operation.sponsorSentAmount,
                    bytes("")
                );
            }
        }

        IERC20Upgradeable token = IERC20Upgradeable(_token);

        token.safeTransfer(account, operation.accountSentAmount);
        if (sponsor != address(0)) {
            token.safeTransfer(sponsor, operation.sponsorSentAmount);
        }
        revokeCashbackInternal(authorizationId, operation.revokedCashbackAmount);
    }

    /// @dev Returns a structure with parameters for a payment cancellation operation.
    function defineCancellationOperation(Payment storage payment) internal view returns (CancelingOperation memory) {
        uint256 paymentBaseAmount = payment.baseAmount;
        uint256 paymentRefundAmount = payment.refundAmount;
        uint256 subsidyLimit = payment.subsidyLimit;
        uint256 sponsorRefundAmount = defineSponsorRefundAmount(paymentRefundAmount, paymentBaseAmount, subsidyLimit);
        uint256 paymentSumAmount = paymentBaseAmount + payment.extraAmount;
        (uint256 accountSumAmount, uint256 sponsorSumAmount) = defineSumAmountParts(paymentSumAmount, subsidyLimit);
        uint256 paymentTotalAmount = paymentSumAmount - paymentRefundAmount;
        uint256 accountSentAmount = accountSumAmount - (payment.compensationAmount - sponsorRefundAmount);
        uint256 sponsorSentAmount = sponsorSumAmount - sponsorRefundAmount;

        CancelingOperation memory operation = CancelingOperation({
            paymentTotalAmount: paymentTotalAmount,
            accountSentAmount: accountSentAmount,
            sponsorSentAmount: sponsorSentAmount,
            totalSentAmount: accountSentAmount + sponsorSentAmount,
            revokedCashbackAmount: paymentTotalAmount - accountSentAmount - sponsorSentAmount
        });

        return operation;
    }

    /// @dev Contains parameters of a payment refunding operation.
    struct RefundingOperation {
        uint256 paymentRefundAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 sponsorRefundAmount;
        uint256 newPaymentRefundAmount;
        uint256 newPaymentSumAmount;
        uint256 paymentTotalAmountDiff;
        uint256 oldCashbackAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 newCashbackAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 oldCompensationAmount; // It is for local use only to avoid the "Stack too deep" error.
        uint256 newCompensationAmount;
        uint256 accountSentAmount;
        uint256 sponsorSentAmount;
        uint256 totalSentAmount;
        uint256 revokedCashbackAmount;
    }

    /// @dev Makes a refund for a payment. See {ICardPaymentCashback-refundPayment}.
    function refundPaymentInternal(
        uint256 refundAmount,
        uint256 newExtraAmount,
        bytes16 authorizationId,
        bytes16 correlationId
    ) internal {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];
        PaymentStatus status = payment.status;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentNotExist();
        }
        if (status != PaymentStatus.Uncleared && status != PaymentStatus.Cleared && status != PaymentStatus.Confirmed) {
            revert InappropriatePaymentStatus(status);
        }
        if (payment.refundAmount + refundAmount > payment.baseAmount) {
            revert InappropriateRefundAmount();
        }
        if (newExtraAmount > payment.extraAmount) {
            revert InappropriateNewExtraPaymentAmount();
        }

        RefundingOperation memory operation = defineRefundingOperation(refundAmount, newExtraAmount, payment);

        payment.refundAmount = operation.newPaymentRefundAmount;
        payment.compensationAmount = operation.newCompensationAmount;

        address account = payment.account;

        bool inBlocklist;
        if (IERC20Blocklistable(_token).isBlacklisted(account)) {
            inBlocklist = true;
            IERC20Blocklistable(_token).unBlacklist(account);
        }

        address sponsor = payment.sponsor;
        IERC20Upgradeable token = IERC20Upgradeable(_token);
        if (status == PaymentStatus.Uncleared) {
            _totalUnclearedBalance -= operation.paymentTotalAmountDiff;
            _unclearedBalances[account] -= operation.paymentTotalAmountDiff;
            token.safeTransfer(account, operation.accountSentAmount);
            if (sponsor != address(0)) {
                token.safeTransfer(sponsor, operation.sponsorSentAmount);
            }
        } else if (status == PaymentStatus.Cleared) {
            _totalClearedBalance -= operation.paymentTotalAmountDiff;
            _clearedBalances[account] -= operation.paymentTotalAmountDiff;
            token.safeTransfer(account, operation.accountSentAmount);
            if (sponsor != address(0)) {
                token.safeTransfer(sponsor, operation.sponsorSentAmount);
            }
        } else { // status == PaymentStatus.ConfirmPayment
            address cashOutAccount_ = requireCashOutAccount();
            token.safeTransferFrom(cashOutAccount_, account, operation.accountSentAmount);
            if (sponsor != address(0)) {
                token.safeTransferFrom(cashOutAccount_, sponsor, operation.sponsorSentAmount);
            }
            token.safeTransferFrom(cashOutAccount_, address(this), operation.revokedCashbackAmount);
        }

        revokeCashbackInternal(authorizationId, operation.revokedCashbackAmount);

        emit RefundPayment(
            authorizationId,
            correlationId,
            account,
            refundAmount,
            operation.totalSentAmount,
            status
        );
        if (sponsor != address(0)) {
            emit RefundPaymentSubsidized(
                authorizationId,
                correlationId,
                sponsor,
                operation.sponsorRefundAmount,
                operation.sponsorSentAmount,
                bytes("")
            );
        }
        updateExtraAmountInternal(
            authorizationId,
            correlationId,
            account,
            operation.newPaymentSumAmount,
            newExtraAmount,
            payment
        );

        if (inBlocklist) {
            IERC20Blocklistable(_token).blacklist(account);
        }
    }

    /// @dev Returns a structure with parameters for a payment updating operation.
    function defineRefundingOperation(
        uint256 paymentRefundAmount,
        uint256 newPaymentExtraAmount,
        Payment storage payment
    ) internal view returns (RefundingOperation memory) {
        uint256 subsidyLimit = payment.subsidyLimit;
        uint256 paymentBaseAmount = payment.baseAmount;
        uint256 oldPaymentRefundAmount = payment.refundAmount;
        uint256 newPaymentRefundAmount = oldPaymentRefundAmount + paymentRefundAmount;
        uint256 oldSponsorRefundAmount =
            defineSponsorRefundAmount(oldPaymentRefundAmount, paymentBaseAmount, subsidyLimit);
        uint256 newSponsorRefundAmount =
            defineSponsorRefundAmount(newPaymentRefundAmount, paymentBaseAmount, subsidyLimit);
        uint256 accountBaseAmount = defineAccountBaseAmount(paymentBaseAmount, subsidyLimit);

        RefundingOperation memory operation;

        operation.newPaymentSumAmount = paymentBaseAmount + newPaymentExtraAmount;
        operation.sponsorRefundAmount = newSponsorRefundAmount - oldSponsorRefundAmount;
        operation.paymentRefundAmount = paymentRefundAmount;
        operation.newPaymentRefundAmount = newPaymentRefundAmount;
        operation.oldCompensationAmount = payment.compensationAmount;
        operation.oldCashbackAmount = operation.oldCompensationAmount - oldPaymentRefundAmount;
        operation.newCashbackAmount = calculateCashback(
            accountBaseAmount - (newPaymentRefundAmount - newSponsorRefundAmount),
            payment.cashbackRate
        );

        // The cashback cannot be increased in the refunding operation.
        if (operation.newCashbackAmount > operation.oldCashbackAmount) {
            operation.newCashbackAmount = operation.oldCashbackAmount;
        }
        operation.revokedCashbackAmount = operation.oldCashbackAmount - operation.newCashbackAmount;
        operation.newCompensationAmount = newPaymentRefundAmount + operation.newCashbackAmount;

        uint256 oldPaymentExtraAmount = payment.extraAmount;
        uint256 oldAccountExtraAmount =
            defineAccountExtraAmount(paymentBaseAmount, oldPaymentExtraAmount, subsidyLimit);
        uint256 newAccountExtraAmount =
            defineAccountExtraAmount(paymentBaseAmount, newPaymentExtraAmount, subsidyLimit);
        uint256 paymentExtraAmountChange = oldPaymentExtraAmount - newPaymentExtraAmount;
        uint256 accountExtraAmountChange = oldAccountExtraAmount - newAccountExtraAmount;
        operation.accountSentAmount = operation.newCompensationAmount - operation.oldCompensationAmount -
            newSponsorRefundAmount + accountExtraAmountChange;
        operation.sponsorSentAmount =
            operation.sponsorRefundAmount + paymentExtraAmountChange - accountExtraAmountChange;
        operation.totalSentAmount = operation.accountSentAmount + operation.sponsorSentAmount;
        operation.paymentTotalAmountDiff = operation.paymentRefundAmount + paymentExtraAmountChange;

        return operation;
    }

    /// @dev Sends cashback related to a payment.
    function sendCashbackInternal(
        address account,
        uint256 basePaymentAmount,
        bytes16 authorizationId,
        int16   requestedCashbackRateInPermil
    ) internal returns (uint256 sentAmount, uint16 appliedCashbackRate) {
        if (requestedCashbackRateInPermil == 0) {
            return (0, 0);
        }
        address distributor = _cashbackDistributor;
        if (_cashbackEnabled && distributor != address(0)) {
            bool success;
            uint256 cashbackNonce;
            if (requestedCashbackRateInPermil > 0) {
                appliedCashbackRate = uint16(requestedCashbackRateInPermil);
            } else {
                appliedCashbackRate = _cashbackRateInPermil;
            }
            uint256 cashbackAmount = calculateCashback(basePaymentAmount, appliedCashbackRate);
            (success, sentAmount, cashbackNonce) = ICashbackDistributor(distributor).sendCashback(
                _token,
                ICashbackDistributorTypes.CashbackKind.CardPayment,
                authorizationId,
                account,
                cashbackAmount
            );
            _cashbacks[authorizationId].lastCashbackNonce = cashbackNonce;
            if (success) {
                emit SendCashbackSuccess(distributor, sentAmount, cashbackNonce);
            } else {
                emit SendCashbackFailure(distributor, cashbackAmount, cashbackNonce);
                appliedCashbackRate = 0;
            }
        }
    }

    /// @dev Revokes partially or fully cashback related to a payment.
    function revokeCashbackInternal(bytes16 authorizationId, uint256 amount) internal {
        address distributor = _cashbackDistributor;
        uint256 cashbackNonce = _cashbacks[authorizationId].lastCashbackNonce;
        if (cashbackNonce != 0 && distributor != address(0)) {
            if (ICashbackDistributor(distributor).revokeCashback(cashbackNonce, amount)) {
                emit RevokeCashbackSuccess(distributor, amount, cashbackNonce);
            } else {
                emit RevokeCashbackFailure(distributor, amount, cashbackNonce);
            }
        }
    }

    /// @dev Increases cashback related to a payment.
    function increaseCashbackInternal(
        bytes16 authorizationId,
        uint256 amount
    ) internal returns (uint256 sentAmount) {
        address distributor = _cashbackDistributor;
        uint256 cashbackNonce = _cashbacks[authorizationId].lastCashbackNonce;
        if (cashbackNonce != 0 && distributor != address(0)) {
            bool success;
            (success, sentAmount) = ICashbackDistributor(distributor).increaseCashback(cashbackNonce, amount);
            if (success) {
                emit IncreaseCashbackSuccess(distributor, sentAmount, cashbackNonce);
            } else {
                emit IncreaseCashbackFailure(distributor, amount, cashbackNonce);
            }
        }
    }

    /// @dev Checks if the cash-out account exists and returns if it does. Otherwise reverts the execution.
    function requireCashOutAccount() internal view returns (address account) {
        account = _cashOutAccount;
        if (account == address(0)) {
            revert ZeroCashOutAccount();
        }
    }

    /// @dev Calculates cashback according to the amount and the rate.
    function calculateCashback(uint256 amount, uint256 cashbackRateInPermil) internal pure returns (uint256) {
        uint256 cashback = amount * cashbackRateInPermil / 1000;
        return ((cashback + CASHBACK_ROUNDING_COEF / 2) / CASHBACK_ROUNDING_COEF) * CASHBACK_ROUNDING_COEF;
    }

    /// @dev Update the extra amount of a payment and emits the related event.
    function updateExtraAmountInternal(
        bytes16 authorizationId,
        bytes16 correlationId,
        address account,
        uint256 sumAmount,
        uint256 newExtraAmount,
        Payment storage payment
    ) internal {
        uint256 oldExtraAmount = payment.extraAmount;
        if (oldExtraAmount != newExtraAmount) {
            emit PaymentExtraAmountChanged(
                authorizationId,
                correlationId,
                account,
                sumAmount,
                newExtraAmount,
                oldExtraAmount
            );
            payment.extraAmount = newExtraAmount;
        }
    }

    /// @dev Defines the account part of a payment base amount according to a subsidy limit.
    function defineAccountBaseAmount(uint256 paymentBaseAmount, uint256 subsidyLimit) internal pure returns (uint256) {
        if (subsidyLimit >= paymentBaseAmount) {
            return 0;
        } else {
            return paymentBaseAmount - subsidyLimit;
        }
    }

    /// @dev Defines the account part of a payment extra amount according to a subsidy limit.
    function defineAccountExtraAmount(
        uint256 paymentBaseAmount,
        uint256 paymentExtraAmount,
        uint256 subsidyLimit
    ) internal pure returns (uint256) {
        if (subsidyLimit > paymentBaseAmount) {
            uint256 paymentSumAmount = paymentBaseAmount + paymentExtraAmount;
            if (subsidyLimit >= paymentSumAmount) {
                return 0;
            } else {
                return paymentSumAmount - subsidyLimit;
            }
        } else {
            return paymentExtraAmount;
        }
    }

    /// @dev Defines the account and sponsor parts of a payment sum amount according to a subsidy limit.
    function defineSumAmountParts(
        uint256 paymentSumAmount,
        uint256 subsidyLimit
    ) internal pure returns (
        uint256 accountSumAmount,
        uint256 sponsorSumAmount
    ) {
        if (subsidyLimit >= paymentSumAmount) {
            sponsorSumAmount = paymentSumAmount;
            accountSumAmount = 0;
        } else {
            sponsorSumAmount = subsidyLimit;
            accountSumAmount = paymentSumAmount - subsidyLimit;
        }
    }

    function defineSponsorRefundAmount(
        uint256 paymentRefundAmount,
        uint256 paymentBaseAmount,
        uint256 subsidyLimit
    ) internal pure returns (uint256) {
        if (subsidyLimit >= paymentBaseAmount) {
            return paymentRefundAmount;
        } else {
            return paymentRefundAmount * subsidyLimit / paymentBaseAmount;
        }
    }

    /// @dev Resets the payment structure fields related to the subsidy part of a payment.
    function resetSubsidizedPaymentFields(Payment storage payment) internal {
        if (payment.sponsor != address(0)) {
            payment.sponsor = address(0);
        }
        if (payment.subsidyLimit != 0) {
            payment.subsidyLimit = 0;
        }
    }

    /// @dev Resets the payment structure fields related to the compensation and refund of a payment.
    function resetCompensationAndRefundFields(Payment storage payment) internal {
        payment.compensationAmount = 0;
        if (payment.refundAmount != 0) {
            payment.refundAmount = 0;
        }
    }
}
