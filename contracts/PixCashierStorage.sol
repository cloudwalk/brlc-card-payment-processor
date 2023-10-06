// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { IPixCashierTypes } from "./interfaces/IPixCashier.sol";

/**
 * @title PixCashier storage version 1
 */
abstract contract PixCashierStorageV1 is IPixCashierTypes {
    /// @dev The address of the underlying token.
    address internal _token;

    /// @dev The mapping of a pending cash-out balance for a given account.
    mapping(address => uint256) internal _cashOutBalances;

    /// @dev The mapping of a cash-out operation structure for a given off-chain transaction identifier.
    mapping(bytes32 => CashOut) internal _cashOuts;

    /// @dev The set of off-chain transaction identifiers that correspond the pending cash-out operations.
    EnumerableSetUpgradeable.Bytes32Set _pendingCashOutTxIds;

    /// @dev The processed cash-out operation counter that includes number of reversed and confirmed operations.
    uint256 internal _processedCashOutCounter;
}

/**
 * @title PixCashier storage version 2
 */
abstract contract PixCashierStorageV2 is IPixCashierTypes {
    /// @dev The mapping of a cash-out operation structure for a given off-chain transaction identifier.
    mapping(bytes32 => CashInOperation) internal _cashIns;
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
abstract contract PixCashierStorage is PixCashierStorageV1, PixCashierStorageV2 {

}
