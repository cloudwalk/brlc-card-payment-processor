// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { ICashbackDistributorTypes } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CashbackDistributor storage version 1
 */
abstract contract CashbackDistributorStorageV1 is ICashbackDistributorTypes {
    /// @dev The enable flag of the cashback operations.
    bool internal _enabled;

    /// @dev The nonce of the next cashback operation.
    uint256 internal _nextNonce;

    /// @dev The mapping of a cashback structure for a given cashback nonce.
    mapping(uint256 => Cashback) internal _cashbacks;

    /// @dev Mapping of a nonce collection of all the cashback operations for a given external cashback identifier.
    mapping(bytes32 => uint256[]) internal _nonceCollectionByExternalId;

    // Obsolete
    mapping(bytes32 => uint256) private _totalAmountByExternalId;

    // Obsolete
    mapping(address => uint256) private _totalAmountByRecipient;

    /// @dev Mapping of a total amount of success cashback operations for a given token and an external identifier.
    mapping(address => mapping(bytes32 => uint256)) internal _totalCashbackByTokenAndExternalId;

    /// @dev Mapping of a total amount of success cashback operations for a given token and an recipient address.
    mapping(address => mapping(address => uint256)) internal _totalCashbackByTokenAndRecipient;
}

/**
 * @title CashbackDistributor storage
 * @dev Contains storage variables of the {CashbackDistributor} contract.
 *
 * We are following Compound's approach of upgrading new contract implementations.
 * See https://github.com/compound-finance/compound-protocol.
 * When we need to add new storage variables, we create a new version of CashbackDistributorStorage
 * e.g. CashbackDistributorStorage<versionNumber>, so finally it would look like
 * "contract CashbackDistributorStorage is CashbackDistributorStorageV1, CashbackDistributorStorageV2".
 */
abstract contract CashbackDistributorStorage is CashbackDistributorStorageV1 {

}
