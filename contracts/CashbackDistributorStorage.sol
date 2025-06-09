// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { ICashbackDistributorTypes } from "./interfaces/ICashbackDistributor.sol";

/**
 * @title CashbackDistributor storage version 1
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
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

    /// @dev Mapping of a total amount of successful cashback operations for a given token and an external identifier.
    mapping(address => mapping(bytes32 => uint256)) internal _totalCashbackByTokenAndExternalId;

    /// @dev Mapping of a total amount of successful cashback operations for a given token and a recipient address.
    mapping(address => mapping(address => uint256)) internal _totalCashbackByTokenAndRecipient;
}

/**
 * @title CashbackDistributor storage version 2
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 */
abstract contract CashbackDistributorStorageV2 {
    /// @dev The cashback periodic cap reset period.
    uint256 public constant CASHBACK_RESET_PERIOD = 30 days;

    /// @dev The maximum amount of cashback for a period.
    uint256 public constant MAX_CASHBACK_FOR_PERIOD = 300 * 10 ** 6;

    /// @dev The mapping of the last time the cashback periodic cap was reset for a token and a recipient.
    mapping(address => mapping(address => uint256)) internal _cashbackLastTimeReset;

    /// @dev The mapping of the total amount of cashback within the current cap period for a token and a recipient.
    mapping(address => mapping(address => uint256)) internal _cashbackSinceLastReset;
}

/**
 * @title CashbackDistributor storage
 * @author CloudWalk Inc. (See https://www.cloudwalk.io)
 * @dev Contains storage variables of the {CashbackDistributor} contract.
 *
 * We are following Compound's approach of upgrading new contract implementations.
 * See https://github.com/compound-finance/compound-protocol.
 * When we need to add new storage variables, we create a new version of CashbackDistributorStorage
 * e.g. CashbackDistributorStorage<versionNumber>, so finally it would look like
 * "contract CashbackDistributorStorage is CashbackDistributorStorageV1, CashbackDistributorStorageV2".
 */
abstract contract CashbackDistributorStorage is CashbackDistributorStorageV1, CashbackDistributorStorageV2 {}
