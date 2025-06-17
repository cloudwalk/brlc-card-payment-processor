// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { ICardPaymentProcessorTypes } from "./interfaces/ICardPaymentProcessor.sol";
import { ICardPaymentCashbackTypes } from "./interfaces/ICardPaymentCashback.sol";

/**
 * @title CardPaymentProcessor storage version 1
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 */
abstract contract CardPaymentProcessorStorageV1 is ICardPaymentProcessorTypes {
    /// @dev The address of the underlying token.
    address internal _token;

    /// @dev The total balance of cleared tokens locked in the contract.
    uint256 internal _totalClearedBalance;

    /// @dev The total balance of uncleared tokens locked in the contract.
    uint256 internal _totalUnclearedBalance;

    /// @dev Mapping of a payment for a given authorization ID.
    mapping(bytes16 => Payment) internal _payments;

    /// @dev Mapping of uncleared balance for a given address.
    mapping(address => uint256) internal _unclearedBalances;

    /// @dev Mapping of cleared balance for a given address.
    mapping(address => uint256) internal _clearedBalances;

    /// @dev Mapping of a payment revocation flag for a given parent transaction hash.
    mapping(bytes32 => bool) internal _paymentRevocationFlags;

    /// @dev Mapping of a payment reversion flag for a given parent transaction hash.
    mapping(bytes32 => bool) internal _paymentReversionFlags;

    /// @dev The revocation limit for a single payment.
    uint8 internal _revocationLimit;
}

/**
 * @title CardPaymentProcessor storage version 2
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 */
abstract contract CardPaymentProcessorStorageV2 {
    /// @dev The account to transfer cleared tokens to.
    address internal _cashOutAccount;
}

/**
 * @title CardPaymentProcessor storage version 3
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 */
abstract contract CardPaymentProcessorStorageV3 is ICardPaymentCashbackTypes {
    /// @dev The enabled flag of the cashback operations.
    bool internal _cashbackEnabled;

    /// @dev The address of the cashback distributor contract.
    address internal _cashbackDistributor;

    /// @dev The current cashback rate in permil (parts per thousand).
    uint16 internal _cashbackRateInPermil;

    /// @dev Mapping of a structure with cashback data for a given authorization ID.
    mapping(bytes16 => Cashback) internal _cashbacks;
}

/**
 * @title CardPaymentProcessor cumulative storage
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Contains storage variables of the {CardPaymentProcessor} contract.
 *
 * When we need to add new storage variables, we create a new version of CardPaymentProcessorStorage
 * e.g. CardPaymentProcessorStorage<versionNumber>, so finally it would look like
 * "contract CardPaymentProcessorStorage is CardPaymentProcessorStorageV1, CardPaymentProcessorStorageV2".
 */
abstract contract CardPaymentProcessorStorage is
    CardPaymentProcessorStorageV1,
    CardPaymentProcessorStorageV2,
    CardPaymentProcessorStorageV3
{}
