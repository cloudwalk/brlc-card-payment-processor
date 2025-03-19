// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import { ICashbackDistributor } from "../interfaces/ICashbackDistributor.sol";

/**
 * @title CashbackDistributor contract
 * @dev An implementation of the {ICashbackDistributor} interface for test purposes.
 */
contract CashbackDistributorMock is ICashbackDistributor {
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
     * @dev Constructor that simply set values of all storage variables.
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

    /**
     * @dev See {ICashbackDistributor-revokeCashback}.
     *
     * Just a stub for testing. Always returns `true`.
     */
    function enabled() public pure returns (bool) {
        return true;
    }

    /**
     * @dev See {ICashbackDistributor-nextNonce}.
     *
     * Just a stub for testing. Always returns `true`.
     */
    function nextNonce() public pure returns (uint256) {
        return 0;
    }

    /**
     * @dev See {ICashbackDistributor-getCashback}.
     *
     * Just a stub for testing. Always returns an empty structure.
     */
    function getCashback(uint256 nonce) public pure returns (Cashback memory cashback) {
        cashback = (new Cashback[](1))[0];
        nonce;
    }

    /**
     * @dev See {ICashbackDistributor-getCashbacks}.
     *
     * Just a stub for testing. Always returns an empty array.
     */
    function getCashbacks(uint256[] memory nonces) public pure returns (Cashback[] memory cashbacks) {
        cashbacks = new Cashback[](0);
        nonces;
    }

    /**
     * @dev See {ICashbackDistributor-getCashbackNonces}.
     *
     * Just a stub for testing. Always returns an empty array.
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
     * @dev See {ICashbackDistributor-getTotalCashbackByTokenAndExternalId}.
     *
     * Just a stub for testing. Always returns zero.
     */
    function getTotalCashbackByTokenAndExternalId(address token, bytes32 externalId) public pure returns (uint256) {
        token;
        externalId;
        return 0;
    }

    /**
     * @dev See {ICashbackDistributor-getTotalCashbackByTokenAndRecipient}.
     *
     * Just a stub for testing. Always returns zero.
     */
    function getTotalCashbackByTokenAndRecipient(address token, address recipient) public pure returns (uint256) {
        token;
        recipient;
        return 0;
    }

   /**
     * @dev See {ICashbackDistributor-getCashbackSinceLastReset}.
     *
     * Just a stub for testing. Always returns zero.
     */
    function getCashbackSinceLastReset(address token, address recipient) public pure returns (uint256) {
        token;
        recipient;
        return 0;
    }

    /**
     * @dev See {ICashbackDistributor-getCashbackLastTimeReset}.
     *
     * Just a stub for testing. Always returns zero.
     */
    function getCashbackLastTimeReset(address token, address recipient) public pure returns (uint256) {
        token;
        recipient;
        return 0;
    }

    /**
     * @dev See {ICashbackDistributor-previewCashbackCap}.
     *
     * Just a stub for testing. Always returns zeros.
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
     * @dev See {ICashbackDistributor-enable}.
     *
     * Just a stub for testing. Does nothing.
     */
    function enable() public {}

    /**
     * @dev See {ICashbackDistributor-disable}.
     *
     * Just a stub for testing. Does nothing.
     */
    function disable() public {}

    /**
     * @dev See {ICashbackDistributor-sendCashback}.
     *
     * Just a stub for testing.
     * Returns the previously set values and emits an event with provided arguments.
     * Stores `token`, `msg.sender` and `recipient` for further usage.
     * if the returned `success` part of the result is `true` sends the provided amount of tokens
     * from this contract to `recipient`.
     *
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
     * @dev See {ICashbackDistributor-revokeCashback}.
     *
     * Just a stub for testing.
     * Returns the previously set value and emits an event with provided arguments.
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
     * @dev See {ICashbackDistributor-increaseCashback}.
     *
     * Just a stub for testing.
     * Returns the previously set value and emits an event with provided arguments.
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
     * @dev Sets a new value for the success part of the `sendCashback()` function result.
     */
    function setSendCashbackSuccessResult(bool newSendCashbackSuccessResult) external {
        sendCashbackSuccessResult = newSendCashbackSuccessResult;
    }

    /**
     * @dev Sets a new value for the amount part of the `sendCashback()` function result.
     */
    function setSendCashbackAmountResult(int256 newSendCashbackAmountResult) external {
        sendCashbackAmountResult = newSendCashbackAmountResult;
    }

    /**
     * @dev Sets a new value for the result of the `revokeCashback()` function.
     */
    function setRevokeCashbackSuccessResult(bool newRevokeCashbackSuccessResult) external {
        revokeCashbackSuccessResult = newRevokeCashbackSuccessResult;
    }

    /**
     * @dev Sets a new value for the success part of the `increaseCashback()` function.
     */
    function setIncreaseCashbackSuccessResult(bool newIncreaseCashbackSuccessResult) external {
        increaseCashbackSuccessResult = newIncreaseCashbackSuccessResult;
    }

    /**
     * @dev Sets a new value for the amount part of the `increaseCashback()` function result.
     */
    function setIncreaseCashbackAmountResult(int256 newIncreaseCashbackAmountResult) external {
        increaseCashbackAmountResult = newIncreaseCashbackAmountResult;
    }
}
