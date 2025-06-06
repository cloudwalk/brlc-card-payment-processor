import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory, TransactionReceipt, TransactionResponse } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getAddress, proveTx } from "../test-utils/eth";
import { createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { checkEquality, checkEventField, checkEventFieldNotEqual } from "../test-utils/checkers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { setUpFixture } from "../test-utils/common";

const MAX_UINT256 = ethers.MaxUint256;
const MAX_INT256 = ethers.MaxInt256;
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_SPONSOR_ADDRESS = ethers.ZeroAddress;
const ZERO_SUBSIDY_LIMIT = 0;
const ZERO_TRANSACTION_HASH: string = ethers.ZeroHash;
const BYTES16_LENGTH: number = 16;
const BYTES32_LENGTH: number = 32;
const CASHBACK_RATE_AS_IN_CONTRACT = -1;
const CASHBACK_ROUNDING_COEF = 10000;
const DIGITS_COEF = 1000000;
const INITIAL_USER_BALANCE = 1000_000 * DIGITS_COEF;
const INITIAL_SPONSOR_BALANCE = INITIAL_USER_BALANCE * 2;

const FUNCTION_REFUND_PAYMENT_FULL = "refundPayment(uint256,uint256,bytes16,bytes16)";
const FUNCTION_REFUND_PAYMENT_PRUNED = "refundPayment(uint256,bytes16,bytes16)";

// Events of the contract under test
const EVENT_NAME_CONFIRM_PAYMENT = "ConfirmPayment";
const EVENT_NAME_CONFIRM_PAYMENT_SUBSIDIZED = "ConfirmPaymentSubsidized";
const EVENT_NAME_CLEAR_PAYMENT = "ClearPayment";
const EVENT_NAME_CLEAR_PAYMENT_SUBSIDIZED = "ClearPaymentSubsidized";
const EVENT_NAME_ENABLE_CASHBACK = "EnableCashback";
const EVENT_NAME_DISABLE_CASHBACK = "DisableCashback";
const EVENT_NAME_INCREASE_CASHBACK_FAILURE = "IncreaseCashbackFailure";
const EVENT_NAME_INCREASE_CASHBACK_MOCK = "IncreaseCashbackMock";
const EVENT_NAME_INCREASE_CASHBACK_SUCCESS = "IncreaseCashbackSuccess";
const EVENT_NAME_MAKE_PAYMENT = "MakePayment";
const EVENT_NAME_MAKE_PAYMENT_SUBSIDIZED = "MakePaymentSubsidized";
const EVENT_NAME_PAYMENT_EXTRA_AMOUNT_CHANGED = "PaymentExtraAmountChanged";
const EVENT_NAME_REFUND_ACCOUNT = "RefundAccount";
const EVENT_NAME_REFUND_PAYMENT = "RefundPayment";
const EVENT_NAME_REFUND_PAYMENT_SUBSIDIZED = "RefundPaymentSubsidized";
const EVENT_NAME_REVERSE_PAYMENT = "ReversePayment";
const EVENT_NAME_REVERSE_PAYMENT_SUBSIDIZED = "ReversePaymentSubsidized";
const EVENT_NAME_REVOKE_CASHBACK_FAILURE = "RevokeCashbackFailure";
const EVENT_NAME_REVOKE_CASHBACK_MOCK = "RevokeCashbackMock";
const EVENT_NAME_REVOKE_CASHBACK_SUCCESS = "RevokeCashbackSuccess";
const EVENT_NAME_REVOKE_PAYMENT = "RevokePayment";
const EVENT_NAME_REVOKE_PAYMENT_SUBSIDIZED = "RevokePaymentSubsidized";
const EVENT_NAME_SEND_CASHBACK_FAILURE = "SendCashbackFailure";
const EVENT_NAME_SEND_CASHBACK_MOCK = "SendCashbackMock";
const EVENT_NAME_SEND_CASHBACK_SUCCESS = "SendCashbackSuccess";
const EVENT_NAME_SET_CASH_OUT_ACCOUNT = "SetCashOutAccount";
const EVENT_NAME_SET_CASHBACK_DISTRIBUTOR = "SetCashbackDistributor";
const EVENT_NAME_SET_CASHBACK_RATE = "SetCashbackRate";
const EVENT_NAME_SET_REVOCATION_LIMIT = "SetRevocationLimit";
const EVENT_NAME_UNCLEAR_PAYMENT = "UnclearPayment";
const EVENT_NAME_UNCLEAR_PAYMENT_SUBSIDIZED = "UnclearPaymentSubsidized";
const EVENT_NAME_UPDATE_PAYMENT_AMOUNT = "UpdatePaymentAmount";
const EVENT_NAME_UPDATE_PAYMENT_SUBSIDIZED = "UpdatePaymentSubsidized";

enum PaymentStatus {
  Nonexistent = 0,
  Uncleared = 1,
  Cleared = 2,
  Revoked = 3,
  Reversed = 4,
  Confirmed = 5
}

enum CashbackKind {
  // Manual = 0,
  CardPayment = 1
}

interface TestPayment {
  account: HardhatEthersSigner;
  baseAmount: number;
  extraAmount: number;
  authorizationId: string;
  correlationId: string;
  parentTxHash: string;
}

interface PaymentModel {
  authorizationId: string;
  account: HardhatEthersSigner;
  baseAmount: number;
  extraAmount: number;
  status: PaymentStatus;
  compensationAmount: number;
  refundAmount: number;
  cashbackRate: number;
  cashbackEnabled: boolean;
  revocationParentTxHashes: string[];
  reversalParentTxHashes: string[];
  sponsor?: HardhatEthersSigner;
  subsidyLimit: number;
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
  Refunding = 8
}

interface PaymentOperation {
  kind: OperationKind;
  sender?: HardhatEthersSigner;
  account: HardhatEthersSigner;
  newBaseAmount: number;
  newExtraAmount: number;
  refundAmountChange: number;
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
  cashbackRequestedChange: number; // From the user point of view, if "+" then the user earns cashback
  cashbackActualChange: number; // From the user point of view, if "+" then the user earns cashback
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
  sponsor?: HardhatEthersSigner;
  subsidyLimit: number;
  sponsorRefundAmountChange: number;
  sponsorBalanceChange: number;
  oldSponsorSumAmount: number;
  newSponsorSumAmount: number;
}

interface Fixture {
  cardPaymentProcessor: Contract;
  tokenMock: Contract;
  cashbackDistributorMock: Contract;
  cashbackDistributorMockConfig: CashbackDistributorMockConfig;
}

interface AmountParts {
  accountBaseAmount: number;
  accountExtraAmount: number;
  sponsorBaseAmount: number;
  sponsorExtraAmount: number;
}

interface RefundParts {
  accountRefundAmount: number;
  sponsorRefundAmount: number;
}

class CashbackDistributorMockShell {
  readonly contract: Contract;
  readonly config: CashbackDistributorMockConfig;

  constructor(props: {
    cashbackDistributorMockConfig: CashbackDistributorMockConfig;
    cashbackDistributorMockContract: Contract;
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

  constructor(props: { cashbackDistributorMockConfig: CashbackDistributorMockConfig; cashbackRateInPermil: number }) {
    this.#cashbackDistributorMockConfig = props.cashbackDistributorMockConfig;
    this.#cashbackRateInPermil = props.cashbackRateInPermil;
  }

  makePayment(
    payment: TestPayment,
    props: {
      sponsor?: HardhatEthersSigner;
      subsidyLimit?: number;
      cashbackRateInPermil?: number;
      sender?: HardhatEthersSigner;
    } = {}
  ): number {
    const paymentModel = this.#createPayment(payment);
    const operation: PaymentOperation = this.#createPaymentOperation(paymentModel, OperationKind.Making);
    operation.sender = props.sender ?? payment.account;
    operation.oldBaseAmount = 0;
    operation.oldExtraAmount = 0;
    operation.correlationId = payment.correlationId;
    operation.sponsor = props.sponsor;
    operation.subsidyLimit = !operation.sponsor ? 0 : props.subsidyLimit ?? 0;
    if (!!props.cashbackRateInPermil && props.cashbackRateInPermil > 0) {
      operation.cashbackRate = props.cashbackRateInPermil;
    } else if (props.cashbackRateInPermil === 0) {
      operation.cashbackEnabled = false;
      operation.cashbackRate = 0;
    }
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
    operation.refundAmountChange = refundAmount;
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
    return new Set(this.#paymentMakingOperations.map(operation => operation.account.address));
  }

  getAccountUnclearedBalance(account: string): number {
    return this.#unclearedBalancePerAccount.get(account) ?? 0;
  }

  getAccountClearedBalance(account: string): number {
    return this.#clearedBalancePerAccount.get(account) ?? 0;
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
      cashbackRate: this.#cashbackRateInPermil,
      cashbackEnabled: this.#cashbackEnabled,
      revocationParentTxHashes: !currentPayment ? [] : [...currentPayment.revocationParentTxHashes],
      reversalParentTxHashes: [],
      sponsor: undefined,
      subsidyLimit: 0
    };
  }

  #createPaymentOperation(payment: PaymentModel, kind: OperationKind): PaymentOperation {
    const cashback = this.getCashbackByAuthorizationId(payment.authorizationId);
    const amountParts: AmountParts = this.#defineAmountParts(
      payment.baseAmount,
      payment.extraAmount,
      payment.subsidyLimit
    );
    return {
      kind,
      sender: undefined,
      account: payment.account,
      newBaseAmount: payment.baseAmount,
      newExtraAmount: payment.extraAmount,
      refundAmountChange: 0,
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
      paymentStatus: payment.status,
      sponsor: payment.sponsor,
      subsidyLimit: payment.subsidyLimit,
      sponsorRefundAmountChange: 0,
      sponsorBalanceChange: 0,
      oldSponsorSumAmount: amountParts.sponsorBaseAmount + amountParts.sponsorExtraAmount,
      newSponsorSumAmount: amountParts.sponsorBaseAmount + amountParts.sponsorExtraAmount
    };
  }

  #definePaymentMakingOperation(operation: PaymentOperation) {
    const { accountBaseAmount, accountExtraAmount, sponsorBaseAmount, sponsorExtraAmount } = this.#defineAmountParts(
      operation.newBaseAmount,
      operation.newExtraAmount,
      operation.subsidyLimit
    );
    if (operation.cashbackEnabled) {
      operation.cashbackRequestedChange = this.#calculateCashback(accountBaseAmount, operation.cashbackRate);
      operation.cashbackSendingSucceeded = this.#cashbackDistributorMockConfig.sendCashbackSuccessResult;
      operation.cashbackNonce = this.#cashbackDistributorMockConfig.sendCashbackNonceResult;
      this.#cashbackPerAuthorizationId.set(operation.authorizationId, { lastCashbackNonce: operation.cashbackNonce });
      if (operation.cashbackSendingSucceeded) {
        if (this.#cashbackDistributorMockConfig.sendCashbackAmountResult < 0) {
          operation.cashbackActualChange = operation.cashbackRequestedChange;
        } else {
          operation.cashbackActualChange = this.#cashbackDistributorMockConfig.sendCashbackAmountResult;
        }
      } else {
        operation.cashbackRate = 0;
      }
    } else {
      operation.cashbackRate = 0;
    }
    operation.totalAmount = operation.newBaseAmount + operation.newExtraAmount;
    operation.cardPaymentProcessorBalanceChange = operation.newBaseAmount + operation.newExtraAmount;
    operation.userBalanceChange = -(accountBaseAmount + accountExtraAmount) + operation.cashbackActualChange;
    operation.newSponsorSumAmount = sponsorBaseAmount + sponsorExtraAmount;
    operation.sponsorBalanceChange = -operation.newSponsorSumAmount;
    if (operation.sender == operation.account) {
      operation.senderBalanceChange = operation.userBalanceChange;
    }
  }

  #registerPaymentMakingOperation(operation: PaymentOperation, payment: PaymentModel): number {
    payment.compensationAmount = operation.cashbackActualChange;
    payment.cashbackEnabled = operation.cashbackEnabled;
    payment.cashbackRate = operation.cashbackRate;
    let balance = this.#unclearedBalancePerAccount.get(operation.account.address) ?? 0;
    balance += operation.totalAmount;
    this.#unclearedBalancePerAccount.set(operation.account.address, balance);
    this.#totalUnclearedBalance += operation.totalAmount;
    this.#totalBalance += operation.totalAmount;
    this.#paymentPerAuthorizationId.set(payment.authorizationId, payment);
    this.#paymentOperations.push(operation);
    if (operation.sponsor) {
      payment.sponsor = operation.sponsor;
      payment.subsidyLimit = operation.subsidyLimit;
    }
    return this.#paymentMakingOperations.push(operation) - 1;
  }

  #calculateCashback(amount: number, cashbackRateInPermil: number) {
    const cashback = Math.floor((amount * cashbackRateInPermil) / 1000);
    return this.#roundCashback(cashback, CASHBACK_ROUNDING_COEF);
  }

  #roundCashback(cashback: number, roundingCoefficient: number): number {
    return Math.floor(Math.floor(cashback + roundingCoefficient / 2) / roundingCoefficient) * roundingCoefficient;
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
      throw new Error(`The payment has inappropriate status: ${payment.status}`);
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
    const newAmountParts: AmountParts = this.#defineAmountParts(
      operation.newBaseAmount,
      operation.newExtraAmount,
      operation.subsidyLimit
    );
    const oldAmountParts: AmountParts = this.#defineAmountParts(
      operation.oldBaseAmount,
      operation.oldExtraAmount,
      operation.subsidyLimit
    );
    const amountDiff =
      operation.newBaseAmount + operation.newExtraAmount - operation.oldBaseAmount - operation.oldExtraAmount;
    const accountAmountDiff: number =
      newAmountParts.accountBaseAmount +
      newAmountParts.accountExtraAmount -
      oldAmountParts.accountBaseAmount -
      oldAmountParts.accountExtraAmount;
    const sponsorAmountDiff: number =
      newAmountParts.sponsorBaseAmount +
      newAmountParts.sponsorExtraAmount -
      oldAmountParts.sponsorBaseAmount -
      oldAmountParts.sponsorExtraAmount;
    operation.newSponsorSumAmount = newAmountParts.sponsorBaseAmount + newAmountParts.sponsorExtraAmount;
    if (!payment.cashbackEnabled) {
      operation.userBalanceChange = -accountAmountDiff;
      operation.sponsorBalanceChange = -sponsorAmountDiff;
      operation.cardPaymentProcessorBalanceChange = amountDiff;
    } else {
      operation.cashbackRequestedChange = this.#defineCashbackChangeForPaymentUpdatingOperation(operation, payment);
      if (operation.newBaseAmount > operation.oldBaseAmount) {
        operation.cashbackIncreaseRequested = true;
        if (this.#cashbackDistributorMockConfig.increaseCashbackSuccessResult) {
          operation.cashbackIncreaseSuccess = true;
          if (this.#cashbackDistributorMockConfig.increaseCashbackAmountResult < 0) {
            operation.cashbackActualChange = operation.cashbackRequestedChange;
          } else {
            operation.cashbackActualChange = this.#cashbackDistributorMockConfig.increaseCashbackAmountResult;
          }
        }
        operation.userBalanceChange = -accountAmountDiff + operation.cashbackActualChange;
        operation.sponsorBalanceChange = -sponsorAmountDiff;
        operation.cardPaymentProcessorBalanceChange = amountDiff;
        operation.compensationAmountChange = operation.cashbackActualChange;
      } else {
        operation.cashbackRevocationRequested = true;
        if (this.#cashbackDistributorMockConfig.revokeCashbackSuccessResult) {
          operation.cashbackRevocationSuccess = true;
          operation.cashbackActualChange = operation.cashbackRequestedChange;
        }
        operation.userBalanceChange = -accountAmountDiff + operation.cashbackRequestedChange;
        operation.sponsorBalanceChange = -sponsorAmountDiff;
        operation.cardPaymentProcessorBalanceChange =
          amountDiff - (operation.cashbackRequestedChange - operation.cashbackActualChange);
        operation.compensationAmountChange = operation.cashbackRequestedChange;
      }
    }
  }

  #defineCashbackChangeForPaymentUpdatingOperation(operation: PaymentOperation, payment: PaymentModel) {
    const newAmountParts: AmountParts = this.#defineAmountParts(
      operation.newBaseAmount,
      operation.newExtraAmount,
      operation.subsidyLimit
    );
    const oldAmountParts: AmountParts = this.#defineAmountParts(
      operation.oldBaseAmount,
      operation.oldExtraAmount,
      operation.subsidyLimit
    );
    const refundParts: RefundParts = this.#defineRefundParts(
      payment.refundAmount,
      payment.baseAmount,
      payment.subsidyLimit
    );
    const cashbackModel = this.getCashbackByAuthorizationId(operation.authorizationId);
    operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
    const oldExpectedCashback = this.#calculateCashback(
      oldAmountParts.accountBaseAmount - refundParts.accountRefundAmount,
      payment.cashbackRate
    );
    const oldActualCashback = payment.compensationAmount - payment.refundAmount;
    const newExpectedCashback = this.#calculateCashback(
      newAmountParts.accountBaseAmount - refundParts.accountRefundAmount,
      payment.cashbackRate
    );
    if (newExpectedCashback < oldExpectedCashback && newExpectedCashback > oldActualCashback) {
      return 0;
    } else {
      return newExpectedCashback - oldActualCashback;
    }
  }

  #registerPaymentUpdatingOperation(operation: PaymentOperation, payment: PaymentModel) {
    payment.baseAmount = operation.newBaseAmount;
    payment.extraAmount = operation.newExtraAmount;
    payment.compensationAmount += operation.compensationAmountChange;
    const amountDiff =
      operation.newBaseAmount + operation.newExtraAmount - operation.oldBaseAmount - operation.oldExtraAmount;
    this.#changeBalanceMap(this.#unclearedBalancePerAccount, operation.account.address, amountDiff);
    this.#totalUnclearedBalance += amountDiff;
    this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    return this.#paymentOperations.push(operation) - 1;
  }

  #checkPaymentClearing(payment: PaymentModel) {
    if (payment.status !== PaymentStatus.Uncleared) {
      throw new Error(`The payment has inappropriate status: ${payment.status}`);
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

  #getOperationByIndex(operations: PaymentOperation[], index: number, kind: string): PaymentOperation {
    if (index < 0) {
      index = operations.length + index;
    }
    if (index >= operations.length) {
      throw new Error(`A payment ${kind} operation with index ${index} does not exist. `);
    }
    return operations[index];
  }

  #checkPaymentUnclearing(payment: PaymentModel) {
    if (payment.status !== PaymentStatus.Cleared) {
      throw new Error(`The payment has inappropriate status: ${payment.status}`);
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
      throw new Error(`The payment has inappropriate status: ${payment.status}`);
    }
  }

  #definePaymentCancelingOperation(operation: PaymentOperation, payment: PaymentModel) {
    const amountParts: AmountParts = this.#defineAmountParts(
      payment.baseAmount,
      payment.extraAmount,
      payment.subsidyLimit
    );
    const refundParts: RefundParts = this.#defineRefundParts(
      payment.refundAmount,
      payment.baseAmount,
      payment.subsidyLimit
    );
    operation.userBalanceChange =
      amountParts.accountBaseAmount +
      amountParts.accountExtraAmount -
      (payment.compensationAmount - refundParts.sponsorRefundAmount);
    operation.sponsorBalanceChange =
      amountParts.sponsorBaseAmount + amountParts.sponsorExtraAmount - refundParts.sponsorRefundAmount;
    if (payment.cashbackEnabled) {
      operation.cashbackRevocationRequested = true;
      operation.cashbackRequestedChange = -(payment.compensationAmount - payment.refundAmount);
      const cashbackModel = this.getCashbackByAuthorizationId(operation.authorizationId);
      operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
      if (this.#cashbackDistributorMockConfig.revokeCashbackSuccessResult) {
        operation.cashbackActualChange = operation.cashbackRequestedChange;
        operation.cashbackRevocationSuccess = true;
      }
    }
    operation.cardPaymentProcessorBalanceChange =
      -(payment.baseAmount + payment.extraAmount - payment.refundAmount) -
      (operation.cashbackRequestedChange - operation.cashbackActualChange);
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
      throw new Error(`The payment has inappropriate status: ${payment.status}`);
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
    if (
      !(
        payment.status === PaymentStatus.Uncleared ||
        payment.status === PaymentStatus.Cleared ||
        payment.status === PaymentStatus.Confirmed
      )
    ) {
      throw new Error(`The payment has inappropriate status: ${payment.status}`);
    }
    if (operation.refundAmountChange > payment.baseAmount - payment.refundAmount) {
      throw new Error(
        `The refund amount is wrong for the payment with authorizationId=${payment.authorizationId}.` +
        `The requested amount: ${operation.refundAmountChange}. ` +
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
    const oldAmountParts: AmountParts = this.#defineAmountParts(
      payment.baseAmount,
      operation.oldExtraAmount,
      payment.subsidyLimit
    );
    const newAmountParts: AmountParts = this.#defineAmountParts(
      payment.baseAmount,
      operation.newExtraAmount,
      payment.subsidyLimit
    );

    const newPaymentRefundAmount = operation.refundAmountChange + payment.refundAmount;
    const oldRefundParts: RefundParts = this.#defineRefundParts(
      payment.refundAmount,
      payment.baseAmount,
      payment.subsidyLimit
    );
    const newRefundParts: RefundParts = this.#defineRefundParts(
      newPaymentRefundAmount,
      payment.baseAmount,
      payment.subsidyLimit
    );
    const sponsorRefundAmount = newRefundParts.sponsorRefundAmount - oldRefundParts.sponsorRefundAmount;
    const accountRefundAmount = operation.refundAmountChange - sponsorRefundAmount;
    operation.userBalanceChange =
      accountRefundAmount + (oldAmountParts.accountExtraAmount - newAmountParts.accountExtraAmount);
    operation.sponsorBalanceChange =
      sponsorRefundAmount + (oldAmountParts.sponsorExtraAmount - newAmountParts.sponsorExtraAmount);

    if (payment.cashbackEnabled) {
      operation.cashbackRevocationRequested = true;
      const cashbackModel = this.getCashbackByAuthorizationId(operation.authorizationId);
      operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
      const oldCashback = payment.compensationAmount - payment.refundAmount;
      const newCashback = this.#calculateCashback(
        newAmountParts.accountBaseAmount - newRefundParts.accountRefundAmount,
        payment.cashbackRate
      );
      const cashbackRevocationAmount = newCashback > oldCashback ? 0 : oldCashback - newCashback;
      if (this.#cashbackDistributorMockConfig.revokeCashbackSuccessResult) {
        operation.cashbackActualChange = -cashbackRevocationAmount;
        operation.cashbackRevocationSuccess = true;
      }
      operation.cashbackRequestedChange = -cashbackRevocationAmount;
      operation.userBalanceChange -= cashbackRevocationAmount;
    }

    if (operation.paymentStatus === PaymentStatus.Confirmed) {
      operation.cardPaymentProcessorBalanceChange = -(
        operation.cashbackRequestedChange - operation.cashbackActualChange
      );
      operation.cashOutAccountBalanceChange = -(
        operation.refundAmountChange +
        (operation.oldExtraAmount - operation.newExtraAmount)
      );
    } else {
      operation.cardPaymentProcessorBalanceChange =
        -(operation.refundAmountChange + (operation.oldExtraAmount - operation.newExtraAmount)) -
        (operation.cashbackRequestedChange - operation.cashbackActualChange);
    }
    operation.totalAmount = payment.baseAmount + operation.newExtraAmount - newPaymentRefundAmount;
    operation.compensationAmountChange = operation.refundAmountChange + operation.cashbackRequestedChange;
    operation.sponsorRefundAmountChange = sponsorRefundAmount;
  }

  #registerPaymentRefundingOperation(operation: PaymentOperation, payment: PaymentModel): number {
    const balanceChange = -operation.refundAmountChange + (operation.newExtraAmount - operation.oldExtraAmount);
    payment.refundAmount += operation.refundAmountChange;
    payment.compensationAmount += operation.compensationAmountChange;
    payment.extraAmount = operation.newExtraAmount;
    if (operation.paymentStatus === PaymentStatus.Uncleared) {
      this.#changeBalanceMap(this.#unclearedBalancePerAccount, operation.account.address, balanceChange);
      this.#totalUnclearedBalance += balanceChange;
      this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    } else if (operation.paymentStatus == PaymentStatus.Cleared) {
      this.#changeBalanceMap(this.#clearedBalancePerAccount, operation.account.address, balanceChange);
      this.#totalClearedBalance += balanceChange;
      this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    } else {
      this.#totalBalance += -(operation.cashbackRequestedChange - operation.cashbackActualChange);
    }
    return this.#paymentOperations.push(operation) - 1;
  }

  #defineAmountParts(paymentBaseAmount: number, paymentExtraAmount: number, subsidyLimit: number): AmountParts {
    const result: AmountParts = {
      accountBaseAmount: paymentBaseAmount,
      accountExtraAmount: paymentExtraAmount,
      sponsorBaseAmount: 0,
      sponsorExtraAmount: 0
    };
    if (subsidyLimit >= paymentBaseAmount + paymentExtraAmount) {
      result.sponsorBaseAmount = paymentBaseAmount;
      result.accountBaseAmount = 0;
      result.sponsorExtraAmount = paymentExtraAmount;
      result.accountExtraAmount = 0;
    } else if (subsidyLimit >= paymentBaseAmount) {
      result.sponsorBaseAmount = paymentBaseAmount;
      result.accountBaseAmount = 0;
      result.sponsorExtraAmount = subsidyLimit - paymentBaseAmount;
      result.accountExtraAmount = paymentExtraAmount - result.sponsorExtraAmount;
    } else {
      result.sponsorBaseAmount = subsidyLimit;
      result.accountBaseAmount = paymentBaseAmount - result.sponsorBaseAmount;
      result.sponsorExtraAmount = 0;
      result.accountExtraAmount = paymentExtraAmount;
    }
    return result;
  }

  #defineRefundParts(paymentRefundAmount: number, paymentBaseAmount: number, subsidyLimit: number): RefundParts {
    let sponsorRefundAmount;
    if (subsidyLimit >= paymentBaseAmount) {
      sponsorRefundAmount = paymentRefundAmount;
    } else {
      sponsorRefundAmount = Math.floor((paymentRefundAmount * subsidyLimit) / paymentBaseAmount);
    }
    return {
      accountRefundAmount: paymentRefundAmount - sponsorRefundAmount,
      sponsorRefundAmount
    };
  }
}

interface OperationResult {
  operationIndex: number;
  tx: Promise<TransactionResponse>;
  txReceipt: TransactionReceipt;
}

class CardPaymentProcessorShell {
  contract: Contract;
  model: CardPaymentProcessorModel;
  executor: HardhatEthersSigner;

  constructor(props: {
    cardPaymentProcessorContract: Contract;
    cardPaymentProcessorModel: CardPaymentProcessorModel;
    executor: HardhatEthersSigner;
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

  async makePayments(payments: TestPayment[], sender: HardhatEthersSigner = this.executor): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (const payment of payments) {
      const operationIndex = this.model.makePayment(payment, { sender });
      const tx = connect(this.contract, sender).makePaymentFor(
        payment.account.address,
        payment.baseAmount,
        payment.extraAmount,
        payment.authorizationId,
        payment.correlationId,
        ZERO_ADDRESS,
        ZERO_SUBSIDY_LIMIT,
        CASHBACK_RATE_AS_IN_CONTRACT
      );
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt
      });
      payment.parentTxHash = txReceipt.hash;
    }
    return operationResults;
  }

  async makePaymentFor(
    payment: TestPayment,
    sponsor?: HardhatEthersSigner,
    subsidyLimit?: number,
    cashbackRateInPermil?: number,
    sender: HardhatEthersSigner = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.makePayment(payment, {
      sponsor,
      subsidyLimit,
      cashbackRateInPermil,
      sender
    });
    const tx = connect(this.contract, sender).makePaymentFor(
      payment.account.address,
      payment.baseAmount,
      payment.extraAmount,
      payment.authorizationId,
      payment.correlationId,
      sponsor?.address ?? ZERO_ADDRESS,
      subsidyLimit ?? 0,
      cashbackRateInPermil ?? -1
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async updatePaymentAmount(
    payment: TestPayment,
    newBaseAmount: number,
    newExtraAmount: number = payment.extraAmount,
    sender: HardhatEthersSigner = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.updatePaymentAmount(
      newBaseAmount,
      newExtraAmount,
      payment.authorizationId,
      payment.correlationId
    );
    const tx = connect(this.contract, sender).updatePaymentAmount(
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
    sender: HardhatEthersSigner = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (const payment of payments) {
      const operationIndex = this.model.clearPayment(payment.authorizationId);
      const tx = connect(this.contract, sender).clearPayment(payment.authorizationId);
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt
      });
    }
    return operationResults;
  }

  async unclearPayments(
    payments: TestPayment[],
    sender: HardhatEthersSigner = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (const payment of payments) {
      const operationIndex = this.model.unclearPayment(payment.authorizationId);
      const tx = connect(this.contract, sender).unclearPayment(payment.authorizationId);
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt
      });
    }
    return operationResults;
  }

  async revokePayment(payment: TestPayment, sender: HardhatEthersSigner = this.executor): Promise<OperationResult> {
    const operationIndex = this.model.revokePayment(
      payment.authorizationId,
      payment.correlationId,
      payment.parentTxHash
    );
    const tx = connect(this.contract, sender)["revokePayment(bytes16,bytes16,bytes32)"](
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

  async reversePayment(payment: TestPayment, sender: HardhatEthersSigner = this.executor): Promise<OperationResult> {
    const operationIndex = this.model.reversePayment(
      payment.authorizationId,
      payment.correlationId,
      payment.parentTxHash
    );
    const tx = connect(this.contract, sender).reversePayment(
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
    sender: HardhatEthersSigner = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (const payment of payments) {
      const operationIndex = this.model.confirmPayment(payment.authorizationId);
      const tx = connect(this.contract, sender).confirmPayment(payment.authorizationId);
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt
      });
      payment.parentTxHash = txReceipt.hash;
    }
    return operationResults;
  }

  async refundPayment(
    payment: TestPayment,
    refundAmount: number,
    newExtraAmount: number = payment.extraAmount,
    sender: HardhatEthersSigner = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.refundPayment(
      refundAmount,
      newExtraAmount,
      payment.authorizationId,
      payment.correlationId
    );
    const tx = connect(this.contract, sender)[FUNCTION_REFUND_PAYMENT_FULL](
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
  cashOutAccount: HardhatEthersSigner;
  payments: TestPayment[];

  constructor(props: {
    fixture: Fixture;
    cashbackRateInPermil: number;
    cashOutAccount: HardhatEthersSigner;
    cardPaymentProcessorExecutor: HardhatEthersSigner;
    payments: TestPayment[];
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
      executor: props.cardPaymentProcessorExecutor
    });
    this.cashOutAccount = props.cashOutAccount;
    this.payments = props.payments;
  }

  async checkPaymentOperationsForTx(tx: Promise<TransactionResponse>, paymentOperationIndexes: number[] = [-1]) {
    const operations: PaymentOperation[] = paymentOperationIndexes.map(
      index => this.cardPaymentProcessorShell.model.getPaymentOperation(index)
    );
    const cashbackRevocationRequestedInAnyOperation =
      operations.filter(operation => operation.cashbackRevocationRequested).length > 0;
    const cashbackIncreaseRequestedInAnyOperation =
      operations.filter(operation => operation.cashbackIncreaseRequested).length > 0;
    const extraAmountChangedInAnyOperations =
      operations.filter(operation => operation.oldExtraAmount !== operation.newExtraAmount).length > 0;

    for (const operation of operations) {
      switch (operation.kind) {
        case OperationKind.Undefined:
          break;
        case OperationKind.Making:
          await this.checkMakingEvents(tx, operation);
          break;
        case OperationKind.Updating:
          await this.checkUpdatingEvents(tx, operation);
          break;
        case OperationKind.Clearing:
          await this.checkClearingEvents(tx, operation, operations);
          break;
        case OperationKind.Unclearing:
          await this.checkUnclearingEvents(tx, operation, operations);
          break;
        case OperationKind.Revoking:
          await this.checkCancelingEvents(
            tx,
            operation,
            operations,
            EVENT_NAME_REVOKE_PAYMENT,
            EVENT_NAME_REVOKE_PAYMENT_SUBSIDIZED
          );
          break;
        case OperationKind.Reversing:
          await this.checkCancelingEvents(
            tx,
            operation,
            operations,
            EVENT_NAME_REVERSE_PAYMENT,
            EVENT_NAME_REVERSE_PAYMENT_SUBSIDIZED
          );
          break;
        case OperationKind.Confirming:
          await this.checkConfirmingEvents(tx, operation, operations);
          break;
        case OperationKind.Refunding:
          await this.checkRefundingEvents(tx, operation);
          break;
        default:
          throw new Error(`An unknown operation kind was found: ${operation.kind}`);
      }

      if (operation.newExtraAmount !== operation.oldExtraAmount) {
        await expect(tx)
          .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_PAYMENT_EXTRA_AMOUNT_CHANGED)
          .withArgs(
            checkEventField("authorizationId", operation.authorizationId),
            checkEventField("correlationId", operation.correlationId),
            checkEventField("account", operation.account.address),
            checkEventField("sumAmount", operation.newBaseAmount + operation.newExtraAmount),
            checkEventField("newExtraAmount", operation.newExtraAmount),
            checkEventField("oldExtraAmount", operation.oldExtraAmount)
          );
      } else if (!extraAmountChangedInAnyOperations) {
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_PAYMENT_EXTRA_AMOUNT_CHANGED);
      }

      if (operation.kind === OperationKind.Making && operation.cashbackEnabled) {
        await expect(tx)
          .to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_SEND_CASHBACK_MOCK)
          .withArgs(
            checkEventField("sender", getAddress(this.cardPaymentProcessorShell.contract)),
            checkEventField("token", getAddress(this.tokenMock)),
            checkEventField("kind", CashbackKind.CardPayment),
            checkEventField("externalId", operation.authorizationId.padEnd(BYTES32_LENGTH * 2 + 2, "0")),
            checkEventField("recipient", operation.account.address),
            checkEventField("amount", operation.cashbackRequestedChange)
          );
        if (operation.cashbackSendingSucceeded) {
          await expect(tx)
            .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_SEND_CASHBACK_SUCCESS)
            .withArgs(
              checkEventField("cashbackDistributor", getAddress(this.cashbackDistributorMockShell.contract)),
              checkEventField("amount", operation.cashbackActualChange),
              checkEventField("nonce", operation.cashbackNonce)
            );
          await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_SEND_CASHBACK_FAILURE);
        } else {
          await expect(tx)
            .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_SEND_CASHBACK_FAILURE)
            .withArgs(
              checkEventField("cashbackDistributor", getAddress(this.cashbackDistributorMockShell.contract)),
              checkEventField("amount", operation.cashbackRequestedChange),
              checkEventField("nonce", operation.cashbackNonce)
            );
          await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_SEND_CASHBACK_SUCCESS);
        }
      } else { // !(operation.kind === OperationKind.Making && operation.cashbackEnabled)
        await expect(tx).not.to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_SEND_CASHBACK_MOCK);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_SEND_CASHBACK_SUCCESS);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_SEND_CASHBACK_FAILURE);
      }

      if (operation.cashbackRevocationRequested) {
        await expect(tx)
          .to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_REVOKE_CASHBACK_MOCK)
          .withArgs(
            checkEventField("sender", getAddress(this.cardPaymentProcessorShell.contract)),
            checkEventField("nonce", operation.cashbackNonce),
            checkEventField("amount", -operation.cashbackRequestedChange)
          );

        if (operation.cashbackRevocationSuccess) {
          await expect(tx)
            .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_SUCCESS)
            .withArgs(
              checkEventField("cashbackDistributor", getAddress(this.cashbackDistributorMockShell.contract)),
              checkEventField("amount", -operation.cashbackActualChange),
              checkEventField("nonce", operation.cashbackNonce)
            );
          await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_FAILURE);
        } else { // !(operation.cashbackRevocationSuccess)
          await expect(tx)
            .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_FAILURE)
            .withArgs(
              checkEventField("cashbackDistributor", getAddress(this.cashbackDistributorMockShell.contract)),
              checkEventField("amount", -operation.cashbackRequestedChange),
              checkEventField("nonce", operation.cashbackNonce)
            );
          await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_SUCCESS);
        }

        await expect(tx).not.to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_INCREASE_CASHBACK_MOCK);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_SUCCESS);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_FAILURE);
      } else if (operation.cashbackIncreaseRequested) {
        await expect(tx)
          .to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_INCREASE_CASHBACK_MOCK)
          .withArgs(
            checkEventField("sender", getAddress(this.cardPaymentProcessorShell.contract)),
            checkEventField("nonce", operation.cashbackNonce),
            checkEventField("amount", operation.cashbackRequestedChange)
          );

        if (operation.cashbackIncreaseSuccess) {
          await expect(tx)
            .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_SUCCESS)
            .withArgs(
              checkEventField("cashbackDistributor", getAddress(this.cashbackDistributorMockShell.contract)),
              checkEventField("amount", operation.cashbackActualChange),
              checkEventField("nonce", operation.cashbackNonce)
            );
          await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_FAILURE);
        } else {
          // !(operation.cashbackIncreaseSuccess)
          await expect(tx)
            .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_FAILURE)
            .withArgs(
              checkEventField("cashbackDistributor", getAddress(this.cashbackDistributorMockShell.contract)),
              checkEventField("amount", operation.cashbackRequestedChange),
              checkEventField("nonce", operation.cashbackNonce)
            );
          await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_SUCCESS);
        }

        await expect(tx).not.to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_REVOKE_CASHBACK_MOCK);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_SUCCESS);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_FAILURE);
      } else if (!cashbackRevocationRequestedInAnyOperation && !cashbackIncreaseRequestedInAnyOperation) {
        await expect(tx).not.to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_REVOKE_CASHBACK_MOCK);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_SUCCESS);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REVOKE_CASHBACK_FAILURE);

        await expect(tx).not.to.emit(this.cashbackDistributorMockShell.contract, EVENT_NAME_INCREASE_CASHBACK_MOCK);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_SUCCESS);
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_INCREASE_CASHBACK_FAILURE);
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
    const balanceChangePerAccount: Map<HardhatEthersSigner, number> = this.#getBalanceChangePerAccount(operations);
    const accounts: HardhatEthersSigner[] = Array.from(balanceChangePerAccount.keys());
    const accountBalanceChanges: number[] = accounts.map(user => balanceChangePerAccount.get(user) ?? 0);

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
    const accounts: Set<HardhatEthersSigner> = new Set(payments.map(payment => payment.account));
    for (const account of accounts) {
      await proveTx(this.tokenMock.mint(account.address, INITIAL_USER_BALANCE));
      const allowance: bigint = await this.tokenMock.allowance(
        account.address,
        getAddress(this.cardPaymentProcessorShell.contract)
      );
      if (allowance < MAX_UINT256) {
        await proveTx(
          connect(this.tokenMock, account).approve(getAddress(this.cardPaymentProcessorShell.contract), MAX_UINT256)
        );
      }
    }
  }

  async checkMakingEvents(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx)
      .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_MAKE_PAYMENT)
      .withArgs(
        checkEventField("authorizationId", operation.authorizationId),
        checkEventField("correlationId", operation.correlationId),
        checkEventField("account", operation.account.address),
        checkEventField("sumAmount", operation.newBaseAmount + operation.newExtraAmount),
        checkEventField("revocationCounter", operation.revocationCounter),
        checkEventField("sender", operation.sender?.address)
      );

    if (operation.sponsor) {
      await expect(tx)
        .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_MAKE_PAYMENT_SUBSIDIZED)
        .withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("correlationId", operation.correlationId),
          checkEventField("sponsor", operation.sponsor.address),
          checkEventField("subsidyLimit", operation.subsidyLimit),
          checkEventField("sponsorSumAmount", operation.newSponsorSumAmount),
          checkEventField("addendum", "0x")
        );
    } else {
      await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_MAKE_PAYMENT_SUBSIDIZED);
    }
  }

  async checkUpdatingEvents(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx)
      .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_UPDATE_PAYMENT_AMOUNT)
      .withArgs(
        checkEventField("authorizationId", operation.authorizationId),
        checkEventField("correlationId", operation.correlationId),
        checkEventField("account", operation.account.address),
        checkEventField("oldSumAmount", operation.oldBaseAmount + operation.oldExtraAmount),
        checkEventField("newSumAmount", operation.newBaseAmount + operation.newExtraAmount),
        checkEventField("oldBaseAmount", operation.oldBaseAmount),
        checkEventField("newBaseAmount", operation.newBaseAmount)
      );

    if (operation.sponsor) {
      await expect(tx)
        .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_UPDATE_PAYMENT_SUBSIDIZED)
        .withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("correlationId", operation.correlationId),
          checkEventField("sponsor", operation.sponsor.address),
          checkEventField("oldSponsorSumAmount", operation.oldSponsorSumAmount),
          checkEventField("newSponsorSumAmount", operation.newSponsorSumAmount),
          checkEventField("addendum", "0x")
        );
    } else {
      await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_UPDATE_PAYMENT_SUBSIDIZED);
    }
  }

  async checkClearingEvents(
    tx: Promise<TransactionResponse>,
    operation: PaymentOperation,
    operations: PaymentOperation[]
  ) {
    await expect(tx)
      .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CLEAR_PAYMENT)
      .withArgs(
        checkEventField("authorizationId", operation.authorizationId),
        checkEventField("account", operation.account.address),
        checkEventField("totalAmount", operation.totalAmount),
        checkEventField("clearedBalance", operation.clearedBalance),
        checkEventField("unclearedBalance", operation.unclearedBalance),
        checkEventField("revocationCounter", operation.revocationCounter)
      );

    const wasThereSubsidizedPayment: boolean = operations.some(op => !!op.sponsor);

    if (operation.sponsor) {
      await expect(tx)
        .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CLEAR_PAYMENT_SUBSIDIZED)
        .withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("sponsor", operation.sponsor.address),
          checkEventField("addendum", "0x")
        );
    } else {
      if (wasThereSubsidizedPayment) {
        await expect(tx)
          .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CLEAR_PAYMENT_SUBSIDIZED)
          .withArgs(
            checkEventFieldNotEqual("authorizationId", operation.authorizationId),
            anyValue,
            anyValue
          );
      } else {
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CLEAR_PAYMENT_SUBSIDIZED);
      }
    }
  }

  async checkUnclearingEvents(
    tx: Promise<TransactionResponse>,
    operation: PaymentOperation,
    operations: PaymentOperation[]
  ) {
    await expect(tx)
      .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_UNCLEAR_PAYMENT)
      .withArgs(
        checkEventField("authorizationId", operation.authorizationId),
        checkEventField("account", operation.account.address),
        checkEventField("totalAmount", operation.totalAmount),
        checkEventField("clearedBalance", operation.clearedBalance),
        checkEventField("unclearedBalance", operation.unclearedBalance),
        checkEventField("revocationCounter", operation.revocationCounter)
      );

    const wasThereSubsidizedPayment: boolean = operations.some(op => !!op.sponsor);

    if (operation.sponsor) {
      await expect(tx)
        .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_UNCLEAR_PAYMENT_SUBSIDIZED)
        .withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("sponsor", operation.sponsor.address),
          checkEventField("addendum", "0x")
        );
    } else {
      if (wasThereSubsidizedPayment) {
        await expect(tx)
          .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_UNCLEAR_PAYMENT_SUBSIDIZED)
          .withArgs(
            checkEventFieldNotEqual("authorizationId", operation.authorizationId),
            anyValue,
            anyValue
          );
      } else {
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_UNCLEAR_PAYMENT_SUBSIDIZED);
      }
    }
  }

  async checkCancelingEvents(
    tx: Promise<TransactionResponse>,
    operation: PaymentOperation,
    operations: PaymentOperation[],
    mainEventName: string,
    subsidizedEventName: string
  ) {
    await expect(tx)
      .to.emit(this.cardPaymentProcessorShell.contract, mainEventName)
      .withArgs(
        checkEventField("authorizationId", operation.authorizationId),
        checkEventField("correlationId", operation.correlationId),
        checkEventField("account", operation.account.address),
        checkEventField("sentAmount", operation.userBalanceChange + operation.sponsorBalanceChange),
        checkEventField("clearedBalance", operation.clearedBalance),
        checkEventField("unclearedBalance", operation.unclearedBalance),
        checkEventField("wasPaymentCleared", operation.paymentStatus === PaymentStatus.Cleared),
        checkEventField("parentTransactionHash", operation.parentTransactionHash),
        checkEventField("revocationCounter", operation.revocationCounter)
      );

    const wasThereSubsidizedPayment: boolean = operations.some(op => !!op.sponsor);

    if (operation.sponsor) {
      await expect(tx)
        .to.emit(this.cardPaymentProcessorShell.contract, subsidizedEventName)
        .withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("correlationId", operation.correlationId),
          checkEventField("sponsor", operation.sponsor.address),
          checkEventField("sponsorSentAmount", operation.sponsorBalanceChange),
          checkEventField("addendum", "0x")
        );
    } else {
      if (wasThereSubsidizedPayment) {
        await expect(tx)
          .to.emit(this.cardPaymentProcessorShell.contract, subsidizedEventName)
          .withArgs(
            checkEventFieldNotEqual("authorizationId", operation.authorizationId),
            anyValue,
            anyValue,
            anyValue
          );
      } else {
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, subsidizedEventName);
      }
    }
  }

  async checkConfirmingEvents(
    tx: Promise<TransactionResponse>,
    operation: PaymentOperation,
    operations: PaymentOperation[]
  ) {
    await expect(tx)
      .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CONFIRM_PAYMENT)
      .withArgs(
        checkEventField("authorizationId", operation.authorizationId),
        checkEventField("account", operation.account.address),
        checkEventField("totalAmount", operation.totalAmount),
        checkEventField("clearedBalance", operation.clearedBalance),
        checkEventField("revocationCounter", operation.revocationCounter)
      );

    const wasThereSubsidizedPayment: boolean = operations.some(op => !!op.sponsor);

    if (operation.sponsor) {
      await expect(tx)
        .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CONFIRM_PAYMENT_SUBSIDIZED)
        .withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("sponsor", operation.sponsor.address),
          checkEventField("addendum", "0x")
        );
    } else {
      if (wasThereSubsidizedPayment) {
        await expect(tx)
          .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CONFIRM_PAYMENT_SUBSIDIZED)
          .withArgs(
            checkEventFieldNotEqual("authorizationId", operation.authorizationId),
            anyValue,
            anyValue
          );
      } else {
        await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_CONFIRM_PAYMENT_SUBSIDIZED);
      }
    }
  }

  async checkRefundingEvents(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    await expect(tx)
      .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REFUND_PAYMENT)
      .withArgs(
        checkEventField("authorizationId", operation.authorizationId),
        checkEventField("correlationId", operation.correlationId),
        checkEventField("account", operation.account.address),
        checkEventField("refundAmount", operation.refundAmountChange),
        checkEventField("sentAmount", operation.userBalanceChange + operation.sponsorBalanceChange),
        checkEventField("status", operation.paymentStatus)
      );

    if (operation.sponsor) {
      await expect(tx)
        .to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REFUND_PAYMENT_SUBSIDIZED)
        .withArgs(
          checkEventField("authorizationId", operation.authorizationId),
          checkEventField("correlationId", operation.correlationId),
          checkEventField("sponsor", operation.sponsor.address),
          checkEventField("sponsorRefundAmount", operation.sponsorRefundAmountChange),
          checkEventField("sponsorSentAmount", operation.sponsorBalanceChange),
          checkEventField("addendum", "0x")
        );
    } else {
      await expect(tx).not.to.emit(this.cardPaymentProcessorShell.contract, EVENT_NAME_REFUND_PAYMENT_SUBSIDIZED);
    }
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

  #checkPaymentsEquality(
    actualOnChainPayment: Record<string, unknown>,
    expectedPayment: PaymentModel,
    paymentIndex: number
  ) {
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
      expectedPayment.compensationAmount,
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
    expect(actualOnChainPayment.sponsor).to.equal(
      expectedPayment.sponsor?.address ?? ZERO_ADDRESS,
      `payment[${paymentIndex}].sponsor is wrong`
    );
    expect(actualOnChainPayment.subsidyLimit).to.equal(
      expectedPayment.subsidyLimit,
      `payment[${paymentIndex}].subsidyLimit is wrong`
    );
  }

  async #checkPaymentRevocationsByParentHashes(revocationParentTxHashes: string[]) {
    const revocationCount = revocationParentTxHashes.length;
    for (let index = 0; index < revocationCount; ++index) {
      const parentTxHash = revocationParentTxHashes[index];
      expect(await this.cardPaymentProcessorShell.contract.isPaymentRevoked(parentTxHash)).to.equal(
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
      expect(await this.cardPaymentProcessorShell.contract.isPaymentReversed(parentTxHash)).to.equal(
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
        expect(actualCashback.lastCashbackNonce).to.equal(0, note);
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
    expect(await this.tokenMock.balanceOf(getAddress(this.cardPaymentProcessorShell.contract))).to.equal(
      this.cardPaymentProcessorShell.model.totalBalance,
      `The card payment processor token balance is wrong`
    );
  }

  #getBalanceChangePerAccount(operations: PaymentOperation[]) {
    const result: Map<HardhatEthersSigner, number> = new Map();
    operations.forEach(operation => {
      let balanceChange: number = result.get(operation.account) ?? 0;
      balanceChange += operation.userBalanceChange;
      result.set(operation.account, balanceChange);

      const sponsor = operation.sponsor;
      if (sponsor) {
        balanceChange = result.get(sponsor) ?? 0;
        balanceChange += operation.sponsorBalanceChange;
        result.set(sponsor, balanceChange);
      }
    });
    return result;
  }
}

interface Version {
  major: number;
  minor: number;
  patch: number;

  [key: string]: number; // Indexing signature to ensure that fields are iterated over in a key-value style
}

function increaseBytesString(bytesString: string, targetLength: number) {
  return createBytesString(
    parseInt(bytesString.substring(2), 16) + 1,
    targetLength
  );
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
  const MAX_CASHBACK_RATE_IN_PERMIL = 500; // 500%
  const CASHBACK_RATE_IN_PERMIL = 100; // 10%
  const CASHBACK_NONCE = 111222333;
  const EXPECTED_VERSION: Version = {
    major: 1,
    minor: 1,
    patch: 0
  };

  // Error messages of the lib contracts
  const ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const ERROR_MESSAGE_PAUSABLE_PAUSED = "Pausable: paused";
  const ERROR_MESSAGE_ERC20_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  // Errors of the contract under test
  const ERROR_NAME_BLOCKLISTED_ACCOUNT = "BlocklistedAccount";
  const ERROR_NAME_CASH_OUT_ACCOUNT_UNCHANGED = "CashOutAccountUnchanged";
  const ERROR_NAME_CASHBACK_ALREADY_DISABLED = "CashbackAlreadyDisabled";
  const ERROR_NAME_CASHBACK_ALREADY_ENABLED = "CashbackAlreadyEnabled";
  const ERROR_NAME_CASHBACK_DISTRIBUTOR_ALREADY_CONFIGURED = "CashbackDistributorAlreadyConfigured";
  const ERROR_NAME_CASHBACK_DISTRIBUTOR_NOT_CONFIGURED = "CashbackDistributorNotConfigured";
  const ERROR_NAME_CASHBACK_DISTRIBUTOR_ZERO_ADDRESS = "CashbackDistributorZeroAddress";
  const ERROR_NAME_CASHBACK_RATE_EXCESS = "CashbackRateExcess";
  const ERROR_NAME_CASHBACK_RATE_UNCHANGED = "CashbackRateUnchanged";
  const ERROR_NAME_EMPTY_AUTHORIZATION_IDS_ARRAY = "EmptyAuthorizationIdsArray";
  const ERROR_NAME_INAPPROPRIATE_NEW_BASE_PAYMENT_AMOUNT = "InappropriateNewBasePaymentAmount";
  const ERROR_NAME_INAPPROPRIATE_NEW_EXTRA_PAYMENT_AMOUNT = "InappropriateNewExtraPaymentAmount";
  const ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS = "InappropriatePaymentStatus";
  const ERROR_NAME_INAPPROPRIATE_REFUND_AMOUNT = "InappropriateRefundAmount";
  const ERROR_NAME_PAYMENT_ALREADY_CLEARED = "PaymentAlreadyCleared";
  const ERROR_NAME_PAYMENT_ALREADY_EXISTS = "PaymentAlreadyExists";
  const ERROR_NAME_PAYMENT_ALREADY_UNCLEARED = "PaymentAlreadyUncleared";
  const ERROR_NAME_PAYMENT_NOT_EXIST = "PaymentNotExist";
  const ERROR_NAME_REVOCATION_LIMIT_REACHED = "RevocationLimitReached";
  const ERROR_NAME_SUBSIDIZED_PAYMENT_WITH_NON_ZERO_REFUND_AMOUNT = "SubsidizedPaymentWithNonZeroRefundAmount";
  const ERROR_NAME_ZERO_ACCOUNT = "ZeroAccount";
  const ERROR_NAME_ZERO_AUTHORIZATION_ID = "ZeroAuthorizationId";
  const ERROR_NAME_ZERO_CASH_OUT_ACCOUNT = "ZeroCashOutAccount";
  const ERROR_NAME_ZERO_PARENT_TRANSACTION_HASH = "ZeroParentTransactionHash";
  const ERROR_NAME_ZERO_TOKEN_ADDRESS = "ZeroTokenAddress";

  const ownerRole: string = ethers.id("OWNER_ROLE");
  const grantorRole: string = ethers.id("GRANTOR_ROLE");
  const blocklisterRole: string = ethers.id("BLOCKLISTER_ROLE");
  const pauserRole: string = ethers.id("PAUSER_ROLE");
  const rescuerRole: string = ethers.id("RESCUER_ROLE");
  const executorRole: string = ethers.id("EXECUTOR_ROLE");

  let cardPaymentProcessorFactory: ContractFactory;
  let cashbackDistributorMockFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: HardhatEthersSigner;
  let cashOutAccount: HardhatEthersSigner;
  let executor: HardhatEthersSigner;
  let sponsor: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  before(async () => {
    [deployer, cashOutAccount, executor, sponsor, user1, user2] = await ethers.getSigners();

    // Contract factories with the explicitly specified deployer account
    cardPaymentProcessorFactory = await ethers.getContractFactory("CardPaymentProcessor");
    cardPaymentProcessorFactory = cardPaymentProcessorFactory.connect(deployer);
    cashbackDistributorMockFactory = await ethers.getContractFactory("CashbackDistributorMock");
    cashbackDistributorMockFactory = cashbackDistributorMockFactory.connect(deployer);
    tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
    tokenMockFactory = tokenMockFactory.connect(deployer);
  });

  async function deployTokenMock(): Promise<{ tokenMock: Contract }> {
    const name = "ERC20 Test";
    const symbol = "TEST";

    let tokenMock = await upgrades.deployProxy(tokenMockFactory, [name, symbol]) as Contract;
    await tokenMock.waitForDeployment();
    tokenMock = connect(tokenMock, deployer); // Explicitly specifying the initial account

    return { tokenMock };
  }

  async function deployTokenMockAndCardPaymentProcessor(): Promise<{
    cardPaymentProcessor: Contract;
    tokenMock: Contract;
  }> {
    const { tokenMock } = await deployTokenMock();

    let cardPaymentProcessor =
      await upgrades.deployProxy(cardPaymentProcessorFactory, [getAddress(tokenMock)]) as Contract;
    await cardPaymentProcessor.waitForDeployment();
    cardPaymentProcessor = connect(cardPaymentProcessor, deployer); // Explicitly specifying the initial account

    return {
      cardPaymentProcessor,
      tokenMock
    };
  }

  async function deployCashbackDistributorMock(): Promise<{
    cashbackDistributorMock: Contract;
    cashbackDistributorMockConfig: CashbackDistributorMockConfig;
  }> {
    const cashbackDistributorMockConfig: CashbackDistributorMockConfig = {
      sendCashbackSuccessResult: true,
      sendCashbackAmountResult: -1,
      sendCashbackNonceResult: CASHBACK_NONCE,
      revokeCashbackSuccessResult: true,
      increaseCashbackSuccessResult: true,
      increaseCashbackAmountResult: -1
    };

    let cashbackDistributorMock: Contract = await cashbackDistributorMockFactory.deploy(
      cashbackDistributorMockConfig.sendCashbackSuccessResult,
      cashbackDistributorMockConfig.sendCashbackAmountResult,
      cashbackDistributorMockConfig.sendCashbackNonceResult,
      cashbackDistributorMockConfig.revokeCashbackSuccessResult,
      cashbackDistributorMockConfig.increaseCashbackSuccessResult,
      cashbackDistributorMockConfig.increaseCashbackAmountResult
    ) as Contract;
    await cashbackDistributorMock.waitForDeployment();
    cashbackDistributorMock = connect(cashbackDistributorMock, deployer); // Explicitly specifying the initial account

    return {
      cashbackDistributorMock,
      cashbackDistributorMockConfig
    };
  }

  async function deployAndConfigureAllContracts(): Promise<Fixture> {
    const { cardPaymentProcessor, tokenMock } = await deployTokenMockAndCardPaymentProcessor();
    const { cashbackDistributorMock, cashbackDistributorMockConfig } = await deployCashbackDistributorMock();

    await proveTx(cardPaymentProcessor.grantRole(grantorRole, deployer.address));
    await proveTx(cardPaymentProcessor.grantRole(executorRole, executor.address));
    await proveTx(cardPaymentProcessor.setCashbackDistributor(getAddress(cashbackDistributorMock)));
    await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL));

    await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
    await proveTx(connect(tokenMock, cashOutAccount).approve(getAddress(cardPaymentProcessor), MAX_UINT256));

    await proveTx(tokenMock.mint(getAddress(cashbackDistributorMock), MAX_INT256));
    await proveTx(tokenMock.mint(sponsor.address, INITIAL_SPONSOR_BALANCE));
    await proveTx(connect(tokenMock, sponsor).approve(getAddress(cardPaymentProcessor), MAX_UINT256));

    return {
      cardPaymentProcessor,
      tokenMock,
      cashbackDistributorMock,
      cashbackDistributorMockConfig
    };
  }

  async function pauseContract(contract: Contract) {
    await proveTx(contract.grantRole(grantorRole, deployer.address));
    await proveTx(contract.grantRole(pauserRole, deployer.address));
    await proveTx(contract.pause());
  }

  function createTestPayments(numberOfPayments: number = 1): TestPayment[] {
    const testPayments: TestPayment[] = [];
    for (let i = 0; i < numberOfPayments; ++i) {
      const payment: TestPayment = {
        account: i % 2 > 0 ? user1 : user2,
        baseAmount: Math.floor(123.456789 * DIGITS_COEF + i * 123.456789 * DIGITS_COEF),
        extraAmount: Math.floor(123.456789 * DIGITS_COEF + i * 123.456789 * DIGITS_COEF),
        authorizationId: createBytesString(123 + i * 123, BYTES16_LENGTH),
        correlationId: createBytesString(345 + i * 345, BYTES16_LENGTH),
        parentTxHash: createBytesString(1 + i, BYTES32_LENGTH)
      };
      expect(payment.baseAmount).greaterThan(10 * DIGITS_COEF);
      expect(payment.extraAmount).greaterThan(10 * DIGITS_COEF);
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
      payments
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
      expect(await cardPaymentProcessor.underlyingToken()).to.equal(getAddress(tokenMock));

      // The revocation limit
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(REVOCATION_LIMIT_DEFAULT_VALUE);

      // The role hashes
      expect(await cardPaymentProcessor.OWNER_ROLE()).to.equal(ownerRole);
      expect(await cardPaymentProcessor.GRANTOR_ROLE()).to.equal(grantorRole);
      expect(await cardPaymentProcessor.BLOCKLISTER_ROLE()).to.equal(blocklisterRole);
      expect(await cardPaymentProcessor.PAUSER_ROLE()).to.equal(pauserRole);
      expect(await cardPaymentProcessor.RESCUER_ROLE()).to.equal(rescuerRole);
      expect(await cardPaymentProcessor.EXECUTOR_ROLE()).to.equal(executorRole);

      // The admins of roles
      expect(await cardPaymentProcessor.getRoleAdmin(ownerRole)).to.equal(ownerRole);
      expect(await cardPaymentProcessor.getRoleAdmin(grantorRole)).to.equal(ownerRole);
      expect(await cardPaymentProcessor.getRoleAdmin(blocklisterRole)).to.equal(grantorRole);
      expect(await cardPaymentProcessor.getRoleAdmin(pauserRole)).to.equal(grantorRole);
      expect(await cardPaymentProcessor.getRoleAdmin(rescuerRole)).to.equal(grantorRole);
      expect(await cardPaymentProcessor.getRoleAdmin(executorRole)).to.equal(grantorRole);

      // The deployer should have the owner role, but not the other roles
      expect(await cardPaymentProcessor.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await cardPaymentProcessor.hasRole(grantorRole, deployer.address)).to.equal(false);
      expect(await cardPaymentProcessor.hasRole(blocklisterRole, deployer.address)).to.equal(false);
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
        cardPaymentProcessor.initialize(getAddress(tokenMock))
      ).to.be.revertedWith(ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("Is reverted if the passed token address is zero", async () => {
      const anotherCardPaymentProcessor =
        await upgrades.deployProxy(cardPaymentProcessorFactory, [], { initializer: false }) as Contract;

      await expect(
        anotherCardPaymentProcessor.initialize(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(cardPaymentProcessorFactory, ERROR_NAME_ZERO_TOKEN_ADDRESS);
    });

    it("Is reverted for the contract implementation if it is called even for the first time", async () => {
      const tokenAddress = user1.address;
      const cashierImplementation = await cardPaymentProcessorFactory.deploy() as Contract;
      await cashierImplementation.waitForDeployment();

      await expect(cashierImplementation.initialize(tokenAddress))
        .to.be.revertedWith(ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED);
    });
  });

  describe("Function '$__VERSION()'", async () => {
    it("Returns expected values", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      const cardPaymentProcessorVersion = await cardPaymentProcessor.$__VERSION();
      checkEquality(cardPaymentProcessorVersion, EXPECTED_VERSION);
    });
  });

  describe("Function 'setRevocationLimit()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(REVOCATION_LIMIT_DEFAULT_VALUE);

      await expect(cardPaymentProcessor.setRevocationLimit(REVOCATION_LIMIT))
        .to.emit(cardPaymentProcessor, EVENT_NAME_SET_REVOCATION_LIMIT)
        .withArgs(REVOCATION_LIMIT_DEFAULT_VALUE, REVOCATION_LIMIT);
    });

    it("Does not emit an event if the new value equals the old one", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setRevocationLimit(REVOCATION_LIMIT_DEFAULT_VALUE)
      ).not.to.emit(cardPaymentProcessor, EVENT_NAME_SET_REVOCATION_LIMIT);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        connect(cardPaymentProcessor, user1).setRevocationLimit(REVOCATION_LIMIT)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });
  });

  describe("Function 'setCashbackDistributor()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const {
        cardPaymentProcessor,
        tokenMock
      } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      expect(
        await tokenMock.allowance(getAddress(cardPaymentProcessor), CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.equal(0);

      await expect(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1))
        .to.emit(cardPaymentProcessor, EVENT_NAME_SET_CASHBACK_DISTRIBUTOR)
        .withArgs(ZERO_ADDRESS, CASHBACK_DISTRIBUTOR_ADDRESS_STUB1);

      expect(await cardPaymentProcessor.cashbackDistributor()).to.equal(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1);
      expect(
        await tokenMock.allowance(getAddress(cardPaymentProcessor), CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.equal(MAX_UINT256);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        connect(cardPaymentProcessor, user1).setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new cashback distributor address is zero", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setCashbackDistributor(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASHBACK_DISTRIBUTOR_ZERO_ADDRESS);
    });

    it("Is reverted if the cashback distributor has been already configured", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));

      await expect(
        cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB2)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASHBACK_DISTRIBUTOR_ALREADY_CONFIGURED);
    });
  });

  describe("Function 'setCashbackRate()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);

      await expect(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL))
        .to.emit(cardPaymentProcessor, EVENT_NAME_SET_CASHBACK_RATE)
        .withArgs(0, CASHBACK_RATE_IN_PERMIL);

      expect(await cardPaymentProcessor.cashbackRate()).to.equal(CASHBACK_RATE_IN_PERMIL);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        connect(cardPaymentProcessor, user1).setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new rate exceeds the allowable maximum", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setCashbackRate(MAX_CASHBACK_RATE_IN_PERMIL + 1)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASHBACK_RATE_EXCESS);
    });

    it("Is reverted if called with the same argument twice", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL));

      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASHBACK_RATE_UNCHANGED);
    });
  });

  describe("Function 'enableCashback()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));

      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.emit(cardPaymentProcessor, EVENT_NAME_ENABLE_CASHBACK);

      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(true);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        connect(cardPaymentProcessor, user1).enableCashback()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the cashback distributor was not configured", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASHBACK_DISTRIBUTOR_NOT_CONFIGURED);
    });

    it("Is reverted if the cashback operations are already enabled", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));
      await proveTx(cardPaymentProcessor.enableCashback());

      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASHBACK_ALREADY_ENABLED);
    });
  });

  describe("Function 'disableCashback()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));
      await proveTx(cardPaymentProcessor.enableCashback());
      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(true);

      await expect(cardPaymentProcessor.disableCashback()).to.emit(cardPaymentProcessor, EVENT_NAME_DISABLE_CASHBACK);

      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(false);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        connect(cardPaymentProcessor, user1).disableCashback()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the cashback operations are already disabled", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.disableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASHBACK_ALREADY_DISABLED);
    });
  });

  describe("Function 'setCashOutAccount()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);

      await expect(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address))
        .to.emit(cardPaymentProcessor, EVENT_NAME_SET_CASH_OUT_ACCOUNT)
        .withArgs(ZERO_ADDRESS, cashOutAccount.address);

      expect(await cardPaymentProcessor.cashOutAccount()).to.equal(cashOutAccount.address);

      // Can set the zero address
      await expect(cardPaymentProcessor.setCashOutAccount(ZERO_ADDRESS))
        .to.emit(cardPaymentProcessor, EVENT_NAME_SET_CASH_OUT_ACCOUNT)
        .withArgs(cashOutAccount.address, ZERO_ADDRESS);

      expect(await cardPaymentProcessor.cashOutAccount()).to.equal(ZERO_ADDRESS);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        connect(cardPaymentProcessor, user1).setCashOutAccount(cashOutAccount.address)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new cash-out account is the same as the previous set one", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setCashOutAccount(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASH_OUT_ACCOUNT_UNCHANGED);

      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));

      await expect(
        cardPaymentProcessor.setCashOutAccount(cashOutAccount.address)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_CASH_OUT_ACCOUNT_UNCHANGED);
    });
  });

  describe("Function 'makePayment()' with the extra amount parameter", async () => {
    /* Since all payment making functions use the same common internal function to execute,
     * the complete set of checks are provided in the test section for the 'makePaymentFor()' function.
     * In this section, only specific checks are provided.
     */
    describe("Executes as expected if the cashback is enabled and the base and extra payment amounts are", async () => {
      it("Both nonzero", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();

        cardPaymentProcessorShell.model.makePayment(context.payments[0]);
        const tx = connect(cardPaymentProcessorShell.contract, payment.account).makePayment(
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
          connect(cardPaymentProcessorShell.contract, payment.account).makePayment(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller is blocklisted", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await proveTx(cardPaymentProcessorShell.contract.grantRole(blocklisterRole, deployer.address));
        await proveTx(cardPaymentProcessorShell.contract.blocklist(payment.account.address));

        await expect(
          connect(cardPaymentProcessorShell.contract, payment.account).makePayment(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_BLOCKLISTED_ACCOUNT);
      });
    });
  });

  describe("Function 'makePaymentFor()'", async () => {
    async function checkPaymentMakingFor(
      context: TestContext,
      props: {
        sponsor?: HardhatEthersSigner;
        subsidyLimit?: number;
        cashbackEnabled?: boolean;
        cashbackRateInPermil?: number;
      } = {}
    ) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      if (props.cashbackEnabled ?? true) {
        await cardPaymentProcessorShell.enableCashback();
      }

      cardPaymentProcessorShell.model.makePayment(payment, {
        sponsor: props.sponsor,
        subsidyLimit: props.subsidyLimit,
        cashbackRateInPermil: props.cashbackRateInPermil,
        sender: executor
      });
      const tx = connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
        payment.account.address,
        payment.baseAmount,
        payment.extraAmount,
        payment.authorizationId,
        payment.correlationId,
        props.sponsor?.address ?? ZERO_ADDRESS,
        props.subsidyLimit ?? 0,
        props.cashbackRateInPermil ?? CASHBACK_RATE_AS_IN_CONTRACT
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if the payment is", async () => {
      describe("Not Sponsored. And if cashback is enabled and its rate is", async () => {
        describe("Determined by the contract settings. And if cashback is", async () => {
          describe("Enabled without restrictions. And if the base and extra payment amounts are", async () => {
            it("Both nonzero", async () => {
              const context = await beforeMakingPayments();
              await checkPaymentMakingFor(context);
            });

            it("Both nonzero. And if the subsidy limit argument is not zero", async () => {
              const context = await beforeMakingPayments();
              const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
              await checkPaymentMakingFor(context, { subsidyLimit });
            });

            it("Both zero", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].baseAmount = 0;
              context.payments[0].extraAmount = 0;
              await checkPaymentMakingFor(context);
            });

            it("Different: base is zero, extra is nonzero", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].baseAmount = 0;
              await checkPaymentMakingFor(context);
            });

            it("Different: base is nonzero, extra is zero", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].extraAmount = 0;
              await checkPaymentMakingFor(context);
            });

            it("Both nonzero even if the revocation limit of payments is zero", async () => {
              const context = await beforeMakingPayments();
              await proveTx(context.cardPaymentProcessorShell.contract.setRevocationLimit(0));
              await checkPaymentMakingFor(context);
            });

            it("Both nonzero and if cashback is partially sent with non-zero amount", async () => {
              const context = await beforeMakingPayments();
              const sentCashbackAmount = 2 * CASHBACK_ROUNDING_COEF;
              await context.cashbackDistributorMockShell.setSendCashbackAmountResult(sentCashbackAmount);
              await checkPaymentMakingFor(context);
            });

            it("Nonzero and if cashback is partially sent with zero amount", async () => {
              const context = await beforeMakingPayments();
              const sentCashbackAmount = 0;
              await context.cashbackDistributorMockShell.setSendCashbackAmountResult(sentCashbackAmount);
              await checkPaymentMakingFor(context);
            });
          });
          describe("Disabled. And if the base and extra payment amounts are", async () => {
            it("Both nonzero", async () => {
              const context = await beforeMakingPayments();
              await checkPaymentMakingFor(context, { cashbackEnabled: false });
            });
          });
          describe("Enabled but cashback sending fails. And if the base and extra payment amounts are", async () => {
            it("Both nonzero", async () => {
              const context = await beforeMakingPayments();
              await context.cashbackDistributorMockShell.setSendCashbackSuccessResult(false);
              await checkPaymentMakingFor(context);
            });
          });
        });
      });
      describe("Sponsored. And if the cashback rate is", async () => {
        describe("Determined by the contract settings. And if the base and extra payment amounts are", async () => {
          describe("Both nonzero. And if cashback is enabled and the subsidy limit is ", async () => {
            it("The same as the payment sum amount", async () => {
              const context = await beforeMakingPayments();
              const subsidyLimit = context.payments[0].baseAmount + context.payments[0].extraAmount;
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
            });

            it("Less than the payment sum amount but higher than the base amount", async () => {
              const context = await beforeMakingPayments();
              const subsidyLimit = context.payments[0].baseAmount + Math.floor(context.payments[0].extraAmount / 2);
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
            });

            it("Less than the base amount", async () => {
              const context = await beforeMakingPayments();
              const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
            });

            it("Zero", async () => {
              const context = await beforeMakingPayments();
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0 });
            });
          });

          describe("Both zero. And the subsidy limit is", async () => {
            it("Non-zero", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].baseAmount = 0;
              context.payments[0].extraAmount = 0;
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 10 });
            });

            it("Zero", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].baseAmount = 0;
              context.payments[0].extraAmount = 0;
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0 });
            });
          });

          describe("Different: base amount is zero, extra amount is nonzero. And the subsidy limit is", async () => {
            it("The same as the payment sum amount", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].baseAmount = 0;
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: context.payments[0].extraAmount });
            });

            it("Less than the payment sum amount", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].baseAmount = 0;
              const subsidyLimit = Math.floor(context.payments[0].extraAmount / 2);
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
            });

            it("Zero", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].baseAmount = 0;
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0 });
            });
          });

          describe("Different: base amount is nonzero, extra amount is zero. And the subsidy limit is", async () => {
            it("The same as the payment sum amount", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].extraAmount = 0;
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: context.payments[0].baseAmount });
            });

            it("Less than the payment sum amount", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].extraAmount = 0;
              const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
            });

            it("Zero", async () => {
              const context = await beforeMakingPayments();
              context.payments[0].extraAmount = 0;
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0 });
            });
          });
        });

        describe("Requested to be zero. And if the base and extra payment amounts are", async () => {
          describe("Both nonzero. And the subsidy limit is ", async () => {
            const cashbackRateInPermil = 0;

            it("Less than the base amount", async () => {
              const context = await beforeMakingPayments();
              const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit, cashbackRateInPermil });
            });

            it("Zero", async () => {
              const context = await beforeMakingPayments();
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0, cashbackRateInPermil });
            });
          });
        });

        describe("Requested to be a special value. And if the base and extra payment amounts are", async () => {
          describe("Both nonzero. And the subsidy limit is ", async () => {
            const cashbackRateInPermil = CASHBACK_RATE_IN_PERMIL + 100;

            it("Less than the base amount", async () => {
              const context = await beforeMakingPayments();
              const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit, cashbackRateInPermil });
            });

            it("Zero", async () => {
              const context = await beforeMakingPayments();
              await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0, cashbackRateInPermil });
            });
          });
        });
      });
    });

    describe("Is reverted if", async () => {
      const subsidyLimit = INITIAL_SPONSOR_BALANCE;

      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, payment.account).makePaymentFor(
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(payment.account.address, executorRole));
      });

      it("The payment account address is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
            ZERO_ADDRESS,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_ZERO_ACCOUNT);
      });

      it("The payment authorization ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            ZERO_AUTHORIZATION_ID,
            payment.correlationId,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_ZERO_AUTHORIZATION_ID
        );
      });

      it("The account has not enough token balance", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        const excessTokenAmount: number = INITIAL_USER_BALANCE + 1;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
            payment.account.address,
            excessTokenAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId,
            ZERO_ADDRESS,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT
          )
        ).to.be.revertedWith(ERROR_MESSAGE_ERC20_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("The sponsor has not enough token balance", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        const excessTokenAmount: number = INITIAL_SPONSOR_BALANCE + 1;
        const subsidyLimitLocal = excessTokenAmount + 1;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
            payment.account.address,
            excessTokenAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId,
            sponsor.address,
            subsidyLimitLocal,
            CASHBACK_RATE_AS_IN_CONTRACT
          )
        ).to.be.revertedWith(ERROR_MESSAGE_ERC20_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("The payment with the provided authorization ID already exists", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makePayments([payment]);
        const anotherCorrelationId: string = increaseBytesString(payment.correlationId, BYTES16_LENGTH);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            anotherCorrelationId,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_EXISTS);
      });

      it("The requested cashback rate exceeds the maximum allowed value", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
            payment.account.address,
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            payment.correlationId,
            sponsor.address,
            subsidyLimit,
            MAX_CASHBACK_RATE_IN_PERMIL + 1
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_CASHBACK_RATE_EXCESS);
      });
    });
  });

  describe("Function 'updatePaymentAmount()' with the extra amount parameter", async () => {
    enum NewBasePaymentAmountType {
      Same = 0,
      Less = 1,
      More = 2
    }

    enum NewExtraPaymentAmountType {
      Same = 0,
      FarLess = 1,
      FarMore = 2,
      SlightlyLess = 3,
      SlightlyMore = 4,
      Zero = 5
    }

    enum UpdatingConditionType {
      CashbackEnabled = 0,
      CashbackDisabledBeforePaymentMaking = 1,
      CashbackDisabledAfterPaymentMaking = 2,
      CashbackEnabledButRevokingFails = 3,
      CashbackEnabledButIncreasingFails = 4,
      CashbackEnabledButIncreasingPartial = 5
    }

    async function checkUpdatingForNonSubsidizedPayment(
      newBasePaymentAmountType: NewBasePaymentAmountType,
      newExtraPaymentAmountType: NewExtraPaymentAmountType,
      updatingCondition: UpdatingConditionType
    ) {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

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
          newBaseAmount = Math.floor(payment.baseAmount * 0.9);
          break;
        case NewBasePaymentAmountType.More:
          newBaseAmount = Math.floor(payment.baseAmount * 1.1);
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
        updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingPartial &&
        newBasePaymentAmountType === NewBasePaymentAmountType.More
      ) {
        const actualCashbackChange = 2 * CASHBACK_ROUNDING_COEF;
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
      const tx = connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
        newBaseAmount,
        newExtraAmount,
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB
      );

      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    async function checkUpdatingForSubsidizedPayment(props: {
      initBaseAmount: number;
      initExtraAmount: number;
      subsidyLimit: number;
      newBaseAmount: number;
      newExtraAmount: number;
    }) {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      payment.baseAmount = props.initBaseAmount;
      payment.extraAmount = props.initExtraAmount;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, props.subsidyLimit);

      cardPaymentProcessorShell.model.updatePaymentAmount(
        props.newBaseAmount,
        props.newExtraAmount,
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB
      );
      const tx = connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
        props.newBaseAmount,
        props.newExtraAmount,
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB
      );

      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if the payment is", async () => {
      describe("Not subsidized. And if the new base amount is", async () => {
        describe("Less than the initial one. And if the extra amount is", async () => {
          describe("The same as the initial one. And if cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackEnabled
              );
            });

            it("Disabled before payment making", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackDisabledBeforePaymentMaking
              );
            });

            it("Disabled after payment making", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackDisabledAfterPaymentMaking
              );
            });

            it("Enabled but cashback revoking fails", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackEnabledButRevokingFails
              );
            });
          });

          describe("Far less than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.FarLess,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Far more than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.FarMore,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Slightly more than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.SlightlyMore,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Zero. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Less,
                NewExtraPaymentAmountType.Zero,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });
        });

        describe("The same as the initial one. And the extra amount is", async () => {
          describe("The same as the initial one. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Same,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Far less than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Same,
                NewExtraPaymentAmountType.FarLess,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Far more than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Same,
                NewExtraPaymentAmountType.FarMore,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Zero. And cashback sending is", async () => {
            it("Enabled and cashback revoking is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.Same,
                NewExtraPaymentAmountType.Zero,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });
        });

        describe("More than the initial one. And the extra amount is", async () => {
          describe("The same as the initial one. And cashback sending is", async () => {
            it("Enabled and cashback increasing is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackEnabled
              );
            });

            it("Disabled before payment making", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackDisabledBeforePaymentMaking
              );
            });

            it("Disabled after payment making", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackDisabledAfterPaymentMaking
              );
            });

            it("Enabled but cashback increasing fails", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackEnabledButIncreasingFails
              );
            });

            it("Enabled but cashback increasing executes partially", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.Same,
                UpdatingConditionType.CashbackEnabledButIncreasingPartial
              );
            });
          });

          describe("Far less than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback increasing is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.FarLess,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Slightly less than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback increasing is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.SlightlyLess,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Far more than the initial one. And cashback sending is", async () => {
            it("Enabled and cashback increasing is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.FarMore,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });

          describe("Zero. And cashback sending is", async () => {
            it("Enabled and cashback increasing is executed successfully", async () => {
              await checkUpdatingForNonSubsidizedPayment(
                NewBasePaymentAmountType.More,
                NewExtraPaymentAmountType.Zero,
                UpdatingConditionType.CashbackEnabled
              );
            });
          });
        });
      });

      describe("Subsidized. And if the initial subsidy limit (SL) is ", async () => {
        describe("Less than the payment base amount. And if the payment changes are:", async () => {
          it("The base amount decreases but it is still above SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 500 * DIGITS_COEF,
              subsidyLimit: 700 * DIGITS_COEF,
              newBaseAmount: 800 * DIGITS_COEF,
              newExtraAmount: 500 * DIGITS_COEF
            });
          });

          it("The base amount decreases bellow SL but the sum amount is still above SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 500 * DIGITS_COEF,
              subsidyLimit: 700 * DIGITS_COEF,
              newBaseAmount: 600 * DIGITS_COEF,
              newExtraAmount: 500 * DIGITS_COEF
            });
          });

          it("The base amount decreases more and the sum amount becomes bellow SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 500 * DIGITS_COEF,
              subsidyLimit: 700 * DIGITS_COEF,
              newBaseAmount: 200 * DIGITS_COEF,
              newExtraAmount: 300 * DIGITS_COEF
            });
          });
        });

        describe("Between the payment base amount and the sum amount. And if the payment changes are:", async () => {
          it("The base amount decreases but the sum amount is still above SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 600 * DIGITS_COEF,
              subsidyLimit: 1200 * DIGITS_COEF,
              newBaseAmount: 800 * DIGITS_COEF,
              newExtraAmount: 600 * DIGITS_COEF
            });
          });

          it("The base amount decreases and the sum amount becomes bellow SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 600 * DIGITS_COEF,
              subsidyLimit: 1200 * DIGITS_COEF,
              newBaseAmount: 400 * DIGITS_COEF,
              newExtraAmount: 600 * DIGITS_COEF
            });
          });

          it("The base amount increases above SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 600 * DIGITS_COEF,
              subsidyLimit: 1200 * DIGITS_COEF,
              newBaseAmount: 1400 * DIGITS_COEF,
              newExtraAmount: 600 * DIGITS_COEF
            });
          });
        });

        describe("Above the payment sum amount. And if the payment changes are:", async () => {
          it("The payment sum amount decreases", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 600 * DIGITS_COEF,
              subsidyLimit: 2000 * DIGITS_COEF,
              newBaseAmount: 800 * DIGITS_COEF,
              newExtraAmount: 400 * DIGITS_COEF
            });
          });

          it("The payment sum amount increases but it is still below SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 600 * DIGITS_COEF,
              subsidyLimit: 2000 * DIGITS_COEF,
              newBaseAmount: 1200 * DIGITS_COEF,
              newExtraAmount: 700 * DIGITS_COEF
            });
          });

          it("The payment sum amount increases above SL but the base amount is still below SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 600 * DIGITS_COEF,
              subsidyLimit: 2000 * DIGITS_COEF,
              newBaseAmount: 1200 * DIGITS_COEF,
              newExtraAmount: 1000 * DIGITS_COEF
            });
          });

          it("The payment sum amount increases above SL and the base amount becomes above SL", async () => {
            await checkUpdatingForSubsidizedPayment({
              initBaseAmount: 1000 * DIGITS_COEF,
              initExtraAmount: 600 * DIGITS_COEF,
              subsidyLimit: 2000 * DIGITS_COEF,
              newBaseAmount: 2200 * DIGITS_COEF,
              newExtraAmount: 800 * DIGITS_COEF
            });
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
          connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, deployer).updatePaymentAmount(
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
          connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
            payment.baseAmount,
            payment.extraAmount,
            ZERO_AUTHORIZATION_ID,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_ZERO_AUTHORIZATION_ID
        );
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
      });

      it("The new base amount is less than the refund amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makePayments([payment]);
        const refundAmount = Math.floor(payment.baseAmount * 0.5);
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
            refundAmount - 1,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_INAPPROPRIATE_NEW_BASE_PAYMENT_AMOUNT
        );
      });

      it("The payment status is 'Cleared'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.clearPayments([payment]);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
        ).withArgs(PaymentStatus.Cleared);
      });

      it("The payment is subsidized and its refund amount is not zero", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        const subsidyLimit = 0;
        await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
        const refundAmount = 1;
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).updatePaymentAmount(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_SUBSIDIZED_PAYMENT_WITH_NON_ZERO_REFUND_AMOUNT
        );
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
      const tx = connect(cardPaymentProcessorShell.contract, executor).clearPayment(payment.authorizationId);
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
      const tx = connect(cardPaymentProcessorShell.contract, executor).clearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Executes as expected and emits the correct event if the payment is subsidized", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      const subsidyLimit = Math.floor(payment.baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      cardPaymentProcessorShell.model.clearPayment(payment.authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).clearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).clearPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;
      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_AUTHORIZATION_ID
      );
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
    });

    it("Is reverted if the payment has already been cleared", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.makePayments([payment]);
      await proveTx(connect(cardPaymentProcessorShell.contract, executor).clearPayment(payment.authorizationId));

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_CLEARED);
    });
  });

  describe("Function 'clearPayments()'", async () => {
    it("Executes as expected and emits the correct events", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments([payments[0]]);
      const subsidyLimit = Math.floor(payments[1].baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payments[1], sponsor, subsidyLimit);

      const operationIndex1 = cardPaymentProcessorShell.model.clearPayment(payments[0].authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.clearPayment(payments[1].authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).clearPayments([
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
        connect(cardPaymentProcessorShell.contract, executor).clearPayments([payment.authorizationId])
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).clearPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_EMPTY_AUTHORIZATION_IDS_ARRAY
      );
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayments([
          payments[0].authorizationId,
          ZERO_AUTHORIZATION_ID
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_AUTHORIZATION_ID
      );
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayments([
          payments[0].authorizationId,
          increaseBytesString(payments[1].authorizationId, BYTES16_LENGTH)
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
    });

    it("Is reverted if one of the payments has been already cleared", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);

      await proveTx(connect(cardPaymentProcessorShell.contract, executor).clearPayment(payments[1].authorizationId));

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearPayments([
          payments[0].authorizationId,
          payments[1].authorizationId
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_CLEARED);
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
      const tx = connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payment.authorizationId);
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
      const tx = connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Executes as expected and emits the correct event if the payment is subsidized", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      const subsidyLimit = Math.floor(payment.baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
      await cardPaymentProcessorShell.clearPayments([payment]);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      await context.checkCardPaymentProcessorState();

      cardPaymentProcessorShell.model.unclearPayment(payment.authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).unclearPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_AUTHORIZATION_ID
      );
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);

      await proveTx(connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payment.authorizationId));

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'unclearPayments()'", async () => {
    it("Executes as expected and emits the correct events", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      const subsidyLimit = Math.floor(payments[0].baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payments[0], sponsor, subsidyLimit);
      await cardPaymentProcessorShell.makePayments([payments[1]]);
      await cardPaymentProcessorShell.clearPayments(payments);

      const operationIndex1 = cardPaymentProcessorShell.model.unclearPayment(payments[0].authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.unclearPayment(payments[1].authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).unclearPayments([
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
        connect(cardPaymentProcessorShell.contract, executor).unclearPayments([payment.authorizationId])
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).unclearPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_EMPTY_AUTHORIZATION_IDS_ARRAY
      );
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayments([
          payments[0].authorizationId,
          ZERO_AUTHORIZATION_ID
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_AUTHORIZATION_ID
      );
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayments([
          payments[0].authorizationId,
          increaseBytesString(payments[1].authorizationId, BYTES16_LENGTH)
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await proveTx(connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payments[1].authorizationId));

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).unclearPayments([
          payments[0].authorizationId,
          payments[1].authorizationId
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'revokePayment()'", async () => {
    async function revokeSinglePaymentAndCheck(context: TestContext) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      // To be sure that the `refundAmount` field is taken into account
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount, payment.extraAmount);

      cardPaymentProcessorShell.model.revokePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      const tx = connect(cardPaymentProcessorShell.contract, executor).revokePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if the payment is ", async () => {
      describe("Not subsidized. And if", async () => {
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

      describe("Subsidized. And if cashback operations are enabled and the payment status is", async () => {
        describe("'Uncleared'. And if the initial subsidy limit (SL) is", async () => {
          it("Less than the payment base amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
            await revokeSinglePaymentAndCheck(context);
          });

          it("Between the payment base amount and the sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = payment.baseAmount + Math.floor(payment.extraAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
            await revokeSinglePaymentAndCheck(context);
          });

          it("Above the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = payment.baseAmount + payment.extraAmount + 100;
            await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
            await revokeSinglePaymentAndCheck(context);
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
          connect(cardPaymentProcessorShell.contract, executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, deployer).revokePayment(
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
          connect(cardPaymentProcessorShell.contract, executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_REVOCATION_LIMIT_REACHED
        );
      });

      it("The payment authorization ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).revokePayment(
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_ZERO_AUTHORIZATION_ID
        );
      });

      it("The parent transaction hash is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            ZERO_TRANSACTION_HASH
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_ZERO_PARENT_TRANSACTION_HASH);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).revokePayment(
            increaseBytesString(payment.authorizationId, BYTES16_LENGTH),
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
      });
    });
  });

  describe("Function 'reversePayment()'", async () => {
    async function reverseSinglePaymentAndCheck(context: TestContext) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      // To be sure that the `refundAmount` field is taken into account
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount, payment.extraAmount);

      cardPaymentProcessorShell.model.reversePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      const tx = connect(cardPaymentProcessorShell.contract, executor).reversePayment(
        payment.authorizationId,
        PAYMENT_REVOKING_CORRELATION_ID_STUB,
        payment.parentTxHash
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if the payment is", async () => {
      describe("Not Subsidized. And if", async () => {
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

      describe("Subsidized. And if cashback operations are enabled and the payment status is", async () => {
        describe("'Uncleared'. And if the initial subsidy limit (SL) is", async () => {
          it("Less than the payment base amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
            await reverseSinglePaymentAndCheck(context);
          });

          // Other conditions related to the initial subsidy limit are checked during testing the revoking function
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, deployer).reversePayment(
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
          connect(cardPaymentProcessorShell.contract, executor).reversePayment(
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_ZERO_AUTHORIZATION_ID
        );
      });

      it("The parent transaction hash is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            ZERO_TRANSACTION_HASH
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_ZERO_PARENT_TRANSACTION_HASH);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).reversePayment(
            increaseBytesString(payment.authorizationId, BYTES16_LENGTH),
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
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
      const tx = connect(cardPaymentProcessorShell.contract, executor).confirmPayment(payment.authorizationId);
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
      const tx = connect(cardPaymentProcessorShell.contract, executor).confirmPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Executes as expected and emits the correct event if the payment is subsidized", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      const subsidyLimit = Math.floor(payment.baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);
      await cardPaymentProcessorShell.clearPayments([payment]);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      cardPaymentProcessorShell.model.confirmPayment(payment.authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).confirmPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).confirmPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_AUTHORIZATION_ID
      );
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await cardPaymentProcessorShell.makePayments([payment]);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(PaymentStatus.Uncleared);
    });

    it("Is reverted if the cash-out account is the zero address", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await cardPaymentProcessorShell.makePayments([payment]);
      await cardPaymentProcessorShell.clearPayments([payment]);

      await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_CASH_OUT_ACCOUNT
      );
    });
  });

  describe("Function 'confirmPayments()'", async () => {
    it("Executes as expected and emits the correct events", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments([payments[0]]);
      const subsidyLimit = Math.floor(payments[1].baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payments[1], sponsor, subsidyLimit);
      await cardPaymentProcessorShell.clearPayments(payments);

      const operationIndex1 = cardPaymentProcessorShell.model.confirmPayment(payments[0].authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.confirmPayment(payments[1].authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).confirmPayments([
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
        connect(cardPaymentProcessorShell.contract, executor).confirmPayments([payment.authorizationId])
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).confirmPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_EMPTY_AUTHORIZATION_IDS_ARRAY
      );
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayments([
          payments[0].authorizationId,
          ZERO_AUTHORIZATION_ID
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_AUTHORIZATION_ID
      );
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayments([
          payments[0].authorizationId,
          increaseBytesString(payments[1].authorizationId, BYTES16_LENGTH)
        ])
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await proveTx(connect(cardPaymentProcessorShell.contract, executor).unclearPayment(payments[1].authorizationId));

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayments([
          payments[0].authorizationId,
          payments[1].authorizationId
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(PaymentStatus.Uncleared);
    });

    it("Is reverted if the cash-out account is the zero address", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments(payments);
      await cardPaymentProcessorShell.clearPayments(payments);

      await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).confirmPayments([
          payments[0].authorizationId,
          payments[1].authorizationId
        ])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_ZERO_CASH_OUT_ACCOUNT
      );
    });
  });

  describe("Function 'clearAndConfirmPayment()'", async () => {
    it("Executes as expected and emits the correct event if the payment is subsidized", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      const subsidyLimit = Math.floor(payment.baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);

      const operationIndex1 = cardPaymentProcessorShell.model.clearPayment(payment.authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.confirmPayment(payment.authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).clearAndConfirmPayment(payment.authorizationId);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx, [operationIndex1, operationIndex2]);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearAndConfirmPayment(payment.authorizationId)
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).clearAndConfirmPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    // Other conditions are checked during testing the clearing and confirming functions
  });

  describe("Function 'updateLazyClearConfirmPayment()'", async () => {
    enum NewBasePaymentAmountType {
      Same = 0,
      More = 1
    }

    enum NewExtraPaymentAmountType {
      Same = 0,
      More = 1
    }

    async function checkContractFunction(
      newBasePaymentAmountType: NewBasePaymentAmountType,
      newExtraPaymentAmountType: NewExtraPaymentAmountType
    ) {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      const subsidyLimit = Math.floor(payment.baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit);

      let newBaseAmount;
      if (newBasePaymentAmountType === NewBasePaymentAmountType.More) {
        newBaseAmount = payment.baseAmount + 1;
      } else {
        newBaseAmount = payment.baseAmount;
      }
      let newExtraAmount;
      if (newExtraPaymentAmountType === NewExtraPaymentAmountType.More) {
        newExtraAmount = payment.extraAmount + 1;
      } else {
        newExtraAmount = payment.extraAmount;
      }

      const operationIndexes: number[] = [];
      if (newBaseAmount !== payment.baseAmount || newExtraAmount !== payment.extraAmount) {
        const operationIndex1 = cardPaymentProcessorShell.model.updatePaymentAmount(
          newBaseAmount,
          newExtraAmount,
          payment.authorizationId,
          PAYMENT_UPDATING_CORRELATION_ID_STUB
        );
        operationIndexes.push(operationIndex1);
      }
      const operationIndex2 = cardPaymentProcessorShell.model.clearPayment(payment.authorizationId);
      operationIndexes.push(operationIndex2);
      const operationIndex3 = cardPaymentProcessorShell.model.confirmPayment(payment.authorizationId);
      operationIndexes.push(operationIndex3);

      const tx = connect(cardPaymentProcessorShell.contract, executor).updateLazyClearConfirmPayment(
        newBaseAmount,
        newExtraAmount,
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx, operationIndexes);
      await context.checkCardPaymentProcessorState();

      if (newBaseAmount === payment.baseAmount && newExtraAmount === payment.extraAmount) {
        await expect(tx).not.to.emit(cardPaymentProcessorShell.contract, EVENT_NAME_UPDATE_PAYMENT_AMOUNT);
      }
    }

    describe("Executes as expected and emits the correct event if the payment is subsidized and", async () => {
      it("The new base amount differs from the current one and the extra amount is the same", async () => {
        await checkContractFunction(NewBasePaymentAmountType.More, NewExtraPaymentAmountType.Same);
      });

      it("The new extra amount differs from the current one and the base amount is the same", async () => {
        await checkContractFunction(NewBasePaymentAmountType.Same, NewExtraPaymentAmountType.More);
      });

      it("The new base amount and extra amount are the same", async () => {
        await checkContractFunction(NewBasePaymentAmountType.Same, NewExtraPaymentAmountType.Same);
      });
    });

    describe("Is reverted if ", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).updateLazyClearConfirmPayment(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, deployer).updateLazyClearConfirmPayment(
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });
    });

    // Other conditions are checked during testing the updating, clearing, confirming functions
  });

  describe("Function 'clearAndConfirmPayments()'", async () => {
    it("Executes as expected and emits the correct events", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makePayments([payments[0]]);
      const subsidyLimit = Math.floor(payments[1].baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payments[1], sponsor, subsidyLimit);

      const operationIndex1 = cardPaymentProcessorShell.model.clearPayment(payments[0].authorizationId);
      const operationIndex2 = cardPaymentProcessorShell.model.clearPayment(payments[1].authorizationId);
      const operationIndex3 = cardPaymentProcessorShell.model.confirmPayment(payments[0].authorizationId);
      const operationIndex4 = cardPaymentProcessorShell.model.confirmPayment(payments[1].authorizationId);
      const tx = connect(cardPaymentProcessorShell.contract, executor).clearAndConfirmPayments([
        payments[0].authorizationId,
        payments[1].authorizationId
      ]);
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx, [
        operationIndex1,
        operationIndex2,
        operationIndex3,
        operationIndex4
      ]);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearAndConfirmPayments([payment.authorizationId])
      ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, deployer).clearAndConfirmPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        connect(cardPaymentProcessorShell.contract, executor).clearAndConfirmPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_EMPTY_AUTHORIZATION_IDS_ARRAY
      );
    });

    // Other conditions are checked during testing the clearing and confirming functions
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
      Zero = 2
    }

    async function checkRefundingForNonSubsidizedPayment(
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
      const tx = connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
        refundAmount,
        newExtraAmount,
        payment.authorizationId,
        PAYMENT_REFUNDING_CORRELATION_ID_STUB
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    async function checkRefundingForSubsidizedPayment(props: {
      initBaseAmount: number;
      initExtraAmount: number;
      subsidyLimit: number;
      refundAmount: number;
      newExtraAmount: number;
      paymentStatus: PaymentStatus;
    }) {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      payment.baseAmount = props.initBaseAmount;
      payment.extraAmount = props.initExtraAmount;
      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, props.subsidyLimit);

      if (props.paymentStatus == PaymentStatus.Cleared) {
        await cardPaymentProcessorShell.clearPayments([payment]);
      }
      if (props.paymentStatus == PaymentStatus.Confirmed) {
        await cardPaymentProcessorShell.clearPayments([payment]);
        await cardPaymentProcessorShell.confirmPayments([payment]);
      }

      cardPaymentProcessorShell.model.refundPayment(
        props.refundAmount,
        props.newExtraAmount,
        payment.authorizationId,
        PAYMENT_REFUNDING_CORRELATION_ID_STUB
      );
      const tx = connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
        props.refundAmount,
        props.newExtraAmount,
        payment.authorizationId,
        PAYMENT_REFUNDING_CORRELATION_ID_STUB
      );
      expect(tx).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected and emits the correct events if the payment is", async () => {
      describe("Not subsidized. And if the refund amount is", async () => {
        describe("Nonzero. And if the new extra amount of the payment is", async () => {
          describe("The same as the initial one. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Nonzero,
                NewExtraAmountType.Same,
                PaymentStatus.Uncleared
              );
            });
          });

          describe("Less than the initial one. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Nonzero,
                NewExtraAmountType.Less,
                PaymentStatus.Uncleared
              );
            });

            it("Cleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Nonzero,
                NewExtraAmountType.Less,
                PaymentStatus.Cleared
              );
            });

            it("Confirmed", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Nonzero,
                NewExtraAmountType.Less,
                PaymentStatus.Confirmed
              );
            });
          });

          describe("Zero. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Nonzero,
                NewExtraAmountType.Zero,
                PaymentStatus.Uncleared
              );
            });
          });
        });

        describe("Equals the base payment amount. And if the new extra amount of the payment is", async () => {
          describe("The same as the initial one. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Full,
                NewExtraAmountType.Same,
                PaymentStatus.Uncleared
              );
            });
          });

          describe("Less than the initial one. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Full,
                NewExtraAmountType.Less,
                PaymentStatus.Uncleared
              );
            });

            it("Cleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Full,
                NewExtraAmountType.Less,
                PaymentStatus.Cleared
              );
            });

            it("Confirmed", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Full,
                NewExtraAmountType.Less,
                PaymentStatus.Confirmed
              );
            });
          });

          describe("Zero. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Full,
                NewExtraAmountType.Zero,
                PaymentStatus.Uncleared
              );
            });
          });
        });

        describe("Zero. And if the new extra amount of the payment is", async () => {
          describe("The same as the initial one. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Zero,
                NewExtraAmountType.Same,
                PaymentStatus.Uncleared
              );
            });
          });

          describe("Less than the initial one. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Zero,
                NewExtraAmountType.Less,
                PaymentStatus.Uncleared
              );
            });

            it("Cleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Zero,
                NewExtraAmountType.Less,
                PaymentStatus.Cleared
              );
            });

            it("Confirmed", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Zero,
                NewExtraAmountType.Less,
                PaymentStatus.Confirmed
              );
            });
          });

          describe("Zero. And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForNonSubsidizedPayment(
                RefundType.Zero,
                NewExtraAmountType.Zero,
                PaymentStatus.Uncleared
              );
            });
          });
        });
      });
      describe("Subsidized. And if the refund amount is nonzero. And if the init subsidy limit (SL) is", async () => {
        describe("Less than the payment base amount. And if the new extra amount is", async () => {
          describe("Less than the initial one.  And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 800 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 400 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Uncleared
              });
            });

            it("Confirmed", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 800 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 400 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Confirmed
              });
            });
          });
        });

        describe("Between the payment base amount and the sum amount. And if the new extra amount is", async () => {
          describe("Less than the init one but the sum amount is above SL.  And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 1200 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 400 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Uncleared
              });
            });

            it("Confirmed", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 1200 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 400 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Confirmed
              });
            });
          });

          describe("Less than the init one and the sum amount is below SL.  And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 1200 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 100 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Uncleared
              });
            });

            it("Confirmed", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 1200 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 100 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Confirmed
              });
            });
          });
        });

        describe("Above the payment sum amount. And if the new extra amount is", async () => {
          describe("Less than the init one.  And if the payment status is", async () => {
            it("Uncleared", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 2000 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 400 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Uncleared
              });
            });

            it("Confirmed", async () => {
              await checkRefundingForSubsidizedPayment({
                initBaseAmount: 1000 * DIGITS_COEF,
                initExtraAmount: 600 * DIGITS_COEF,
                subsidyLimit: 2000 * DIGITS_COEF,
                refundAmount: 500 * DIGITS_COEF,
                newExtraAmount: 400 * DIGITS_COEF,
                paymentStatus: PaymentStatus.Confirmed
              });
            });
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
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, deployer)[FUNCTION_REFUND_PAYMENT_FULL](
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
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_ZERO_AUTHORIZATION_ID
        );
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_NOT_EXIST);
      });

      it("The refund amount exceeds the base payment amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        const refundAmount = payment.baseAmount + 1;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            refundAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_INAPPROPRIATE_REFUND_AMOUNT
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
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_ZERO_CASH_OUT_ACCOUNT
        );
      });

      it("The payment status is 'Revoked'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.revokePayment(payment);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
        ).withArgs(PaymentStatus.Revoked);
      });

      it("The payment status is 'Reversed'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        await cardPaymentProcessorShell.reversePayment(payment);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
        ).withArgs(PaymentStatus.Reversed);
      });

      it("The new extra amount exceeds the old one of the payment", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makePayments([payment]);
        payment.extraAmount += 1;

        await expect(
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_FULL](
            payment.baseAmount,
            payment.extraAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          ERROR_NAME_INAPPROPRIATE_NEW_EXTRA_PAYMENT_AMOUNT
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
          const tx = connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_PRUNED](
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
          connect(cardPaymentProcessorShell.contract, executor)[FUNCTION_REFUND_PAYMENT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          connect(cardPaymentProcessorShell.contract, deployer)[FUNCTION_REFUND_PAYMENT_PRUNED](
            payment.baseAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });
    });
  });

  describe("Function 'refundAccount()'", async () => {
    const nonZeroTokenAmount = 123;
    const zeroTokenAmount = 0;

    async function checkRefundingAccount(tokenAmount: number) {
      const { cardPaymentProcessorShell, tokenMock } = await prepareForPayments();
      await proveTx(tokenMock.mint(cashOutAccount.address, tokenAmount));

      const tx = await connect(cardPaymentProcessorShell.contract, executor).refundAccount(
        user1.address,
        tokenAmount,
        PAYMENT_REFUNDING_CORRELATION_ID_STUB
      );

      await expect(tx)
        .to.emit(cardPaymentProcessorShell.contract, EVENT_NAME_REFUND_ACCOUNT)
        .withArgs(PAYMENT_REFUNDING_CORRELATION_ID_STUB, user1.address, tokenAmount);

      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [user1, cashOutAccount, cardPaymentProcessorShell.contract],
        [+tokenAmount, -tokenAmount, 0]
      );
    }

    describe("Executes as expected and emits the correct events if the refund amount is", async () => {
      it("Nonzero", async () => {
        await checkRefundingAccount(nonZeroTokenAmount);
      });

      it("Zero", async () => {
        await checkRefundingAccount(zeroTokenAmount);
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { cardPaymentProcessorShell } = await prepareForPayments();
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).refundAccount(
            user1.address,
            nonZeroTokenAmount,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const { cardPaymentProcessorShell } = await prepareForPayments();

        await expect(
          connect(cardPaymentProcessorShell.contract, deployer).refundAccount(
            user1.address,
            nonZeroTokenAmount,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The account address is zero", async () => {
        const { cardPaymentProcessorShell } = await prepareForPayments();

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).refundAccount(
            ZERO_ADDRESS,
            nonZeroTokenAmount,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_ZERO_ACCOUNT);
      });

      it("The cash-out account does not have enough token balance", async () => {
        const { cardPaymentProcessorShell, tokenMock } = await prepareForPayments();
        const tokenAmount = nonZeroTokenAmount;
        await proveTx(tokenMock.mint(cashOutAccount.address, tokenAmount - 1));

        await expect(
          connect(cardPaymentProcessorShell.contract, executor).refundAccount(
            user1.address,
            tokenAmount,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(ERROR_MESSAGE_ERC20_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
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
      await expect(connect(cardPaymentProcessor, executor).clearPayment(authorizationIds[0]))
        .to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS)
        .withArgs(status);

      await expect(connect(cardPaymentProcessor, executor).clearPayments(authorizationIds))
        .to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS)
        .withArgs(status);

      await expect(connect(cardPaymentProcessor, executor).unclearPayment(authorizationIds[0]))
        .to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS)
        .withArgs(status);

      await expect(connect(cardPaymentProcessor, executor).unclearPayments(authorizationIds))
        .to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS)
        .withArgs(status);

      await expect(
        connect(cardPaymentProcessor, executor).revokePayment(
          authorizationIds[0],
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(status);

      await expect(
        connect(cardPaymentProcessor, executor).reversePayment(
          authorizationIds[0],
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(status);

      await expect(connect(cardPaymentProcessor, executor).confirmPayment(authorizationIds[0]))
        .to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS)
        .withArgs(status);

      await expect(connect(cardPaymentProcessor, executor).confirmPayments(authorizationIds))
        .to.be.revertedWithCustomError(cardPaymentProcessor, ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS)
        .withArgs(status);

      await expect(
        connect(cardPaymentProcessor, executor).updatePaymentAmount(
          payments[0].baseAmount,
          payments[0].extraAmount,
          authorizationIds[0],
          PAYMENT_UPDATING_CORRELATION_ID_STUB
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        ERROR_NAME_INAPPROPRIATE_PAYMENT_STATUS
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

      cardPaymentProcessorShell.model.makePayment(payments[0], { sender: executor });
      const tx = connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
        payments[0].account.address,
        payments[0].baseAmount,
        payments[0].extraAmount,
        payments[0].authorizationId,
        payments[0].correlationId,
        ZERO_SPONSOR_ADDRESS,
        ZERO_SUBSIDY_LIMIT,
        CASHBACK_RATE_AS_IN_CONTRACT
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
        connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId,
          ZERO_SPONSOR_ADDRESS,
          ZERO_SUBSIDY_LIMIT,
          CASHBACK_RATE_AS_IN_CONTRACT
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_EXISTS);

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
        connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId,
          ZERO_SPONSOR_ADDRESS,
          ZERO_SUBSIDY_LIMIT,
          CASHBACK_RATE_AS_IN_CONTRACT
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_EXISTS);

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
        connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId,
          ZERO_SPONSOR_ADDRESS,
          ZERO_SUBSIDY_LIMIT,
          CASHBACK_RATE_AS_IN_CONTRACT
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, ERROR_NAME_PAYMENT_ALREADY_EXISTS);
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
        connect(cardPaymentProcessorShell.contract, executor).makePaymentFor(
          payments[0].account.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          payments[0].authorizationId,
          payments[0].correlationId,
          ZERO_SPONSOR_ADDRESS,
          ZERO_SUBSIDY_LIMIT,
          CASHBACK_RATE_AS_IN_CONTRACT
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        ERROR_NAME_REVOCATION_LIMIT_REACHED
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

      const cashOutAccountBalanceBefore: bigint = await tokenMock.balanceOf(cashOutAccount.address);
      await cardPaymentProcessorShell.confirmPayments([payments[0]]);
      const cashOutAccountBalanceAfter: bigint = await tokenMock.balanceOf(cashOutAccount.address);
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
        Math.floor(payment.extraAmount * 1.1)
      );
      await cardPaymentProcessorShell.refundPayment(
        payment,
        Math.floor(payment.baseAmount * 0.2),
        Math.floor(payment.extraAmount * 0.1)
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
      await cardPaymentProcessorShell.refundPayment(payment, paymentModel.baseAmount - paymentModel.refundAmount, 0);
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

    it("Refunding executes as expected if the initial cashback was capped", async () => {
      const context = await beforeMakingPayments();
      const {
        cardPaymentProcessorShell,
        cashbackDistributorMockShell,
        payments: [payment]
      } = context;
      expect(payment).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await cardPaymentProcessorShell.enableCashback();
      await cashbackDistributorMockShell.setSendCashbackAmountResult(CASHBACK_ROUNDING_COEF);
      await cardPaymentProcessorShell.makePayments([payment]);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);
      await context.checkCardPaymentProcessorState();
    });

    it("Updating with cashback decreasing executes as expected if the initial cashback was capped", async () => {
      const context = await beforeMakingPayments();
      const {
        cardPaymentProcessorShell,
        cashbackDistributorMockShell,
        payments: [payment]
      } = context;
      expect(payment).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await cardPaymentProcessorShell.enableCashback();
      await cashbackDistributorMockShell.setSendCashbackAmountResult(CASHBACK_ROUNDING_COEF);
      await cardPaymentProcessorShell.makePayments([payment]);
      const newBaseAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.updatePaymentAmount(payment, newBaseAmount);
      await context.checkCardPaymentProcessorState();
    });

    it("Updating with cashback increasing executes as expected if the initial cashback was capped", async () => {
      const context = await beforeMakingPayments();
      const {
        cardPaymentProcessorShell,
        cashbackDistributorMockShell,
        payments: [payment]
      } = context;
      expect(payment).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await cardPaymentProcessorShell.enableCashback();
      await cashbackDistributorMockShell.setSendCashbackAmountResult(CASHBACK_ROUNDING_COEF);
      await cardPaymentProcessorShell.makePayments([payment]);
      const newBaseAmount = Math.floor(payment.baseAmount * 1.5);
      await cardPaymentProcessorShell.updatePaymentAmount(payment, newBaseAmount);
      await context.checkCardPaymentProcessorState();
    });
  });

  describe("Complex scenarios with subsidized payments and cashback rate control", async () => {
    it("Revoke a subsidized payment and make it again as not subsidized", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      expect(payment).to.be.not.undefined; // Silence TypeScript linter warning about assertion absence

      await cardPaymentProcessorShell.enableCashback();
      const subsidyLimit = Math.floor(payment.baseAmount / 2);
      const cashbackRate1 = 50; // 5%
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRate1);
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);
      await cardPaymentProcessorShell.revokePayment(payment);

      const cashbackRate2 = 150; // 15%
      const operationResult = await cardPaymentProcessorShell.makePaymentFor(
        payment,
        undefined, // sponsor
        subsidyLimit,
        cashbackRate2
      );

      await context.checkPaymentOperationsForTx(operationResult.tx);
      await context.checkCardPaymentProcessorState();
    });
  });

  describe("Token transfer demonstration scenarios", async () => {
    interface ExpectedBalanceChanges {
      user?: number;
      sponsor?: number;
      cardPaymentProcessor?: number;
      cashbackDistributor?: number;
      cashOutAccount?: number;
    }

    async function checkBalanceChanges(
      context: TestContext,
      operationResult: Promise<OperationResult>,
      expectedBalanceChanges: ExpectedBalanceChanges
    ) {
      const tx = (await operationResult).tx;
      await expect(tx).to.changeTokenBalances(
        context.tokenMock,
        [
          context.payments[0].account,
          sponsor,
          context.cardPaymentProcessorShell.contract,
          context.cashbackDistributorMockShell.contract,
          context.cashOutAccount
        ],
        [
          expectedBalanceChanges.user ?? 0,
          expectedBalanceChanges.sponsor ?? 0,
          expectedBalanceChanges.cardPaymentProcessor ?? 0,
          expectedBalanceChanges.cashbackDistributor ?? 0,
          expectedBalanceChanges.cashOutAccount ?? 0
        ]
      );
    }

    it("Making a payment with cashback, example 1: a partially subsidized payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 400 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %

      await cardPaymentProcessorShell.enableCashback();
      const opResult = cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);

      const cashbackChange = 40 * DIGITS_COEF;
      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: -600 * DIGITS_COEF + cashbackChange,
        sponsor: -800 * DIGITS_COEF,
        cardPaymentProcessor: 1400 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Making a payment with cashback, example 2: a fully subsidized payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 400 * DIGITS_COEF;
      const subsidyLimit = 2000 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %

      await cardPaymentProcessorShell.enableCashback();
      const opResult = cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);

      const cashbackChange = 0;
      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: -0 + cashbackChange,
        sponsor: -1400 * DIGITS_COEF,
        cardPaymentProcessor: 1400 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Making a payment with cashback, example 3: cashback rounding up", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      const subsidyLimit = 0;
      const cashbackRateInPermil = 200; // 20 %
      payment.baseAmount = Math.floor((2.5 * CASHBACK_ROUNDING_COEF) / (cashbackRateInPermil / 1000));
      payment.extraAmount = 0;

      await cardPaymentProcessorShell.enableCashback();
      const opResult = cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);

      const cashbackChange = 3 * CASHBACK_ROUNDING_COEF;
      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: -payment.baseAmount + cashbackChange,
        sponsor: -0,
        cardPaymentProcessor: payment.baseAmount,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Making a payment with cashback, example 4: cashback rounding down", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      const subsidyLimit = 0;
      const cashbackRateInPermil = 200; // 20 %
      payment.baseAmount = Math.floor((2.49999 * CASHBACK_ROUNDING_COEF) / (cashbackRateInPermil / 1000));
      payment.extraAmount = 0;

      await cardPaymentProcessorShell.enableCashback();
      const opResult = cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);

      const cashbackChange = 2 * CASHBACK_ROUNDING_COEF;
      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: -payment.baseAmount + cashbackChange,
        sponsor: -0,
        cardPaymentProcessor: payment.baseAmount,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Updating a payment with cashback, example 1: increasing a partially subsidized payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 400 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %
      const newBaseAmount = 1200 * DIGITS_COEF;
      const newExtraAmount = 600 * DIGITS_COEF;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      const opResult = cardPaymentProcessorShell.updatePaymentAmount(payment, newBaseAmount, newExtraAmount);

      const oldCashback = 40 * DIGITS_COEF;
      const newCashback = 80 * DIGITS_COEF;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: -400 * DIGITS_COEF + cashbackChange,
        sponsor: 0,
        cardPaymentProcessor: +400 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Updating a payment with cashback, example 2: decreasing a partially subsidized payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1200 * DIGITS_COEF;
      payment.extraAmount = 600 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %
      const newBaseAmount = 400 * DIGITS_COEF;
      const newExtraAmount = 200 * DIGITS_COEF;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      const opResult = cardPaymentProcessorShell.updatePaymentAmount(payment, newBaseAmount, newExtraAmount);

      const oldCashback = 80 * DIGITS_COEF;
      const newCashback = 0;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: +1000 * DIGITS_COEF + cashbackChange,
        sponsor: +200 * DIGITS_COEF,
        cardPaymentProcessor: -1200 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Updating a payment with cashback, example 3: increasing a fully subsidized payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 400 * DIGITS_COEF;
      payment.extraAmount = 200 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %
      const newBaseAmount = 1200 * DIGITS_COEF;
      const newExtraAmount = 600 * DIGITS_COEF;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      const opResult = cardPaymentProcessorShell.updatePaymentAmount(payment, newBaseAmount, newExtraAmount);

      const oldCashback = 0;
      const newCashback = 80 * DIGITS_COEF;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: -1000 * DIGITS_COEF + cashbackChange,
        sponsor: -200 * DIGITS_COEF,
        cardPaymentProcessor: +1200 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Refunding a payment with cashback, example 1: the extra amount is the same", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 600 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %
      const refundAmount = 400 * DIGITS_COEF;
      const newExtraAmount = payment.extraAmount;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      const opResult = cardPaymentProcessorShell.refundPayment(payment, refundAmount, newExtraAmount);

      const oldCashback = 40 * DIGITS_COEF;
      const newCashback = 24 * DIGITS_COEF;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: +80 * DIGITS_COEF + cashbackChange,
        sponsor: +320 * DIGITS_COEF,
        cardPaymentProcessor: -400 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Refunding a payment with cashback, example 2: the extra amount is lower", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 600 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %
      const refundAmount = 400 * DIGITS_COEF;
      const newExtraAmount = 200 * DIGITS_COEF;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      const opResult = cardPaymentProcessorShell.refundPayment(payment, refundAmount, newExtraAmount);

      const oldCashback = 40 * DIGITS_COEF;
      const newCashback = 24 * DIGITS_COEF;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: +480 * DIGITS_COEF + cashbackChange,
        sponsor: +320 * DIGITS_COEF,
        cardPaymentProcessor: -800 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Refunding a payment with cashback, example 3: refunding a confirmed payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 600 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %
      const refundAmount = 400 * DIGITS_COEF;
      const newExtraAmount = 200 * DIGITS_COEF;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      await cardPaymentProcessorShell.clearPayments([payment]);
      await cardPaymentProcessorShell.confirmPayments([payment]);
      const opResult = cardPaymentProcessorShell.refundPayment(payment, refundAmount, newExtraAmount);

      const oldCashback = 40 * DIGITS_COEF;
      const newCashback = 24 * DIGITS_COEF;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: +480 * DIGITS_COEF + cashbackChange,
        sponsor: +320 * DIGITS_COEF,
        cardPaymentProcessor: 0,
        cashbackDistributor: -cashbackChange,
        cashOutAccount: -800 * DIGITS_COEF
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Revoking a payment with cashback, example 1: a partially subsidized payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 400 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      const opResult = cardPaymentProcessorShell.revokePayment(payment);

      const oldCashback = 40 * DIGITS_COEF;
      const newCashback = 0;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: +600 * DIGITS_COEF + cashbackChange,
        sponsor: +800 * DIGITS_COEF,
        cardPaymentProcessor: -1400 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Revoking a payment with cashback, example 2: a fully subsidized payment", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 400 * DIGITS_COEF;
      const subsidyLimit = 2000 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      const opResult = cardPaymentProcessorShell.revokePayment(payment);

      const oldCashback = 0;
      const newCashback = 0;
      const cashbackChange = newCashback - oldCashback;

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        user: cashbackChange,
        sponsor: +1400 * DIGITS_COEF,
        cardPaymentProcessor: -1400 * DIGITS_COEF,
        cashbackDistributor: -cashbackChange
      };
      await checkBalanceChanges(context, opResult, expectedBalanceChanges);
    });

    it("Confirming a payment with cashback, example 1", async () => {
      const context = await beforeMakingPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      payment.baseAmount = 1000 * DIGITS_COEF;
      payment.extraAmount = 400 * DIGITS_COEF;
      const subsidyLimit = 800 * DIGITS_COEF;
      const cashbackRateInPermil = 200; // 20 %

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment, sponsor, subsidyLimit, cashbackRateInPermil);
      await cardPaymentProcessorShell.clearPayments([payment]);
      const [opResult] = await cardPaymentProcessorShell.confirmPayments([payment]);

      const expectedBalanceChanges: ExpectedBalanceChanges = {
        cardPaymentProcessor: -1400 * DIGITS_COEF,
        cashOutAccount: +1400 * DIGITS_COEF
      };
      await checkBalanceChanges(context, Promise.resolve(opResult), expectedBalanceChanges);
    });
  });
});
