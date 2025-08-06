// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import { ICashbackDistributor, ICashbackDistributorPrimary, ICashbackDistributorConfiguration } from "../interfaces/ICashbackDistributor.sol";

/**
 * @title CashbackDistributorMock contract
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev An implementation of the {ICashbackDistributor} interface for test purposes.
 */
contract CashbackDistributorMock is ICashbackDistributor {
    // ------------------ Storage --------------------------------- //

    /// @dev The success part of the `sendCashback()` function result to return next time.
    bool public sendCashbackSuccessResult;

    /**
     * @dev The amount part of the `sendCashback()` function result to return next time if
     * it is not negative and the success part of the function is `true`.
     */
    int256 public sendCashbackAmountResult;

    /// @dev The nonce part of the `sendCashback()` function result to return next time.
    uint256 public sendCashbackNonceResult;

    /// @dev The result of the `revokeCashback()` function to return next time.
    bool public revokeCashbackSuccessResult;

    /// @dev The success part of the `increaseCashback()` function result to return next time.
    bool public increaseCashbackSuccessResult;

    /**
     * @dev The amount part of the `increaseCashback()` function result to return next time if
     * it is not negative and the success part of the function is `true`.
     */
    int256 public increaseCashbackAmountResult;

    /// @dev The recipient address of the last call of the {sendCashback} function.
    address public lastCashbackRecipient;

    /// @dev The token address of the last call of the {sendCashback} function.
    address public lastCashbackToken;

    /// @dev Mock flag for claimable mode status.
    bool public claimableModeEnabledResult;

    /// @dev Mock claimable cashback balances: token => recipient => amount.
    mapping(address => mapping(address => uint256)) public claimableCashbackBalances;

    /// @dev Mock total claimable cashback by token and external ID.
    mapping(address => mapping(bytes32 => uint256)) public totalClaimableCashbackByTokenAndExternalId;

    /// @dev The result of claim functions to return next time.
    uint256 public claimCashbackResult;

    // ------------------ Events -------------------------------- //

    /**
     * @dev Emitted when the 'sendCashback()' function is called
     */
    event SendCashbackMock(
        address sender,
        address token,
        CashbackKind kind,
        bytes32 indexed externalId,
        address indexed recipient,
        uint256 amount
    );

    /**
     * @dev Emitted when the 'revokeCashback()' function is called
     */
    event RevokeCashbackMock(address sender, uint256 nonce, uint256 amount);

    /**
     * @dev Emitted when the 'increaseCashback()' function is called
     */
    event IncreaseCashbackMock(address sender, uint256 nonce, uint256 amount);

    /**
     * @dev Emitted when the 'setClaimableMode()' function is called
     */
    event SetClaimableModeMock(bool enabled);

    /**
     * @dev Emitted when the 'claimCashback()' function is called
     */
    event ClaimCashbackMock(
        address token,
        address recipient,
        uint256 amount,
        uint256 remainingBalance
    );

    // ------------------ Constructor --------------------------- //

    /**
     * @dev Constructor that simply sets values of all storage variables.
     */
    constructor(
        bool sendCashbackSuccessResult_,
        int256 sendCashbackAmountResult_,
        uint256 sendCashbackNonceResult_,
        bool revokeCashbackSuccessResult_,
        bool increaseCashbackSuccessResult_,
        int256 increaseCashbackAmountResult_
    ) {
        sendCashbackSuccessResult = sendCashbackSuccessResult_;
        sendCashbackAmountResult = sendCashbackAmountResult_;
        sendCashbackNonceResult = sendCashbackNonceResult_;
        revokeCashbackSuccessResult = revokeCashbackSuccessResult_;
        increaseCashbackSuccessResult = increaseCashbackSuccessResult_;
        increaseCashbackAmountResult = increaseCashbackAmountResult_;
        claimableModeEnabledResult = false;
        claimCashbackResult = 100; // Default claim amount for testing

        // Calling stub functions just to provide 100% coverage
        enabled();
        nextNonce();
        getCashback(0);
        getCashbacks(new uint256[](0));
        getCashbackNonces(bytes32(0), 0, 0);
        getTotalCashbackByTokenAndExternalId(address(0), bytes32(0));
        getTotalCashbackByTokenAndRecipient(address(0), address(0));
        getCashbackSinceLastReset(address(0), address(0));
        getCashbackLastTimeReset(address(0), address(0));
        previewCashbackCap(address(0), address(0));
        enable();
        disable();
    }

    // ------------------ Pure functions ------------------------ //

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns `true`.
     */
    function enabled() public pure returns (bool) {
        return true;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns zero.
     */
    function nextNonce() public pure returns (uint256) {
        return 0;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns an empty structure.
     */
    function getCashback(uint256 nonce) public pure returns (Cashback memory cashback) {
        cashback = (new Cashback[](1))[0];
        nonce;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns an empty array.
     */
    function getCashbacks(uint256[] memory nonces) public pure returns (Cashback[] memory cashbacks) {
        cashbacks = new Cashback[](0);
        nonces;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns an empty array.
     */
    function getCashbackNonces(
        bytes32 externalId,
        uint256 index,
        uint256 limit
    ) public pure returns (uint256[] memory nonces) {
        nonces = new uint256[](0);
        externalId;
        index;
        limit;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns zero.
     */
    function getTotalCashbackByTokenAndExternalId(address token, bytes32 externalId) public pure returns (uint256) {
        token;
        externalId;
        return 0;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns zero.
     */
    function getTotalCashbackByTokenAndRecipient(address token, address recipient) public pure returns (uint256) {
        token;
        recipient;
        return 0;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns zero.
     */
    function getCashbackSinceLastReset(address token, address recipient) public pure returns (uint256) {
        token;
        recipient;
        return 0;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns zero.
     */
    function getCashbackLastTimeReset(address token, address recipient) public pure returns (uint256) {
        token;
        recipient;
        return 0;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Always returns zeros.
     */
    function previewCashbackCap(
        address token,
        address recipient
    ) public pure returns (uint256 cashbackPeriodStart, uint256 overallCashbackForPeriod) {
        token;
        recipient;
        cashbackPeriodStart = 0;
        overallCashbackForPeriod = 0;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Returns the stored mock value.
     */
    function claimableModeEnabled() public view returns (bool) {
        return claimableModeEnabledResult;
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Returns the stored mock balance.
     */
    function getClaimableCashbackBalance(address token, address recipient) public view returns (uint256) {
        return claimableCashbackBalances[token][recipient];
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Returns an array of stored mock balances.
     */
    function getClaimableCashbackBalances(
        address token,
        address[] memory recipients
    ) public view returns (uint256[] memory balances) {
        balances = new uint256[](recipients.length);
        for (uint256 i = 0; i < recipients.length; i++) {
            balances[i] = claimableCashbackBalances[token][recipients[i]];
        }
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Just a stub for testing. Returns the stored mock total.
     */
    function getTotalClaimableCashbackByTokenAndExternalId(
        address token,
        bytes32 externalId
    ) public view returns (uint256) {
        return totalClaimableCashbackByTokenAndExternalId[token][externalId];
    }

    // ------------------ Transactional functions ----------------- //

    /**
     * @inheritdoc ICashbackDistributorConfiguration
     *
     * @dev Just a stub for testing. Does nothing.
     */
    function enable() public {}

    /**
     * @inheritdoc ICashbackDistributorConfiguration
     *
     * @dev Just a stub for testing. Does nothing.
     */
    function disable() public {}

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Returns the previously set values and emits an event with provided arguments.
     * Stores `token`, `msg.sender` and `recipient` for further usage.
     * if the returned `success` part of the result is `true` sends the provided amount of tokens
     * from this contract to `recipient`.
     */
    function sendCashback(
        address token,
        CashbackKind kind,
        bytes32 externalId,
        address recipient,
        uint256 amount
    ) external returns (bool success, uint256 sentAmount, uint256 nonce) {
        success = sendCashbackSuccessResult;
        nonce = sendCashbackNonceResult;
        lastCashbackToken = token;
        lastCashbackRecipient = recipient;
        emit SendCashbackMock(msg.sender, token, kind, externalId, recipient, amount);
        if (success) {
            if (sendCashbackAmountResult >= 0) {
                sentAmount = uint256(sendCashbackAmountResult);
            } else {
                sentAmount = amount;
            }
            IERC20Upgradeable(token).transfer(recipient, sentAmount);
        }
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Returns the previously set value and emits an event with provided arguments.
     * If the returned value is `true` sends the provided amount of tokens from `msg.sender` to this contract.
     */
    function revokeCashback(uint256 nonce, uint256 amount) external returns (bool success) {
        success = revokeCashbackSuccessResult;
        emit RevokeCashbackMock(msg.sender, nonce, amount);
        if (success) {
            IERC20Upgradeable(lastCashbackToken).transferFrom(msg.sender, address(this), amount);
        }
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Returns the previously set value and emits an event with provided arguments.
     * If the returned value is `true` sends the provided amount of tokens
     * from this contract to {lastCashbackRecipient}.
     */
    function increaseCashback(uint256 nonce, uint256 amount) external returns (bool success, uint256 sentAmount) {
        success = increaseCashbackSuccessResult;
        emit IncreaseCashbackMock(msg.sender, nonce, amount);
        if (success) {
            if (increaseCashbackAmountResult >= 0) {
                sentAmount = uint256(increaseCashbackAmountResult);
            } else {
                sentAmount = amount;
            }
            IERC20Upgradeable(lastCashbackToken).transfer(lastCashbackRecipient, sentAmount);
        }
    }

    /**
     * @inheritdoc ICashbackDistributorConfiguration
     *
     * @dev Sets the claimable mode flag and emits a mock event.
     */
    function setClaimableMode(bool enabled_) external {
        claimableModeEnabledResult = enabled_;
        emit SetClaimableModeMock(enabled_);
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Returns the stored mock claim amount and emits a mock event.
     * Transfers tokens if the mock balance is sufficient.
     */
    function claimCashback(
        address token,
        address recipient,
        uint256 amount
    ) external returns (uint256 claimedAmount) {
        uint256 availableBalance = claimableCashbackBalances[token][recipient];

        if (availableBalance >= amount) {
            claimedAmount = amount;
            claimableCashbackBalances[token][recipient] -= amount;
            IERC20Upgradeable(token).transfer(recipient, amount);
        } else {
            claimedAmount = claimCashbackResult;
        }

        emit ClaimCashbackMock(
            token,
            recipient,
            claimedAmount,
            claimableCashbackBalances[token][recipient]
        );
    }

    /**
     * @inheritdoc ICashbackDistributorPrimary
     *
     * @dev Claims all available mock balance for the recipient.
     */
    function claimAllCashback(
        address token,
        address recipient
    ) external returns (uint256 claimedAmount) {
        claimedAmount = claimableCashbackBalances[token][recipient];

        if (claimedAmount > 0) {
            claimableCashbackBalances[token][recipient] = 0;
            IERC20Upgradeable(token).transfer(recipient, claimedAmount);
        }

        emit ClaimCashbackMock(token, recipient, claimedAmount, 0);
    }

    /**
     * @dev Sets a new value for the success part of the `sendCashback()` function result.
     * @param newSendCashbackSuccessResult The new value for the success part of the `sendCashback()` function result.
     */
    function setSendCashbackSuccessResult(bool newSendCashbackSuccessResult) external {
        sendCashbackSuccessResult = newSendCashbackSuccessResult;
    }

    /**
     * @dev Sets a new value for the amount part of the `sendCashback()` function result.
     * @param newSendCashbackAmountResult The new value for the amount part of the `sendCashback()` function result.
     */
    function setSendCashbackAmountResult(int256 newSendCashbackAmountResult) external {
        sendCashbackAmountResult = newSendCashbackAmountResult;
    }

    /**
     * @dev Sets a new value for the result of the `revokeCashback()` function.
     * @param newRevokeCashbackSuccessResult The new value for the result of the `revokeCashback()` function.
     */
    function setRevokeCashbackSuccessResult(bool newRevokeCashbackSuccessResult) external {
        revokeCashbackSuccessResult = newRevokeCashbackSuccessResult;
    }

    /**
     * @dev Sets a new value for the success part of the `increaseCashback()` function.
     * @param newIncreaseCashbackSuccessResult The new value for the success part of the `increaseCashback()` function.
     */
    function setIncreaseCashbackSuccessResult(bool newIncreaseCashbackSuccessResult) external {
        increaseCashbackSuccessResult = newIncreaseCashbackSuccessResult;
    }

    /**
     * @dev Sets a new value for the amount part of the `increaseCashback()` function result.
     * @param newIncreaseCashbackAmountResult The new value for the amount part of
     *                                        the `increaseCashback()` function result.
     */
    function setIncreaseCashbackAmountResult(int256 newIncreaseCashbackAmountResult) external {
        increaseCashbackAmountResult = newIncreaseCashbackAmountResult;
    }

    /**
     * @dev Sets a new value for the claimable mode enabled result.
     * @param newClaimableModeEnabledResult The new value for the claimable mode enabled result.
     */
    function setClaimableModeEnabledResult(bool newClaimableModeEnabledResult) external {
        claimableModeEnabledResult = newClaimableModeEnabledResult;
    }

    /**
     * @dev Sets a new value for the claim cashback result.
     * @param newClaimCashbackResult The new value for the claim cashback result.
     */
    function setClaimCashbackResult(uint256 newClaimCashbackResult) external {
        claimCashbackResult = newClaimCashbackResult;
    }

    /**
     * @dev Sets a claimable cashback balance for testing purposes.
     * @param token The token address.
     * @param recipient The recipient address.
     * @param balance The balance to set.
     */
    function setClaimableCashbackBalance(address token, address recipient, uint256 balance) external {
        claimableCashbackBalances[token][recipient] = balance;
    }

    /**
     * @dev Sets a total claimable cashback by token and external ID for testing purposes.
     * @param token The token address.
     * @param externalId The external ID.
     * @param total The total to set.
     */
    function setTotalClaimableCashbackByTokenAndExternalId(
        address token,
        bytes32 externalId,
        uint256 total
    ) external {
        totalClaimableCashbackByTokenAndExternalId[token][externalId] = total;
    }
}
