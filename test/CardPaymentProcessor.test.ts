import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../test-utils/eth";
import { createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { TransactionReceipt, TransactionResponse } from "@ethersproject/abstract-provider";
import { checkEventField } from "../test-utils/checkers";

const MAX_UINT256 = ethers.constants.MaxUint256;
const MAX_INT256 = ethers.constants.MaxInt256;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const ZERO_TRANSACTION_HASH: string = ethers.constants.HashZero;
const BYTES16_LENGTH: number = 16;
const BYTES32_LENGTH: number = 32;
const INITIAL_USER_BALANCE = 1000000;

const FUNCTION_MAKE_PAYMENT_FULL = "makePayment(uint256,uint256,bytes16,bytes16)";
const FUNCTION_MAKE_PAYMENT_FROM_FULL = "makePaymentFrom(address,uint256,uint256,bytes16,bytes16)";
const FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL = "updatePaymentAmount(uint256,uint256,bytes16,bytes16)";
const FUNCTION_REFUND_PAYMENT_FULL = "refundPayment(uint256,uint256,bytes16,bytes16)";

const FUNCTION_MAKE_PAYMENT_PRUNED = "makePayment(uint256,bytes16,bytes16)";
const FUNCTION_MAKE_PAYMENT_FROM_PRUNED = "makePaymentFrom(address,uint256,bytes16,bytes16)";
const FUNCTION_UPDATE_PAYMENT_AMOUNT_PRUNED = "updatePaymentAmount(uint256,bytes16,bytes16)";
const FUNCTION_REFUND_PAYMENT_PRUNED = "refundPayment(uint256,bytes16,bytes16)";

const EVENT_NAME_CONFIRM_PAYMENT = "ConfirmPayment";
const EVENT_NAME_CLEAR_PAYMENT = "ClearPayment";
const EVENT_NAME_ENABLE_CASHBACK = "EnableCashback";
const EVENT_NAME_DISABLE_CASHBACK = "DisableCashback";
const EVENT_NAME_INCREASE_CASHBACK_FAILURE = "IncreaseCashbackFailure";
const EVENT_NAME_INCREASE_CASHBACK_MOCK = "IncreaseCashbackMock";
const EVENT_NAME_INCREASE_CASHBACK_SUCCESS = "IncreaseCashbackSuccess";
const EVENT_NAME_MAKE_PAYMENT = "MakePayment";
const EVENT_NAME_PAYMENT_EXTRA_AMOUNT_CHANGED = "PaymentExtraAmountChanged";
const EVENT_NAME_REFUND_PAYMENT = "RefundPayment";
const EVENT_NAME_REVERSE_PAYMENT = "ReversePayment";
const EVENT_NAME_REVOKE_CASHBACK_FAILURE = "RevokeCashbackFailure";
const EVENT_NAME_REVOKE_CASHBACK_MOCK = "RevokeCashbackMock";
const EVENT_NAME_REVOKE_CASHBACK_SUCCESS = "RevokeCashbackSuccess";
const EVENT_NAME_REVOKE_PAYMENT = "RevokePayment";
const EVENT_NAME_SEND_CASHBACK_FAILURE = "SendCashbackFailure";
const EVENT_NAME_SEND_CASHBACK_MOCK = "SendCashbackMock";
const EVENT_NAME_SEND_CASHBACK_SUCCESS = "SendCashbackSuccess";
const EVENT_NAME_SET_CASH_OUT_ACCOUNT = "SetCashOutAccount";
const EVENT_NAME_SET_CASHBACK_DISTRIBUTOR = "SetCashbackDistributor";
const EVENT_NAME_SET_CASHBACK_RATE = "SetCashbackRate";
const EVENT_NAME_SET_REVOCATION_LIMIT = "SetRevocationLimit";
const EVENT_NAME_UNCLEAR_PAYMENT = "UnclearPayment";
const EVENT_NAME_UPDATE_PAYMENT_AMOUNT = "UpdatePaymentAmount";

enum PaymentStatus {
  Nonexistent = 0,
  Uncleared = 1,
  Cleared = 2,
  Revoked = 3,
  Reversed = 4,
  Confirmed = 5,
}

enum CashbackKind {
  // Manual = 0,
  CardPayment = 1,
}

interface TestPayment {
  account: SignerWithAddress;
  baseAmount: number;
  extraAmount: number;
  authorizationId: string;
  correlationId: string;
  parentTxHash: string;
}

interface PaymentModel {
  authorizationId: string;
  account: SignerWithAddress;
  baseAmount: number;
  extraAmount: number;
  status: PaymentStatus;
  compensationAmount: number;
  refundAmount: number;
  cashbackRate: number;
  cashbackEnabled: boolean;
  revocationParentTxHashes: string[];
  reversalParentTxHashes: string[];
}

interface CashbackDistributorMockConfig {
  sendCashbackSuccessResult: boolean;
  sendCashbackAmountResult: number;
  sendCashbackNonceResult: number;
  revokeCashbackSuccessResult: boolean;
  increaseCashbackSuccessResult: boolean;
  increaseCashbackAmountResult: number;
}

interface CashbackModel {
  lastCashbackNonce: number;
}

enum OperationKind {
  Undefined = 0,
  Making = 1,
  Updating = 2,
  Clearing = 3,
  Unclearing = 4,
  Revoking = 5,
  Reversing = 6,
  Confirming = 7,
  Refunding = 8,
}

interface PaymentOperation {
  kind: OperationKind;
  sender?: SignerWithAddress;
  account: SignerWithAddress;
  newBaseAmount: number;
  newExtraAmount: number;
  refundAmount: number;
  oldBaseAmount: number;
  oldExtraAmount: number;
  totalAmount: number;
  authorizationId: string;
  correlationId: string;
  parentTransactionHash: string;
  revocationCounter: number;
  cashbackEnabled: boolean;
  cashbackSendingSucceeded: boolean;
  cashbackRevocationRequested: boolean;
  cashbackRevocationSuccess: boolean;
  cashbackIncreaseRequested: boolean;
  cashbackIncreaseSuccess: boolean;
  cashbackRequestedChange: number;
  cashbackActualChange: number;
  cashbackRate: number;
  cashbackNonce: number;
  senderBalanceChange: number;
  cardPaymentProcessorBalanceChange: number;
  userBalanceChange: number;
  cashOutAccountBalanceChange: number;
  compensationAmountChange: number;
  clearedBalance: number;
  unclearedBalance: number;
  paymentStatus: PaymentStatus;
}

interface Fixture {
  cardPaymentProcessor: Contract;
  tokenMock: Contract;
  cashbackDistributorMock: Contract;
  cashbackDistributorMockConfig: CashbackDistributorMockConfig;
}

class CashbackDistributorMockShell {
  readonly contract: Contract;
  readonly config: CashbackDistributorMockConfig;

  constructor(props: {
    cashbackDistributorMockConfig: CashbackDistributorMockConfig,
    cashbackDistributorMockContract: Contract
  }) {
    this.contract = props.cashbackDistributorMockContract;
    this.config = props.cashbackDistributorMockConfig;
  }

  async setSendCashbackSuccessResult(newSendCashbackSuccessResult: boolean) {
    await proveTx(this.contract.setSendCashbackSuccessResult(newSendCashbackSuccessResult));
    this.config.sendCashbackSuccessResult = newSendCashbackSuccessResult;
  }

  async setSendCashbackAmountResult(newSendCashbackAmountResult: number) {
    await proveTx(this.contract.setSendCashbackAmountResult(newSendCashbackAmountResult));
    this.config.sendCashbackAmountResult = newSendCashbackAmountResult;
  }

  async setRevokeCashbackSuccessResult(newRevokeCashbackSuccessResult: boolean) {
    await proveTx(this.contract.setRevokeCashbackSuccessResult(newRevokeCashbackSuccessResult));
    this.config.revokeCashbackSuccessResult = newRevokeCashbackSuccessResult;
  }

  async setIncreaseCashbackSuccessResult(newIncreaseCashbackSuccessResult: boolean) {
    await proveTx(this.contract.setIncreaseCashbackSuccessResult(newIncreaseCashbackSuccessResult));
    this.config.increaseCashbackSuccessResult = newIncreaseCashbackSuccessResult;
  }

  async setIncreaseCashbackAmountResult(newIncreaseCashbackAmountResult: number) {
    await proveTx(this.contract.setIncreaseCashbackAmountResult(newIncreaseCashbackAmountResult));
    this.config.increaseCashbackAmountResult = newIncreaseCashbackAmountResult;
  }
}

class CardPaymentProcessorModel {
  #cashbackDistributorMockConfig: CashbackDistributorMockConfig;
  #cashbackEnabled: boolean = false;
  #cashbackRateInPermil: number;
  #paymentPerAuthorizationId: Map<string, PaymentModel> = new Map<string, PaymentModel>();
  #unclearedBalancePerAccount: Map<string, number> = new Map<string, number>();
  #clearedBalancePerAccount: Map<string, number> = new Map<string, number>();
  #totalUnclearedBalance: number = 0;
  #totalClearedBalance: number = 0;
  #totalBalance: number = 0;
  #cashbackPerAuthorizationId: Map<string, CashbackModel> = new Map<string, CashbackModel>();
  #paymentMakingOperations: PaymentOperation[] = [];
  #paymentOperations: PaymentOperation[] = [];

  constructor(props: {
    cashbackDistributorMockConfig: CashbackDistributorMockConfig;
    cashbackRateInPermil: number,
  }) {
    this.#cashbackDistributorMockConfig = props.cashbackDistributorMockConfig;
    this.#cashbackRateInPermil = props.cashbackRateInPermil;
  }

  makePayment(payment: TestPayment, sender: SignerWithAddress = payment.account): number {
    const paymentModel = this.#createPayment(payment);
    const operation: PaymentOperation = this.#createPaymentOperation(paymentModel, OperationKind.Making);
    operation.sender = sender;
    operation.oldBaseAmount = 0;
    operation.oldExtraAmount = 0;
    operation.correlationId = payment.correlationId;
    this.#definePaymentMakingOperation(operation);
    return this.#registerPaymentMakingOperation(operation, paymentModel);
  }

  updatePaymentAmount(
    newBaseAmount: number,
    newExtraAmount: number,
    authorizationId: string,
    correlationId: string
  ): number {
    const payment: PaymentModel = this.getPaymentByAuthorizationId(authorizationId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Updating);
    operation.newBaseAmount = newBaseAmount;
    operation.newExtraAmount = newExtraAmount;
    operation.correlationId = correlationId;
    this.#checkPaymentUpdating(operation, payment);
    this.#definePaymentUpdatingOperation(operation, payment);
    return this.#registerPaymentUpdatingOperation(operation, payment);
  }

  clearPayment(authorizationId: string): number {
    const payment: PaymentModel = this.getPaymentByAuthorizationId(authorizationId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Clearing);
    this.#checkPaymentClearing(payment);
    return this.#registerPaymentClearingOperation(operation, payment);
  }

  unclearPayment(authorizationId: string): number {
    const payment: PaymentModel = this.getPaymentByAuthorizationId(authorizationId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Unclearing);
    this.#checkPaymentUnclearing(payment);
    return this.#registerPaymentUnclearingOperation(operation, payment);
  }

  revokePayment(authorizationId: string, correlationId: string, parentTxHash: string): number {
    const payment: PaymentModel = this.getPaymentByAuthorizationId(authorizationId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Revoking);
    operation.correlationId = correlationId;
    operation.parentTransactionHash = parentTxHash;
    operation.revocationCounter += 1;
    this.#checkPaymentCanceling(payment);
    this.#definePaymentCancelingOperation(operation, payment);
    this.#updateModelDueToPaymentCancelingOperation(operation, payment);
    return this.#registerPaymentRevokingOperation(operation, payment);
  }

  reversePayment(authorizationId: string, correlationId: string, parentTxHash: string): number {
    const payment: PaymentModel = this.getPaymentByAuthorizationId(authorizationId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Reversing);
    operation.correlationId = correlationId;
    operation.parentTransactionHash = parentTxHash;
    this.#checkPaymentCanceling(payment);
    this.#definePaymentCancelingOperation(operation, payment);
    this.#updateModelDueToPaymentCancelingOperation(operation, payment);
    return this.#registerPaymentReversingOperation(operation, payment);
  }

  confirmPayment(authorizationId: string): number {
    const payment: PaymentModel = this.getPaymentByAuthorizationId(authorizationId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Confirming);
    operation.cardPaymentProcessorBalanceChange = -operation.totalAmount;
    operation.cashOutAccountBalanceChange = operation.totalAmount;
    this.#checkPaymentConfirming(payment);
    return this.#registerPaymentConfirmingOperation(operation, payment);
  }

  refundPayment(
    refundAmount: number,
    newExtraAmount: number,
    authorizationId: string,
    correlationId: string
  ): number {
    const payment: PaymentModel = this.getPaymentByAuthorizationId(authorizationId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Refunding);
    operation.correlationId = correlationId;
    operation.refundAmount = refundAmount;
    operation.newExtraAmount = newExtraAmount;
    this.#checkPaymentRefunding(operation, payment);
    this.#definePaymentRefundingOperation(operation, payment);
    return this.#registerPaymentRefundingOperation(operation, payment);
  }

  enableCashback() {
    this.#cashbackEnabled = true;
  }

  disableCashback() {
    this.#cashbackEnabled = false;
  }

  getPaymentModelsInMakingOrder(): PaymentModel[] {
    const paymentNumber = this.#paymentMakingOperations.length;
    const paymentModels: PaymentModel[] = [];
    for (let i = 0; i < paymentNumber; ++i) {
      const paymentModel: PaymentModel = this.#getPaymentByMakingOperationIndex(i);
      paymentModels.push(paymentModel);
    }
    return paymentModels;
  }

  getAuthorizationIds(): Set<string> {
    return new Set(this.#paymentPerAuthorizationId.keys());
  }

  getPaymentByAuthorizationId(authorizationId: string): PaymentModel {
    const payment = this.#paymentPerAuthorizationId.get(authorizationId);
    if (!payment) {
      throw Error(`A payment is not in the model. authorizationId = ${authorizationId}`);
    }
    return payment;
  }

  getCashbackByAuthorizationId(authorizationId: string): CashbackModel | undefined {
    return this.#cashbackPerAuthorizationId.get(authorizationId);
  }

  getAccountAddresses(): Set<string> {
    return new Set(
      this.#paymentMakingOperations.map(operation => operation.account.address)
    );
  }

  getAccountUnclearedBalance(account: string): number {
    return (this.#unclearedBalancePerAccount.get(account) ?? 0);
  }

  getAccountClearedBalance(account: string): number {
    return (this.#clearedBalancePerAccount.get(account) ?? 0);
  }

  get totalUnclearedBalance(): number {
    return this.#totalUnclearedBalance;
  }

  get totalClearedBalance(): number {
    return this.#totalClearedBalance;
  }

  get totalBalance(): number {
    return this.#totalBalance;
  }

  getPaymentOperation(operationIndex: number): PaymentOperation {
    return this.#getOperationByIndex(this.#paymentOperations, operationIndex, "");
  }

  #createPayment(payment: TestPayment): PaymentModel {
    const currentPayment = this.#paymentPerAuthorizationId.get(payment.authorizationId);
    if (!!currentPayment && currentPayment.status != PaymentStatus.Revoked) {
      throw new Error(
        `A payment with the provided authorization ID already exists in the model and its status is not "Revoked".` +
        `authorizationId=${payment.authorizationId}`
      );
    }
    return {
      authorizationId: payment.authorizationId,
      account: payment.account,
      baseAmount: payment.baseAmount,
      extraAmount: payment.extraAmount,
      status: PaymentStatus.Uncleared,
      compensationAmount: 0,
      refundAmount: 0,
      cashbackRate: (this.#cashbackEnabled && this.#cashbackDistributorMockConfig.sendCashbackSuccessResult)
        ? this.#cashbackRateInPermil
        : 0,
      cashbackEnabled: this.#cashbackEnabled,
      revocationParentTxHashes: (!currentPayment) ? [] : [...currentPayment.revocationParentTxHashes],
      reversalParentTxHashes: [],
    };
  }

  #createPaymentOperation(payment: PaymentModel, kind: OperationKind): PaymentOperation {
    const cashback = this.getCashbackByAuthorizationId(payment.authorizationId);
    return {
      kind,
      sender: undefined,
      account: payment.account,
      newBaseAmount: payment.baseAmount,
      newExtraAmount: payment.extraAmount,
      refundAmount: 0,
      oldBaseAmount: payment.baseAmount,
      oldExtraAmount: payment.extraAmount,
      totalAmount: payment.baseAmount + payment.extraAmount - payment.refundAmount,
      authorizationId: payment.authorizationId,
      correlationId: "<no_data>",
      parentTransactionHash: "<no_data>",
      revocationCounter: payment.revocationParentTxHashes.length,
      cashbackEnabled: payment.cashbackEnabled,
      cashbackSendingSucceeded: false,
      cashbackRevocationRequested: false,
      cashbackRevocationSuccess: false,
      cashbackIncreaseRequested: false,
      cashbackIncreaseSuccess: false,
      cashbackRequestedChange: 0,
      cashbackActualChange: 0,
      cashbackRate: payment.cashbackRate,
      cashbackNonce: cashback?.lastCashbackNonce ?? 0,
      senderBalanceChange: 0,
      cardPaymentProcessorBalanceChange: 0,
      userBalanceChange: 0,
      cashOutAccountBalanceChange: 0,
      compensationAmountChange: 0,
      clearedBalance: this.#clearedBalancePerAccount.get(payment.account.address) ?? 0,
      unclearedBalance: this.#unclearedBalancePerAccount.get(payment.account.address) ?? 0,
      paymentStatus: payment.status
    };
  }

  #definePaymentMakingOperation(operation: PaymentOperation) {
    if (operation.cashbackEnabled) {
      operation.cashbackRequestedChange = this.#calculateCashback(operation.newBaseAmount);
      operation.cashbackSendingSucceeded = this.#cashbackDistributorMockConfig.sendCashbackSuccessResult;
      operation.cashbackNonce = this.#cashbackDistributorMockConfig.sendCashbackNonceResult;
      this.#cashbackPerAuthorizationId.set(
        operation.authorizationId,
        { lastCashbackNonce: operation.cashbackNonce }
      );
      if (operation.cashbackSendingSucceeded) {
        operation.cashbackRate = this.#cashbackRateInPermil;
        if (this.#cashbackDistributorMockConfig.sendCashbackAmountResult < 0) {
          operation.cashbackActualChange = operation.cashbackRequestedChange;
        } else {
          operation.cashbackActualChange = this.#cashbackDistributorMockConfig.sendCashbackAmountResult;
        }
      }
    }
    operation.totalAmount = operation.newBaseAmount + operation.newExtraAmount;
    operation.cardPaymentProcessorBalanceChange = operation.newBaseAmount + operation.newExtraAmount;
    operation.userBalanceChange = -operation.cardPaymentProcessorBalanceChange + operation.cashbackActualChange;
    if (operation.sender == operation.account) {
      operation.senderBalanceChange = operation.userBalanceChange;
    }
  }

  #registerPaymentMakingOperation(operation: PaymentOperation, payment: PaymentModel): number {
    payment.compensationAmount = operation.cashbackActualChange;
    let balance = this.#unclearedBalancePerAccount.get(operation.account.address) ?? 0;
    balance += operation.totalAmount;
    this.#unclearedBalancePerAccount.set(operation.account.address, balance);
    this.#totalUnclearedBalance += operation.totalAmount;
    this.#totalBalance += operation.totalAmount;
    this.#paymentPerAuthorizationId.set(payment.authorizationId, payment);
    this.#paymentOperations.push(operation);
    return this.#paymentMakingOperations.push(operation) - 1;
  }

  #calculateCashback(amount: number, cashbackRateInPermil: number = this.#cashbackRateInPermil) {
    return Math.floor(amount * cashbackRateInPermil / 1000);
  }

  #getPaymentByMakingOperationIndex(paymentMakingOperationIndex: number): PaymentModel {
    const paymentOperation: PaymentOperation = this.#paymentMakingOperations[paymentMakingOperationIndex];
    const authorizationId = paymentOperation.authorizationId;
    return this.getPaymentByAuthorizationId(authorizationId);
  }

  #changeBalanceMap(balanceMap: Map<string, number>, mapKey: string, balanceChange: number) {
    let balance = balanceMap.get(mapKey) || 0;
    balance += balanceChange;
    balanceMap.set(mapKey, balance);
  }

  #checkPaymentUpdating(operation: PaymentOperation, payment: PaymentModel) {
    if (payment.status !== PaymentStatus.Uncleared) {
      throw new Error(
        `The payment has inappropriate status: ${payment.status}`
      );
    }
    if (payment.refundAmount > operation.newBaseAmount) {
      throw new Error(
        `The new base amount is wrong for the payment with authorizationId=${payment.authorizationId}.` +
        `The requested new base amount: ${operation.newBaseAmount}. ` +
        `The payment initial base amount: ${payment.baseAmount}. ` +
        `The current payment refund amount: ${payment.refundAmount}`
      );
    }
  }

  #definePaymentUpdatingOperation(operation: PaymentOperation, payment: PaymentModel) {
    const amountDiff =
      operation.newBaseAmount + operation.newExtraAmount - operation.oldBaseAmount - operation.oldExtraAmount;
    if (!payment.cashbackEnabled) {
      operation.userBalanceChange = -amountDiff;
      operation.cardPaymentProcessorBalanceChange = amountDiff;
    } else {
      const cashbackModel = this.getCashbackByAuthorizationId(operation.authorizationId);
      operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
      const oldCashback = this.#calculateCashback(
        operation.oldBaseAmount - payment.refundAmount,
        payment.cashbackRate
      );
      const newCashback = this.#calculateCashback(
        operation.newBaseAmount - payment.refundAmount,
        payment.cashbackRate
      );
      operation.cashbackRequestedChange = newCashback - oldCashback;
      if (newCashback >= oldCashback) {
        operation.cashbackIncreaseRequested = true;
        if (this.#cashbackDistributorMockConfig.increaseCashbackSuccessResult) {
          operation.cashbackIncreaseSuccess = true;
          if (this.#cashbackDistributorMockConfig.increaseCashbackAmountResult < 0) {
            operation.cashbackActualChange = operation.cashbackRequestedChange;
          } else {
            operation.cashbackActualChange = this.#cashbackDistributorMockConfig.increaseCashbackAmountResult;
          }
        }
        operation.userBalanceChange = -amountDiff + operation.cashbackActualChange;
        operation.cardPaymentProcessorBalanceChange = amountDiff;
        operation.compensationAmountChange = operation.cashbackActualChange;
      } else {
        operation.cashbackRevocationRequested = true;
        if (this.#cashbackDistributorMockConfig.revokeCashbackSuccessResult) {
          operation.cashbackRevocationSuccess = true;
          operation.cashbackActualChange = operation.cashbackRequestedChange;
        }
        operation.userBalanceChange = -amountDiff + operation.cashbackRequestedChange;
        operation.cardPaymentProcessorBalanceChange = amountDiff -
          (operation.cashbackRequestedChange - operation.cashbackActualChange);
        operation.compensationAmountChange = operation.cashbackRequestedChange;
      }
    }
  }

  #registerPaymentUpdatingOperation(operation: PaymentOperation, payment: PaymentModel) {
    payment.baseAmount = operation.newBaseAmount;
    payment.extraAmount = operation.newExtraAmount;
    payment.compensationAmount += operation.compensationAmountChange;
    const amountDiff =
      operation.newBaseAmount + operation.newExtraAmount - operation.oldBaseAmount - operation.oldExtraAmount;
    this.#changeBalanceMap(
      this.#unclearedBalancePerAccount,
      operation.account.address,
      amountDiff
    );
    this.#totalUnclearedBalance += amountDiff;
    this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    return this.#paymentOperations.push(operation) - 1;
  }

  #checkPaymentClearing(payment: PaymentModel) {
    if (payment.status !== PaymentStatus.Uncleared) {
      throw new Error(
        `The payment has inappropriate status: ${payment.status}`
      );
    }
  }

  #registerPaymentClearingOperation(operation: PaymentOperation, payment: PaymentModel) {
    this.#changeBalanceMap(this.#unclearedBalancePerAccount, operation.account.address, -operation.totalAmount);
    this.#totalUnclearedBalance -= operation.totalAmount;
    this.#changeBalanceMap(this.#clearedBalancePerAccount, operation.account.address, +operation.totalAmount);
    this.#totalClearedBalance += operation.totalAmount;
    payment.status = PaymentStatus.Cleared;
    operation.unclearedBalance = this.#unclearedBalancePerAccount.get(operation.account.address) ?? 0;
    operation.clearedBalance = this.#clearedBalancePerAccount.get(operation.account.address) ?? 0;
    return this.#paymentOperations.push(operation) - 1;
  }

  #getOperationByIndex(operations: any[], index: number, kind: string): any {
    if (index < 0) {
      index = operations.length + index;
    }
    if (index >= operations.length) {
      throw new Error(
        `A payment ${kind} operation with index ${index} does not exist. `
      );
    }
    return operations[index];
  }

  #checkPaymentUnclearing(payment: PaymentModel) {
    if (payment.status !== PaymentStatus.Cleared) {
      throw new Error(
        `The payment has inappropriate status: ${payment.status}`
      );
    }
  }

  #registerPaymentUnclearingOperation(operation: PaymentOperation, payment: PaymentModel) {
    this.#changeBalanceMap(this.#clearedBalancePerAccount, operation.account.address, -operation.totalAmount);
    this.#totalClearedBalance -= operation.totalAmount;
    this.#changeBalanceMap(this.#unclearedBalancePerAccount, operation.account.address, +operation.totalAmount);
    this.#totalUnclearedBalance += operation.totalAmount;
    payment.status = PaymentStatus.Uncleared;
    operation.unclearedBalance = this.#unclearedBalancePerAccount.get(operation.account.address) ?? 0;
    operation.clearedBalance = this.#clearedBalancePerAccount.get(operation.account.address) ?? 0;
    return this.#paymentOperations.push(operation) - 1;
  }

  #checkPaymentCanceling(payment: PaymentModel) {
    if (!(payment.status === PaymentStatus.Uncleared || payment.status === PaymentStatus.Cleared)) {
      throw new Error(
        `The payment has inappropriate status: ${payment.status}`
      );
    }
  }

  #definePaymentCancelingOperation(operation: PaymentOperation, payment: PaymentModel) {
    operation.userBalanceChange = payment.baseAmount + payment.extraAmount - payment.compensationAmount;
    if (payment.cashbackEnabled) {
      operation.cashbackRevocationRequested = true;
      operation.cashbackRequestedChange = -(operation.totalAmount - operation.userBalanceChange);
      const cashbackModel = this.getCashbackByAuthorizationId(operation.authorizationId);
      operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
      if (this.#cashbackDistributorMockConfig.revokeCashbackSuccessResult) {
        operation.cashbackActualChange = operation.cashbackRequestedChange;
        operation.cashbackRevocationSuccess = true;
      }
    }
    operation.cardPaymentProcessorBalanceChange =
      -(operation.userBalanceChange - operation.cashbackActualChange);
  }

  #updateModelDueToPaymentCancelingOperation(operation: PaymentOperation, payment: PaymentModel) {
    if (operation.paymentStatus === PaymentStatus.Cleared) {
      this.#changeBalanceMap(this.#clearedBalancePerAccount, operation.account.address, -operation.totalAmount);
      this.#totalClearedBalance -= operation.totalAmount;
    } else {
      this.#changeBalanceMap(this.#unclearedBalancePerAccount, operation.account.address, -operation.totalAmount);
      this.#totalUnclearedBalance -= operation.totalAmount;
    }
    operation.unclearedBalance = this.#unclearedBalancePerAccount.get(operation.account.address) ?? 0;
    operation.clearedBalance = this.#clearedBalancePerAccount.get(operation.account.address) ?? 0;
    this.#totalBalance += operation.cardPaymentProcessorBalanceChange;

    payment.compensationAmount = 0;
    payment.refundAmount = 0;
  }

  #registerPaymentRevokingOperation(operation: PaymentOperation, payment: PaymentModel) {
    payment.status = PaymentStatus.Revoked;
    payment.revocationParentTxHashes.push(operation.parentTransactionHash);
    return this.#paymentOperations.push(operation) - 1;
  }

  #registerPaymentReversingOperation(operation: PaymentOperation, payment: PaymentModel) {
    payment.status = PaymentStatus.Reversed;
    payment.reversalParentTxHashes.push(operation.parentTransactionHash);
    return this.#paymentOperations.push(operation) - 1;
  }

  #checkPaymentConfirming(payment: PaymentModel) {
    if (payment.status !== PaymentStatus.Cleared) {
      throw new Error(
        `The payment has inappropriate status: ${payment.status}`
      );
    }
  }

  #registerPaymentConfirmingOperation(operation: PaymentOperation, payment: PaymentModel) {
    this.#changeBalanceMap(this.#clearedBalancePerAccount, operation.account.address, -operation.totalAmount);
    this.#totalClearedBalance -= operation.totalAmount;
    operation.clearedBalance = this.#clearedBalancePerAccount.get(operation.account.address) ?? 0;
    this.#totalBalance -= operation.totalAmount;

    payment.status = PaymentStatus.Confirmed;
    return this.#paymentOperations.push(operation) - 1;
  }

  #checkPaymentRefunding(operation: PaymentOperation, payment: PaymentModel) {
    if (!(
      payment.status === PaymentStatus.Uncleared
      || payment.status === PaymentStatus.Cleared
      || payment.status === PaymentStatus.Confirmed
    )) {
      throw new Error(
        `The payment has inappropriate status: ${payment.status}`
      );
    }
    if (operation.refundAmount > (payment.baseAmount - payment.refundAmount)) {
      throw new Error(
        `The refund amount is wrong for the payment with authorizationId=${payment.authorizationId}.` +
        `The requested amount: ${operation.refundAmount}. ` +
        `The payment initial amount: ${payment.baseAmount}. ` +
        `The current payment refund amount: ${payment.refundAmount}`
      );
    }
    if (operation.newExtraAmount > payment.extraAmount) {
      throw new Error(
        `The new extra amount is wrong for the payment with authorizationId=${payment.authorizationId}.` +
        `The requested new extra amount: ${operation.newExtraAmount}. ` +
        `The payment initial extra amount: ${payment.extraAmount}`
      );
    }
  }

  #definePaymentRefundingOperation(operation: PaymentOperation, payment: PaymentModel) {
    const newRefundAmount = operation.refundAmount + payment.refundAmount;
    operation.userBalanceChange = operation.refundAmount + (operation.oldExtraAmount - operation.newExtraAmount);
    if (payment.cashbackEnabled) {
      operation.cashbackRevocationRequested = true;
      const cashbackModel = this.getCashbackByAuthorizationId(operation.authorizationId);
      operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
      const oldCashback = this.#calculateCashback(
        payment.baseAmount - payment.refundAmount,
        payment.cashbackRate
      );
      const newCashback = this.#calculateCashback(
        payment.baseAmount - newRefundAmount,
        payment.cashbackRate
      );
      const cashbackRevocationAmount = oldCashback - newCashback;
      if (this.#cashbackDistributorMockConfig.revokeCashbackSuccessResult) {
        operation.cashbackActualChange = -cashbackRevocationAmount;
        operation.cashbackRevocationSuccess = true;
      }
      operation.cashbackRequestedChange = -cashbackRevocationAmount;
      operation.userBalanceChange -= cashbackRevocationAmount;
    }
    const serviceBalanceChange = -(operation.userBalanceChange - operation.cashbackRequestedChange);
    if (operation.paymentStatus === PaymentStatus.Confirmed) {
      operation.cardPaymentProcessorBalanceChange =
        operation.cashbackRequestedChange - operation.cashbackActualChange;
      operation.cashOutAccountBalanceChange = serviceBalanceChange;
    } else {
      operation.cardPaymentProcessorBalanceChange = serviceBalanceChange;
    }
    operation.totalAmount = payment.baseAmount + operation.newExtraAmount - newRefundAmount;
    operation.compensationAmountChange = operation.refundAmount + operation.cashbackActualChange;
  }

  #registerPaymentRefundingOperation(operation: PaymentOperation, payment: PaymentModel): number {
    const balanceChange = -operation.refundAmount + (operation.newExtraAmount - payment.extraAmount);
    payment.refundAmount += operation.refundAmount;
    payment.compensationAmount += operation.compensationAmountChange;
    payment.extraAmount = operation.newExtraAmount;
    if (operation.paymentStatus === PaymentStatus.Uncleared) {
      this.#changeBalanceMap(
        this.#unclearedBalancePerAccount,
        operation.account.address,
        balanceChange
      );
      this.#totalUnclearedBalance += balanceChange;
      this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    } else if (operation.paymentStatus == PaymentStatus.Cleared) {
      this.#changeBalanceMap(
        this.#clearedBalancePerAccount,
        operation.account.address,
        balanceChange
      );
      this.#totalClearedBalance += balanceChange;
      this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    } else {
      this.#totalBalance +=
        -(operation.cashbackRequestedChange - operation.cashbackActualChange);
    }
    return this.#paymentOperations.push(operation) - 1;
  }
}

interface OperationResult {
  operationIndex: number,
  tx: Promise<TransactionResponse>,
  txReceipt: TransactionReceipt,
}

class CardPaymentProcessorShell {
  contract: Contract;
  model: CardPaymentProcessorModel;
  executor: SignerWithAddress;

  constructor(props: {
    cardPaymentProcessorContract: Contract,
    cardPaymentProcessorModel: CardPaymentProcessorModel,
    executor: SignerWithAddress,
  }) {
    this.contract = props.cardPaymentProcessorContract;
    this.model = props.cardPaymentProcessorModel;
    this.executor = props.executor;
  }

  async enableCashback() {
    this.model.enableCashback();
    await proveTx(this.contract.enableCashback());
  }

  async disableCashback() {
    this.model.disableCashback();
    await proveTx(this.contract.disableCashback());
  }

  async makePayments(
    payments: TestPayment[],
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (let payment of payments) {
      const operationIndex = this.model.makePayment(payment, sender);
      const tx = this.contract.connect(sender).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
        payment.account.address,
        payment.baseAmount,
        payment.extraAmount,
        payment.authorizationId,
        payment.correlationId,
      );
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt,
      });
      payment.parentTxHash = txReceipt.transactionHash;
    }
    return operationResults;
  }

  async updatePaymentAmount(
    payment: TestPayment,
    newBaseAmount: number,
    newExtraAmount: number = payment.extraAmount,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.updatePaymentAmount(
      newBaseAmount,
      newExtraAmount,
      payment.authorizationId,
      payment.correlationId
    );
    const tx = this.contract.connect(sender).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
      newBaseAmount,
      newExtraAmount,
      payment.authorizationId,
      payment.correlationId
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async clearPayments(
    payments: TestPayment[],
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (let payment of payments) {
      const operationIndex = this.model.clearPayment(payment.authorizationId);
      const tx = this.contract.connect(sender).clearPayment(payment.authorizationId);
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt,
      });
    }
    return operationResults;
  }

  async unclearPayments(
    payments: TestPayment[],
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (let payment of payments) {
      const operationIndex = this.model.unclearPayment(payment.authorizationId);
      const tx = this.contract.connect(sender).unclearPayment(payment.authorizationId);
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt,
      });
    }
    return operationResults;
  }

  async revokePayment(
    payment: TestPayment,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.revokePayment(
      payment.authorizationId,
      payment.correlationId,
      payment.parentTxHash
    );
    const tx = this.contract.connect(sender).revokePayment(
      payment.authorizationId,
      payment.correlationId,
      payment.parentTxHash
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async reversePayment(
    payment: TestPayment,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.reversePayment(
      payment.authorizationId,
      payment.correlationId,
      payment.parentTxHash
    );
    const tx = this.contract.connect(sender).reversePayment(
      payment.authorizationId,
      payment.correlationId,
      payment.parentTxHash
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async confirmPayments(
    payments: TestPayment[],
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (let payment of payments) {
      const operationIndex = this.model.confirmPayment(payment.authorizationId);
      const tx = this.contract.connect(sender).confirmPayment(payment.authorizationId);
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt,
      });
      payment.parentTxHash = txReceipt.transactionHash;
    }
    return operationResults;
  }

  async refundPayment(
    payment: TestPayment,
    refundAmount: number,
    newExtraAmount: number = payment.extraAmount,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.refundPayment(
      refundAmount,
      newExtraAmount,
      payment.authorizationId,
      payment.correlationId
    );
    const tx = this.contract.connect(sender).functions[FUNCTION_REFUND_PAYMENT_FULL](
      refundAmount,
      newExtraAmount,
      payment.authorizationId,
      payment.correlationId
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }
}

class TestContext {
  cashbackDistributorMockConfig: CashbackDistributorMockConfig;
  tokenMock: Contract;
  cardPaymentProcessorShell: CardPaymentProcessorShell;
  cashbackDistributorMockShell: CashbackDistributorMockShell;
  cashOutAccount: SignerWithAddress;
  payments: TestPayment[];

  constructor(props: {
    fixture: Fixture,
    cashbackRateInPermil: number,
    cashOutAccount: SignerWithAddress,
    cardPaymentProcessorExecutor: SignerWithAddress,
    payments: TestPayment[]
  }) {
    this.cashbackDistributorMockConfig = { ...props.fixture.cashbackDistributorMockConfig };
    this.tokenMock = props.fixture.tokenMock;
    this.cashbackDistributorMockShell = new CashbackDistributorMockShell({
      cashbackDistributorMockContract: props.fixture.cashbackDistributorMock,
      cashbackDistributorMockConfig: this.cashbackDistributorMockConfig
    });
    this.cardPaymentProcessorShell = new CardPaymentProcessorShell({
      cardPaymentProcessorContract: props.fixture.cardPaymentProcessor,
      cardPaymentProcessorModel: new CardPaymentProcessorModel({
        cashbackDistributorMockConfig: this.cashbackDistributorMockConfig,
        cashbackRateInPermil: props.cashbackRateInPermil
      }),
      executor: props.cardPaymentProcessorExecutor,
    });
    this.cashOutAccount = props.cashOutAccount;
    this.payments = props.payments;
  }

  async checkPaymentOperationsForTx(tx: Promise<TransactionResponse>, paymentOperationIndexes: number[] = [-1]) {
    const operations: PaymentOperation[] = paymentOperationIndexes.map(
      (index) => this.cardPaymentProcessorShell.model.getPaymentOperation(index)
    );

    for (let operation of operations) {
      switch (operation.kind) {
        case OperationKind.Undefined:
          break;
        case OperationKind.Making:
          await this.checkMakingEvent(tx, operation);
          break;
        case OperationKind.Updating:
          await this.checkUpdatingEvent(tx, operation);
          break;
        case OperationKind.Clearing:
          await this.checkClearingEvent(tx, operation);
          break;
        case OperationKind.Unclearing:
          await this.checkUnclearingEvent(tx, operation);
          break;
        case OperationKind.Revoking:
          await this.checkCancelingEvent(tx, operation, EVENT_NAME_REVOKE_PAYMENT);
          break;
        case OperationKind.Reversing:
          await this.checkCancelingEvent(tx, operation, EVENT_NAME_REVERSE_PAYMENT);
          break;
        case OperationKind.Confirming:
          await this.checkConfirmingEvent(tx, operation);
          break;
        case OperationKind.Refunding:
          await this.checkRefundingEvent(tx, operation);
          break;
      }

      if (operation.newExtraAmount !== operation.oldExtraAmount) {
        await expect(tx).to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_PAYMENT_EXTRA_AMOUNT_CHANGED
        ).withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("account", operation.account.address),
          checkEventField("sumAmount", operation.newBaseAmount + operation.newExtraAmount),
          checkEventField("newExtraAmount", operation.newExtraAmount),
          checkEventField("oldExtraAmount", operation.oldExtraAmount)
        );
      } else {
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_PAYMENT_EXTRA_AMOUNT_CHANGED
        );
      }

      if (operation.kind === OperationKind.Making && operation.cashbackEnabled) {
        await expect(tx).to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_SEND_CASHBACK_MOCK
        ).withArgs(
          checkEventField("sender", this.cardPaymentProcessorShell.contract.address),
          checkEventField("token", this.tokenMock.address),
          checkEventField("kind", CashbackKind.CardPayment),
          checkEventField(
            "externalId",
            operation.authorizationId.padEnd(BYTES32_LENGTH * 2 + 2, "0")
          ),
          checkEventField("recipient", operation.account.address),
          checkEventField("amount", operation.cashbackRequestedChange)
        );
        if (operation.cashbackSendingSucceeded) {
          await expect(tx).to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_SEND_CASHBACK_SUCCESS
          ).withArgs(
            checkEventField("cashbackDistributor", this.cashbackDistributorMockShell.contract.address),
            checkEventField("amount", operation.cashbackActualChange),
            checkEventField("nonce", operation.cashbackNonce)
          );
          await expect(tx).not.to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_SEND_CASHBACK_FAILURE
          );
        } else {
          await expect(tx).to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_SEND_CASHBACK_FAILURE
          ).withArgs(
            checkEventField("cashbackDistributor", this.cashbackDistributorMockShell.contract.address),
            checkEventField("amount", operation.cashbackRequestedChange),
            checkEventField("nonce", operation.cashbackNonce)
          );
          await expect(tx).not.to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_SEND_CASHBACK_SUCCESS
          );
        }
      } else { // !(operation.kind === OperationKind.Making && operation.cashbackEnabled)
        await expect(tx).not.to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_SEND_CASHBACK_MOCK
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_SEND_CASHBACK_SUCCESS
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_SEND_CASHBACK_FAILURE
        );
      }

      if (operation.cashbackRevocationRequested) {
        await expect(tx).to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          checkEventField("sender", this.cardPaymentProcessorShell.contract.address),
          checkEventField("nonce", operation.cashbackNonce),
          checkEventField("amount", -operation.cashbackRequestedChange),
        );

        if (operation.cashbackRevocationSuccess) {
          await expect(tx).to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_REVOKE_CASHBACK_SUCCESS
          ).withArgs(
            checkEventField("cashbackDistributor", this.cashbackDistributorMockShell.contract.address),
            checkEventField("amount", -operation.cashbackActualChange),
            checkEventField("nonce", operation.cashbackNonce)
          );
          await expect(tx).not.to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_REVOKE_CASHBACK_FAILURE
          );
        } else { // !(operation.cashbackRevocationSuccess)
          await expect(tx).to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_REVOKE_CASHBACK_FAILURE
          ).withArgs(
            checkEventField("cashbackDistributor", this.cashbackDistributorMockShell.contract.address),
            checkEventField("amount", -operation.cashbackRequestedChange),
            checkEventField("nonce", operation.cashbackNonce)
          );
          await expect(tx).not.to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_REVOKE_CASHBACK_SUCCESS
          );
        }

        await expect(tx).not.to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_INCREASE_CASHBACK_MOCK
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_INCREASE_CASHBACK_SUCCESS
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_INCREASE_CASHBACK_FAILURE
        );
      } else if (operation.cashbackIncreaseRequested) {
        await expect(tx).to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_INCREASE_CASHBACK_MOCK
        ).withArgs(
          checkEventField("sender", this.cardPaymentProcessorShell.contract.address),
          checkEventField("nonce", operation.cashbackNonce),
          checkEventField("amount", operation.cashbackRequestedChange),
        );

        if (operation.cashbackIncreaseSuccess) {
          await expect(tx).to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_INCREASE_CASHBACK_SUCCESS
          ).withArgs(
            checkEventField("cashbackDistributor", this.cashbackDistributorMockShell.contract.address),
            checkEventField("amount", operation.cashbackActualChange),
            checkEventField("nonce", operation.cashbackNonce)
          );
          await expect(tx).not.to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_INCREASE_CASHBACK_FAILURE
          );
        } else { // !(operation.cashbackIncreaseSuccess)
          await expect(tx).to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_INCREASE_CASHBACK_FAILURE
          ).withArgs(
            checkEventField("cashbackDistributor", this.cashbackDistributorMockShell.contract.address),
            checkEventField("amount", operation.cashbackRequestedChange),
            checkEventField("nonce", operation.cashbackNonce)
          );
          await expect(tx).not.to.emit(
            this.cardPaymentProcessorShell.contract,
            EVENT_NAME_INCREASE_CASHBACK_SUCCESS
          );
        }

        await expect(tx).not.to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_REVOKE_CASHBACK_FAILURE
        );
      } else {  // !(operation.cashbackIncreaseSuccess || operation.cashbackRevocationRequested)
        await expect(tx).not.to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_REVOKE_CASHBACK_FAILURE
        );

        await expect(tx).not.to.emit(
          this.cashbackDistributorMockShell.contract,
          EVENT_NAME_INCREASE_CASHBACK_MOCK
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_INCREASE_CASHBACK_SUCCESS
        );
        await expect(tx).not.to.emit(
          this.cardPaymentProcessorShell.contract,
          EVENT_NAME_INCREASE_CASHBACK_FAILURE
        );
      }
    }

    await this.checkBalanceChanges(tx, operations);
  }

  private async checkBalanceChanges(tx: Promise<TransactionResponse>, operations: PaymentOperation[]) {
    const cardPaymentProcessorBalanceChange = operations
      .map(operation => operation.cardPaymentProcessorBalanceChange)
      .reduce((sum: number, currentValue: number) => sum + currentValue);
    const cashbackDistributorBalanceChange = operations
      .map(operation => -operation.cashbackActualChange)
      .reduce((sum: number, currentValue: number) => sum + currentValue);
    const cashOutAccountBalanceChange = operations
      .map(operation => operation.cashOutAccountBalanceChange)
      .reduce((sum: number, currentValue: number) => sum + currentValue);
    const balanceChangePerUser: Map<SignerWithAddress, number> = this.#getBalanceChangePerAccount(operations);
    const accounts: SignerWithAddress[] = Array.from(balanceChangePerUser.keys());
    const accountBalanceChanges: number[] = accounts.map(user => balanceChangePerUser.get(user) ?? 0);


    await expect(tx).to.changeTokenBalances(
      this.tokenMock,
      [
        this.cardPaymentProcessorShell.contract,
        this.cashbackDistributorMockShell.contract,
        this.cashOutAccount,
        ...accounts
      ],
      [
        cardPaymentProcessorBalanceChange,
        cashbackDistributorBalanceChange,
        cashOutAccountBalanceChange,
        ...accountBalanceChanges
      ]
    );
  }

  async checkCardPaymentProcessorState() {
    await this.#checkPaymentStructures();
    await this.#checkCashbacks();
    await this.#checkClearedAndUnclearedBalances();
    await this.#checkTokenBalance();
  }

  async setUpContractsForPayments(payments: TestPayment[] = this.payments) {
    const accounts: Set<SignerWithAddress> = new Set(payments.map(payment => payment.account));
    for (let account of accounts) {
      await proveTx(this.tokenMock.mint(account.address, INITIAL_USER_BALANCE));
      const allowance: BigNumber = await this.tokenMock.allowance(
        account.address,
        this.cardPaymentProcessorShell.contract.address
      );
      if (allowance.lt(MAX_UINT256)) {
        await proveTx(
          this.tokenMock.connect(account).approve(
            this.cardPaymentProcessorShell.contract.address,
            MAX_UINT256
          )
        );
      }
    }
  }

  async checkMakingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_MAKE_PAYMENT
    ).withArgs(
      checkEventField("authorizationId", operation.authorizationId),
      checkEventField("correlationId", operation.correlationId),
      checkEventField("account", operation.account.address),
      checkEventField("sumAmount", operation.newBaseAmount + operation.newExtraAmount),
      checkEventField("revocationCounter", operation.revocationCounter),
      checkEventField("sender", operation.sender?.address)
    );
  }

  async checkUpdatingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_UPDATE_PAYMENT_AMOUNT
    ).withArgs(
      checkEventField("authorizationId", operation.authorizationId),
      checkEventField("correlationId", operation.correlationId),
      checkEventField("account", operation.account.address),
      checkEventField("oldSumAmount", operation.oldBaseAmount + operation.oldExtraAmount),
      checkEventField("newSumAmount", operation.newBaseAmount + operation.newExtraAmount),
    );
  }

  async checkClearingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_CLEAR_PAYMENT
    ).withArgs(
      checkEventField("authorizationId", operation.authorizationId),
      checkEventField("account", operation.account.address),
      checkEventField("totalAmount", operation.totalAmount),
      checkEventField("clearedBalance", operation.clearedBalance),
      checkEventField("unclearedBalance", operation.unclearedBalance),
      checkEventField("revocationCounter", operation.revocationCounter)
    );
  }

  async checkUnclearingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_UNCLEAR_PAYMENT
    ).withArgs(
      checkEventField("authorizationId", operation.authorizationId),
      checkEventField("account", operation.account.address),
      checkEventField("totalAmount", operation.totalAmount),
      checkEventField("clearedBalance", operation.clearedBalance),
      checkEventField("unclearedBalance", operation.unclearedBalance),
      checkEventField("revocationCounter", operation.revocationCounter)
    );
  }

  async checkCancelingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation, eventName: string) {
    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      eventName
    ).withArgs(
      checkEventField("authorizationId", operation.authorizationId),
      checkEventField("correlationId", operation.correlationId),
      checkEventField("account", operation.account.address),
      checkEventField("sentAmount", operation.userBalanceChange),
      checkEventField("clearedBalance", operation.clearedBalance),
      checkEventField("unclearedBalance", operation.unclearedBalance),
      checkEventField("wasPaymentCleared", operation.paymentStatus === PaymentStatus.Cleared),
      checkEventField("parentTransactionHash", operation.parentTransactionHash),
      checkEventField("revocationCounter", operation.revocationCounter)
    );
  }

  async checkConfirmingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_CONFIRM_PAYMENT
    ).withArgs(
      checkEventField("authorizationId", operation.authorizationId),
      checkEventField("account", operation.account.address),
      checkEventField("totalAmount", operation.totalAmount),
      checkEventField("clearedBalance", operation.clearedBalance),
      checkEventField("revocationCounter", operation.revocationCounter)
    );
  }

  async checkRefundingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_REFUND_PAYMENT
    ).withArgs(
      checkEventField("authorizationId", operation.authorizationId),
      checkEventField("correlationId", operation.correlationId),
      checkEventField("account", operation.account.address),
      checkEventField("refundAmount", operation.refundAmount),
      checkEventField("sentAmount", operation.userBalanceChange),
      checkEventField("status", operation.paymentStatus)
    );
  }

  async #checkPaymentStructures() {
    const expectedPayments: PaymentModel[] = this.cardPaymentProcessorShell.model.getPaymentModelsInMakingOrder();
    const paymentNumber = expectedPayments.length;
    const checkedAuthorizationIds: Set<string> = new Set();
    for (let i = 0; i < paymentNumber; ++i) {
      const expectedPayment: PaymentModel = expectedPayments[i];
      if (checkedAuthorizationIds.has(expectedPayment.authorizationId)) {
        continue;
      }
      checkedAuthorizationIds.add(expectedPayment.authorizationId);
      const actualPayment = await this.cardPaymentProcessorShell.contract.paymentFor(expectedPayment.authorizationId);
      this.#checkPaymentsEquality(actualPayment, expectedPayment, i);
      if (expectedPayment.revocationParentTxHashes.length > 0) {
        await this.#checkPaymentRevocationsByParentHashes(expectedPayment.revocationParentTxHashes);
      }
      if (expectedPayment.reversalParentTxHashes.length > 0) {
        expect(expectedPayment.reversalParentTxHashes.length).to.lessThanOrEqual(
          1,
          `The reversal count of a payment with the authorization ID ${expectedPayment.authorizationId} is wrong`
        );
        await this.#checkPaymentReversalsByParentHashes(expectedPayment.reversalParentTxHashes);
      }
    }
  }

  #checkPaymentsEquality(actualOnChainPayment: any, expectedPayment: PaymentModel, paymentIndex: number) {
    expect(actualOnChainPayment.account).to.equal(
      expectedPayment.account.address,
      `payment[${paymentIndex}].account is wrong`
    );
    expect(actualOnChainPayment.baseAmount).to.equal(
      expectedPayment.baseAmount,
      `payment[${paymentIndex}].baseAmount is wrong`
    );
    expect(actualOnChainPayment.extraAmount).to.equal(
      expectedPayment.extraAmount,
      `payment[${paymentIndex}].extraAmount is wrong`
    );
    expect(actualOnChainPayment.status).to.equal(
      expectedPayment.status,
      `payment[${paymentIndex}].status is wrong`
    );
    expect(actualOnChainPayment.revocationCounter).to.equal(
      expectedPayment.revocationParentTxHashes.length,
      `payment[${paymentIndex}].revocationCounter is wrong`
    );
    expect(actualOnChainPayment.compensationAmount).to.equal(
      (expectedPayment.compensationAmount),
      `payment[${paymentIndex}].compensationAmount is wrong`
    );
    expect(actualOnChainPayment.refundAmount).to.equal(
      expectedPayment.refundAmount,
      `payment[${paymentIndex}].refundAmount is wrong`
    );
    expect(actualOnChainPayment.cashbackRate).to.equal(
      expectedPayment.cashbackRate,
      `payment[${paymentIndex}].cashbackRate is wrong`
    );
  }

  async #checkPaymentRevocationsByParentHashes(revocationParentTxHashes: string[]) {
    const revocationCount = revocationParentTxHashes.length;
    for (let index = 0; index < revocationCount; ++index) {
      const parentTxHash = revocationParentTxHashes[index];
      expect(
        await this.cardPaymentProcessorShell.contract.isPaymentRevoked(parentTxHash)
      ).to.equal(
        true,
        `The result of the "isPaymentRevoked()" function is wrong for parentTxHash=${parentTxHash} and` +
        `the revocation index is ${index}`
      );
    }
  }

  async #checkPaymentReversalsByParentHashes(reversalParentTxHashes: string[]) {
    const reversalCount = reversalParentTxHashes.length;
    for (let index = 0; index < reversalCount; ++index) {
      const parentTxHash = reversalParentTxHashes[index];
      expect(
        await this.cardPaymentProcessorShell.contract.isPaymentReversed(parentTxHash)
      ).to.equal(
        true,
        `The result of the "isPaymentReversed()" function is wrong for parentTxHash=${parentTxHash} and` +
        `the reversal index is ${index}`
      );
    }
  }

  async #checkCashbacks() {
    const authorizationIds: Set<string> = this.cardPaymentProcessorShell.model.getAuthorizationIds();
    for (const authorizationId of authorizationIds) {
      const expectedCashback = this.cardPaymentProcessorShell.model.getCashbackByAuthorizationId(authorizationId);
      const actualCashback = await this.cardPaymentProcessorShell.contract.getCashback(authorizationId);
      const note = `The last cashback nonce of a payment with authorizationId=${authorizationId} is wrong`;
      if (!expectedCashback) {
        expect(actualCashback.lastCashbackNonce).to.equal(ethers.constants.Zero, note);
      } else {
        expect(actualCashback.lastCashbackNonce).to.equal(expectedCashback.lastCashbackNonce, note);
      }
    }
  }

  async #checkClearedAndUnclearedBalances() {
    const accountAddresses: Set<string> = this.cardPaymentProcessorShell.model.getAccountAddresses();

    for (const account of accountAddresses) {
      const expectedBalance = this.cardPaymentProcessorShell.model.getAccountUnclearedBalance(account);
      const actualBalance = await this.cardPaymentProcessorShell.contract.unclearedBalanceOf(account);
      expect(actualBalance).to.equal(
        expectedBalance,
        `The uncleared balance for account ${account} is wrong`
      );
    }

    for (const account of accountAddresses) {
      const expectedBalance = this.cardPaymentProcessorShell.model.getAccountClearedBalance(account);
      const actualBalance = await this.cardPaymentProcessorShell.contract.clearedBalanceOf(account);
      expect(actualBalance).to.equal(
        expectedBalance,
        `The cleared balance for account ${account} is wrong`
      );
    }

    expect(await this.cardPaymentProcessorShell.contract.totalUnclearedBalance()).to.equal(
      this.cardPaymentProcessorShell.model.totalUnclearedBalance,
      `The total uncleared balance is wrong`
    );

    expect(await this.cardPaymentProcessorShell.contract.totalClearedBalance()).to.equal(
      this.cardPaymentProcessorShell.model.totalClearedBalance,
      `The total cleared balance is wrong`
    );
  }

  async #checkTokenBalance() {
    expect(
      await this.tokenMock.balanceOf(this.cardPaymentProcessorShell.contract.address)
    ).to.equal(
      this.cardPaymentProcessorShell.model.totalBalance,
      `The card payment processor token balance is wrong`
    );
  }

  #getBalanceChangePerAccount(operations: PaymentOperation[]) {
    const result: Map<SignerWithAddress, number> = new Map();
    operations.forEach(operation => {
      let balanceChange: number = result.get(operation.account) ?? 0;
      balanceChange += operation.userBalanceChange;
      result.set(operation.account, balanceChange);
    });
    return result;
  }
}

function increaseBytesString(bytesString: string, targetLength: number) {
  return createBytesString(
    parseInt(bytesString.substring(2), 16) + 1,
    targetLength
  );
}

async function setUpFixture(func: any) {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'CardPaymentProcessor'", async () => {
  const REVOCATION_LIMIT = 123;
  const REVOCATION_LIMIT_DEFAULT_VALUE = 255;
  const ZERO_AUTHORIZATION_ID: string = createBytesString("00", BYTES16_LENGTH);
  const PAYMENT_REFUNDING_CORRELATION_ID_STUB: string = createBytesString("C01", BYTES16_LENGTH);
  const PAYMENT_REVERSING_CORRELATION_ID_STUB: string = createBytesString("C02", BYTES16_LENGTH);
  const PAYMENT_REVOKING_CORRELATION_ID_STUB: string = createBytesString("C03", BYTES16_LENGTH);
  const PAYMENT_UPDATING_CORRELATION_ID_STUB: string = createBytesString("C04", BYTES16_LENGTH);
  const CASHBACK_DISTRIBUTOR_ADDRESS_STUB1 = "0x0000000000000000000000000000000000000001";
  const CASHBACK_DISTRIBUTOR_ADDRESS_STUB2 = "0x0000000000000000000000000000000000000002";
  const MAX_CASHBACK_RATE_IN_PERMIL = 250; // 25%
  const CASHBACK_RATE_IN_PERMIL = 100; // 10%
  const CASHBACK_NONCE = 111222333;

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_TOKEN_ADDRESS_IZ_ZERO = "ZeroTokenAddress";
  const REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED = "BlacklistedAccount";
  const REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST = "PaymentNotExist";
  const REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS = "PaymentAlreadyExists";
  const REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED = "PaymentAlreadyCleared";
  const REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED = "PaymentAlreadyUncleared";
  const REVERT_ERROR_IF_PAYMENT_ACCOUNT_IS_ZERO = "ZeroAccount";
  const REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO = "ZeroAuthorizationId";
  const REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS = "InappropriatePaymentStatus";
  const REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT = "RevocationLimitReached";
  const REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY = "EmptyAuthorizationIdsArray";
  const REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_UNCHANGED = "CashOutAccountUnchanged";
  const REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO = "ZeroParentTransactionHash";
  const REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_IS_ZERO = "CashbackDistributorZeroAddress";
  const REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_IS_ALREADY_CONFIGURED = "CashbackDistributorAlreadyConfigured";
  const REVERT_ERROR_IF_CASHBACK_RATE_EXCESS = "CashbackRateExcess";
  const REVERT_ERROR_IF_CASHBACK_RATE_UNCHANGED = "CashbackRateUnchanged";
  const REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_NOT_CONFIGURED = "CashbackDistributorNotConfigured";
  const REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED = "CashbackAlreadyEnabled";
  const REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED = "CashbackAlreadyDisabled";
  const REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO = "ZeroCashOutAccount";
  const REVERT_ERROR_IF_REFUND_AMOUNT_IS_INAPPROPRIATE = "InappropriateRefundAmount";
  const REVERT_ERROR_IF_NEW_BASE_PAYMENT_AMOUNT_IS_INAPPROPRIATE = "InappropriateNewBasePaymentAmount";
  const REVERT_ERROR_IF_NEW_EXTRA_PAYMENT_AMOUNT_IS_INAPPROPRIATE = "InappropriateNewExtraPaymentAmount";

  const ownerRole: string = ethers.utils.id("OWNER_ROLE");
  const blacklisterRole: string = ethers.utils.id("BLACKLISTER_ROLE");
  const pauserRole: string = ethers.utils.id("PAUSER_ROLE");
  const rescuerRole: string = ethers.utils.id("RESCUER_ROLE");
  const executorRole: string = ethers.utils.id("EXECUTOR_ROLE");

  let cardPaymentProcessorFactory: ContractFactory;
  let cashbackDistributorMockFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let cashOutAccount: SignerWithAddress;
  let executor: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  before(async () => {
    cardPaymentProcessorFactory = await ethers.getContractFactory("CardPaymentProcessor");
    cashbackDistributorMockFactory = await ethers.getContractFactory("CashbackDistributorMock");
    tokenMockFactory = await ethers.getContractFactory("ERC20UpgradeableMock");

    [deployer, cashOutAccount, executor, user1, user2] = await ethers.getSigners();
  });

  async function deployTokenMock(): Promise<{ tokenMock: Contract }> {
    const name = "ERC20 Test";
    const symbol = "TEST";

    const tokenMock: Contract = await upgrades.deployProxy(tokenMockFactory, [name, symbol]);
    await tokenMock.deployed();

    return { tokenMock };
  }

  async function deployTokenMockAndCardPaymentProcessor(): Promise<{
    cardPaymentProcessor: Contract,
    tokenMock: Contract
  }> {
    const { tokenMock } = await deployTokenMock();

    const cardPaymentProcessor: Contract = await upgrades.deployProxy(
      cardPaymentProcessorFactory,
      [tokenMock.address]
    );
    await cardPaymentProcessor.deployed();

    return {
      cardPaymentProcessor,
      tokenMock
    };
  }

  async function deployCashbackDistributorMock(): Promise<{
    cashbackDistributorMock: Contract,
    cashbackDistributorMockConfig: CashbackDistributorMockConfig
  }> {
    const cashbackDistributorMockConfig: CashbackDistributorMockConfig = {
      sendCashbackSuccessResult: true,
      sendCashbackAmountResult: -1,
      sendCashbackNonceResult: CASHBACK_NONCE,
      revokeCashbackSuccessResult: true,
      increaseCashbackSuccessResult: true,
      increaseCashbackAmountResult: -1,
    };

    const cashbackDistributorMock: Contract = await cashbackDistributorMockFactory.deploy(
      cashbackDistributorMockConfig.sendCashbackSuccessResult,
      cashbackDistributorMockConfig.sendCashbackAmountResult,
      cashbackDistributorMockConfig.sendCashbackNonceResult,
      cashbackDistributorMockConfig.revokeCashbackSuccessResult,
      cashbackDistributorMockConfig.increaseCashbackSuccessResult,
      cashbackDistributorMockConfig.increaseCashbackAmountResult
    );
    await cashbackDistributorMock.deployed();

    return {
      cashbackDistributorMock,
      cashbackDistributorMockConfig
    };
  }

  async function deployAndConfigureAllContracts(): Promise<Fixture> {
    const { cardPaymentProcessor, tokenMock } = await deployTokenMockAndCardPaymentProcessor();
    const { cashbackDistributorMock, cashbackDistributorMockConfig } = await deployCashbackDistributorMock();

    await proveTx(cardPaymentProcessor.grantRole(executorRole, executor.address));
    await proveTx(cardPaymentProcessor.setCashbackDistributor(cashbackDistributorMock.address));
    await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL));

    await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
    await proveTx(tokenMock.connect(cashOutAccount).approve(cardPaymentProcessor.address, MAX_UINT256));

    await proveTx(tokenMock.mint(cashbackDistributorMock.address, MAX_INT256));

    return {
      cardPaymentProcessor,
      tokenMock,
      cashbackDistributorMock,
      cashbackDistributorMockConfig
    };
  }

  async function pauseContract(contract: Contract) {
    await proveTx(contract.grantRole(pauserRole, deployer.address));
    await proveTx(contract.pause());
  }

  function createTestPayments(numberOfPayments: number = 1): TestPayment[] {
    const testPayments: TestPayment[] = [];
    for (let i = 0; i < numberOfPayments; ++i) {
      const payment: TestPayment = {
        account: (i % 2 > 0) ? user1 : user2,
        baseAmount: 235 + i * 235,
        extraAmount: 235 + i * 235,
        authorizationId: createBytesString(123 + i * 123, BYTES16_LENGTH),
        correlationId: createBytesString(345 + i * 345, BYTES16_LENGTH),
        parentTxHash: createBytesString(1 + i, BYTES32_LENGTH),
      };
      testPayments.push(payment);
    }
    return testPayments;
  }

  async function prepareForPayments(props: { paymentNumber: number } = { paymentNumber: 1 }): Promise<TestContext> {
    const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
    const payments = createTestPayments(props.paymentNumber);
    return new TestContext({
      fixture,
      cashbackRateInPermil: CASHBACK_RATE_IN_PERMIL,
      cashOutAccount,
      cardPaymentProcessorExecutor: executor,
      payments,
    });
  }

  async function beforeMakingPayments(props: { paymentNumber: number } = { paymentNumber: 1 }): Promise<TestContext> {
    const context = await prepareForPayments(props);
    await context.setUpContractsForPayments();
    return context;
  }

  describe("Function 'initialize()'", async () => {
    it("Configures the contract as expected", async () => {
      const { cardPaymentProcessor, tokenMock } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);

      // The underlying contract address
      expect(await cardPaymentProcessor.underlyingToken()).to.equal(tokenMock.address);

      // The revocation limit
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(REVOCATION_LIMIT_DEFAULT_VALUE);

      // The admins of roles
      expect(await cardPaymentProcessor.getRoleAdmin(ownerRole)).to.equal(ownerRole);
      expect(await cardPaymentProcessor.getRoleAdmin(blacklisterRole)).to.equal(ownerRole);
      expect(await cardPaymentProcessor.getRoleAdmin(pauserRole)).to.equal(ownerRole);
      expect(await cardPaymentProcessor.getRoleAdmin(rescuerRole)).to.equal(ownerRole);
      expect(await cardPaymentProcessor.getRoleAdmin(executorRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await cardPaymentProcessor.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await cardPaymentProcessor.hasRole(blacklisterRole, deployer.address)).to.equal(false);
      expect(await cardPaymentProcessor.hasRole(pauserRole, deployer.address)).to.equal(false);
      expect(await cardPaymentProcessor.hasRole(rescuerRole, deployer.address)).to.equal(false);
      expect(await cardPaymentProcessor.hasRole(executorRole, deployer.address)).to.equal(false);

      // The initial contract state is unpaused
      expect(await cardPaymentProcessor.paused()).to.equal(false);

      // Cashback related values
      expect(await cardPaymentProcessor.cashbackDistributor()).to.equal(ZERO_ADDRESS);
      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(false);
      expect(await cardPaymentProcessor.cashbackRate()).to.equal(0);
      expect(await cardPaymentProcessor.MAX_CASHBACK_RATE_IN_PERMIL()).to.equal(MAX_CASHBACK_RATE_IN_PERMIL);

      // The cash-out account
      expect(await cardPaymentProcessor.cashOutAccount()).to.equal(ZERO_ADDRESS);
    });

    it("Is reverted if it is called a second time", async () => {
      const { cardPaymentProcessor, tokenMock } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.initialize(tokenMock.address)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("Is reverted if the passed token address is zero", async () => {
      const anotherCardPaymentProcessor: Contract =
        await upgrades.deployProxy(cardPaymentProcessorFactory, [], { initializer: false });

      await expect(
        anotherCardPaymentProcessor.initialize(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(cardPaymentProcessorFactory, REVERT_ERROR_IF_TOKEN_ADDRESS_IZ_ZERO);
    });
  });

  describe("Function 'setRevocationLimit()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(REVOCATION_LIMIT_DEFAULT_VALUE);

      await expect(
        cardPaymentProcessor.setRevocationLimit(REVOCATION_LIMIT)
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_REVOCATION_LIMIT
      ).withArgs(
        REVOCATION_LIMIT_DEFAULT_VALUE,
        REVOCATION_LIMIT
      );
    });

    it("Does not emit an event if the new value equals the old one", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setRevocationLimit(REVOCATION_LIMIT_DEFAULT_VALUE)
      ).not.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_REVOCATION_LIMIT
      );
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.connect(user1).setRevocationLimit(REVOCATION_LIMIT)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });
  });

  describe("Function 'setCashbackDistributor()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor, tokenMock } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      expect(
        await tokenMock.allowance(cardPaymentProcessor.address, CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.equal(0);

      await expect(
        cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_CASHBACK_DISTRIBUTOR
      ).withArgs(
        ZERO_ADDRESS,
        CASHBACK_DISTRIBUTOR_ADDRESS_STUB1
      );

      expect(await cardPaymentProcessor.cashbackDistributor()).to.equal(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1);
      expect(
        await tokenMock.allowance(cardPaymentProcessor.address, CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.equal(MAX_UINT256);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.connect(user1).setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new cashback distributor address is zero", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setCashbackDistributor(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_IS_ZERO);
    });

    it("Is reverted if the cashback distributor has been already configured", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));

      await expect(
        cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB2)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_IS_ALREADY_CONFIGURED);
    });
  });

  describe("Function 'setCashbackRate()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);

      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_CASHBACK_RATE
      ).withArgs(
        0,
        CASHBACK_RATE_IN_PERMIL
      );

      expect(await cardPaymentProcessor.cashbackRate()).to.equal(CASHBACK_RATE_IN_PERMIL);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.connect(user1).setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new rate exceeds the allowable maximum", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setCashbackRate(MAX_CASHBACK_RATE_IN_PERMIL + 1)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_RATE_EXCESS);
    });

    it("Is reverted if called with the same argument twice", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL));

      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_RATE_UNCHANGED);
    });
  });

  describe("Function 'enableCashback()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));

      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_ENABLE_CASHBACK
      );

      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(true);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.connect(user1).enableCashback()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the cashback distributor was not configured", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_NOT_CONFIGURED);
    });

    it("Is reverted if the cashback operations are already enabled", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));
      await proveTx(cardPaymentProcessor.enableCashback());

      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED);
    });
  });

  describe("Function 'disableCashback()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));
      await proveTx(cardPaymentProcessor.enableCashback());
      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(true);

      await expect(
        cardPaymentProcessor.disableCashback()
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_DISABLE_CASHBACK
      );

      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(false);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.connect(user1).disableCashback()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the cashback operations are already disabled", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.disableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED);
    });
  });

  describe("Function 'setCashOutAccount()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);

      await expect(
        cardPaymentProcessor.setCashOutAccount(cashOutAccount.address)
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_CASH_OUT_ACCOUNT
      ).withArgs(
        ZERO_ADDRESS,
        cashOutAccount.address
      );

      expect(await cardPaymentProcessor.cashOutAccount()).to.equal(cashOutAccount.address);

      // Can set the zero address
      await expect(
        cardPaymentProcessor.setCashOutAccount(ZERO_ADDRESS)
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_CASH_OUT_ACCOUNT
      ).withArgs(
        cashOutAccount.address,
        ZERO_ADDRESS
      );

      expect(await cardPaymentProcessor.cashOutAccount()).to.equal(ZERO_ADDRESS);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.connect(user1).setCashOutAccount(cashOutAccount.address)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new cash-out account is the same as the previous set one", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setCashOutAccount(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_UNCHANGED);

      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));

      await expect(
        cardPaymentProcessor.setCashOutAccount(cashOutAccount.address)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_UNCHANGED);
    });
  });

  describe("Function 'makePayment()' with the extra amount parameter", async () => {
    /* Because the functions 'makePayment()' and 'makePaymentFrom()' use the same common internal function to execute,
     * the main checks of the functions are provided in the section for the 'makePaymentFrom()' function.
     * In this section, only specific checks for the 'makePayment()' function are provided.
     */
    describe("Executes as expected if the cashback is enabled and the base and extra payment amounts are", async () => {
      it("Both nonzero", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();

        cardPaymentProcessorShell.model.makePayment(context.payments[0], context.payments[0].account);
        const tx = cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_FULL](
          payment.baseAmount,
          payment.extraAmount,
          payment.authorizationId,
          payment.correlationId
        );
        expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
        await context.checkPaymentOperationsForTx(tx);
        await context.checkCardPaymentProcessorState();
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller is blacklisted", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await proveTx(cardPaymentProcessorShell.contract.grantRole(blacklisterRole, deployer.address));
        await proveTx(cardPaymentProcessorShell.contract.blacklist(payment.account.address));

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
      });
    });
  });

  describe("Function 'makePayment()' with no extra amount parameter", async () => {
    describe("Executes as expected if the cashback is enabled and the payment amount is", async () => {
      it("Nonzero", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();

        payment.extraAmount = 0;
        cardPaymentProcessorShell.model.makePayment(payment, payment.account);
        const tx = cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_PRUNED](
          payment.baseAmount,
          payment.authorizationId,
          payment.correlationId
        );
        expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
        await context.checkPaymentOperationsForTx(tx);
        await context.checkCardPaymentProcessorState();
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller is blacklisted", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await proveTx(cardPaymentProcessorShell.contract.grantRole(blacklisterRole, deployer.address));
        await proveTx(cardPaymentProcessorShell.contract.blacklist(payment.account.address));

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
      });
    });
  });

  describe("Function 'makePaymentFrom()' with the extra amount parameter", async () => {

    async function checkPaymentMakingFromWithCashback(context: TestContext) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();

      cardPaymentProcessorShell.model.makePayment(payment, executor);
      const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
        payment.account.address,
        payment.baseAmount,
        payment.extraAmount,
        payment.authorizationId,
        payment.correlationId
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if the cashback is enabled and the base and extra payment amounts are", async () => {
      it("Both nonzero", async () => {
        const context = await beforeMakingPayments();
        await checkPaymentMakingFromWithCashback(context);
      });

      it("Both zero", async () => {
        const context = await beforeMakingPayments();
        context.payments[0].baseAmount = 0;
        context.payments[0].extraAmount = 0;
        await checkPaymentMakingFromWithCashback(context);
      });

      it("Different: base is zero, extra is nonzero", async () => {
        const context = await beforeMakingPayments();
        context.payments[0].baseAmount = 0;
        await checkPaymentMakingFromWithCashback(context);
      });

      it("Different: base is nonzero, extra is zero", async () => {
        const context = await beforeMakingPayments();
        context.payments[0].extraAmount = 0;
        await checkPaymentMakingFromWithCashback(context);
      });

      it("Both nonzero even if the revocation limit of payments is zero", async () => {
        const context = await beforeMakingPayments();
        await proveTx(context.cardPaymentProcessorShell.contract.setRevocationLimit(0));
        await checkPaymentMakingFromWithCashback(context);
      });

      it("Both nonzero and if cashback is partially sent with non-zero amount", async () => {
        const context = await beforeMakingPayments();
        const sentCashbackAmount = 1;
        await context.cashbackDistributorMockShell.setSendCashbackAmountResult(sentCashbackAmount);
        await checkPaymentMakingFromWithCashback(context);
      });

      it("Nonzero and if cashback is partially sent with zero amount", async () => {
        const context = await beforeMakingPayments();
        const sentCashbackAmount = 0;
        await context.cashbackDistributorMockShell.setSendCashbackAmountResult(sentCashbackAmount);
        await checkPaymentMakingFromWithCashback(context);
      });
    });

    describe("Executes as expected if if the payment base and extra amounts are nonzero and", async () => {
      it("Cashback is disabled", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        cardPaymentProcessorShell.model.makePayment(payment, executor);
        const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
          payment.account.address,
          payment.baseAmount,
          payment.extraAmount,
          payment.authorizationId,
          payment.correlationId
        );
        expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
        await context.checkPaymentOperationsForTx(tx);
        await context.checkCardPaymentProcessorState();
      });

      it("Cashback sending fails", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, cashbackDistributorMockShell, payments: [payment] } = context;

        await cashbackDistributorMockShell.setSendCashbackSuccessResult(false);
        await cardPaymentProcessorShell.enableCashback();

        cardPaymentProcessorShell.model.makePayment(payment, executor);
        const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
          payment.account.address,
          payment.baseAmount,
          payment.extraAmount,
          payment.authorizationId,
          payment.correlationId
        );
        expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
        await context.checkPaymentOperationsForTx(tx);
        await context.checkCardPaymentProcessorState();
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(payment.account.address, executorRole));
      });

      it("The payment account address is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
            ZERO_ADDRESS,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ACCOUNT_IS_ZERO);
      });

      it("The payment authorization ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            ZERO_AUTHORIZATION_ID,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
        );
      });

      it("The account has not enough token balance", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        const excessTokenAmount: number = INITIAL_USER_BALANCE + 1;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
            payment.account.address,
            excessTokenAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("The payment with the provided authorization ID already exists", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makePayments([payment]);

        const anotherCorrelationId: string = increaseBytesString(payment.correlationId, BYTES16_LENGTH);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            anotherCorrelationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
      });
    });
  });

  describe("Function 'makePaymentFrom()' with no extra amount parameter", async () => {

    describe("Executes as expected if the cashback is enabled and the payment amounts is", async () => {
      it("Nonzero", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();

        payment.extraAmount = 0;
        cardPaymentProcessorShell.model.makePayment(payment, executor);
        const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_PRUNED](
          payment.account.address,
          payment.baseAmount,
          payment.authorizationId,
          payment.correlationId
        );
        expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
        await context.checkPaymentOperationsForTx(tx);
        await context.checkCardPaymentProcessorState();
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_PRUNED](
            payment.account.address,
            payment.baseAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.account).functions[FUNCTION_MAKE_PAYMENT_FROM_PRUNED](
            payment.account.address,
            payment.baseAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(payment.account.address, executorRole));
      });

      it("The payment account address is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_PRUNED](
            ZERO_ADDRESS,
            payment.baseAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ACCOUNT_IS_ZERO);
      });
    });
  });

  describe("Function 'updatePaymentAmount()' with the extra amount parameter", async () => {
    enum NewBasePaymentAmountType {
      Same = 0,
      Less = 1,
      More = 2,
    }

    enum NewExtraPaymentAmountType {
      Same = 0,
      FarLess = 1,
      FarMore = 2,
      SlightlyLess = 3,
      SlightlyMore = 4,
      Zero = 5,
    }

    enum UpdatingConditionType {
      CashbackEnabled = 0,
      CashbackDisabledBeforePaymentMaking = 1,
      CashbackDisabledAfterPaymentMaking = 2,
      CashbackEnabledButRevokingFails = 3,
      CashbackEnabledButIncreasingFails = 4,
      CashbackEnabledButIncreasingPartial = 5,
    }

    async function checkUpdating(
      newBasePaymentAmountType: NewBasePaymentAmountType,
      newExtraPaymentAmountType: NewExtraPaymentAmountType,
      updatingCondition: UpdatingConditionType
    ) {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      payment.baseAmount = 1234;
      payment.extraAmount = 1234;

      if (updatingCondition !== UpdatingConditionType.CashbackDisabledBeforePaymentMaking) {
        await cardPaymentProcessorShell.enableCashback();
      }
      await cardPaymentProcessorShell.makePayments([payment]);
      if (updatingCondition === UpdatingConditionType.CashbackDisabledAfterPaymentMaking) {
        await cardPaymentProcessorShell.disableCashback();
      }

      let newBaseAmount = payment.baseAmount;
      switch (newBasePaymentAmountType) {
        case NewBasePaymentAmountType.Less:
          newBaseAmount = Math.floor(payment.baseAmount * 0.5);
          break;
        case NewBasePaymentAmountType.More:
          newBaseAmount = Math.floor(payment.baseAmount * 2);
          break;
      }

      let newExtraAmount = payment.extraAmount;
      switch (newExtraPaymentAmountType) {
        case NewExtraPaymentAmountType.FarLess:
          newExtraAmount = Math.floor(payment.extraAmount * 0.5);
          break;
        case NewExtraPaymentAmountType.FarMore:
          newExtraAmount = Math.floor(payment.extraAmount * 2);
          break;
        case NewExtraPaymentAmountType.SlightlyLess:
          newExtraAmount = payment.extraAmount - 1;
          break;
        case NewExtraPaymentAmountType.SlightlyMore:
          newExtraAmount = payment.extraAmount + 1;
          break;
        case NewExtraPaymentAmountType.Zero:
          newExtraAmount = 0;
          break;
      }

      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      await context.checkCardPaymentProcessorState();

      if (
        updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingPartial
        && newBasePaymentAmountType === NewBasePaymentAmountType.More
      ) {
        const actualCashbackChange = 1;
        await context.cashbackDistributorMockShell.setIncreaseCashbackAmountResult(actualCashbackChange);
      }

      if (updatingCondition === UpdatingConditionType.CashbackEnabledButRevokingFails) {
        await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);
      }
      if (updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingFails) {
        await context.cashbackDistributorMockShell.setIncreaseCashbackSuccessResult(false);
      }

      cardPaymentProcessorShell.model.updatePaymentAmount(
        newBaseAmount,
        newExtraAmount,
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
        newBaseAmount,
        newExtraAmount,
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB
      );

      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if the new base amount is", async () => {
      describe("Less than the initial one and the extra amount is", async () => {
        describe("The same as the initial one and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackEnabled
            );
          });
          it("Disabled before payment making", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackDisabledBeforePaymentMaking
            );
          });
          it("Disabled after payment making", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackDisabledAfterPaymentMaking
            );
          });
          it("Enabled but cashback revoking fails", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackEnabledButRevokingFails
            );
          });
        });
        describe("Far less than the initial one and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.FarLess,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Far more than the initial one and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.FarMore,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Slightly more than the initial one and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.SlightlyMore,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Zero and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Less,
              NewExtraPaymentAmountType.Zero,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
      });
      describe("The same as the initial one and the extra amount is", async () => {
        describe("The same as the initial one and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Same,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackEnabled);
          });
        });
        describe("Far less than the initial one and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Same,
              NewExtraPaymentAmountType.FarLess,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Far more than the initial one and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Same,
              NewExtraPaymentAmountType.FarMore,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Zero and cashback sending is", async () => {
          it("Enabled and cashback revoking is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.Same,
              NewExtraPaymentAmountType.Zero,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
      });

      describe("More than the initial one and the extra amount is", async () => {
        describe("The same as the initial one and cashback sending is", async () => {
          it("Enabled and cashback increasing is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackEnabled
            );
          });
          it("Disabled before payment making", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackDisabledBeforePaymentMaking
            );
          });
          it("Disabled after payment making", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackDisabledAfterPaymentMaking
            );
          });
          it("Enabled but cashback increasing fails", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackEnabledButIncreasingFails);
          });
          it("Enabled but cashback increasing executes partially", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.Same,
              UpdatingConditionType.CashbackEnabledButIncreasingPartial
            );
          });
        });
        describe("Far less than the initial one and cashback sending is", async () => {
          it("Enabled and cashback increasing is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.FarLess,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Slightly less than the initial one and cashback sending is", async () => {
          it("Enabled and cashback increasing is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.SlightlyLess,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Far more than the initial one and cashback sending is", async () => {
          it("Enabled and cashback increasing is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.FarMore,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
        describe("Zero and cashback sending is", async () => {
          it("Enabled and cashback increasing is executed successfully", async () => {
            await checkUpdating(
              NewBasePaymentAmountType.More,
              NewExtraPaymentAmountType.Zero,
              UpdatingConditionType.CashbackEnabled
            );
          });
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment authorization ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            ZERO_AUTHORIZATION_ID,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
        );
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });

      it("The new base amount is less than the refund amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makePayments([payment]);
        const refundAmount = Math.floor(payment.baseAmount * 0.5);
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
            refundAmount - 1,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_NEW_BASE_PAYMENT_AMOUNT_IS_INAPPROPRIATE
        );
      });

      it("The payment status is 'Cleared'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.clearPayments([payment]);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Cleared);
      });
    });
  });

  describe("Function 'updatePaymentAmount()' with no extra amount parameter", async () => {
    describe("Executes as expected and emits the correct events if the payment amount is", async () => {
      describe("Less than the initial one and cashback sending is", async () => {
        it("Enabled and cashback revoking is executed successfully", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;

          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makePayments([payment]);

          const newBaseAmount = Math.floor(payment.baseAmount * 0.5);
          const refundAmount = Math.floor(payment.baseAmount * 0.1);
          await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

          await context.checkCardPaymentProcessorState();

          cardPaymentProcessorShell.model.updatePaymentAmount(
            newBaseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          );
          const tx =
            cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_PRUNED](
              newBaseAmount,
              payment.authorizationId,
              PAYMENT_UPDATING_CORRELATION_ID_STUB
            );

          expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
          await context.checkPaymentOperationsForTx(tx);
          await context.checkCardPaymentProcessorState();
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });
    });
  });

  describe("Function 'clearPayment()'", async () => {
    it("Executes as expected and emits the correct event if there was no refunding", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);

      cardPaymentProcessorShell.model.clearPayment(payment.authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).clearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Executes as expected and emits the correct event if there was a refund operation", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      cardPaymentProcessorShell.model.clearPayment(payment.authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).clearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(deployer).clearPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;
      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
      );
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment has already been cleared", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.makePayments([payment]);
      await proveTx(cardPaymentProcessorShell.contract.connect(executor).clearPayment(payment.authorizationId));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });
  });

  describe("Function 'clearPayments()'", async () => {
    it("Executes as expected and emits the correct events", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);

      const operationIndex1 = cardPaymentProcessorShell.model.clearPayment(payments[0].authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.clearPayment(payments[1].authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).clearPayments([
        payments[0].authorizationId,
        payments[1].authorizationId,
      ]);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx, [operationIndex1, operationIndex2]);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayments([payment.authorizationId])
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(deployer).clearPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY
      );
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayments([
          payments[0].authorizationId,
          ZERO_AUTHORIZATION_ID
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
      );
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayments([
          payments[0].authorizationId,
          increaseBytesString(payments[1].authorizationId, BYTES16_LENGTH)
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments has been already cleared", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);

      await proveTx(cardPaymentProcessorShell.contract.connect(executor).clearPayment(payments[1].authorizationId));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).clearPayments([
          payments[0].authorizationId,
          payments[1].authorizationId
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });
  });

  describe("Function 'unclearPayment()'", async () => {
    it("Executes as expected and emits the correct event if there was no refunding", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);

      await context.checkCardPaymentProcessorState();

      cardPaymentProcessorShell.model.unclearPayment(payment.authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Executes as expected and emits the correct event if there was a refund operation", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      await context.checkCardPaymentProcessorState();

      cardPaymentProcessorShell.model.unclearPayment(payment.authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(deployer).unclearPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
      );
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);

      await proveTx(cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payment.authorizationId));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'unclearPayments()'", async () => {
    it("Executes as expected and emits the correct events", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      const operationIndex1 = cardPaymentProcessorShell.model.unclearPayment(payments[0].authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.unclearPayment(payments[1].authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).unclearPayments([
        payments[0].authorizationId,
        payments[1].authorizationId,
      ]);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx, [operationIndex1, operationIndex2]);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayments([payment.authorizationId])
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(deployer).unclearPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY
      );
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayments([
          payments[0].authorizationId,
          ZERO_AUTHORIZATION_ID
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
      );
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayments([
          payments[0].authorizationId,
          increaseBytesString(payments[1].authorizationId, BYTES16_LENGTH)
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await proveTx(cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payments[1].authorizationId));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).unclearPayments([
          payments[0].authorizationId,
          payments[1].authorizationId,
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'revokePayment()'", async () => {
    async function revokeSinglePaymentAndCheck(context: TestContext) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      cardPaymentProcessorShell.model.revokePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).revokePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if", async () => {
      it("Cashback operations are enabled and the payment status is 'Uncleared'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await revokeSinglePaymentAndCheck(context);
      });

      it("Cashback operations are enabled and the payment status is 'Cleared'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.clearPayments([payment]);
        await revokeSinglePaymentAndCheck(context);
      });

      it("Cashback operations are enabled but cashback revoking fails", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.disableCashback();
        await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);

        await revokeSinglePaymentAndCheck(context);
      });

      it("Cashback operations are disabled before sending", async () => {
        const context = await beforeMakingPayments();
        await context.cardPaymentProcessorShell.makePayments([context.payments[0]]);
        await revokeSinglePaymentAndCheck(context);
      });

      it("Cashback operations are disabled after sending", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.disableCashback();

        await revokeSinglePaymentAndCheck(context);
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The configured revocation limit of payments is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await proveTx(cardPaymentProcessorShell.contract.setRevocationLimit(0));

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT
        );
      });

      it("The payment authorization ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
        );
      });

      it("The parent transaction hash is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            ZERO_TRANSACTION_HASH,
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(
            increaseBytesString(payment.authorizationId, BYTES16_LENGTH),
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });
    });
  });

  describe("Function 'reversePayment()'", async () => {
    async function reverseSinglePaymentAndCheck(context: TestContext) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      cardPaymentProcessorShell.model.reversePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).reversePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if", async () => {
      it("Cashback operations are enabled and the payment status is 'Uncleared'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await reverseSinglePaymentAndCheck(context);
      });

      it("Cashback operations are enabled and the payment status is 'Cleared'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.clearPayments([payment]);
        await reverseSinglePaymentAndCheck(context);
      });

      it("Cashback operations are enabled but cashback revoking fails", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.disableCashback();
        await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);

        await reverseSinglePaymentAndCheck(context);
      });

      it("Cashback operations are disabled before sending", async () => {
        const context = await beforeMakingPayments();
        await context.cardPaymentProcessorShell.makePayments([context.payments[0]]);
        await reverseSinglePaymentAndCheck(context);
      });

      it("Cashback operations are disabled after sending", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.disableCashback();

        await reverseSinglePaymentAndCheck(context);
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment authorization ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).reversePayment(
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
        );
      });

      it("The parent transaction hash is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            ZERO_TRANSACTION_HASH,
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).reversePayment(
            increaseBytesString(payment.authorizationId, BYTES16_LENGTH),
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });
    });
  });

  describe("Function 'confirmPayment()'", async () => {
    it("Executes as expected and emits the correct event if there was no refunding", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);

      cardPaymentProcessorShell.model.confirmPayment(payment.authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Executes as expected and emits the correct event if there was a refund operation", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      cardPaymentProcessorShell.model.confirmPayment(payment.authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(deployer).confirmPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
      );
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayment(
          payment.authorizationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await cardPaymentProcessorShell.makePayments([payment]);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(PaymentStatus.Uncleared);
    });

    it("Is reverted if the cash-out account is the zero address", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);

      await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO
      );
    });
  });

  describe("Function 'confirmPayments()'", async () => {
    it("Executes as expected and emits the correct events", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      const operationIndex1 = cardPaymentProcessorShell.model.confirmPayment(payments[0].authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.confirmPayment(payments[1].authorizationId);
      const tx = cardPaymentProcessorShell.contract.connect(executor).confirmPayments([
        payments[0].authorizationId,
        payments[1].authorizationId
      ]);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx, [operationIndex1, operationIndex2]);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments([payment.authorizationId])
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(deployer).confirmPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY
      );
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments([
          payments[0].authorizationId,
          ZERO_AUTHORIZATION_ID
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
      );
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments([
          payments[0].authorizationId,
          increaseBytesString(payments[1].authorizationId, BYTES16_LENGTH)
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await proveTx(cardPaymentProcessorShell.contract.connect(executor).unclearPayment(payments[1].authorizationId));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments([
          payments[0].authorizationId,
          payments[1].authorizationId
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(PaymentStatus.Uncleared);
    });

    it("Is reverted if the cash-out account is the zero address", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments([
          payments[0].authorizationId,
          payments[1].authorizationId
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO
      );
    });
  });

  describe("Function 'refundPayment()' with the extra amount parameter", async () => {

    enum RefundType {
      Zero = 0,
      Nonzero = 1,
      Full = 2
    }

    enum NewExtraAmountType {
      Same = 0,
      Less = 1,
      Zero = 2,
    }

    async function checkRefunding(
      refundType: RefundType,
      newExtraAmountType: NewExtraAmountType,
      paymentStatus: PaymentStatus
    ) {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);

      let refundAmount = 0;
      switch (refundType) {
        case RefundType.Nonzero:
          refundAmount = Math.floor(payment.baseAmount * 0.1);
          break;
        case RefundType.Full:
          refundAmount = payment.baseAmount;
          break;
      }

      let newExtraAmount = 0;
      switch (newExtraAmountType) {
        case NewExtraAmountType.Same:
          newExtraAmount = payment.extraAmount;
          break;
        case NewExtraAmountType.Less:
          newExtraAmount = Math.floor(payment.extraAmount * 0.5);
          break;
        case NewExtraAmountType.Zero:
          newExtraAmount = 0;
          break;
      }

      if (paymentStatus == PaymentStatus.Cleared) {
        await cardPaymentProcessorShell.clearPayments([payment]);
      }
      if (paymentStatus == PaymentStatus.Confirmed) {
        await cardPaymentProcessorShell.clearPayments([payment]);
        await cardPaymentProcessorShell.confirmPayments([payment]);
      }

      cardPaymentProcessorShell.model.refundPayment(
        refundAmount,
        newExtraAmount,
        payment.authorizationId,
        PAYMENT_REFUNDING_CORRELATION_ID_STUB
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
        refundAmount,
        newExtraAmount,
        payment.authorizationId,
        PAYMENT_REFUNDING_CORRELATION_ID_STUB
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if the refund amount is", async () => {
      describe("Nonzero and the new extra amount of the payment is", async () => {
        describe("The same as the initial one and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Nonzero, NewExtraAmountType.Same, PaymentStatus.Uncleared);
          });
        });

        describe("Less than the initial one and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Nonzero, NewExtraAmountType.Less, PaymentStatus.Uncleared);
          });

          it("Cleared", async () => {
            await checkRefunding(RefundType.Nonzero, NewExtraAmountType.Less, PaymentStatus.Cleared);
          });

          it("Confirmed", async () => {
            await checkRefunding(RefundType.Nonzero, NewExtraAmountType.Less, PaymentStatus.Confirmed);
          });
        });

        describe("Zero and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Nonzero, NewExtraAmountType.Zero, PaymentStatus.Uncleared);
          });
        });
      });

      describe("Equals the base payment amount and the new extra amount of the payment is", async () => {
        describe("The same as the initial one and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Full, NewExtraAmountType.Same, PaymentStatus.Uncleared);
          });
        });

        describe("Less than the initial one and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Full, NewExtraAmountType.Less, PaymentStatus.Uncleared);
          });

          it("Cleared", async () => {
            await checkRefunding(RefundType.Full, NewExtraAmountType.Less, PaymentStatus.Cleared);
          });

          it("Confirmed", async () => {
            await checkRefunding(RefundType.Full, NewExtraAmountType.Less, PaymentStatus.Confirmed);
          });
        });

        describe("Zero and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Full, NewExtraAmountType.Zero, PaymentStatus.Uncleared);
          });
        });
      });

      describe("Zero and the new extra amount of the payment is", async () => {
        describe("The same as the initial one and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Zero, NewExtraAmountType.Same, PaymentStatus.Uncleared);
          });
        });

        describe("Less than the initial one and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Zero, NewExtraAmountType.Less, PaymentStatus.Uncleared);
          });

          it("Cleared", async () => {
            await checkRefunding(RefundType.Zero, NewExtraAmountType.Less, PaymentStatus.Cleared);
          });

          it("Confirmed", async () => {
            await checkRefunding(RefundType.Zero, NewExtraAmountType.Less, PaymentStatus.Confirmed);
          });
        });

        describe("Zero and the payment status is", async () => {
          it("Uncleared", async () => {
            await checkRefunding(RefundType.Zero, NewExtraAmountType.Zero, PaymentStatus.Uncleared);
          });
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment authorization ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO
        );
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });

      it("The refund amount exceeds the base payment amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        const refundAmount = payment.baseAmount + 1;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            refundAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_REFUND_AMOUNT_IS_INAPPROPRIATE
        );
      });

      it("The payment is confirmed, but the cash-out amount address is zero", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.clearPayments([payment]);
        await cardPaymentProcessorShell.confirmPayments([payment]);

        await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO
        );
      });

      it("The payment status is 'Revoked'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.revokePayment(payment);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Revoked);
      });

      it("The payment status is 'Reversed'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.reversePayment(payment);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Reversed);
      });

      it("The new extra amount exceeds the old one of the payment", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        payment.extraAmount += 1;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_NEW_EXTRA_PAYMENT_AMOUNT_IS_INAPPROPRIATE
        );
      });
    });
  });

  describe("Function 'refundPayment()' with no extra amount parameter", async () => {
    describe("Executes as expected and emits the correct events if the refund amount is", async () => {
      describe("Nonzero and the payment status is", async () => {
        it("Uncleared", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;
          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makePayments([payment]);

          const refundAmount = Math.floor(payment.baseAmount * 0.1);


          cardPaymentProcessorShell.model.refundPayment(
            refundAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          );
          const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_PRUNED](
            refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          );
          expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

          await context.checkPaymentOperationsForTx(tx);
          await context.checkCardPaymentProcessorState();
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_REFUND_PAYMENT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).functions[FUNCTION_REFUND_PAYMENT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });
    });
  });

  describe("Complex scenarios without cashback", async () => {
    async function checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
      cardPaymentProcessor: Contract,
      payments: TestPayment[],
      status: PaymentStatus
    ) {
      const authorizationIds = payments.map(payment => payment.authorizationId);
      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationIds[0],
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationIds[0],
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);

      await expect(
        cardPaymentProcessor.connect(executor).functions[FUNCTION_UPDATE_PAYMENT_AMOUNT_FULL](
          payments[0].baseAmount,
          payments[0].extraAmount,
          authorizationIds[0],
          PAYMENT_UPDATING_CORRELATION_ID_STUB)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(status);
    }

    it("All payment processing functions except making are reverted if a payment was revoked", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;

      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.revokePayment(payments[0]);

      await context.checkCardPaymentProcessorState();
      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
        cardPaymentProcessorShell.contract,
        payments,
        PaymentStatus.Revoked
      );

      cardPaymentProcessorShell.model.makePayment(payments[0], executor);
      const tx = cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
        payments[0].account.address,
        payments[0].baseAmount,
        payments[0].extraAmount,
        payments[0].authorizationId,
        payments[0].correlationId
      );
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("All payment processing functions are reverted if a payment was reversed", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;

      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.reversePayment(payments[0]);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
        cardPaymentProcessorShell.contract,
        payments,
        PaymentStatus.Reversed
      );
      await context.checkCardPaymentProcessorState();
    });

    it("All payment processing functions are reverted if a payment was confirmed", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;

      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);
      await cardPaymentProcessorShell.confirmPayments([payments[0]]);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
        cardPaymentProcessorShell.contract,
        payments,
        PaymentStatus.Confirmed
      );
      await context.checkCardPaymentProcessorState();
    });

    it("Making payment function is reverted if the payment has the 'Cleared' status", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments } = context;

      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
    });

    it("Making payment function is reverted if the revocation counter has reached the limit", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments } = context;
      const revocationCounterMax: number = 1;

      await proveTx(cardPaymentProcessorShell.contract.setRevocationLimit(revocationCounterMax));
      expect(await cardPaymentProcessorShell.contract.revocationLimit()).to.equal(revocationCounterMax);

      for (let relocationCounter = 0; relocationCounter < revocationCounterMax; ++relocationCounter) {
        await cardPaymentProcessorShell.makePayments([payments[0]]);
        await cardPaymentProcessorShell.revokePayment(payments[0]);
      }
      await context.checkCardPaymentProcessorState();

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).functions[FUNCTION_MAKE_PAYMENT_FROM_FULL](
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT
      );
    });

    it("All payment processing functions execute successfully if both base and extra amounts are zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, tokenMock, payments } = context;
      payments.forEach(payment => {
        payment.baseAmount = 0;
        payment.extraAmount = 0;
      });

      await cardPaymentProcessorShell.makePayments(payments);
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.clearPayments(payments);
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.unclearPayments(payments);
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.revokePayment(payments[0]);
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.reversePayment(payments[1]);
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.makePayments([payments[0]]);
      await cardPaymentProcessorShell.clearPayments([payments[0]]);

      const cashOutAccountBalanceBefore: BigNumber = await tokenMock.balanceOf(cashOutAccount.address);
      await cardPaymentProcessorShell.confirmPayments([payments[0]]);
      const cashOutAccountBalanceAfter: BigNumber = await tokenMock.balanceOf(cashOutAccount.address);
      await context.checkCardPaymentProcessorState();
      expect(cashOutAccountBalanceBefore).to.equal(cashOutAccountBalanceAfter);
    });
  });

  describe("Complex scenarios with cashback", async () => {
    it("Several refund and payment updating operations execute as expected if cashback is enabled", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      expect(payment).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);

      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.updatePaymentAmount(payment, Math.floor(payment.baseAmount * 2));
      await cardPaymentProcessorShell.refundPayment(payment, Math.floor(payment.baseAmount * 0.1));
      await cardPaymentProcessorShell.updatePaymentAmount(
        payment,
        Math.floor(payment.baseAmount * 0.9),
        Math.floor(payment.extraAmount * 1.1),
      );
      await cardPaymentProcessorShell.refundPayment(
        payment,
        Math.floor(payment.baseAmount * 0.2),
        Math.floor(payment.extraAmount * 0.1),
      );
      await cardPaymentProcessorShell.updatePaymentAmount(payment, Math.floor(payment.baseAmount * 1.5));
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.clearPayments([payment]);
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.refundPayment(payment, Math.floor(payment.baseAmount * 0.3));
      await context.checkCardPaymentProcessorState();

      const [operationResult] = await cardPaymentProcessorShell.confirmPayments([payment]);
      await context.checkPaymentOperationsForTx(operationResult.tx);
      await context.checkCardPaymentProcessorState();

      await cardPaymentProcessorShell.refundPayment(payment, Math.floor(payment.baseAmount * 0.4));
      const paymentModel = cardPaymentProcessorShell.model.getPaymentByAuthorizationId(payment.authorizationId);
      await cardPaymentProcessorShell.refundPayment(
        payment,
        paymentModel.baseAmount - paymentModel.refundAmount,
        0
      );
      await context.checkCardPaymentProcessorState();
    });

    it("Several revocation execute as expected with and without the payment extra amount and cashback", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      expect(payment).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.revokePayment(payment);
      await context.checkCardPaymentProcessorState();

      payment.extraAmount = 0;
      await cardPaymentProcessorShell.disableCashback();
      await cardPaymentProcessorShell.makePayments([payment]);
      await context.checkCardPaymentProcessorState();
      await cardPaymentProcessorShell.revokePayment(payment);
      await context.checkCardPaymentProcessorState();
    });
  });
});
