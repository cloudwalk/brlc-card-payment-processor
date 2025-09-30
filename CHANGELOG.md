# 1.4.1

## Main Changes

### CashbackDistributor

- The `revokeCashback` method reverts with an "insufficient allowance" error when a a cashback receiver account has no sufficient token allowance to revoke cashback.
- The `OutOfBalance` revocation status has higher priority than `OutOfFunds`.

## Migration steps

No special actions are required for already deployed smart contracts, just upgrade them.

# 1.4.0
