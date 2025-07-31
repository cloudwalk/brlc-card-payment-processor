// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title ICardPaymentCashbackTypes interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the types used in the wrapper contract for the card payment cashback operations.
 */
interface ICardPaymentCashbackTypes {
    /**
     * @dev The data of a single cashback operation.
     *
     * Fields:
     *
     * - lastCashbackNonce -- The nonce of the last cashback operation.
     */
    struct Cashback {
        uint256 lastCashbackNonce;
    }
}

/**
 * @title ICardPaymentCashback interface
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Defines the interface of the wrapper contract for the card payment cashback operations.
 */
interface ICardPaymentCashback is ICardPaymentCashbackTypes {
    // ------------------ Events ---------------------------------- //

    /**
     * @dev Emitted when the cashback distributor is changed.
     * @param oldDistributor The address of the old cashback distributor contract.
     * @param newDistributor The address of the new cashback distributor contract.
     */
    event SetCashbackDistributor(address oldDistributor, address newDistributor);

    /**
     * @dev Emitted when the cashback rate is changed.
     * @param oldRateInPermil The value of the old cashback rate in permil.
     * @param newRateInPermil The value of the new cashback rate in permil.
     */
    event SetCashbackRate(uint16 oldRateInPermil, uint16 newRateInPermil);

    /**
     * @dev Emitted when a cashback send request succeeded.
     * @param cashbackDistributor The address of the cashback distributor.
     * @param amount The actual amount of the sent cashback.
     * @param nonce The nonce of the cashback.
     */
    event SendCashbackSuccess(address indexed cashbackDistributor, uint256 amount, uint256 nonce);

    /**
     * @dev Emitted when a cashback send request failed.
     * @param cashbackDistributor The address of the cashback distributor.
     * @param amount The requested amount of cashback to send.
     * @param nonce The nonce of the cashback.
     */
    event SendCashbackFailure(address indexed cashbackDistributor, uint256 amount, uint256 nonce);

    /**
     * @dev Emitted when a cashback revocation request succeeded.
     * @param cashbackDistributor The address of the cashback distributor.
     * @param amount The actual amount of the revoked cashback.
     * @param nonce The nonce of the cashback.
     */
    event RevokeCashbackSuccess(address indexed cashbackDistributor, uint256 amount, uint256 nonce);

    /**
     * @dev Emitted when a cashback revocation request failed.
     * @param cashbackDistributor The address of the cashback distributor.
     * @param amount The requested amount of cashback to revoke.
     * @param nonce The nonce of the cashback.
     */
    event RevokeCashbackFailure(address indexed cashbackDistributor, uint256 amount, uint256 nonce);

    /**
     * @dev Emitted when a cashback increase request succeeded.
     * @param cashbackDistributor The address of the cashback distributor.
     * @param amount The actual amount of the cashback increase.
     * @param nonce The nonce of the cashback.
     */
    event IncreaseCashbackSuccess(address indexed cashbackDistributor, uint256 amount, uint256 nonce);

    /**
     * @dev Emitted when a cashback increase request failed.
     * @param cashbackDistributor The address of the cashback distributor.
     * @param amount The requested amount of cashback to increase.
     * @param nonce The nonce of the cashback.
     */
    event IncreaseCashbackFailure(address indexed cashbackDistributor, uint256 amount, uint256 nonce);

    /// @dev Emitted when cashback operations are enabled.
    event EnableCashback();

    /// @dev Emitted when cashback operations are disabled.
    event DisableCashback();

    // ------------------ Transactional functions --------------- //

    /**
     * @dev Sets a new address of the cashback distributor contract.
     *
     * Emits a {SetCashbackDistributor} event.
     *
     * @param newCashbackDistributor The address of the new cashback distributor contract.
     */
    function setCashbackDistributor(address newCashbackDistributor) external;

    /**
     * @dev Sets a new cashback rate.
     *
     * Emits a {SetCashbackRate} event.
     *
     * @param newCashbackRateInPermil The value of the new cashback rate in permil.
     */
    function setCashbackRate(uint16 newCashbackRateInPermil) external;

    /**
     * @dev Enables the cashback operations.
     *
     * Emits a {EnableCashback} event.
     */
    function enableCashback() external;

    /**
     * @dev Disables the cashback operations.
     *
     * Emits a {DisableCashback} event.
     */
    function disableCashback() external;

    // ------------------ View functions ------------------------ //

    /**
     * @dev Returns the address of the cashback distributor contract.
     */
    function cashbackDistributor() external view returns (address);

    /**
     * @dev Checks if the cashback operations are enabled.
     */
    function cashbackEnabled() external view returns (bool);

    /**
     * @dev Returns the current cashback rate in permil.
     */
    function cashbackRate() external view returns (uint256);

    /**
     * @dev Returns the cashback details for the transaction authorization ID.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function getCashback(bytes16 authorizationId) external view returns (Cashback memory);
}
