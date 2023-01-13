// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { ICashbackDistributor } from "../interfaces/ICashbackDistributor.sol";

/**
 * @title CashbackDistributor contract
 * @dev An implementation of the {ICashbackDistributor} interface for test purposes.
 */
contract CashbackDistributorMock is ICashbackDistributor {
    /// @dev The success part of the `sendCashback()` function result to return next time.
    bool public sendCashbackSuccessResult;

    /// @dev The nonce part of the `sendCashback()` function result to return next time.
    uint256 public sendCashbackNonceResult;

    /// @dev The success part of the `revokeCashback()` function result to return next time.
    bool public revokeCashbackSuccessResult;

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
     * @dev Constructor that simply set values of all storage variables.
     */
    constructor(
        bool sendCashbackSuccessResult_,
        uint256 sendCashbackNonceResult_,
        bool revokeCashbackSuccessResult_
    ) {
        sendCashbackSuccessResult = sendCashbackSuccessResult_;
        sendCashbackNonceResult = sendCashbackNonceResult_;
        revokeCashbackSuccessResult = revokeCashbackSuccessResult_;

        // Calling stub functions just to provide 100% coverage
        enabled();
        nextNonce();
        getCashback(0);
        getCashbacks(new uint256[](0));
        getCashbackNonces(bytes32(0), 0, 0);
        getTotalCashbackByTokenAndExternalId(address(0), bytes32(0));
        getTotalCashbackByTokenAndRecipient(address(0), address(0));
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
     * Just a stub for testing. Returns the previously set values and emits an event with provided arguments.
     */
    function sendCashback(
        address token,
        CashbackKind kind,
        bytes32 externalId,
        address recipient,
        uint256 amount
    ) external returns (bool success, uint256 nonce) {
        success = sendCashbackSuccessResult;
        nonce = sendCashbackNonceResult;
        emit SendCashbackMock(msg.sender, token, kind, externalId, recipient, amount);
    }

    /**
     * @dev See {ICashbackDistributor-revokeCashback}.
     *
     * Just a stub for testing. Returns the previously set value and emits an event with provided arguments.
     */
    function revokeCashback(uint256 nonce, uint256 amount) external returns (bool success) {
        success = revokeCashbackSuccessResult;
        emit RevokeCashbackMock(msg.sender, nonce, amount);
    }

    /**
     * @dev Sets a new value for the success part of the `sendCashback()` function result.
     */
    function setSendCashbackSuccessResult(bool newSendCashbackSuccessResult) external {
        sendCashbackSuccessResult = newSendCashbackSuccessResult;
    }

    /**
     * @dev Sets a new value for the success part of the `revokeCashback()` function result.
     */
    function setRevokeCashbackSuccessResult(bool newRevokeCashbackSuccessResult) external {
        revokeCashbackSuccessResult = newRevokeCashbackSuccessResult;
    }
}
