// SPDX-License-Identifier: MIT

pragma solidity ^0.8.8;

/**
 * @title PixCashier storage version 1
 */
abstract contract PixCashierStorageV1 {
    /// @dev The address of the underlying token.
    address internal _token;

    /// @dev Mapping of a cash-out token balance for a given account. These balances are parts of the contract balance.
    mapping(address => uint256) internal _cashOutBalances;
}

/**
 * @title PixCashier storage
 * @dev Contains storage variables of the {PixCashier} contract.
 *
 * We are following Compound's approach of upgrading new contract implementations.
 * See https://github.com/compound-finance/compound-protocol.
 * When we need to add new storage variables, we create a new version of PixCashierStorage
 * e.g. PixCashierStorage<versionNumber>, so finally it would look like
 * "contract PixCashierStorage is PixCashierStorageV1, PixCashierStorageV2".
 */
abstract contract PixCashierStorage is PixCashierStorageV1 {

}
