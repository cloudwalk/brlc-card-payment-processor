// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

abstract contract CashbackControl {
    event SetCashbackRate(uint32 oldRate, uint32 newRate);

    error UnsafeCashbackRate(uint32 proposedRate);

    uint32 internal _cashbackRate;
    uint32 internal _maxSafeCashbackRate;

    function __CashbackControl_init() internal {
        _cashbackRate = 100;
        _maxSafeCashbackRate = 1000;
    }

    function setCashbackRateInternal(uint32 newRate) internal {
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
