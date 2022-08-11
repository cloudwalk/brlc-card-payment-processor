// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

import {CardPaymentProcessor} from "./interfaces/ICardPaymentProcessor.sol";

abstract contract CardPaymentProcessorStorageV1 {
    /// @dev The address of the underlying token.
    address internal _token;

    /// @dev The total balance of cleared tokens owned by the contract.
    uint256 internal _totalClearedBalance;

    /// @dev The total balance of uncleared tokens owned by the contract.
    uint256 internal _totalUnclearedBalance;

    /// @dev Mapping of payment for a given authorization ID.
    mapping(bytes16 => CardPaymentProcessor.Payment) internal _payments;

    /// @dev Mapping of uncleared balance for a given address.
    mapping(address => uint256) internal _unclearedBalances;

    /// @dev Mapping of cleared balance for a given address.
    mapping(address => uint256) internal _clearedBalances;

    /// @dev Stotes payment revocation flag for a given parent transaction hash.
    mapping(bytes32 => bool) internal _paymentRevocationFlags;

    /// @dev Stotes payment reversion flag for a given parent transaction hash.
    mapping(bytes32 => bool) internal _paymentReversionFlags;

    /// @dev The maximum revocation limit for a single payment.
    uint8 internal _revocationLimit;
}

// We are following Compound's method of upgrading new contract implementations
// When we need to add new storage variables, we create a new version of CardPaymentProcessorStorage
// e.g. CardPaymentProcessorStorage<versionNumber>, so finally it would look like
// contract CardPaymentProcessorStorage is CardPaymentProcessorStorageV1, CardPaymentProcessorStorageV2
abstract contract CardPaymentProcessorStorage is CardPaymentProcessorStorageV1 {

}
