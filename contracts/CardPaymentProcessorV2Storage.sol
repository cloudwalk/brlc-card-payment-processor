// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { ICardPaymentProcessorV2Types } from "./interfaces/ICardPaymentProcessorV2.sol";
import { ICardPaymentCashbackV2Types } from "./interfaces/ICardPaymentCashbackV2.sol";

/**
 * @title CardPaymentProcessor storage version 1
 */
abstract contract CardPaymentProcessorV2StorageV1 is ICardPaymentProcessorV2Types, ICardPaymentCashbackV2Types {
    /// @dev The factor to represent the cashback rates in the contract, e.g. number 15 means 1.5% cashback rate.
    /// @dev The formula to calculate cashback by an amount: cashbackAmount = cashbackRate * amount / CASHBACK_FACTOR
    uint16 public constant CASHBACK_FACTOR = 1000;

    /// @dev The maximum allowable cashback rate in units of `CASHBACK_FACTOR`.
    uint16 public constant MAX_CASHBACK_RATE = 250;

    /**
     * @dev The coefficient used to round the cashback according to the formula:
     *      `roundedCashback = [(cashback + coef / 2) / coef] * coef`.
     * Currently, it can only be changed by deploying a new implementation of the contract.
     */
    uint16 public constant CASHBACK_ROUNDING_COEF = 10000;

    /// @dev The address of the underlying token.
    address internal _token;

    /// @dev The enable flag of the cashback operations.
    bool internal _cashbackEnabled;

    /// @dev The current cashback rate in units of `CASHBACK_FACTOR`..
    uint16 internal _cashbackRate;

    /// @dev The account to transfer confirmed tokens to.
    address internal _cashOutAccount;

    /// @dev Mapping of a payment for a given payment ID.
    mapping(bytes32 => Payment) internal _payments;

    /// @dev The address of the cashback distributor contract.
    address internal _cashbackDistributor;

    /// @dev Mapping of a structure with cashback data for a given payment ID.
    mapping(bytes32 => Cashback) internal _cashbacks;
}

/**
 * @title CardPaymentProcessor storage
 * @dev Contains storage variables of the {CardPaymentProcessor} contract.
 *
 * We are following Compound's approach of upgrading new contract implementations.
 * See https://github.com/compound-finance/compound-protocol.
 * When we need to add new storage variables, we create a new version of CardPaymentProcessorStorage
 * e.g. CardPaymentProcessorV2Storage<versionNumber>, so finally it would look like
 * "contract CardPaymentProcessorV2Storage is CardPaymentProcessorV2StorageV1, CardPaymentProcessorV2StorageV2".
 */
abstract contract CardPaymentProcessorV2Storage is CardPaymentProcessorV2StorageV1 {}
