// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

abstract contract CashbackControl is AccessControlUpgradeable {
    event SetCashbackRate(uint32 oldRate, uint32 newRate);

    // Money has been transferred to user account
    event CashbackApplied(bytes16 authorizationId, uint256 amount);

    // Transaction has been refunded, so we return the amount minus the cashback
    event CashbackBypassed(bytes16 authorizationId, uint256 amount);

    error UnsafeCashbackRate(uint32 proposedRate);

    bytes32 public constant CASHBACK_OWNER_ROLE = keccak256("CASHBACK_OWNER_ROLE");

    uint32 internal _cashbackRate;
    uint32 internal _maxSafeCashbackRate;

    function __CashbackControl_init(bytes32 ownerRole) internal onlyInitializing {
        __Context_init_unchained();
        __AccessControl_init_unchained();

        __CashbackControl_init_unchained(ownerRole);
    }

    function __CashbackControl_init_unchained(bytes32 ownerRole) internal onlyInitializing {
        _setRoleAdmin(CASHBACK_OWNER_ROLE, ownerRole);

        _cashbackRate = 100;
        _maxSafeCashbackRate = 1000;
    }

    function setCashbackRate(uint32 newRate) external onlyRole(CASHBACK_OWNER_ROLE) {
        uint32 oldRate = _cashbackRate;

        if (newRate > _maxSafeCashbackRate) {
            revert UnsafeCashbackRate(newRate);
        }

        if (oldRate == newRate) {
            return;
        }

        _cashbackRate = newRate;

        emit SetCashbackRate(oldRate, newRate);
    }

    function cashbackRate() external view returns (uint32) {
        return _cashbackRate;
    }
}
