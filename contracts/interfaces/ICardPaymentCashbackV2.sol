// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

/**
 * @title CardPaymentCashbackV2 types interface
 */
interface ICardPaymentCashbackV2Types {
    /**
     * @dev Statuses of a cashback operation as an enum.
     *
     * The possible values:
     * - Undefined - The operation does not exist (the default value).
     * - Success --- The operation has been successfully executed with a full amount transfer.
     * - Partial --- The operation has been successfully executed but with a partial amount transfer.
     * - Capped ---- The operation has been refused because the cap for the period has been reached.
     * - Failed ---- The operation has been refused because the token transfer has failed.
     */
    enum CashbackOperationStatus {
        Undefined, // 0
        Success,   // 1
        Partial,   // 2
        Capped,    // 3
        Failed     // 4
    }

    /// @dev Structure with cashback-related data for a single account
    struct AccountCashbackState {
        uint72 totalAmount;
        uint72 capPeriodStartAmount;
        uint32 capPeriodStartTime;
    }
}

/**
 * @title CardPaymentCashbackV2 interface
 * @dev The interface of the wrapper contract for the card payment cashback operations.
 */
interface ICardPaymentCashbackV2 is ICardPaymentCashbackV2Types {
    /**
     * @dev Emitted when the cashback rate is changed.
     * @param oldRate The value of the old cashback rate.
     * @param newRate The value of the new cashback rate.
     */
    event CashbackRateChanged(uint256 oldRate, uint256 newRate);

    /**
     * @dev Emitted when the cashback treasury address is changed.
     * @param oldTreasury The address of the old cashback treasury.
     * @param newTreasure The address of the new cashback treasury.
     */
    event CashbackTreasuryChanged(address oldTreasury, address newTreasure);

    /**
     * @dev Emitted when a cashback sending request executed, successfully or not.
     * @param paymentId The associated card transaction payment ID from the off-chain card processing backend.
     * @param recipient The address of the cashback recipient.
     * @param status The status of the cashback operation.
     * @param amount The actual amount of the sent cashback.
     */
    event CashbackSent(
        bytes32 indexed paymentId,
        address indexed recipient,
        CashbackOperationStatus indexed status,
        uint256 amount
    );

    /**
     * @dev Emitted when a cashback revocation request executed, successfully or not.
     * @param paymentId The associated card transaction payment ID from the off-chain card processing backend.
     * @param recipient The address of the cashback recipient.
     * @param status The status of the cashback operation.
     * @param oldCashbackAmount The cashback amount before the operation.
     * @param newCashbackAmount The cashback amount after the operation.
     *
     */
    event CashbackRevoked(
        bytes32 indexed paymentId,
        address indexed recipient,
        CashbackOperationStatus indexed status,
        uint256 oldCashbackAmount,
        uint256 newCashbackAmount
    );

    /**
     * @dev Emitted when a cashback increase request executed, successfully or not.
     * @param paymentId The associated card transaction payment ID from the off-chain card processing backend.
     * @param recipient The address of the cashback recipient.
     * @param status The status of the cashback operation.
     * @param oldCashbackAmount The cashback amount before the operation.
     * @param newCashbackAmount The cashback amount after the operation.
     */
    event CashbackIncreased(
        bytes32 indexed paymentId,
        address indexed recipient,
        CashbackOperationStatus indexed status,
        uint256 oldCashbackAmount,
        uint256 newCashbackAmount
    );

    /// @dev Emitted when cashback operations are enabled.
    event CashbackEnabled();

    /// @dev Emitted when cashback operations are disabled.
    event CashbackDisabled();

    /**
     * @dev Returns the current cashback treasury address.
     */
    function cashbackTreasury() external view returns (address);

    /**
     * @dev Checks if the cashback operations are enabled.
     */
    function cashbackEnabled() external view returns (bool);

    /**
     * @dev Returns the current cashback rate.
     */
    function cashbackRate() external view returns (uint256);

    /**
     * @dev Sets a new address of the cashback treasury.
     *
     * Emits a {CashbackTreasuryChanged} event.
     *
     * @param newCashbackTreasury The address of the new cashback treasury.
     */
    function setCashbackTreasury(address newCashbackTreasury) external;

    /**
     * @dev Sets a new cashback rate.
     *
     * Emits a {SetCashbackRate} event.
     *
     * @param newCashbackRate The value of the new cashback rate.
     */
    function setCashbackRate(uint256 newCashbackRate) external;

    /**
     * @dev Enables the cashback operations.
     *
     * Emits a {EnableCashback} event.
     */
    function enableCashback() external;

    /**
     * @dev Disables the cashback operations.
     *
     * Emits a {DisableCashback} event.
     */
    function disableCashback() external;

    /**
     * @dev Returns a structure with cashback-related data for a single account.
     * @param account The account address to get the cashback state for.
     */
    function getAccountCashbackState(address account) external view returns (AccountCashbackState memory);
}
