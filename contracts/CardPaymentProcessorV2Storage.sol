// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { ICardPaymentProcessorV2Types } from "./interfaces/ICardPaymentProcessorV2.sol";
import { ICardPaymentCashbackV2Types } from "./interfaces/ICardPaymentCashbackV2.sol";

/**
 * @title CardPaymentProcessorV2 storage version 1
 */
abstract contract CardPaymentProcessorV2StorageV1 is ICardPaymentProcessorV2Types, ICardPaymentCashbackV2Types {
    /// @dev The address of the underlying token.
    address internal _token;

    /// @dev The account to transfer confirmed tokens to.
    address internal _cashOutAccount;

    /// @dev The mapping of a payment for a given payment ID.
    mapping(bytes32 => Payment) internal _payments;

    /// @dev The payment statistics.
    PaymentStatistics internal _paymentStatistics;

    /// @dev The address of the cashback treasury.
    address internal _cashbackTreasury;

    /// @dev The enable flag of the cashback operations.
    bool internal _cashbackEnabled;

    /// @dev The current cashback rate in units of `CASHBACK_FACTOR`.
    uint16 internal _cashbackRate;

    /// @dev The mapping of an account cashback structure for a given account address.
    mapping(address => AccountCashbackState) internal _accountCashbackStates;
}

/**
 * @title CardPaymentProcessorV2 storage
 * @dev Contains storage variables of the {CardPaymentProcessorV2} contract.
 *
 * We are following Compound's approach of upgrading new contract implementations.
 * See https://github.com/compound-finance/compound-protocol.
 * When we need to add new storage variables, we create a new version of CardPaymentProcessorStorage
 * e.g. CardPaymentProcessorV2Storage<versionNumber>, so finally it would look like
 * "contract CardPaymentProcessorV2Storage is CardPaymentProcessorV2StorageV1, CardPaymentProcessorV2StorageV2".
 */
abstract contract CardPaymentProcessorV2Storage is CardPaymentProcessorV2StorageV1 {
    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     */
    uint256[43] private __gap;
}
