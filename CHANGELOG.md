# 1.4.1
## Main Changes
### CashbackDistributor

- The `revokeCashback` method now reverts with an "insufficient allowance" error when payer account has no sufficient token allowance to revoke cashback.
- The `OutOfBalance` revocation status now has the highest priority among statuses.

## Migration steps
No special actions are required for already deployed smart contracts, just upgrade them.

# 1.4.0