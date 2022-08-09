// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "./base/PausableExUpgradeable.sol";

/**
 * @title CardPaymentProcessorUpgradeable contract
 * @dev Wrapper for the card payment operations.
 */
contract CardPaymentProcessorUpgradeable is AccessControlUpgradeable, PausableExUpgradeable {

    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    event MakePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 amount,
        uint8 revocationCounter
    );

    event ClearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    event UnclearPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        uint8 revocationCounter
    );

    event RevokePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        bool wasPaymentCleared,
        bytes32 parentTransactionHash,
        uint8 revocationCounter
    );

    event ReversePayment(
        bytes16 indexed authorizationId,
        bytes16 indexed correlationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint256 unclearedBalance,
        bool wasPaymentCleared,
        bytes32 parentTransactionHash,
        uint8 revocationCounter
    );

    event ConfirmPayment(
        bytes16 indexed authorizationId,
        address indexed account,
        uint256 amount,
        uint256 clearedBalance,
        uint8 revocationCounter
    );

    event SetRevocationCounterMaximum(
        uint8 oldValue,
        uint8 newValue
    );

    /**
     * @dev Possible statuses of a payment as an enum
     *
     * The possible values:
     * - Nonexistent -- the payment does not exist (the default value).
     * - Uncleared -- the status immediately after the payment making.
     * - Cleared -- the payment has been cleared and is ready to be confirmed.
     * - Revoked -- the payment was revoked due to some technical reason.
     *              The related tokens have been transferred back to a customer.
     *              The payment can be made again with the same authorizationId.
     * - Reversed -- the payment was reversed due to the decision of the off-chain card processing service.
     *               The related tokens have been transferred back to a customer.
     *               The payment cannot be made again with the same authorizationId.
     * - Confirmed -- the payment was approved.
     *                The related tokens have been transferred to a special cash-out account to further operations.
     *                The payment cannot be made again with the same authorizationId.
     */
    enum PaymentStatus {
        Nonexistent, // 0
        Uncleared,   // 1
        Cleared,     // 2
        Revoked,     // 3
        Reversed,    // 4
        Confirmed    // 5
    }

    /**
     * @dev Structure with the data of a single payment:
     *
     * - account -- the account who made the payment;
     * - amount -- the amount of tokens in the payment;
     * - status -- the current status of the payment according to the {PaymentStatus} enum;
     * - revocationCounter -- the number of revocation of the payment.
     */
    struct Payment {
        address account;
        uint256 amount;
        PaymentStatus status;
        uint8 revocationCounter;
    }

    /// @dev The address of the underlying token contract.
    address public token;

    uint256 private _totalClearedBalance;
    uint256 private _totalUnclearedBalance;
    uint8 private _revocationCounterMaximum;

    mapping(address => uint256) private _unclearedBalances;
    mapping(address => uint256) private _clearedBalances;
    mapping(bytes16 => Payment) private _payments;
    mapping(bytes32 => bool) private _paymentRevocationFlags;
    mapping(bytes32 => bool) private _paymentReversionFlags;

    /// @dev Zero has been passed when setting the new value of the revocation counter maximum.
    error ZeroNewValueOfRevocationCounterMaximum();

    /// @dev Zero amount of tokens has been passed when making a payment.
    error ZeroPaymentAmount();

    /// @dev Zero authorization ID has been passed as a function argument.
    error ZeroAuthorizationId();

    /// @dev The payment with the provided authorization ID already exists and was not revoked.
    error PaymentAlreadyExists();

    /**
     * @dev Revocation counter of the payment reached the configured maximum and payment cannot be made.
     * @param configuredRevocationCounterMaximum The configured maximum value.
     */
    error RevocationCounterReachedMaximum(uint8 configuredRevocationCounterMaximum);

    /// @dev The input array of authorization IDs of a function is empty.
    error EmptyInputArrayOfAuthorizationIds();

    /// @dev Zero cash out account has been passed as a function argument.
    error ZeroCashOutAccount();

    /// @dev Zero parent transaction has been passed as a function argument.
    error ZeroParentTransactionHash();

    /// @dev Payment with the provided authorization ID is uncleared, but it should be cleared.
    error PaymentIsUncleared();

    /// @dev Payment with the provided authorization ID is cleared, but it should be uncleared.
    error PaymentIsCleared();

    /**
     * @dev The payment with the provided authorization ID has an inappropriate status.
     * @param currentStatus The current status of payment with the provided authorization ID.
     */
    error InappropriatePaymentStatus(PaymentStatus currentStatus);

    /// @dev The payment with the provided authorization ID does not exist.
    error PaymentDoesNotExit();

    function initialize(address token_) public initializer {
        __CardPaymentProcessor_init(token_);
    }

    function __CardPaymentProcessor_init(address token_) internal onlyInitializing {
        __AccessControl_init_unchained();
        __Context_init_unchained();
        __ERC165_init_unchained();
        __Pausable_init_unchained();
        __PausableEx_init_unchained(OWNER_ROLE);

        __CardPaymentProcessor_init_unchained(token_);
    }

    function __CardPaymentProcessor_init_unchained(address token_) internal onlyInitializing {
        token = token_;
        _revocationCounterMaximum = type(uint8).max;

        _setRoleAdmin(OWNER_ROLE, OWNER_ROLE);
        _setRoleAdmin(EXECUTOR_ROLE, OWNER_ROLE);

        _setupRole(OWNER_ROLE, _msgSender());
    }

    /**
     * @dev Returns the total uncleared amount of tokens locked in the contract.
     */
    function totalUnclearedBalance() external view virtual returns (uint256) {
        return _totalUnclearedBalance;
    }

    /**
     * @dev Returns the total cleared amount of tokens locked in the contract.
     */
    function totalClearedBalance() external view virtual returns (uint256) {
        return _totalClearedBalance;
    }

    /**
     * @dev Returns the uncleared balance for an account.
     * @param account The address of the account.
     */
    function unclearedBalanceOf(address account) external view virtual returns (uint256) {
        return _unclearedBalances[account];
    }

    /**
     * @dev Returns the cleared balance for an account.
     * @param account The address of the account.
     */
    function clearedBalanceOf(address account) external view virtual returns (uint256) {
        return _clearedBalances[account];
    }

    /**
     * @dev Returns payment data for a card transaction authorization ID.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function paymentFor(bytes16 authorizationId) external view virtual returns (Payment memory) {
        return _payments[authorizationId];
    }

    /**
     * @dev Checks if a payment related to a parent transaction hash has been revoked.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function isPaymentRevoked(bytes32 parentTxHash) external view virtual returns (bool) {
        return _paymentRevocationFlags[parentTxHash];
    }

    /**
     * @dev Checks if a payment related to a parent transaction hash has been reversed.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function isPaymentReversed(bytes32 parentTxHash) external view virtual returns (bool) {
        return _paymentReversionFlags[parentTxHash];
    }

    /**
     * @dev Sets a new value for the revocation counter maximum.
     * Emits a {SetRevocationCounterMaximum} event if the new value differs from the old one.
     * @param newValue The new value of revocation counter maximum to set.
     */
    function setRevocationCounterMaximum(uint8 newValue) external onlyRole(OWNER_ROLE) {
        if (newValue == 0) {
            revert ZeroNewValueOfRevocationCounterMaximum();
        }

        uint8 oldValue = _revocationCounterMaximum;
        if (oldValue == newValue) {
            return;
        }

        _revocationCounterMaximum = newValue;
        emit SetRevocationCounterMaximum(
            oldValue,
            newValue
        );
    }

    /**
     * @dev Returns the value of the revocation counter maximum.
     */
    function revocationCounterMaximum() external virtual view returns (uint8) {
        return _revocationCounterMaximum;
    }


    /**
     * @dev Makes a card payment.
     *
     * Transfers the underlying tokens from the payer (who is the caller of the function) to this contract.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     * - The amount of tokens in the payment should be greater then zero.
     * - The authorization ID of the payment should not be zero.
     * - The payment with the authorization ID should not exist or
     *   should be revoked not more then the configured maximum times.
     *
     * Emits a {MakePayment} event.
     *
     * @param amount The amount of tokens to be transferred to this contract because of the payment.
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to call of this function in the off-chain card processing backend.
     */
    function makePayment(
        uint256 amount,
        bytes16 authorizationId,
        bytes16 correlationId
    )
        external
        whenNotPaused
    {
        Payment storage payment = _payments[authorizationId];
        address sender = _msgSender();

        if (amount == 0) {
            revert ZeroPaymentAmount();
        }
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        PaymentStatus status = payment.status;
        if (status != PaymentStatus.Nonexistent && status != PaymentStatus.Revoked) {
            revert PaymentAlreadyExists();
        }

        uint8 revocationCounter = payment.revocationCounter;
        if (revocationCounter >= _revocationCounterMaximum) {
            revert RevocationCounterReachedMaximum(_revocationCounterMaximum);
        }

        IERC20Upgradeable(token).transferFrom(
            sender,
            address(this),
            amount
        );

        payment.account = sender;
        payment.amount = amount;
        payment.status = PaymentStatus.Uncleared;

        _unclearedBalances[sender] = _unclearedBalances[sender] + amount;
        _totalUnclearedBalance = _totalUnclearedBalance + amount;

        emit MakePayment(
            authorizationId,
            correlationId,
            sender,
            amount,
            revocationCounter
        );
    }

    /**
     * @dev Executes a clearing operation for a single previously made card payment.
     *
     * Requirements:
     *
     * - The payment should have the "uncleared" status.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment should not be zero.
     *
     * Emits a {ClearPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function clearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = clearPaymentInternal(authorizationId);

        _totalUnclearedBalance = _totalUnclearedBalance - amount;
        _totalClearedBalance = _totalClearedBalance + amount;
    }

    /**
     * @dev Executes a clearing operation for several previously made card payments.
     *
     * Requirements:
     *
     * - Each payment should have the "uncleared" status or the call will be reverted.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     * - The input array of the the authorization IDs should not be empty.
     * - All the authorization IDs of the payments should not be zero.
     *
     * Emits a {ClearPayment} event for each payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function clearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyInputArrayOfAuthorizationIds();
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            totalAmount += clearPaymentInternal(authorizationIds[i]);
        }
        _totalUnclearedBalance = _totalUnclearedBalance - totalAmount;
        _totalClearedBalance = _totalClearedBalance + totalAmount;
    }

    /**
     * @dev Cancels a previously executed clearing operation for a single card payment.
     *
     * Requirements:
     *
     * - The payment should have the "cleared" status or the call will be reverted.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     * - The input authorization ID of the payment should not be zero.
     *
     * Emits a {UnclearPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     */
    function unclearPayment(bytes16 authorizationId) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        uint256 amount = unclearPaymentInternal(authorizationId);

        _totalClearedBalance = _totalClearedBalance - amount;
        _totalUnclearedBalance = _totalUnclearedBalance + amount;
    }

    /**
     * @dev Cancels a previously executed clearing operation for several card payments.
     *
     * Requirements:
     *
     * - Each payment should have the "cleared" status or the call will be reverted.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     * - The input array of the the authorization IDs should not be empty.
     * - All the authorization IDs of the payments should not be zero.
     *
     * Emits a {UnclearPayment} event for the payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     */
    function unclearPayments(bytes16[] memory authorizationIds) external whenNotPaused onlyRole(EXECUTOR_ROLE) {
        if (authorizationIds.length == 0) {
            revert EmptyInputArrayOfAuthorizationIds();
        }
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            totalAmount = totalAmount + unclearPaymentInternal(authorizationIds[i]);
        }
        _totalClearedBalance = _totalClearedBalance - totalAmount;
        _totalUnclearedBalance = _totalUnclearedBalance + totalAmount;
    }

    /**
     * @dev Performs the reverse of a previously made card payment.
     * Finalizes the payment: no other operations can be done for the payment.
     * Transfers tokens back from this contract to the payer.
     *
     * Requirements:
     *
     * - The payment should have "cleared" or "uncleared" statuses.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and parent transaction hash of the payment should not be zero.
     *
     * Emits a {ReversePayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to call of this function in the off-chain card processing backend.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function reversePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    )
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        cancelPaymentInternal(
            authorizationId,
            correlationId,
            parentTxHash,
            PaymentStatus.Reversed
        );
    }

    /**
     * @dev Performs the revocation of a previously made card payment and increase its revocation counter.
     * Does not finalize the payment: it can be made again until revocation counter reaches the configured maximum.
     * Transfers tokens back from this contract to the payer.
     *
     * Requirements:
     *
     * - The payment should have "cleared" or "uncleared" statuses.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and parent transaction hash of the payment should not be zero.
     *
     * Emits a {RevokePayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param correlationId The ID that is correlated to call of this function in the off-chain card processing backend.
     * @param parentTxHash The hash of the transaction where the payment was made.
     */
    function revokePayment(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash
    )
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        cancelPaymentInternal(
            authorizationId,
            correlationId,
            parentTxHash,
            PaymentStatus.Revoked
        );
    }

    /**
     * @dev Executes the final step of single card payments processing with token transferring.
     * Finalizes the payment: no other operations can be done for the payment.
     * Transfers previously cleared tokens gotten from a payer to a dedicated cash-out account for further operations.
     *
     * Requirements:
     *
     * - The payment should have the "cleared" status.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     * - The input authorization ID and cash out account of the payment should not be zero.
     *
     * Emits a {ConfirmPayment} event for the payment.
     *
     * @param authorizationId The card transaction authorization ID from the off-chain card processing backend.
     * @param cashOutAccount The account to transfer cleared tokens to.
     */
    function confirmPayment(
        bytes16 authorizationId,
        address cashOutAccount
    )
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        if (cashOutAccount == address(0)) {
            revert ZeroCashOutAccount();
        }

        uint256 amount = confirmPaymentInternal(authorizationId);
        _totalClearedBalance = _totalClearedBalance - amount;
        IERC20Upgradeable(token).transfer(cashOutAccount, amount);
    }

    /**
     * @dev Executes the final step of several card payments processing with token transferring.
     * Finalizes the payment: no other operations can be done for the payments.
     * Transfers previously cleared tokens gotten from payers to a dedicated cash-out account for further operations.
     *
     * Requirements:
     *
     * - Each payment should have the "cleared" status or the call will be reverted.
     * - The contract must not be paused.
     * - The caller should have the {EXECUTOR_ROLE} role.
     *
     * Emits a {ConfirmPayment} event for the payment.
     *
     * @param authorizationIds The card transaction authorization IDs from the off-chain card processing backend.
     * @param cashOutAccount The account to transfer cleared tokens to.
     */
    function confirmPayments(
        bytes16[] memory authorizationIds,
        address cashOutAccount
    )
        external
        whenNotPaused
        onlyRole(EXECUTOR_ROLE)
    {
        if (authorizationIds.length == 0) {
            revert EmptyInputArrayOfAuthorizationIds();
        }
        if (cashOutAccount == address(0)) {
            revert ZeroCashOutAccount();
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < authorizationIds.length; i++) {
            totalAmount += confirmPaymentInternal(authorizationIds[i]);
        }
        _totalClearedBalance = _totalClearedBalance - totalAmount;

        IERC20Upgradeable(token).transfer(cashOutAccount, totalAmount);
    }

    function clearPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        checkUnclearedStatus(payment.status);
        payment.status = PaymentStatus.Cleared;

        address account = payment.account;
        amount = payment.amount;

        uint256 newUnclearedBalance = _unclearedBalances[account] - amount;
        _unclearedBalances[account] = newUnclearedBalance;
        uint256 newClearedBalance = _clearedBalances[account] + amount;
        _clearedBalances[account] = newClearedBalance;

        emit ClearPayment(
            authorizationId,
            account,
            amount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );
    }

    function unclearPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        checkClearedStatus(payment.status);
        payment.status = PaymentStatus.Uncleared;

        address account = payment.account;
        amount = payment.amount;

        uint256 newClearedBalance = _clearedBalances[account] - amount;
        _clearedBalances[account] = newClearedBalance;
        uint256 newUnclearedBalance = _unclearedBalances[account] + amount;
        _unclearedBalances[account] = newUnclearedBalance;

        emit UnclearPayment(
            authorizationId,
            account,
            amount,
            newClearedBalance,
            newUnclearedBalance,
            payment.revocationCounter
        );
    }

    function confirmPaymentInternal(bytes16 authorizationId) internal returns (uint256 amount) {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }

        Payment storage payment = _payments[authorizationId];

        checkClearedStatus(payment.status);
        payment.status = PaymentStatus.Confirmed;

        address account = payment.account;
        amount = payment.amount;
        uint256 newClearedBalance = _clearedBalances[account] - amount;
        _clearedBalances[account] = newClearedBalance;

        emit ConfirmPayment(
            authorizationId,
            account,
            amount,
            newClearedBalance,
            payment.revocationCounter
        );
    }

    function cancelPaymentInternal(
        bytes16 authorizationId,
        bytes16 correlationId,
        bytes32 parentTxHash,
        PaymentStatus targetStatus
    )
        internal
    {
        if (authorizationId == 0) {
            revert ZeroAuthorizationId();
        }
        if (parentTxHash == 0) {
            revert ZeroParentTransactionHash();
        }

        Payment storage payment = _payments[authorizationId];
        PaymentStatus status = payment.status;

        if (status == PaymentStatus.Nonexistent) {
            revert PaymentDoesNotExit();
        }

        address account = payment.account;
        uint256 amount = payment.amount;

        if (status == PaymentStatus.Uncleared) {
            _unclearedBalances[account] = _unclearedBalances[account] - amount;
            _totalUnclearedBalance = _totalUnclearedBalance - amount;
        } else if (status == PaymentStatus.Cleared) {
            _clearedBalances[account] = _clearedBalances[account] - amount;
            _totalClearedBalance = _totalClearedBalance - amount;
        } else {
            revert InappropriatePaymentStatus(status);
        }

        IERC20Upgradeable(token).transfer(account, amount);

        if (targetStatus == PaymentStatus.Revoked) {
            payment.status = PaymentStatus.Revoked;
            uint8 newRevocationCounter = payment.revocationCounter + 1;
            payment.revocationCounter = newRevocationCounter;
            _paymentRevocationFlags[parentTxHash] = true;

            emit RevokePayment(
                authorizationId,
                correlationId,
                account,
                amount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                newRevocationCounter
            );
        } else {
            payment.status = PaymentStatus.Reversed;
            _paymentReversionFlags[parentTxHash] = true;

            emit ReversePayment(
                authorizationId,
                correlationId,
                account,
                amount,
                _clearedBalances[account],
                _unclearedBalances[account],
                status == PaymentStatus.Cleared,
                parentTxHash,
                payment.revocationCounter
            );
        }
    }

    function checkClearedStatus(PaymentStatus status) internal pure {
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentDoesNotExit();
        }
        if (status == PaymentStatus.Uncleared) {
            revert PaymentIsUncleared();
        }
        if (status != PaymentStatus.Cleared) {
            revert InappropriatePaymentStatus(status);
        }
    }

    function checkUnclearedStatus(PaymentStatus status) internal pure {
        if (status == PaymentStatus.Nonexistent) {
            revert PaymentDoesNotExit();
        }
        if (status == PaymentStatus.Cleared) {
            revert PaymentIsCleared();
        }
        if (status != PaymentStatus.Uncleared) {
            revert InappropriatePaymentStatus(status);
        }
    }
}
