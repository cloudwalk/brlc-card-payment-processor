import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../test-utils/eth";
import { createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { TransactionReceipt, TransactionResponse } from "@ethersproject/abstract-provider";
import { checkEventField, checkEventFieldNotEqual, EventFieldCheckingOptions } from "../test-utils/checkers";

const MAX_UINT256 = ethers.constants.MaxUint256;
const MAX_INT256 = ethers.constants.MaxInt256;
const MAX_UINT_64 = BigNumber.from("0xffffffffffffffff");
const ZERO_ADDRESS = ethers.constants.AddressZero;
const ZERO_PAYER_ADDRESS = ethers.constants.AddressZero;
const ZERO_SPONSOR_ADDRESS = ethers.constants.AddressZero;
const ZERO_CONFIRMATION_AMOUNT = 0;
const ZERO_REFUND_AMOUNT = 0;
const ZERO_SUBSIDY_LIMIT = 0;
const BYTES32_LENGTH: number = 32;
const CASHBACK_RATE_AS_IN_CONTRACT = -1;
const ZERO_CASHBACK_RATE = 0;
const CASHBACK_ROUNDING_COEF = 10000;
const DIGITS_COEF = 1000000;
const INITIAL_USER_BALANCE = 1000_000 * DIGITS_COEF;
const INITIAL_SPONSOR_BALANCE = INITIAL_USER_BALANCE * 2;
const CASHBACK_FACTOR = 1000;

const EVENT_DATA_FIELD_VERSION_DEFAULT_VALUE = "01";
const EVENT_DATA_FIELD_FLAGS_NON_SUBSIDIZED = "00";
const EVENT_DATA_FIELD_FLAGS_SUBSIDIZED = "01";
const EVENT_DATA_FIELD_CHARS_FOR_AMOUNT = 16;
const eventDataFieldCheckingOptions: EventFieldCheckingOptions = {
  showValuesInErrorMessage: true,
  caseInsensitiveComparison: true
};

const EVENT_NAME_ACCOUNT_REFUNDED = "AccountRefunded";
const EVENT_NAME_ENABLE_CASHBACK = "EnableCashback";
const EVENT_NAME_DISABLE_CASHBACK = "DisableCashback";
const EVENT_NAME_INCREASE_CASHBACK_FAILURE = "IncreaseCashbackFailure";
const EVENT_NAME_INCREASE_CASHBACK_MOCK = "IncreaseCashbackMock";
const EVENT_NAME_INCREASE_CASHBACK_SUCCESS = "IncreaseCashbackSuccess";
const EVENT_NAME_PAYMENT_CONFIRMED_AMOUNT_CHANGED = "PaymentConfirmedAmountChanged";
const EVENT_NAME_PAYMENT_MADE = "PaymentMade";
const EVENT_NAME_PAYMENT_REFUNDED = "PaymentRefunded";
const EVENT_NAME_PAYMENT_REVERSED = "PaymentReversed";
const EVENT_NAME_PAYMENT_REVOKED = "PaymentRevoked";
const EVENT_NAME_PAYMENT_UPDATED = "PaymentUpdated";
const EVENT_NAME_PAYMENTS_MERGED = "PaymentsMerged";
const EVENT_NAME_REVOKE_CASHBACK_FAILURE = "RevokeCashbackFailure";
const EVENT_NAME_REVOKE_CASHBACK_MOCK = "RevokeCashbackMock";
const EVENT_NAME_REVOKE_CASHBACK_SUCCESS = "RevokeCashbackSuccess";
const EVENT_NAME_SEND_CASHBACK_FAILURE = "SendCashbackFailure";
const EVENT_NAME_SEND_CASHBACK_MOCK = "SendCashbackMock";
const EVENT_NAME_SEND_CASHBACK_SUCCESS = "SendCashbackSuccess";
const EVENT_NAME_SET_CASH_OUT_ACCOUNT = "SetCashOutAccount";
const EVENT_NAME_SET_CASHBACK_DISTRIBUTOR = "SetCashbackDistributor";
const EVENT_NAME_SET_CASHBACK_RATE = "SetCashbackRate";

enum PaymentStatus {
  Nonexistent = 0,
  Active = 1,
  Merged = 2,
  Revoked = 3,
  Reversed = 4,
  MergePrepared = 5
}

enum CashbackKind {
  // Manual = 0,
  CardPayment = 1,
}

enum CashbackMergingFailureKind {
  NotEnoughBalance = 0,
  RevocationError = 1,
  IncreaseError = 2
}

interface TestPayment {
  id: string;
  payer: SignerWithAddress;
  baseAmount: number;
  extraAmount: number;
}

interface PaymentModel {
  paymentId: string;
  status: PaymentStatus;
  payer: SignerWithAddress;
  cashbackEnabled: boolean;
  cashbackRate: number;
  confirmedAmount: number;
  sponsor?: SignerWithAddress;
  subsidyLimit: number;
  baseAmount: number;
  extraAmount: number;
  cashbackAmount: number;
  refundAmount: number;
  mergedCashbackAmount: number;
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

enum CashbackOperationKind {
  Undefined = 0,
  None = 1,
  Sending = 2,
  Increase = 3,
  Revocation = 4,
  SingleMerge = 5,
  AggregatedMerge = 6
}

enum OperationKind {
  Undefined = 0,
  Making = 1,
  Updating = 2,
  Revoking = 3,
  Reversing = 4,
  Confirming = 5,
  Refunding = 6,
  MergePreparation = 7,
  SingleMerging = 8,
  AggregatedMerging = 9
}

enum UpdatingOperationKind {
  Full = 0,
  Lazy = 1
}

interface PaymentOperation {
  kind: OperationKind;
  paymentId: string;
  paymentStatus: PaymentStatus;
  sender?: SignerWithAddress;
  payer: SignerWithAddress;
  oldBaseAmount: number;
  newBaseAmount: number;
  oldExtraAmount: number;
  newExtraAmount: number;
  oldConfirmationAmount: number;
  newConfirmationAmount: number;
  oldRefundAmount: number;
  newRefundAmount: number;
  oldReminder: number;
  newReminder: number;
  oldCashbackAmount: number;
  oldPayerSumAmount: number;
  newPayerSumAmount: number;
  oldPayerRefundAmount: number;
  newPayerRefundAmount: number;
  oldPayerReminder: number;
  newPayerReminder: number;
  cashbackEnabled: boolean;
  cashbackOperationKind: CashbackOperationKind,
  cashbackOperationSucceeded: boolean;
  cashbackRequestedChange: number; // From the user point of view, if "+" then the user earns cashback
  cashbackActualChange: number; // From the user point of view, if "+" then the user earns cashback
  cashbackRate: number;
  cashbackNonce: number;
  sponsor?: SignerWithAddress;
  subsidyLimit: number;
  oldSponsorSumAmount: number;
  newSponsorSumAmount: number;
  oldSponsorRefundAmount: number;
  newSponsorRefundAmount: number;
  oldSponsorReminder: number;
  newSponsorReminder: number;
  senderBalanceChange: number;
  cardPaymentProcessorBalanceChange: number;
  cashOutAccountBalanceChange: number;
  payerBalanceChange: number;
  sponsorBalanceChange: number;
  updatingOperationKind: UpdatingOperationKind;
  mergedPaymentIds: string[];
}

interface Fixture {
  cardPaymentProcessor: Contract;
  tokenMock: Contract;
  cashbackDistributorMock: Contract;
  cashbackDistributorMockConfig: CashbackDistributorMockConfig;
}

interface AmountParts {
  payerBaseAmount: number;
  payerExtraAmount: number;
  payerSumAmount: number;
  sponsorBaseAmount: number;
  sponsorExtraAmount: number;
  sponsorSumAmount: number;
}

interface RefundParts {
  payerRefundAmount: number;
  sponsorRefundAmount: number;
}

interface PaymentConfirmation {
  paymentId: string;
  amount: number;
}

enum CashbackConditionType {
  CashbackEnabled = 0,
  CashbackDisabledBeforePaymentMaking = 1,
  CashbackDisabledAfterPaymentMaking = 2,
  CashbackEnabledButRevokingFails = 3,
  CashbackEnabledButIncreasingFails = 4,
  CashbackEnabledButIncreasingPartial = 5,
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

  async increaseSendCashbackNonceResult() {
    await proveTx(this.contract.setSendCashbackNonceResult(this.config.sendCashbackNonceResult + 1));
    this.config.sendCashbackNonceResult += 1;
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
  #cashbackRate: number;
  #paymentPerId: Map<string, PaymentModel> = new Map<string, PaymentModel>();
  #totalBalance: number = 0;
  #totalConfirmedAmount: number = 0;
  #cashbackPerPaymentId: Map<string, CashbackModel> = new Map<string, CashbackModel>();
  #paymentMakingOperations: PaymentOperation[] = [];
  #paymentOperations: PaymentOperation[] = [];

  constructor(props: {
    cashbackDistributorMockConfig: CashbackDistributorMockConfig;
    cashbackRateInPermil: number,
  }) {
    this.#cashbackDistributorMockConfig = props.cashbackDistributorMockConfig;
    this.#cashbackRate = props.cashbackRateInPermil;
  }

  makePayment(
    payment: TestPayment,
    props: {
      sponsor?: SignerWithAddress,
      subsidyLimit?: number,
      cashbackRate?: number,
      confirmationAmount?: number
      sender?: SignerWithAddress
    } = {}
  ): number {
    const paymentModel: PaymentModel = this.#createPayment(payment);
    const operation: PaymentOperation = this.#createPaymentOperation(paymentModel, OperationKind.Making);
    operation.sender = props.sender ?? payment.payer;
    operation.oldBaseAmount = 0;
    operation.oldExtraAmount = 0;
    operation.oldReminder = 0;
    operation.sponsor = props.sponsor;
    operation.subsidyLimit = !operation.sponsor ? 0 : (props.subsidyLimit ?? 0);
    operation.cashbackOperationKind = CashbackOperationKind.Sending;
    operation.newConfirmationAmount = props.confirmationAmount ?? 0;
    if (!!props.cashbackRate && props.cashbackRate > 0) {
      operation.cashbackRate = props.cashbackRate;
    } else if (props.cashbackRate === 0) {
      operation.cashbackEnabled = false;
      operation.cashbackRate = 0;
    }
    this.#checkPaymentConfirming(operation);
    this.#definePaymentOperation(operation);
    return this.#registerPaymentMakingOperation(operation, paymentModel);
  }

  updatePayment(
    paymentId: string,
    newBaseAmount: number,
    newExtraAmount: number,
    updatingOperationKind: UpdatingOperationKind = UpdatingOperationKind.Full
  ): number {
    const payment: PaymentModel = this.getPaymentById(paymentId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Updating);
    operation.newBaseAmount = newBaseAmount;
    operation.newExtraAmount = newExtraAmount;
    operation.updatingOperationKind = updatingOperationKind;
    this.#checkPaymentUpdating(operation);
    this.#definePaymentOperation(operation);
    return this.#registerPaymentOperation(operation, payment);
  }

  revokePayment(paymentId: string): number {
    const payment: PaymentModel = this.getPaymentById(paymentId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Revoking);
    operation.newBaseAmount = 0;
    operation.newExtraAmount = 0;
    operation.newConfirmationAmount = 0;
    operation.newRefundAmount = 0;
    this.#checkPaymentCanceling(operation);
    this.#definePaymentOperation(operation);
    this.#updateModelDueToPaymentCancelingOperation(operation);
    return this.#registerPaymentCancelingOperation(operation, payment, PaymentStatus.Revoked);
  }

  reversePayment(paymentId: string): number {
    const payment: PaymentModel = this.getPaymentById(paymentId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Reversing);
    operation.newBaseAmount = 0;
    operation.newExtraAmount = 0;
    operation.newConfirmationAmount = 0;
    operation.newRefundAmount = 0;
    this.#checkPaymentCanceling(operation);
    this.#definePaymentOperation(operation);
    this.#updateModelDueToPaymentCancelingOperation(operation);
    return this.#registerPaymentCancelingOperation(operation, payment, PaymentStatus.Reversed);
  }

  confirmPayment(paymentId: string, confirmationAmount: number): number {
    const payment: PaymentModel = this.getPaymentById(paymentId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Confirming);
    operation.cardPaymentProcessorBalanceChange = -confirmationAmount;
    operation.cashOutAccountBalanceChange = confirmationAmount;
    operation.newConfirmationAmount = operation.oldConfirmationAmount + confirmationAmount;
    this.#checkPaymentConfirming(operation);
    return this.#registerPaymentOperation(operation, payment);
  }

  refundPayment(
    paymentId: string,
    refundingAmount: number,
  ): number {
    const payment: PaymentModel = this.getPaymentById(paymentId);
    const operation: PaymentOperation = this.#createPaymentOperation(payment, OperationKind.Refunding);
    operation.newRefundAmount = operation.oldRefundAmount + refundingAmount;
    this.#checkPaymentRefunding(operation);
    this.#definePaymentOperation(operation);
    return this.#registerPaymentOperation(operation, payment);
  }

  mergePayments(
    targetPaymentId: string,
    mergedPaymentIds: string[]
  ): number[] {
    const operationIndexes: number[] = [];
    for (const mergedPaymentId of mergedPaymentIds) {
      operationIndexes.push(this.#preparePaymentMerge(mergedPaymentId));
      operationIndexes.push(this.#mergeTwoPayments(targetPaymentId, mergedPaymentId));
    }
    const firstMergingOperation: PaymentOperation = this.getPaymentOperation(operationIndexes[1]);
    const lastMergingOperation: PaymentOperation =
      this.getPaymentOperation(operationIndexes[operationIndexes.length - 1]);

    if (firstMergingOperation.payer.address !== lastMergingOperation.payer.address) {
      throw new Error("The payer address does not match in the first and last merging operations");
    }

    const aggregatedMergeOperation: PaymentOperation = { ...firstMergingOperation };
    aggregatedMergeOperation.kind = OperationKind.AggregatedMerging;
    aggregatedMergeOperation.newBaseAmount = lastMergingOperation.newBaseAmount;
    aggregatedMergeOperation.newExtraAmount = lastMergingOperation.newExtraAmount;
    aggregatedMergeOperation.newConfirmationAmount = lastMergingOperation.newConfirmationAmount;
    aggregatedMergeOperation.newRefundAmount = lastMergingOperation.newRefundAmount;
    aggregatedMergeOperation.newReminder = lastMergingOperation.newReminder;
    aggregatedMergeOperation.newPayerSumAmount = lastMergingOperation.newPayerSumAmount;
    aggregatedMergeOperation.newPayerRefundAmount = lastMergingOperation.newPayerRefundAmount;
    aggregatedMergeOperation.newPayerReminder = lastMergingOperation.newPayerReminder;
    aggregatedMergeOperation.cashbackOperationKind = CashbackOperationKind.AggregatedMerge;
    aggregatedMergeOperation.cashbackOperationSucceeded = true;
    aggregatedMergeOperation.cashbackRequestedChange =
      lastMergingOperation.oldCashbackAmount +
      lastMergingOperation.cashbackActualChange -
      firstMergingOperation.oldCashbackAmount;
    aggregatedMergeOperation.cashbackActualChange = aggregatedMergeOperation.cashbackRequestedChange;
    aggregatedMergeOperation.newSponsorSumAmount = lastMergingOperation.newSponsorSumAmount;
    aggregatedMergeOperation.newSponsorRefundAmount = lastMergingOperation.newSponsorRefundAmount;
    aggregatedMergeOperation.newSponsorReminder = lastMergingOperation.newSponsorReminder;
    aggregatedMergeOperation.senderBalanceChange = 0; // It will be defined by single operations
    aggregatedMergeOperation.cardPaymentProcessorBalanceChange = 0; // It will be defined by single operations
    aggregatedMergeOperation.cashOutAccountBalanceChange = 0; // It will be defined by single operations
    aggregatedMergeOperation.payerBalanceChange = 0; // It will be defined by single operations
    aggregatedMergeOperation.sponsorBalanceChange = 0; // It will be defined by single operations
    aggregatedMergeOperation.mergedPaymentIds = mergedPaymentIds;
    const aggregatedMergeOperationIndex = this.#paymentOperations.push(aggregatedMergeOperation) - 1;
    operationIndexes.push(aggregatedMergeOperationIndex);
    return operationIndexes;
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

  getPaymentIds(): Set<string> {
    return new Set(this.#paymentPerId.keys());
  }

  getPaymentById(paymentId: string): PaymentModel {
    const payment = this.#paymentPerId.get(paymentId);
    if (!payment) {
      throw Error(`A payment is not in the model. Payment id = ${paymentId}`);
    }
    return payment;
  }

  getCashbackByPaymentId(paymentId: string): CashbackModel | undefined {
    return this.#cashbackPerPaymentId.get(paymentId);
  }

  getPayerAddresses(): Set<string> {
    return new Set(
      this.#paymentMakingOperations.map(operation => operation.payer.address)
    );
  }

  get totalBalance(): number {
    return this.#totalBalance;
  }

  get totalConfirmedAmount(): number {
    return this.#totalConfirmedAmount;
  }

  getPaymentOperation(operationIndex: number): PaymentOperation {
    return this.#getOperationByIndex(this.#paymentOperations, operationIndex, "");
  }

  #createPayment(payment: TestPayment): PaymentModel {
    const currentPayment: PaymentModel = this.#paymentPerId.get(payment.id);
    if (!!currentPayment && currentPayment.status != PaymentStatus.Revoked) {
      throw new Error(
        `A payment with the provided ID already exists in the model and its status is not "Revoked".` +
        `Payment id=${payment.id}`
      );
    }
    return {
      paymentId: payment.id,
      status: PaymentStatus.Active,
      payer: payment.payer,
      cashbackEnabled: this.#cashbackEnabled,
      cashbackRate: this.#cashbackRate,
      confirmedAmount: 0,
      sponsor: undefined,
      subsidyLimit: 0,
      baseAmount: payment.baseAmount,
      extraAmount: payment.extraAmount,
      cashbackAmount: 0,
      refundAmount: 0,
      mergedCashbackAmount: 0
    };
  }

  #createPaymentOperation(payment: PaymentModel, kind: OperationKind): PaymentOperation {
    const cashback = this.getCashbackByPaymentId(payment.paymentId);
    const reminder = payment.baseAmount + payment.extraAmount - payment.refundAmount;
    const amountParts: AmountParts =
      this.#defineAmountParts(payment.baseAmount, payment.extraAmount, payment.subsidyLimit);
    const refundParts: RefundParts =
      this.#defineRefundParts(payment.refundAmount, payment.baseAmount, payment.subsidyLimit);
    const sponsorReminder: number = amountParts.sponsorSumAmount - refundParts.sponsorRefundAmount;
    return {
      kind,
      paymentId: payment.paymentId,
      paymentStatus: payment.status,
      sender: undefined,
      payer: payment.payer,
      oldBaseAmount: payment.baseAmount,
      newBaseAmount: payment.baseAmount,
      oldExtraAmount: payment.extraAmount,
      newExtraAmount: payment.extraAmount,
      oldConfirmationAmount: payment.confirmedAmount,
      newConfirmationAmount: payment.confirmedAmount,
      oldRefundAmount: payment.refundAmount,
      newRefundAmount: payment.refundAmount,
      oldReminder: reminder,
      newReminder: reminder,
      oldPayerSumAmount: amountParts.payerSumAmount,
      newPayerSumAmount: amountParts.sponsorSumAmount,
      oldPayerRefundAmount: refundParts.payerRefundAmount,
      newPayerRefundAmount: refundParts.payerRefundAmount,
      oldPayerReminder: reminder - sponsorReminder,
      newPayerReminder: reminder - sponsorReminder,
      cashbackEnabled: payment.cashbackEnabled,
      oldCashbackAmount: payment.cashbackAmount,
      cashbackOperationKind: CashbackOperationKind.Undefined,
      cashbackOperationSucceeded: false,
      cashbackRequestedChange: 0,
      cashbackActualChange: 0,
      cashbackRate: payment.cashbackRate,
      cashbackNonce: cashback?.lastCashbackNonce ?? 0,
      sponsor: payment.sponsor,
      subsidyLimit: payment.subsidyLimit,
      oldSponsorSumAmount: amountParts.sponsorSumAmount,
      newSponsorSumAmount: amountParts.sponsorSumAmount,
      oldSponsorRefundAmount: refundParts.sponsorRefundAmount,
      newSponsorRefundAmount: refundParts.sponsorRefundAmount,
      oldSponsorReminder: sponsorReminder,
      newSponsorReminder: sponsorReminder,
      senderBalanceChange: 0,
      cardPaymentProcessorBalanceChange: 0,
      cashOutAccountBalanceChange: 0,
      payerBalanceChange: 0,
      sponsorBalanceChange: 0,
      updatingOperationKind: UpdatingOperationKind.Full,
      mergedPaymentIds: []
    };
  }

  #definePaymentOperation(operation: PaymentOperation) {
    const newAmountParts: AmountParts =
      this.#defineAmountParts(operation.newBaseAmount, operation.newExtraAmount, operation.subsidyLimit);
    const newRefundParts: RefundParts =
      this.#defineRefundParts(operation.newRefundAmount, operation.newBaseAmount, operation.subsidyLimit);
    const oldPayerReminder: number = operation.oldReminder - operation.oldSponsorReminder;
    const newPayerReminder: number = newAmountParts.payerSumAmount - newRefundParts.payerRefundAmount;
    const newSponsorReminder: number = newAmountParts.sponsorSumAmount - newRefundParts.sponsorRefundAmount;
    const newRemainder: number = operation.newBaseAmount + operation.newExtraAmount - operation.newRefundAmount;
    if (newRemainder < operation.newConfirmationAmount) {
      operation.newConfirmationAmount = newRemainder;
    }

    operation.newReminder = newRemainder;
    operation.newPayerSumAmount = newAmountParts.payerSumAmount;
    operation.newSponsorSumAmount = newAmountParts.sponsorSumAmount;
    operation.newPayerRefundAmount = newRefundParts.payerRefundAmount;
    operation.newSponsorRefundAmount = newRefundParts.sponsorRefundAmount;
    operation.newPayerReminder = newPayerReminder;
    operation.newSponsorReminder = newSponsorReminder;
    if (
      operation.kind !== OperationKind.MergePreparation &&
      operation.kind !== OperationKind.SingleMerging &&
      operation.kind !== OperationKind.AggregatedMerging
    ) {
      operation.payerBalanceChange = oldPayerReminder - newPayerReminder;
      operation.sponsorBalanceChange = operation.oldSponsorReminder - newSponsorReminder;
      operation.cardPaymentProcessorBalanceChange -= (operation.payerBalanceChange + operation.sponsorBalanceChange);
      operation.cardPaymentProcessorBalanceChange -=
        (operation.newConfirmationAmount - operation.oldConfirmationAmount);
      operation.cashOutAccountBalanceChange = operation.newConfirmationAmount - operation.oldConfirmationAmount;
    }

    this.#defineCashbackOperation(operation);

    if (!operation.cashbackEnabled) {
      return;
    }

    if (
      operation.cashbackOperationKind == CashbackOperationKind.Increase
      || operation.cashbackOperationKind == CashbackOperationKind.Sending
    ) {
      operation.payerBalanceChange += operation.cashbackActualChange;
    }
    if (operation.cashbackOperationKind == CashbackOperationKind.Revocation) {
      operation.payerBalanceChange += operation.cashbackRequestedChange;
      operation.cardPaymentProcessorBalanceChange -=
        (operation.cashbackRequestedChange - operation.cashbackActualChange);
    }

    if (operation.sender === operation.payer) {
      operation.senderBalanceChange = operation.payerBalanceChange;
    }
  }

  #defineCashbackOperation(operation: PaymentOperation) {
    if (!operation.cashbackEnabled) {
      operation.cashbackOperationKind = CashbackOperationKind.None;
      operation.cashbackOperationSucceeded = false;
      operation.cashbackRequestedChange = 0;
      operation.cashbackActualChange = 0;
      return;
    }
    if (
      operation.cashbackOperationKind !== CashbackOperationKind.None &&
      operation.cashbackOperationKind !== CashbackOperationKind.SingleMerge &&
      operation.cashbackOperationKind !== CashbackOperationKind.AggregatedMerge
    ) {
      const newAmountParts: AmountParts =
        this.#defineAmountParts(operation.newBaseAmount, operation.newExtraAmount, operation.subsidyLimit);
      const refundParts: RefundParts =
        this.#defineRefundParts(operation.newRefundAmount, operation.newBaseAmount, operation.subsidyLimit);
      const newCashbackAmount = this.#calculateCashback(
        newAmountParts.payerBaseAmount,
        refundParts.payerRefundAmount,
        operation.cashbackRate
      );
      operation.cashbackRequestedChange = newCashbackAmount - operation.oldCashbackAmount;
    }
    if (operation.cashbackOperationKind === CashbackOperationKind.Undefined) {
      if (operation.cashbackRequestedChange > 0) {
        operation.cashbackOperationKind = CashbackOperationKind.Increase;
      } else if (operation.cashbackRequestedChange < 0) {
        operation.cashbackOperationKind = CashbackOperationKind.Revocation;
      } else {
        operation.cashbackOperationKind = CashbackOperationKind.None;
      }
      const cashbackModel = this.getCashbackByPaymentId(operation.paymentId);
      operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
    } else if (operation.cashbackOperationKind == CashbackOperationKind.Sending) {
      if (operation.cashbackRequestedChange < 0) {
        throw new Error("The cashback amount change is negative during the cashback sending operation");
      }
      operation.cashbackNonce = this.#cashbackDistributorMockConfig.sendCashbackNonceResult;
      const cashbackModel: CashbackModel = { lastCashbackNonce: operation.cashbackNonce };
      this.#cashbackPerPaymentId.set(operation.paymentId, cashbackModel);
    } else if (operation.cashbackOperationKind == CashbackOperationKind.SingleMerge) {
      if (operation.cashbackRequestedChange < 0) {
        throw new Error("The cashback amount change is negative during the cashback merge operation");
      } else if (operation.cashbackRequestedChange > 0) {
        operation.cashbackOperationKind = CashbackOperationKind.Increase;
        const cashbackModel = this.getCashbackByPaymentId(operation.paymentId);
        operation.cashbackNonce = cashbackModel?.lastCashbackNonce ?? 0;
      } else {
        operation.cashbackOperationKind = CashbackOperationKind.None;
      }
    }
    operation.cashbackActualChange = 0;
    operation.cashbackOperationSucceeded = false;
    if (operation.cashbackOperationKind == CashbackOperationKind.Increase) {
      if (this.#cashbackDistributorMockConfig.increaseCashbackSuccessResult) {
        operation.cashbackOperationSucceeded = true;
        if (this.#cashbackDistributorMockConfig.increaseCashbackAmountResult < 0) {
          operation.cashbackActualChange = operation.cashbackRequestedChange;
        } else {
          operation.cashbackActualChange = this.#cashbackDistributorMockConfig.increaseCashbackAmountResult;
        }
      }
    } else if (operation.cashbackOperationKind == CashbackOperationKind.Revocation) {
      if (this.#cashbackDistributorMockConfig.revokeCashbackSuccessResult) {
        operation.cashbackOperationSucceeded = true;
        operation.cashbackActualChange = operation.cashbackRequestedChange;
      }
    } else if (operation.cashbackOperationKind == CashbackOperationKind.Sending) {
      if (this.#cashbackDistributorMockConfig.sendCashbackSuccessResult) {
        operation.cashbackOperationSucceeded = true;
        if (this.#cashbackDistributorMockConfig.sendCashbackAmountResult < 0) {
          operation.cashbackActualChange = operation.cashbackRequestedChange;
        } else {
          operation.cashbackActualChange = this.#cashbackDistributorMockConfig.sendCashbackAmountResult;
        }
      } else {
        operation.cashbackRate = 0;
      }
    }
  }

  #registerPaymentOperation(operation: PaymentOperation, payment: PaymentModel): number {
    payment.baseAmount = operation.newBaseAmount;
    payment.extraAmount = operation.newExtraAmount;
    payment.refundAmount = operation.newRefundAmount;
    payment.confirmedAmount = operation.newConfirmationAmount;
    payment.cashbackAmount += operation.cashbackActualChange;
    this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    this.#totalConfirmedAmount += operation.cashOutAccountBalanceChange;
    return this.#paymentOperations.push(operation) - 1;
  }

  #registerPaymentMakingOperation(operation: PaymentOperation, payment: PaymentModel): number {
    payment.cashbackEnabled = operation.cashbackEnabled;
    payment.cashbackRate = operation.cashbackRate;
    if (!!operation.sponsor) {
      payment.sponsor = operation.sponsor;
      payment.subsidyLimit = operation.subsidyLimit;
    }
    this.#paymentPerId.set(payment.paymentId, payment);
    this.#paymentMakingOperations.push(operation);
    return this.#registerPaymentOperation(operation, payment);
  }

  #calculateCashback(baseAmount: number, refundAmount: number, cashbackRate: number) {
    if (baseAmount < refundAmount) {
      return 0;
    }
    const amount = baseAmount - refundAmount;
    const cashback = Math.floor(amount * cashbackRate / CASHBACK_FACTOR);
    return this.#roundCashback(cashback, CASHBACK_ROUNDING_COEF);
  }

  #roundCashback(cashback: number, roundingCoefficient: number): number {
    return Math.floor(Math.floor(cashback + roundingCoefficient / 2) / roundingCoefficient) * roundingCoefficient;
  }

  #getPaymentByMakingOperationIndex(paymentMakingOperationIndex: number): PaymentModel {
    const paymentOperation: PaymentOperation = this.#paymentMakingOperations[paymentMakingOperationIndex];
    const paymentId = paymentOperation.paymentId;
    return this.getPaymentById(paymentId);
  }

  #checkPaymentUpdating(operation: PaymentOperation) {
    if (operation.paymentStatus !== PaymentStatus.Active) {
      throw new Error(
        `The payment has inappropriate status: ${operation.paymentStatus}`
      );
    }
    if (operation.newRefundAmount > operation.newBaseAmount + operation.newExtraAmount) {
      throw new Error(
        `The new sum amount is wrong for the payment with the id=${operation.paymentId}. ` +
        `The new sum amount: ${operation.newBaseAmount + operation.newExtraAmount}. ` +
        `The old sum amount: ${operation.oldBaseAmount + operation.oldExtraAmount}. ` +
        `The payment refund amount: ${operation.newRefundAmount}`
      );
    }
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

  #checkPaymentCanceling(operation: PaymentOperation) {
    if (operation.paymentStatus !== PaymentStatus.Active) {
      throw new Error(
        `The payment has inappropriate status: ${operation.paymentStatus}`
      );
    }
  }

  #updateModelDueToPaymentCancelingOperation(operation: PaymentOperation) {
    this.#totalBalance += operation.cardPaymentProcessorBalanceChange;
    this.#totalConfirmedAmount += operation.cashOutAccountBalanceChange;
  }

  #registerPaymentCancelingOperation(operation: PaymentOperation, payment: PaymentModel, targetStatus: PaymentStatus) {
    payment.status = targetStatus;
    return this.#paymentOperations.push(operation) - 1;
  }

  #checkPaymentConfirming(operation: PaymentOperation) {
    if (operation.paymentStatus !== PaymentStatus.Active) {
      throw new Error(
        `The payment has inappropriate status: ${operation.paymentStatus}`
      );
    }
    const reminder: number = operation.newBaseAmount + operation.newExtraAmount - operation.newRefundAmount;
    if (operation.newConfirmationAmount > reminder) {
      throw new Error(
        `The confirmation amount is wrong for the payment with id=${operation.paymentId}. ` +
        `The old payment confirmed amount: ${operation.oldConfirmationAmount}. ` +
        `The new confirmation amount: ${operation.newConfirmationAmount}. ` +
        `The payment reminder: ${reminder}.`
      );
    }
  }

  #checkPaymentRefunding(operation: PaymentOperation) {
    if (operation.paymentStatus !== PaymentStatus.Active) {
      throw new Error(
        `The payment has inappropriate status: ${operation.paymentStatus}`
      );
    }
    if (operation.newRefundAmount > (operation.newBaseAmount + operation.newExtraAmount)) {
      throw new Error(
        `The new refund amount is wrong for the payment with id=${operation.paymentId}. ` +
        `The old refund amount: ${operation.oldRefundAmount}. ` +
        `The new refund amount: ${operation.newRefundAmount}. ` +
        `The payment sum amount: ${operation.newBaseAmount + operation.newExtraAmount}`
      );
    }
  }

  #defineAmountParts(paymentBaseAmount: number, paymentExtraAmount: number, subsidyLimit: number): AmountParts {
    const result: AmountParts = {
      payerBaseAmount: paymentBaseAmount,
      payerExtraAmount: paymentExtraAmount,
      payerSumAmount: paymentBaseAmount + paymentExtraAmount,
      sponsorBaseAmount: 0,
      sponsorExtraAmount: 0,
      sponsorSumAmount: 0,
    };
    if (subsidyLimit >= (paymentBaseAmount + paymentExtraAmount)) {
      result.sponsorBaseAmount = paymentBaseAmount;
      result.payerBaseAmount = 0;
      result.sponsorExtraAmount = paymentExtraAmount;
      result.payerExtraAmount = 0;
    } else if (subsidyLimit >= paymentBaseAmount) {
      result.sponsorBaseAmount = paymentBaseAmount;
      result.payerBaseAmount = 0;
      result.sponsorExtraAmount = subsidyLimit - paymentBaseAmount;
      result.payerExtraAmount = paymentExtraAmount - result.sponsorExtraAmount;
    } else {
      result.sponsorBaseAmount = subsidyLimit;
      result.payerBaseAmount = paymentBaseAmount - result.sponsorBaseAmount;
      result.sponsorExtraAmount = 0;
      result.payerExtraAmount = paymentExtraAmount;
    }
    result.payerSumAmount = result.payerBaseAmount + result.payerExtraAmount;
    result.sponsorSumAmount = result.sponsorBaseAmount + result.sponsorExtraAmount;
    return result;
  }

  #defineRefundParts(paymentRefundAmount: number, paymentBaseAmount: number, subsidyLimit: number): RefundParts {
    let sponsorRefundAmount;
    if (subsidyLimit === 0) {
      sponsorRefundAmount = 0;
    } else if (subsidyLimit >= paymentBaseAmount) {
      sponsorRefundAmount = paymentRefundAmount;
    } else {
      sponsorRefundAmount = Math.floor(paymentRefundAmount * subsidyLimit / paymentBaseAmount);
      if (sponsorRefundAmount > subsidyLimit) {
        sponsorRefundAmount = subsidyLimit;
      }
    }
    return {
      payerRefundAmount: paymentRefundAmount - sponsorRefundAmount,
      sponsorRefundAmount
    };
  }


  #preparePaymentMerge(
    mergedPaymentId: string
  ): number {
    const mergedPayment: PaymentModel = this.getPaymentById(mergedPaymentId);
    const operation: PaymentOperation = this.#createPaymentOperation(mergedPayment, OperationKind.MergePreparation);
    operation.newBaseAmount = 0;
    operation.newExtraAmount = 0;
    operation.newConfirmationAmount = 0;
    operation.newRefundAmount = 0;
    this.#checkPaymentCanceling(operation);
    this.#definePaymentOperation(operation);
    this.#updateModelDueToPaymentCancelingOperation(operation);
    mergedPayment.mergedCashbackAmount = -operation.cashbackActualChange;
    return this.#registerPaymentCancelingOperation(operation, mergedPayment, PaymentStatus.MergePrepared);
  }

  #mergeTwoPayments(
    targetPaymentId: string,
    mergedPaymentId: string,
  ): number {
    const targetPayment: PaymentModel = this.getPaymentById(targetPaymentId);
    const mergedPayment: PaymentModel = this.getPaymentById(mergedPaymentId);
    const operation: PaymentOperation = this.#createPaymentOperation(targetPayment, OperationKind.SingleMerging);
    this.#checkPaymentMerging(operation, mergedPayment);
    operation.newBaseAmount += mergedPayment.baseAmount;
    operation.newExtraAmount += mergedPayment.extraAmount;
    operation.newRefundAmount += mergedPayment.refundAmount;
    operation.newConfirmationAmount += mergedPayment.confirmedAmount;
    operation.cashbackOperationKind = CashbackOperationKind.SingleMerge;
    operation.cashbackRequestedChange = mergedPayment.mergedCashbackAmount;
    this.#definePaymentOperation(operation);
    mergedPayment.status = PaymentStatus.Merged;
    return this.#registerPaymentOperation(operation, targetPayment);
  }

  #checkPaymentMerging(operation: PaymentOperation, mergedPayment: PaymentModel) {
    if (operation.paymentStatus !== PaymentStatus.Active) {
      throw new Error(
        `The target payment has inappropriate status: ${operation.paymentStatus}`
      );
    }
    if (operation.sponsor) {
      throw new Error(
        `The target payment is subsidized with sponsor address: ${operation.sponsor.address}`
      );
    }
    if (mergedPayment.status !== PaymentStatus.MergePrepared) {
      throw new Error(
        `The merged payment has inappropriate status: ${mergedPayment.status}`
      );
    }
    if (mergedPayment.payer.address !== operation.payer.address) {
      throw new Error(
        `The payer addresses of the merged payment and target payment do not match. ` +
        `targetPayment.payer.address=${operation.payer.address}. ` +
        `mergedPayment.payer.address=${mergedPayment.payer.address}.`
      );
    }
    if (mergedPayment.cashbackRate > operation.cashbackRate) {
      throw new Error(
        `The merged payment cashback rate is greater than the target payment cashback rate. ` +
        `targetPayment.cashbackRate=${operation.cashbackRate}. ` +
        `mergedPayment.cashbackRate=${mergedPayment.cashbackRate}.`
      );
    }
  }
}

interface OperationResult {
  operationIndex: number,
  tx: Promise<TransactionResponse>,
  txReceipt: TransactionReceipt,
}

interface OperationConditions {
  confirmationAmountChangedInAnyOperation: boolean;
  cashbackSendingRequestedInAnyOperation: boolean;
  cashbackIncreaseRequestedInAnyOperation: boolean;
  cashbackRevocationRequestedInAnyOperation: boolean;
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

  async makeCommonPayments(
    payments: TestPayment[],
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult[]> {
    const operationResults: OperationResult[] = [];
    for (let payment of payments) {
      const operationIndex = this.model.makePayment(payment, { sender });
      const tx = this.contract.connect(sender).makeCommonPaymentFor(
        payment.id,
        payment.payer.address,
        payment.baseAmount,
        payment.extraAmount
      );
      const txReceipt: TransactionReceipt = await proveTx(tx);
      operationResults.push({
        operationIndex,
        tx,
        txReceipt,
      });
    }
    return operationResults;
  }

  async makePaymentFor(
    payment: TestPayment,
    props: {
      sponsor?: SignerWithAddress,
      subsidyLimit?: number,
      cashbackRate?: number,
      confirmationAmount?: number
      sender?: SignerWithAddress
    } = {}
  ): Promise<OperationResult> {
    if (!props.sender) {
      props.sender = this.executor;
    }
    if (!props.subsidyLimit) {
      props.sponsor = undefined;
    }
    const operationIndex = this.model.makePayment(payment, props);
    const tx = this.contract.connect(props.sender).makePaymentFor(
      payment.id,
      payment.payer.address,
      payment.baseAmount,
      payment.extraAmount,
      props.sponsor?.address ?? ZERO_SPONSOR_ADDRESS,
      props.subsidyLimit ?? 0,
      props.cashbackRate ?? CASHBACK_RATE_AS_IN_CONTRACT,
      props.confirmationAmount ?? 0
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async updatePayment(
    payment: TestPayment,
    newBaseAmount: number,
    newExtraAmount: number = payment.extraAmount,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.updatePayment(
      payment.id,
      newBaseAmount,
      newExtraAmount,
      UpdatingOperationKind.Full
    );
    const tx = this.contract.connect(sender).updatePayment(
      payment.id,
      newBaseAmount,
      newExtraAmount
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async revokePayment(
    payment: TestPayment,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.revokePayment(payment.id);
    const tx = this.contract.connect(sender).revokePayment(payment.id);
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
    const operationIndex = this.model.reversePayment(payment.id);
    const tx = this.contract.connect(sender).reversePayment(payment.id);
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async confirmPayment(
    payment: TestPayment,
    confirmationAmount: number,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.confirmPayment(payment.id, confirmationAmount);
    const tx = this.contract.connect(sender).confirmPayment(payment.id, confirmationAmount);
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async refundPayment(
    payment: TestPayment,
    refundAmount: number,
    sender: SignerWithAddress = this.executor
  ): Promise<OperationResult> {
    const operationIndex = this.model.refundPayment(
      payment.id,
      refundAmount
    );
    const tx = this.contract.connect(sender).refundPayment(
      payment.id,
      refundAmount
    );
    const txReceipt: TransactionReceipt = await proveTx(tx);
    return {
      operationIndex,
      tx,
      txReceipt
    };
  }

  async mergePayments(
    targetPayment: TestPayment,
    mergedPayments: TestPayment[],
    sender: SignerWithAddress = this.executor
  ) {
    const mergedPaymentIds: string[] = mergedPayments.map(payment => payment.id);
    const operationIndex = this.model.mergePayments(
      targetPayment.id,
      mergedPaymentIds
    );
    const tx = this.contract.connect(sender).mergePayments(
      targetPayment.id,
      mergedPaymentIds
    );
  }
}

function encodeEventDataFieldForAmount(amount: number): string {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`The provided amount is not valid for encoding as an event data field: ${amount}`);
  }
  return amount.toString(16).padStart(EVENT_DATA_FIELD_CHARS_FOR_AMOUNT, "0");
}

function encodeEventDataFieldForAddress(address: string | undefined): string {
  if (!address) {
    throw new Error(`The provided address is not valid for encoding as an event data field: ${address}`);
  }
  if (address.startsWith("0x")) {
    if (address.length != 42) {
      throw new Error(`The provided address is not valid for encoding as an event data field: ${address}`);
    }
    return address.slice(2);
  } else {
    if (address.length != 40) {
      throw new Error(`The provided address is not valid for encoding as an event data field: ${address}`);
    }
    return address;
  }
}

function defineEventDataField(...parts: string[]): string {
  return "0x" + parts.join("");
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

  async setUpContractsForPayments(payments: TestPayment[] = this.payments) {
    const accounts: Set<SignerWithAddress> = new Set(payments.map(payment => payment.payer));
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

  async checkPaymentOperationsForTx(tx: Promise<TransactionResponse>, paymentOperationIndexes: number[] = [-1]) {
    const operations: PaymentOperation[] = paymentOperationIndexes.map(
      (index) => this.cardPaymentProcessorShell.model.getPaymentOperation(index)
    );
    const operationConditions: OperationConditions = this.defineOperationConditions(operations);

    for (let operation of operations) {
      await this.checkMainEvents(tx, operation);
      await this.checkConfirmationEvents(tx, operation, operationConditions);
      await this.checkCashbackEvents(
        operation,
        tx,
        operationConditions
      );
    }

    await this.checkBalanceChanges(tx, operations);
  }

  defineOperationConditions(operations: PaymentOperation[]): OperationConditions {
    const result: OperationConditions = {
      cashbackIncreaseRequestedInAnyOperation: false,
      cashbackRevocationRequestedInAnyOperation: false,
      cashbackSendingRequestedInAnyOperation: false,
      confirmationAmountChangedInAnyOperation: false
    };
    operations.forEach(operation => {
      if (operation.cashbackOperationKind == CashbackOperationKind.Sending) {
        result.cashbackSendingRequestedInAnyOperation = true;
      } else if (operation.cashbackOperationKind == CashbackOperationKind.Increase) {
        result.cashbackIncreaseRequestedInAnyOperation = true;
      } else if (operation.cashbackOperationKind == CashbackOperationKind.Revocation) {
        result.cashbackRevocationRequestedInAnyOperation = true;
      }
      if (operation.newConfirmationAmount != operation.oldConfirmationAmount) {
        result.confirmationAmountChangedInAnyOperation = true;
      }
    });

    return result;
  }

  async checkMainEvents(
    tx: Promise<TransactionResponse>,
    operation: PaymentOperation
  ) {
    switch (operation.kind) {
      case OperationKind.Undefined:
        break;
      case OperationKind.Making:
        await this.checkMakingEvents(tx, operation);
        break;
      case OperationKind.Updating:
        await this.checkUpdatingEvents(tx, operation);
        break;
      case OperationKind.Revoking:
        await this.checkCancelingEvents(tx, operation);
        break;
      case OperationKind.Reversing:
        await this.checkCancelingEvents(tx, operation);
        break;
      case OperationKind.Confirming:
        // Do nothing. It will be checked in another function.
        break;
      case OperationKind.Refunding:
        await this.checkRefundingEvents(tx, operation);
        break;
      case OperationKind.MergePreparation:
        // Do nothing. We should check only cashback events here.
        break;
      case OperationKind.SingleMerging:
        // Do nothing. We should check cashback events here and the main event in another function
        break;
      case OperationKind.AggregatedMerging:
        await this.checkMergingEvent(tx, operation);
        break;
      default:
        throw new Error(
          `An unknown operation kind was found: ${operation.kind}`
        );
    }
  }

  async checkConfirmationEvents(
    tx: Promise<TransactionResponse>,
    operation: PaymentOperation,
    operationConditions: OperationConditions
  ) {
    if (operation.kind === OperationKind.SingleMerging || operation.kind === OperationKind.MergePreparation) {
      // Individual confirmation events of payments merging do not exist, only the aggregated one does.
      return;
    }
    const expectedDataField: string = defineEventDataField(
      EVENT_DATA_FIELD_VERSION_DEFAULT_VALUE,
      !operation.sponsor ? EVENT_DATA_FIELD_FLAGS_NON_SUBSIDIZED : EVENT_DATA_FIELD_FLAGS_SUBSIDIZED,
      encodeEventDataFieldForAmount(operation.oldConfirmationAmount),
      encodeEventDataFieldForAmount(operation.newConfirmationAmount),
      !operation.sponsor ? "" : encodeEventDataFieldForAddress(operation.sponsor?.address),
    );

    if (operation.newConfirmationAmount != operation.oldConfirmationAmount) {
      await expect(tx).to.emit(
        this.cardPaymentProcessorShell.contract,
        EVENT_NAME_PAYMENT_CONFIRMED_AMOUNT_CHANGED
      ).withArgs(
        checkEventField("paymentId", operation.paymentId),
        checkEventField("payer", operation.payer.address),
        checkEventField("data", expectedDataField, eventDataFieldCheckingOptions)
      );
    } else if (operationConditions.confirmationAmountChangedInAnyOperation) {
      await expect(tx).to.emit(
        this.cardPaymentProcessorShell.contract,
        EVENT_NAME_PAYMENT_CONFIRMED_AMOUNT_CHANGED
      ).withArgs(
        checkEventField("paymentId", operation.paymentId),
        checkEventField("payer", operation.payer.address),
        checkEventFieldNotEqual("data", expectedDataField, eventDataFieldCheckingOptions)
      );
    } else {
      await expect(tx).not.to.emit(
        this.cardPaymentProcessorShell.contract,
        EVENT_NAME_PAYMENT_CONFIRMED_AMOUNT_CHANGED
      );
    }
  }

  async checkCashbackEvents(
    operation: PaymentOperation,
    tx: Promise<TransactionResponse>,
    operationConditions: OperationConditions
  ) {
    if (operation.cashbackOperationKind === CashbackOperationKind.Sending) {
      await expect(tx).to.emit(
        this.cashbackDistributorMockShell.contract,
        EVENT_NAME_SEND_CASHBACK_MOCK
      ).withArgs(
        checkEventField("sender", this.cardPaymentProcessorShell.contract.address),
        checkEventField("token", this.tokenMock.address),
        checkEventField("kind", CashbackKind.CardPayment),
        checkEventField(
          "externalId",
          operation.paymentId
        ),
        checkEventField("recipient", operation.payer.address),
        checkEventField("amount", operation.cashbackRequestedChange)
      );
      if (operation.cashbackOperationSucceeded) {
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
    }

    if (operation.cashbackOperationKind === CashbackOperationKind.Revocation) {
      await expect(tx).to.emit(
        this.cashbackDistributorMockShell.contract,
        EVENT_NAME_REVOKE_CASHBACK_MOCK
      ).withArgs(
        checkEventField("sender", this.cardPaymentProcessorShell.contract.address),
        checkEventField("nonce", operation.cashbackNonce),
        checkEventField("amount", -operation.cashbackRequestedChange),
      );

      if (operation.cashbackOperationSucceeded) {
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
      } else { // !(operation.cashbackOperationSucceeded)
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
    }

    if (operation.cashbackOperationKind === CashbackOperationKind.Increase) {
      await expect(tx).to.emit(
        this.cashbackDistributorMockShell.contract,
        EVENT_NAME_INCREASE_CASHBACK_MOCK
      ).withArgs(
        checkEventField("sender", this.cardPaymentProcessorShell.contract.address),
        checkEventField("nonce", operation.cashbackNonce),
        checkEventField("amount", operation.cashbackRequestedChange),
      );

      if (operation.cashbackOperationSucceeded) {
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
      } else { // !(operation.cashbackOperationSucceeded)
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
    }

    if (!operationConditions.cashbackSendingRequestedInAnyOperation) {
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

    if (!operationConditions.cashbackIncreaseRequestedInAnyOperation) {
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

    if (!operationConditions.cashbackRevocationRequestedInAnyOperation) {
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
    }
  }

  async checkMergingEvent(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    const expectedDataField: string = defineEventDataField(
      EVENT_DATA_FIELD_VERSION_DEFAULT_VALUE,
      !operation.sponsor ? EVENT_DATA_FIELD_FLAGS_NON_SUBSIDIZED : EVENT_DATA_FIELD_FLAGS_SUBSIDIZED,
      encodeEventDataFieldForAmount(operation.oldBaseAmount),
      encodeEventDataFieldForAmount(operation.newBaseAmount),
      encodeEventDataFieldForAmount(operation.oldExtraAmount),
      encodeEventDataFieldForAmount(operation.newExtraAmount),
      encodeEventDataFieldForAmount(operation.oldCashbackAmount),
      encodeEventDataFieldForAmount(operation.oldCashbackAmount + operation.cashbackActualChange),
      encodeEventDataFieldForAmount(operation.oldRefundAmount),
      encodeEventDataFieldForAmount(operation.newRefundAmount),
    );

    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_PAYMENTS_MERGED
    ).withArgs(
      checkEventField("paymentId", operation.paymentId),
      checkEventField("payer", operation.payer.address),
      checkEventField("mergedPaymentIds", operation.mergedPaymentIds, { convertToJson: true }),
      checkEventField("data", expectedDataField, eventDataFieldCheckingOptions)
    );
  }

  private async checkBalanceChanges(tx: Promise<TransactionResponse>, operations: PaymentOperation[]) {
    const cardPaymentProcessorBalanceChange = operations
      .map(operation => operation.cardPaymentProcessorBalanceChange)
      .reduce((sum: number, currentValue: number) => sum + currentValue);
    const cashbackDistributorBalanceChange = operations
      .filter(operation => operation.kind != OperationKind.AggregatedMerging)
      .map(operation => -operation.cashbackActualChange)
      .reduce((sum: number, currentValue: number) => sum + currentValue);
    const cashOutAccountBalanceChange = operations
      .map(operation => operation.cashOutAccountBalanceChange)
      .reduce((sum: number, currentValue: number) => sum + currentValue);
    const balanceChangePerAccount: Map<SignerWithAddress, number> = this.#getBalanceChangePerAccount(operations);
    const accounts: SignerWithAddress[] = Array.from(balanceChangePerAccount.keys());
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
    await this.#checkTokenBalances();
  }

  async checkMakingEvents(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    const expectedDataField: string = defineEventDataField(
      EVENT_DATA_FIELD_VERSION_DEFAULT_VALUE,
      !operation.sponsor ? EVENT_DATA_FIELD_FLAGS_NON_SUBSIDIZED : EVENT_DATA_FIELD_FLAGS_SUBSIDIZED,
      encodeEventDataFieldForAmount(operation.newBaseAmount),
      encodeEventDataFieldForAmount(operation.newExtraAmount),
      encodeEventDataFieldForAmount(operation.newPayerSumAmount),
      !operation.sponsor ? "" : encodeEventDataFieldForAddress(operation.sponsor?.address),
      !operation.sponsor ? "" : encodeEventDataFieldForAmount(operation.newSponsorSumAmount)
    );

    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_PAYMENT_MADE
    ).withArgs(
      checkEventField("paymentId", operation.paymentId),
      checkEventField("payer", operation.payer.address),
      checkEventField("data", expectedDataField, eventDataFieldCheckingOptions)
    );
  }

  async checkUpdatingEvents(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    if (
      operation.updatingOperationKind === UpdatingOperationKind.Full ||
      operation.newBaseAmount !== operation.oldBaseAmount ||
      operation.newExtraAmount !== operation.oldExtraAmount
    ) {
      const expectedDataField: string = defineEventDataField(
        EVENT_DATA_FIELD_VERSION_DEFAULT_VALUE,
        !operation.sponsor ? EVENT_DATA_FIELD_FLAGS_NON_SUBSIDIZED : EVENT_DATA_FIELD_FLAGS_SUBSIDIZED,
        encodeEventDataFieldForAmount(operation.oldBaseAmount),
        encodeEventDataFieldForAmount(operation.newBaseAmount),
        encodeEventDataFieldForAmount(operation.oldExtraAmount),
        encodeEventDataFieldForAmount(operation.newExtraAmount),
        encodeEventDataFieldForAmount(operation.oldPayerSumAmount),
        encodeEventDataFieldForAmount(operation.newPayerSumAmount),
        !operation.sponsor ? "" : encodeEventDataFieldForAddress(operation.sponsor?.address),
        !operation.sponsor ? "" : encodeEventDataFieldForAmount(operation.oldSponsorSumAmount),
        !operation.sponsor ? "" : encodeEventDataFieldForAmount(operation.newSponsorSumAmount)
      );

      await expect(tx).to.emit(
        this.cardPaymentProcessorShell.contract,
        EVENT_NAME_PAYMENT_UPDATED
      ).withArgs(
        checkEventField("paymentId", operation.paymentId),
        checkEventField("payer", operation.payer.address),
        checkEventField("data", expectedDataField, eventDataFieldCheckingOptions)
      );
    } else {
      await expect(tx).not.to.emit(
        this.cardPaymentProcessorShell.contract,
        EVENT_NAME_PAYMENT_UPDATED
      );
    }
  }

  async checkCancelingEvents(
    tx: Promise<TransactionResponse>,
    operation: PaymentOperation,
  ) {
    const mainEventName: string = operation.kind === OperationKind.Revoking
      ? EVENT_NAME_PAYMENT_REVOKED
      : EVENT_NAME_PAYMENT_REVERSED;

    const expectedDataField: string = defineEventDataField(
      EVENT_DATA_FIELD_VERSION_DEFAULT_VALUE,
      !operation.sponsor ? EVENT_DATA_FIELD_FLAGS_NON_SUBSIDIZED : EVENT_DATA_FIELD_FLAGS_SUBSIDIZED,
      encodeEventDataFieldForAmount(operation.oldPayerReminder),
      !operation.sponsor ? "" : encodeEventDataFieldForAddress(operation.sponsor?.address ?? ZERO_ADDRESS),
      !operation.sponsor ? "" : encodeEventDataFieldForAmount(operation.oldSponsorReminder)
    );

    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      mainEventName
    ).withArgs(
      checkEventField("paymentId", operation.paymentId),
      checkEventField("payer", operation.payer.address),
      checkEventField("data", expectedDataField, eventDataFieldCheckingOptions)
    );
  }

  async checkRefundingEvents(tx: Promise<TransactionResponse>, operation: PaymentOperation) {
    const expectedDataField: string = defineEventDataField(
      EVENT_DATA_FIELD_VERSION_DEFAULT_VALUE,
      !operation.sponsor ? EVENT_DATA_FIELD_FLAGS_NON_SUBSIDIZED : EVENT_DATA_FIELD_FLAGS_SUBSIDIZED,
      encodeEventDataFieldForAmount(operation.oldPayerRefundAmount),
      encodeEventDataFieldForAmount(operation.newPayerRefundAmount),
      !operation.sponsor ? "" : encodeEventDataFieldForAddress(operation.sponsor?.address ?? ZERO_ADDRESS),
      !operation.sponsor ? "" : encodeEventDataFieldForAmount(operation.oldSponsorRefundAmount),
      !operation.sponsor ? "" : encodeEventDataFieldForAmount(operation.newSponsorRefundAmount)
    );

    await expect(tx).to.emit(
      this.cardPaymentProcessorShell.contract,
      EVENT_NAME_PAYMENT_REFUNDED
    ).withArgs(
      checkEventField("paymentId", operation.paymentId),
      checkEventField("payer", operation.payer.address),
      checkEventField("data", expectedDataField, eventDataFieldCheckingOptions)
    );
  }

  async #checkPaymentStructures() {
    const expectedPayments: PaymentModel[] = this.cardPaymentProcessorShell.model.getPaymentModelsInMakingOrder();
    const paymentNumber = expectedPayments.length;
    const checkedPaymentIds: Set<string> = new Set();
    for (let i = 0; i < paymentNumber; ++i) {
      const expectedPayment: PaymentModel = expectedPayments[i];
      if (checkedPaymentIds.has(expectedPayment.paymentId)) {
        continue;
      }
      checkedPaymentIds.add(expectedPayment.paymentId);
      const actualPayment = await this.cardPaymentProcessorShell.contract.getPayment(expectedPayment.paymentId);
      this.#checkPaymentsEquality(actualPayment, expectedPayment, i);
    }
  }

  #checkPaymentsEquality(actualOnChainPayment: any, expectedPayment: PaymentModel, paymentIndex: number) {
    expect(actualOnChainPayment.status).to.equal(
      expectedPayment.status,
      `payment[${paymentIndex}].status is wrong`
    );
    expect(actualOnChainPayment.reserve1).to.equal(
      0,
      `payment[${paymentIndex}].reserve1 is wrong`
    );
    expect(actualOnChainPayment.payer).to.equal(
      expectedPayment.payer.address,
      `payment[${paymentIndex}].payer is wrong`
    );
    expect(actualOnChainPayment.cashbackRate).to.equal(
      expectedPayment.cashbackRate,
      `payment[${paymentIndex}].cashbackRate is wrong`
    );
    expect(actualOnChainPayment.confirmedAmount).to.equal(
      expectedPayment.confirmedAmount,
      `payment[${paymentIndex}].confirmedAmount is wrong`
    );
    expect(actualOnChainPayment.sponsor).to.equal(
      expectedPayment.sponsor?.address ?? ZERO_ADDRESS,
      `payment[${paymentIndex}].sponsor is wrong`
    );
    expect(actualOnChainPayment.subsidyLimit).to.equal(
      expectedPayment.subsidyLimit,
      `payment[${paymentIndex}].subsidyLimit is wrong`
    );
    expect(actualOnChainPayment.reserve2).to.equal(
      0,
      `payment[${paymentIndex}].reserve2 is wrong`
    );
    expect(actualOnChainPayment.baseAmount).to.equal(
      expectedPayment.baseAmount,
      `payment[${paymentIndex}].baseAmount is wrong`
    );
    expect(actualOnChainPayment.extraAmount).to.equal(
      expectedPayment.extraAmount,
      `payment[${paymentIndex}].extraAmount is wrong`
    );
    expect(actualOnChainPayment.cashbackAmount).to.equal(
      expectedPayment.cashbackAmount,
      `payment[${paymentIndex}].cashbackAmount is wrong`
    );
    expect(actualOnChainPayment.refundAmount).to.equal(
      expectedPayment.refundAmount,
      `payment[${paymentIndex}].refundAmount is wrong`
    );
  }

  async #checkCashbacks() {
    const paymentIds: Set<string> = this.cardPaymentProcessorShell.model.getPaymentIds();
    for (const paymentId of paymentIds) {
      const expectedCashback = this.cardPaymentProcessorShell.model.getCashbackByPaymentId(paymentId);
      const actualCashback = await this.cardPaymentProcessorShell.contract.getCashback(paymentId);
      const note = `The last cashback nonce of a payment with id=${paymentId} is wrong`;
      if (!expectedCashback) {
        expect(actualCashback.lastCashbackNonce).to.equal(ethers.constants.Zero, note);
      } else {
        expect(actualCashback.lastCashbackNonce).to.equal(expectedCashback.lastCashbackNonce, note);
      }
    }
  }

  async #checkTokenBalances() {
    expect(
      await this.tokenMock.balanceOf(this.cardPaymentProcessorShell.contract.address)
    ).to.equal(
      this.cardPaymentProcessorShell.model.totalBalance,
      `The card payment processor token balance is wrong`
    );

    expect(
      await this.tokenMock.balanceOf(this.cashOutAccount.address)
    ).to.equal(
      this.cardPaymentProcessorShell.model.totalConfirmedAmount,
      `The confirmed amount token balance is wrong`
    );
  }

  #getBalanceChangePerAccount(operations: PaymentOperation[]) {
    const result: Map<SignerWithAddress, number> = new Map();
    operations.forEach(operation => {
      let balanceChange: number = result.get(operation.payer) ?? 0;
      balanceChange += operation.payerBalanceChange;
      result.set(operation.payer, balanceChange);

      const sponsor = operation.sponsor;
      if (!!sponsor) {
        balanceChange = result.get(sponsor) ?? 0;
        balanceChange += operation.sponsorBalanceChange;
        result.set(sponsor, balanceChange);
      }
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

describe("Contract 'CardPaymentProcessorV2'", async () => {
  const ZERO_PAYMENT_ID: string = createBytesString("00", BYTES32_LENGTH);
  const CASHBACK_DISTRIBUTOR_ADDRESS_STUB1 = "0x0000000000000000000000000000000000000001";
  const CASHBACK_DISTRIBUTOR_ADDRESS_STUB2 = "0x0000000000000000000000000000000000000002";
  const CASHBACK_RATE_MAX = 250; // 25%
  const CASHBACK_RATE_DEFAULT = 100; // 10%
  const CASHBACK_RATE_ZERO = 0;
  const CASHBACK_NONCE_DEFAULT = 111222333;

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_ACCOUNT_ZERO_ADDRESS = "AccountZeroAddress";
  const REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED = "CashbackAlreadyEnabled";
  const REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED = "CashbackAlreadyDisabled";
  const REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_ALREADY_CONFIGURED = "CashbackDistributorAlreadyConfigured";
  const REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_NOT_CONFIGURED = "CashbackDistributorNotConfigured";
  const REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_ZERO_ADDRESS = "CashbackDistributorZeroAddress";
  const REVERT_ERROR_IF_CASHBACK_MERGING_FAILURE = "CashbackMergingFailure";
  const REVERT_ERROR_IF_CASHBACK_RATE_EXCESS = "CashbackRateExcess";
  const REVERT_ERROR_IF_CASHBACK_RATE_UNCHANGED = "CashbackRateUnchanged";
  const REVERT_ERROR_IF_CASH_OUT_ACCOUNT_NOT_CONFIGURED = "CashOutAccountNotConfigured";
  const REVERT_ERROR_IF_CASH_OUT_ACCOUNT_UNCHANGED = "CashOutAccountUnchanged";
  const REVERT_ERROR_IF_INAPPROPRIATE_CONFIRMATION_AMOUNT = "InappropriateConfirmationAmount";
  const REVERT_ERROR_IF_INAPPROPRIATE_REFUNDING_AMOUNT = "InappropriateRefundingAmount";
  const REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS = "InappropriatePaymentStatus";
  const REVERT_ERROR_IF_INAPPROPRIATE_SUM_AMOUNT = "InappropriateSumAmount";
  const REVERT_ERROR_IF_MERGED_PAYMENT_CASHBACK_RATE_MISMATCH = "MergedPaymentCashbackRateMismatch";
  const REVERT_ERROR_IF_MERGED_PAYMENT_ID_AND_TARGET_PAYMENT_ID_EQUALITY =
    "MergedPaymentIdAndTargetPaymentIdEquality";
  const REVERT_ERROR_IF_MERGED_PAYMENT_ID_ARRAY_EMPTY = "MergedPaymentIdArrayEmpty";
  const REVERT_ERROR_IF_MERGED_PAYMENT_PAYER_MISMATCH = "MergedPaymentPayerMismatch";
  const REVERT_ERROR_IF_OVERFLOW_OF_SUM_AMOUNT = "OverflowOfSumAmount";
  const REVERT_ERROR_IF_PAYER_ZERO_ADDRESS = "PayerZeroAddress";
  const REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTENT = "PaymentAlreadyExistent";
  const REVERT_ERROR_IF_PAYMENT_CONFIRMATION_ARRAY_EMPTY = "PaymentConfirmationArrayEmpty";
  const REVERT_ERROR_IF_PAYMENT_NON_EXISTENT = "PaymentNonExistent";
  const REVERT_ERROR_IF_PAYMENT_SUBSIDIZED = "PaymentSubsidized";
  const REVERT_ERROR_IF_PAYMENT_ZERO_ID = "PaymentZeroId";
  const REVERT_ERROR_IF_TOKEN_ZERO_ADDRESS = "TokenZeroAddress";

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
  let sponsor: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  before(async () => {
    cardPaymentProcessorFactory = await ethers.getContractFactory("CardPaymentProcessorV2");
    cashbackDistributorMockFactory = await ethers.getContractFactory("CashbackDistributorMock");
    tokenMockFactory = await ethers.getContractFactory("ERC20UpgradeableMock");

    [deployer, cashOutAccount, executor, sponsor, user1, user2] = await ethers.getSigners();
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
      sendCashbackNonceResult: CASHBACK_NONCE_DEFAULT,
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
    await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
    await proveTx(cardPaymentProcessor.setCashbackDistributor(cashbackDistributorMock.address));
    await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_DEFAULT));

    await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
    await proveTx(tokenMock.connect(cashOutAccount).approve(cardPaymentProcessor.address, MAX_UINT256));

    await proveTx(tokenMock.mint(cashbackDistributorMock.address, MAX_INT256));
    await proveTx(tokenMock.mint(sponsor.address, INITIAL_SPONSOR_BALANCE));
    await proveTx(tokenMock.connect(sponsor).approve(cardPaymentProcessor.address, MAX_UINT256));

    return {
      cardPaymentProcessor,
      tokenMock,
      cashbackDistributorMock,
      cashbackDistributorMockConfig
    };
  }

  async function pauseContract(contract: Contract) {
    if (!(await contract.hasRole(pauserRole, deployer.address))) {
      await proveTx(contract.grantRole(pauserRole, deployer.address));
    }
    await proveTx(contract.pause());
  }

  function createTestPayments(numberOfPayments: number = 1): TestPayment[] {
    const testPayments: TestPayment[] = [];
    for (let i = 0; i < numberOfPayments; ++i) {
      const payment: TestPayment = {
        id: createBytesString(123 + i * 123, BYTES32_LENGTH),
        payer: (i % 2 > 0) ? user1 : user2,
        baseAmount: Math.floor(123.456789 * DIGITS_COEF + i * 123.456789 * DIGITS_COEF),
        extraAmount: Math.floor(132.456789 * DIGITS_COEF + i * 132.456789 * DIGITS_COEF),
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
      cashbackRateInPermil: CASHBACK_RATE_DEFAULT,
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
      expect(await cardPaymentProcessor.token()).to.equal(tokenMock.address);

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
      expect(await cardPaymentProcessor.MAX_CASHBACK_RATE()).to.equal(CASHBACK_RATE_MAX);

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
      ).to.be.revertedWithCustomError(cardPaymentProcessorFactory, REVERT_ERROR_IF_TOKEN_ZERO_ADDRESS);
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

      // Can be set to the zero address
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
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_UNCHANGED);

      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));

      await expect(
        cardPaymentProcessor.setCashOutAccount(cashOutAccount.address)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_UNCHANGED);
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
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_ZERO_ADDRESS);
    });

    it("Is reverted if the cashback distributor has been already configured", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));

      await expect(
        cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB2)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_ALREADY_CONFIGURED);
    });
  });

  describe("Function 'setCashbackRate()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);

      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_DEFAULT)
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_CASHBACK_RATE
      ).withArgs(
        CASHBACK_RATE_ZERO,
        CASHBACK_RATE_DEFAULT
      );

      expect(await cardPaymentProcessor.cashbackRate()).to.equal(CASHBACK_RATE_DEFAULT);

      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_ZERO)
      ).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SET_CASHBACK_RATE
      ).withArgs(
        CASHBACK_RATE_DEFAULT,
        CASHBACK_RATE_ZERO
      );

      expect(await cardPaymentProcessor.cashbackRate()).to.equal(CASHBACK_RATE_ZERO);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.connect(user1).setCashbackRate(CASHBACK_RATE_DEFAULT)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new rate exceeds the allowable maximum", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_MAX + 1)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_RATE_EXCESS);
    });

    it("Is reverted if called with the same argument twice", async () => {
      const { cardPaymentProcessor } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);
      await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_DEFAULT));

      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_DEFAULT)
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

  describe("Function 'makePaymentFor()'", async () => {
    async function checkPaymentMakingFor(
      context: TestContext,
      props: {
        sponsor?: SignerWithAddress
        subsidyLimit?: number,
        cashbackEnabled?: boolean,
        cashbackRate?: number,
        confirmationAmount?: number
      } = {}
    ) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      if (props.cashbackEnabled ?? true) {
        await cardPaymentProcessorShell.enableCashback();
      }

      cardPaymentProcessorShell.model.makePayment(
        payment, {
          sponsor: props.sponsor,
          subsidyLimit: props.subsidyLimit,
          cashbackRate: props.cashbackRate,
          confirmationAmount: props.confirmationAmount,
          sender: executor
        }
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
        payment.id,
        payment.payer.address,
        payment.baseAmount,
        payment.extraAmount,
        props.sponsor?.address ?? ZERO_SPONSOR_ADDRESS,
        props.subsidyLimit ?? ZERO_SUBSIDY_LIMIT,
        props.cashbackRate ?? CASHBACK_RATE_AS_IN_CONTRACT,
        props.confirmationAmount ?? ZERO_CONFIRMATION_AMOUNT
      );
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      describe("The payment is not immediately confirmed, and", async () => {
        describe("The payment is not sponsored, and", async () => {
          describe("The cashback rate is determined by the contract settings, and", async () => {
            describe("Cashback is enabled, and the base and extra payment amounts are", async () => {
              it("Both nonzero", async () => {
                const context = await beforeMakingPayments();
                await checkPaymentMakingFor(context);
              });

              it("Both nonzero, and if the subsidy limit argument is not zero", async () => {
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

              it("Both nonzero, and cashback is partially sent with non-zero amount", async () => {
                const context = await beforeMakingPayments();
                const sentCashbackAmount = 2 * CASHBACK_ROUNDING_COEF;
                await context.cashbackDistributorMockShell.setSendCashbackAmountResult(sentCashbackAmount);
                await checkPaymentMakingFor(context);
              });

              it("Nonzero, and cashback is partially sent with zero amount", async () => {
                const context = await beforeMakingPayments();
                const sentCashbackAmount = 0;
                await context.cashbackDistributorMockShell.setSendCashbackAmountResult(sentCashbackAmount);
                await checkPaymentMakingFor(context);
              });
            });
            describe("Cashback is disabled, and the base and extra payment amounts are", async () => {
              it("Both nonzero", async () => {
                const context = await beforeMakingPayments();
                await checkPaymentMakingFor(context, { cashbackEnabled: false });
              });
            });
            describe("Cashback is enabled but its sending fails, and the base and extra payment amounts are", async () => {
              it("Both nonzero", async () => {
                const context = await beforeMakingPayments();
                await context.cashbackDistributorMockShell.setSendCashbackSuccessResult(false);
                await checkPaymentMakingFor(context);
              });
            });
          });
        });
        describe("The payment is sponsored, cashback is enabled, and", async () => {
          describe("The cashback rate is determined by the contract settings, and", async () => {
            describe("The base and extra payment amounts are both nonzero, and the subsidy limit is", async () => {
              it("Zero", async () => {
                const context = await beforeMakingPayments();
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0 });
              });

              it("Less than the base amount", async () => {
                const context = await beforeMakingPayments();
                const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
              });

              it("Less than the payment sum amount but higher than the base amount", async () => {
                const context = await beforeMakingPayments();
                const { payments: [payment] } = context;
                const subsidyLimit = payment.baseAmount + Math.floor(payment.extraAmount / 2);
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
              });

              it("The same as the payment sum amount", async () => {
                const context = await beforeMakingPayments();
                const { payments: [payment] } = context;
                const subsidyLimit = payment.baseAmount + payment.extraAmount;
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
              });

              it("Greater than the payment sum amount", async () => {
                const context = await beforeMakingPayments();
                const { payments: [payment] } = context;
                const sumAmount = payment.baseAmount + payment.extraAmount;
                const subsidyLimit = Math.floor(sumAmount * 1.1);
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
              });
            });
            describe("The base and extra payment amounts are both zero, and the subsidy limit is", async () => {
              it("Non-zero", async () => {
                const context = await beforeMakingPayments();
                const { payments: [payment] } = context;
                const subsidyLimit = payment.baseAmount;
                payment.baseAmount = 0;
                payment.extraAmount = 0;
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
              });

              it("Zero", async () => {
                const context = await beforeMakingPayments();
                const { payments: [payment] } = context;
                payment.baseAmount = 0;
                payment.extraAmount = 0;
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0 });
              });
            });
            describe("The base amount is nonzero, the extra amount is zero, and the subsidy limit is", async () => {
              it("The same as the payment sum amount", async () => {
                const context = await beforeMakingPayments();
                context.payments[0].extraAmount = 0;
                const subsidyLimit = context.payments[0].baseAmount;
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
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
            describe("The base amount is zero, the extra amount is nonzero, and the subsidy limit is", async () => {
              it("The same as the payment sum amount", async () => {
                const context = await beforeMakingPayments();
                context.payments[0].baseAmount = 0;
                const subsidyLimit = context.payments[0].extraAmount;
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit });
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
          });
          describe("The cashback rate is requested to be zero, and", async () => {
            const cashbackRate = 0;
            describe("The base and extra payment amounts are both nonzero, and the subsidy limit is ", async () => {
              it("Less than the base amount", async () => {
                const context = await beforeMakingPayments();
                const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit, cashbackRate });
              });
            });
          });
          describe("The cashback is requested to be a special value, and", async () => {
            const cashbackRate = CASHBACK_RATE_DEFAULT * 2;
            describe("The base and extra payment amounts are both nonzero, and the subsidy limit is ", async () => {
              it("Less than the base amount", async () => {
                const context = await beforeMakingPayments();
                const subsidyLimit = Math.floor(context.payments[0].baseAmount / 2);
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit, cashbackRate });
              });

              it("Zero", async () => {
                const context = await beforeMakingPayments();
                await checkPaymentMakingFor(context, { sponsor, subsidyLimit: 0, cashbackRate });
              });
            });
          });
        });
      });
      describe("The payment is immediately confirmed, sponsored, with some amounts, usual cashback, and", async () => {
        describe("The confirmation amount is", async () => {
          it("Less than the base amount", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            const confirmationAmount = Math.floor(payment.baseAmount / 4);
            await checkPaymentMakingFor(context, { sponsor, subsidyLimit, confirmationAmount });
          });

          it("Less than the payment sum amount but higher than the base amount", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            const confirmationAmount = payment.baseAmount + Math.floor(payment.extraAmount / 2);
            await checkPaymentMakingFor(context, { sponsor, subsidyLimit, confirmationAmount });
          });

          it("The same as the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            const confirmationAmount = payment.baseAmount + payment.extraAmount;
            await checkPaymentMakingFor(context, { sponsor, subsidyLimit, confirmationAmount });
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
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.payer).makePaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(payment.payer.address, executorRole));
      });

      it("The payment account address is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            payment.id,
            ZERO_PAYER_ADDRESS,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYER_ZERO_ADDRESS);
      });

      it("The payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            ZERO_PAYMENT_ID,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("The account has not enough token balance", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        payment.baseAmount = INITIAL_USER_BALANCE + 1;
        payment.extraAmount = 0;
        const subsidyLimitLocal = 0;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimitLocal,
            CASHBACK_RATE_AS_IN_CONTRACT,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("The sponsor has not enough token balance", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        const subsidyLimitLocal = INITIAL_SPONSOR_BALANCE + 1;
        payment.baseAmount = 0;
        payment.extraAmount = subsidyLimitLocal;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimitLocal,
            CASHBACK_RATE_AS_IN_CONTRACT,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("The payment with the provided ID already exists", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makeCommonPayments([payment]);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTENT);
      });

      it("The requested cashback rate exceeds the maximum allowed value", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_MAX + 1,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_CASHBACK_RATE_EXCESS);
      });

      it("The confirmation amount for the payment is greater than the sum amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        const excessConfirmationAmount = payment.baseAmount + payment.extraAmount + 1;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount,
            sponsor.address,
            subsidyLimit,
            CASHBACK_RATE_AS_IN_CONTRACT,
            excessConfirmationAmount
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_INAPPROPRIATE_CONFIRMATION_AMOUNT
        );
      });
    });
  });

  describe("Function 'makeCommonPaymentFor()'", async () => {
    /* Since all payment making functions use the same common internal function to execute,
     * the complete set of checks are provided in the test section for the 'makePaymentFor()' function.
     * In this section, only specific checks are provided.
     */
    describe("Executes as expected if", async () => {
      it("Cashback is enabled, and the base and extra payment amounts are both nonzero", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.enableCashback();

        cardPaymentProcessorShell.model.makePayment(
          payment, {
            sender: executor
          }
        );
        const tx = cardPaymentProcessorShell.contract.connect(executor).makeCommonPaymentFor(
          payment.id,
          payment.payer.address,
          payment.baseAmount,
          payment.extraAmount,
        );
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
          cardPaymentProcessorShell.contract.connect(executor).makeCommonPaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(payment.payer).makeCommonPaymentFor(
            payment.id,
            payment.payer.address,
            payment.baseAmount,
            payment.extraAmount
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(payment.payer.address, executorRole));
      });
    });
  });

  describe("Function 'updatePayment()'", async () => {
    async function checkUpdating(context: TestContext, props: {
                                   cashbackCondition?: CashbackConditionType,
                                   newBaseAmount?: number,
                                   newExtraAmount?: number,
                                   refundAmount?: number,
                                   confirmedAmount?: number,
                                   subsidyLimit?: number,
                                 } = { cashbackCondition: CashbackConditionType.CashbackEnabled }
    ) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      const { cashbackCondition, subsidyLimit, confirmedAmount: confirmedAmount } = props;

      if (cashbackCondition !== CashbackConditionType.CashbackDisabledBeforePaymentMaking) {
        await cardPaymentProcessorShell.enableCashback();
      }
      await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit, confirmedAmount });
      if (cashbackCondition === CashbackConditionType.CashbackDisabledAfterPaymentMaking) {
        await cardPaymentProcessorShell.disableCashback();
      }

      if (props.refundAmount === 0 || props.refundAmount) {
        await cardPaymentProcessorShell.refundPayment(payment, props.refundAmount ?? 0);
      } else {
        const refundAmount = Math.floor(payment.baseAmount * 0.1);
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);
      }
      if (cashbackCondition === CashbackConditionType.CashbackEnabledButIncreasingPartial) {
        const actualCashbackChange = 2 * CASHBACK_ROUNDING_COEF;
        await context.cashbackDistributorMockShell.setIncreaseCashbackAmountResult(actualCashbackChange);
      }
      if (cashbackCondition === CashbackConditionType.CashbackEnabledButRevokingFails) {
        await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);
      }
      if (cashbackCondition === CashbackConditionType.CashbackEnabledButIncreasingFails) {
        await context.cashbackDistributorMockShell.setIncreaseCashbackSuccessResult(false);
      }

      await context.checkCardPaymentProcessorState();

      const newBaseAmount = props.newBaseAmount ?? payment.baseAmount;
      const newExtraAmount = props.newExtraAmount ?? payment.extraAmount;

      cardPaymentProcessorShell.model.updatePayment(
        payment.id,
        newBaseAmount,
        newExtraAmount
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).updatePayment(
        payment.id,
        newBaseAmount,
        newExtraAmount
      );

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      describe("The payment is not subsidized and not confirmed, and", async () => {
        describe("The base amount decreases, and", async () => {
          describe("The extra amount remains the same, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
              await checkUpdating(context, { newBaseAmount });
            });

            it("Disabled before payment making", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
              await checkUpdating(context, {
                newBaseAmount,
                cashbackCondition: CashbackConditionType.CashbackDisabledBeforePaymentMaking
              });
            });

            it("Disabled after payment making", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
              await checkUpdating(context, {
                newBaseAmount,
                cashbackCondition: CashbackConditionType.CashbackDisabledAfterPaymentMaking
              });
            });

            it("Enabled but cashback operation fails", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
              await checkUpdating(context, {
                newBaseAmount,
                cashbackCondition: CashbackConditionType.CashbackEnabledButRevokingFails
              });
            });
          });

          describe("The extra amount decreases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const { payments: [payment] } = context;
              const newBaseAmount = Math.floor(payment.baseAmount * 0.9);
              const newExtraAmount = Math.floor(payment.extraAmount * 0.5);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount increases but the sum amount decreases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const { payments: [payment] } = context;
              const newBaseAmount = Math.floor(payment.baseAmount * 0.7);
              const newExtraAmount = Math.floor(payment.extraAmount * 1.1);
              const oldSumAmount = payment.baseAmount + payment.extraAmount;
              const newSumAmount = newBaseAmount + newExtraAmount;
              expect(newSumAmount - oldSumAmount).to.be.lessThan(0);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount increases and the sum amount increases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const { payments: [payment] } = context;
              const newBaseAmount = Math.floor(payment.baseAmount * 0.7);
              const newExtraAmount = Math.floor(payment.extraAmount * 2);
              const oldSumAmount = payment.baseAmount + payment.extraAmount;
              const newSumAmount = newBaseAmount + newExtraAmount;
              expect(newSumAmount - oldSumAmount).to.be.greaterThan(0);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount becomes zero, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
              const newExtraAmount = 0;
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });
        });

        describe("The base amount remains the same, and", async () => {
          describe("The extra amount remains the same, and cashback is", async () => {
            it("Enabled, and cashback revoking is executed successfully", async () => {
              const context = await beforeMakingPayments();
              await checkUpdating(context);
            });
          });

          describe("The extra amount decreases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newExtraAmount = Math.floor(context.payments[0].extraAmount * 0.5);
              await checkUpdating(context, { newExtraAmount });
            });
          });

          describe("The extra amount increases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newExtraAmount = Math.floor(context.payments[0].extraAmount * 2);
              await checkUpdating(context, { newExtraAmount });
            });
          });

          describe("The extra amount becomes zero, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newExtraAmount = 0;
              await checkUpdating(context, { newExtraAmount });
            });
          });
        });

        describe("The base amount increases, and", async () => {
          describe("The extra amount remains the same, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 1.1);
              await checkUpdating(context, { newBaseAmount });
            });

            it("Disabled before payment making", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 1.1);
              await checkUpdating(context, {
                newBaseAmount,
                cashbackCondition: CashbackConditionType.CashbackDisabledBeforePaymentMaking
              });
            });

            it("Disabled after payment making", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 1.1);
              await checkUpdating(context, {
                newBaseAmount,
                cashbackCondition: CashbackConditionType.CashbackDisabledAfterPaymentMaking
              });
            });

            it("Enabled but cashback operation fails", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 1.1);
              await checkUpdating(context, {
                newBaseAmount,
                cashbackCondition: CashbackConditionType.CashbackEnabledButIncreasingFails
              });
            });

            it("Enabled but cashback operation executes partially", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 1.1);
              await checkUpdating(context, {
                newBaseAmount,
                cashbackCondition: CashbackConditionType.CashbackEnabledButIncreasingPartial
              });
            });
          });

          describe("The extra amount decreases and the sum amount decreases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const { payments: [payment] } = context;
              const newBaseAmount = Math.floor(payment.baseAmount * 1.1);
              const newExtraAmount = Math.floor(payment.extraAmount * 0.5);
              const oldSumAmount = payment.baseAmount + payment.extraAmount;
              const newSumAmount = newBaseAmount + newExtraAmount;
              expect(newSumAmount - oldSumAmount).to.be.lessThan(0);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount decreases but the sum amount increases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const { payments: [payment] } = context;
              const newBaseAmount = Math.floor(payment.baseAmount * 1.5);
              const newExtraAmount = Math.floor(payment.extraAmount * 0.9);
              const oldSumAmount = payment.baseAmount + payment.extraAmount;
              const newSumAmount = newBaseAmount + newExtraAmount;
              expect(newSumAmount - oldSumAmount).to.be.greaterThan(0);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount increases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 1.1);
              const newExtraAmount = Math.floor(context.payments[0].extraAmount * 2);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount becomes zero, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
              const newExtraAmount = 0;
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });
        });

        describe("The base amount becomes zero, and", async () => {
          describe("The extra amount remains the same, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = 0;
              await checkUpdating(context, { newBaseAmount });
            });
          });

          describe("The extra amount decreases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const { payments: [payment] } = context;
              const newBaseAmount = 0;
              const newExtraAmount = Math.floor(payment.extraAmount * 0.5);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount increases, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const { payments: [payment] } = context;
              const newBaseAmount = 9;
              const newExtraAmount = Math.floor(payment.extraAmount * 2);
              await checkUpdating(context, { newBaseAmount, newExtraAmount });
            });
          });

          describe("The extra amount becomes zero, and cashback is", async () => {
            it("Enabled, and cashback operation is executed successfully", async () => {
              const context = await beforeMakingPayments();
              const newBaseAmount = 0;
              const newExtraAmount = 0;
              await checkUpdating(context, { newBaseAmount, newExtraAmount, refundAmount: 0 });
            });
          });
        });
      });

      describe("The payment is subsidized but not confirmed, and", async () => {
        describe("The initial subsidy limit (SL) is less than the base amount, and", async () => {
          it("The base amount decreases but it is still above SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            const newBaseAmount = Math.floor(payment.baseAmount * 0.9);
            await checkUpdating(context, { newBaseAmount, subsidyLimit });
          });

          it("The base amount decreases bellow SL but the sum amount is still above SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            const newBaseAmount = Math.floor(payment.baseAmount * 0.3);
            expect(newBaseAmount + payment.extraAmount).to.be.greaterThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, subsidyLimit });
          });

          it("The base amount decreases and the sum amount becomes bellow SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            const newBaseAmount = Math.floor(payment.baseAmount * 0.2);
            const newExtraAmount = Math.floor(payment.extraAmount * 0.2);
            expect(newBaseAmount + newExtraAmount).to.be.lessThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit });
          });
        });

        describe("The initial subsidy limit (SL) is between the base amount and the sum amount, and", async () => {
          it("The base amount decreases but the sum amount is still above SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount + payment.extraAmount * 0.5);
            const newBaseAmount = Math.floor(payment.baseAmount * 0.9);
            const newExtraAmount = Math.floor(payment.extraAmount * 0.9);
            expect(newBaseAmount + newExtraAmount).to.be.greaterThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit });
          });

          it("The base amount decreases and the sum amount becomes bellow SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount + payment.extraAmount * 0.5);
            const newBaseAmount = Math.floor(payment.baseAmount * 0.2);
            const newExtraAmount = Math.floor(payment.extraAmount * 0.2);
            expect(newBaseAmount + newExtraAmount).to.be.lessThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit });
          });

          it("The base amount increases above SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor(payment.baseAmount + payment.extraAmount * 0.5);
            const newBaseAmount = Math.floor(payment.baseAmount * 2);
            expect(newBaseAmount).to.be.greaterThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, subsidyLimit });
          });
        });

        describe("The initial subsidy limit (SL) is above the payment sum amount, and", async () => {
          it("The payment sum amount decreases", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor((payment.baseAmount + payment.extraAmount) * 1.2);
            const newBaseAmount = Math.floor(payment.baseAmount * 0.9);
            const newExtraAmount = Math.floor(payment.extraAmount * 0.9);
            await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit });
          });

          it("The payment sum amount increases but it is still below SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor((payment.baseAmount + payment.extraAmount) * 1.2);
            const newBaseAmount = Math.floor(payment.baseAmount * 1.1);
            const newExtraAmount = Math.floor(payment.extraAmount * 1.1);
            expect(newBaseAmount + newExtraAmount).to.be.lessThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit });
          });

          it("The payment sum amount increases above SL but the base amount is still below SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor((payment.baseAmount + payment.extraAmount) * 1.2);
            const newBaseAmount = Math.floor(payment.baseAmount * 1.1);
            const newExtraAmount = Math.floor(payment.extraAmount * 1.5);
            expect(newBaseAmount + newExtraAmount).to.be.greaterThan(subsidyLimit);
            expect(newBaseAmount).to.be.lessThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit });
          });

          it("The payment sum amount increases above SL and the base amount becomes above SL", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const subsidyLimit = Math.floor((payment.baseAmount + payment.extraAmount) * 1.2);
            const newBaseAmount = Math.floor(payment.baseAmount * 2.5);
            const newExtraAmount = payment.extraAmount;
            expect(newBaseAmount + newExtraAmount).to.be.greaterThan(subsidyLimit);
            expect(newBaseAmount).to.be.greaterThan(subsidyLimit);
            await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit });
          });
        });
      });

      describe("The payment is subsidized and confirmed, and", async () => {
        it("The payment sum amount is increased", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
          const newBaseAmount = Math.floor(payment.baseAmount * 1.1);
          const newExtraAmount = Math.floor(payment.extraAmount * 1.1);
          const confirmedAmount = Math.floor(payment.baseAmount + payment.extraAmount * 0.5);
          await checkUpdating(context, { newBaseAmount, newExtraAmount, subsidyLimit, confirmedAmount });
        });

        it("The payment sum amount is decreased but the reminder is still above the confirmed amount", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
          const newBaseAmount = Math.floor(payment.baseAmount * 0.9);
          const newExtraAmount = Math.floor(payment.extraAmount * 0.9);
          const refundAmount = Math.floor(payment.baseAmount * 0.1);
          const reminder = newBaseAmount + newExtraAmount - refundAmount;
          const confirmedAmount = Math.floor(reminder * 0.9);
          await checkUpdating(context,
            { newBaseAmount, newExtraAmount, subsidyLimit, refundAmount, confirmedAmount }
          );
        });

        it("The payment sum amount decreased and the reminder becomes below the confirmed amount", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
          const newBaseAmount = Math.floor(payment.baseAmount * 0.7);
          const newExtraAmount = Math.floor(payment.extraAmount * 0.7);
          const refundAmount = Math.floor(payment.baseAmount * 0.1);
          const reminder = newBaseAmount + newExtraAmount - refundAmount;
          const confirmedAmount = Math.floor(reminder * 1.1);
          await checkUpdating(context,
            { newBaseAmount, newExtraAmount, subsidyLimit, refundAmount, confirmedAmount }
          );
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updatePayment(
            payment.id,
            payment.baseAmount,
            payment.extraAmount,
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).updatePayment(
            payment.id,
            payment.baseAmount,
            payment.extraAmount,
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updatePayment(
            ZERO_PAYMENT_ID,
            payment.baseAmount,
            payment.extraAmount,
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("The payment with the provided ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updatePayment(
            payment.id,
            payment.baseAmount,
            payment.extraAmount,
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(payment.id);
      });

      it("The new sum amount is less than the refund amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makeCommonPayments([payment]);
        const refundAmount = Math.floor((payment.baseAmount + payment.extraAmount) * 0.5);
        const newBaseAmount = Math.floor(payment.baseAmount * 0.4);
        const newExtraAmount = Math.floor(payment.baseAmount * 0.4);
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updatePayment(
            payment.id,
            newBaseAmount,
            newExtraAmount,
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_INAPPROPRIATE_SUM_AMOUNT
        );
      });
    });
  });

  describe("Function 'revokePayment()'", async () => {
    async function checkRevocation(context: TestContext) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      // To be sure that the `refundAmount` field is taken into account
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      cardPaymentProcessorShell.model.revokePayment(payment.id);
      const tx = cardPaymentProcessorShell.contract.connect(executor).revokePayment(payment.id);

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      describe("The payment is not subsidized and not confirmed, and", async () => {
        it("Cashback operations are enabled", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;

          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makeCommonPayments([payment]);
          await checkRevocation(context);
        });

        it("Cashback operations are enabled but cashback revoking fails", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;

          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makeCommonPayments([payment]);
          await cardPaymentProcessorShell.disableCashback();
          await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);

          await checkRevocation(context);
        });

        it("Cashback operations are disabled before sending", async () => {
          const context = await beforeMakingPayments();
          await context.cardPaymentProcessorShell.makeCommonPayments([context.payments[0]]);
          await checkRevocation(context);
        });

        it("Cashback operations are disabled after sending", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;

          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makeCommonPayments([payment]);
          await cardPaymentProcessorShell.disableCashback();

          await checkRevocation(context);
        });
      });

      describe("The payment is subsidized, but not confirmed, and cashback operations are enabled, and", async () => {
        describe("The initial subsidy limit (SL) is", async () => {
          it("Less than the payment base amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
            await checkRevocation(context);
          });

          it("Between the payment base amount and the sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = payment.baseAmount + Math.floor(payment.extraAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
            await checkRevocation(context);
          });

          it("Above the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor((payment.baseAmount + payment.extraAmount) * 1.1);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
            await checkRevocation(context);
          });
        });
      });

      describe("The payment is subsidized and confirmed, and cashback operations are enabled, and", async () => {
        describe("The confirmed amount is", async () => {
          it("Less than the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            const confirmationAmount = Math.floor(payment.baseAmount + payment.extraAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit, confirmationAmount });
            await checkRevocation(context);
          });

          it("Equal to the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            const confirmationAmount = payment.baseAmount + payment.extraAmount;
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit, confirmationAmount });
            await checkRevocation(context);
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
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(payment.id)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).revokePayment(payment.id)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(ZERO_PAYMENT_ID)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("The payment with the provided ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).revokePayment(payment.id)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(payment.id);
      });
    });
  });

  describe("Function 'reversePayment()'", async () => {
    async function checkReversing(context: TestContext) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      // To be sure that the `refundAmount` field is taken into account
      const refundAmount = Math.floor(payment.baseAmount * 0.1);
      await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

      cardPaymentProcessorShell.model.reversePayment(payment.id);
      const tx = cardPaymentProcessorShell.contract.connect(executor).reversePayment(payment.id);

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      describe("The payment is not subsidized and not confirmed, and", async () => {
        it("Cashback operations are enabled", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;

          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makeCommonPayments([payment]);
          await checkReversing(context);
        });

        it("Cashback operations are enabled but cashback revoking fails", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;

          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makeCommonPayments([payment]);
          await cardPaymentProcessorShell.disableCashback();
          await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);

          await checkReversing(context);
        });

        it("Cashback operations are disabled before sending", async () => {
          const context = await beforeMakingPayments();
          await context.cardPaymentProcessorShell.makeCommonPayments([context.payments[0]]);
          await checkReversing(context);
        });

        it("Cashback operations are disabled after sending", async () => {
          const context = await beforeMakingPayments();
          const { cardPaymentProcessorShell, payments: [payment] } = context;

          await cardPaymentProcessorShell.enableCashback();
          await cardPaymentProcessorShell.makeCommonPayments([payment]);
          await cardPaymentProcessorShell.disableCashback();

          await checkReversing(context);
        });
      });

      describe("The payment is subsidized, but not confirmed, and cashback operations are enabled, and", async () => {
        describe("The initial subsidy limit (SL) is", async () => {
          it("Less than the payment base amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
            await checkReversing(context);
          });

          it("Between the payment base amount and the sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = payment.baseAmount + Math.floor(payment.extraAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
            await checkReversing(context);
          });

          it("Above the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor((payment.baseAmount + payment.extraAmount) * 1.1);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
            await checkReversing(context);
          });
        });
      });

      describe("The payment is subsidized and confirmed, and cashback operations are enabled, and", async () => {
        describe("The confirmed amount is", async () => {
          it("Less than the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            const confirmationAmount = Math.floor(payment.baseAmount + payment.extraAmount / 2);
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit, confirmationAmount });
            await checkReversing(context);
          });

          it("Equal to the payment sum amount", async () => {
            const context = await beforeMakingPayments();
            const { cardPaymentProcessorShell, payments: [payment] } = context;

            await cardPaymentProcessorShell.enableCashback();
            const subsidyLimit = Math.floor(payment.baseAmount / 2);
            const confirmationAmount = payment.baseAmount + payment.extraAmount;
            await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit, confirmationAmount });
            await checkReversing(context);
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
          cardPaymentProcessorShell.contract.connect(executor).reversePayment(payment.id)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).reversePayment(payment.id)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).reversePayment(ZERO_PAYMENT_ID)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("The payment with the provided ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).reversePayment(payment.id)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(payment.id);
      });
    });
  });

  describe("Function 'confirmPayment()'", async () => {
    async function checkConfirmation(context: TestContext, confirmationAmount: number, refundAmount?: number) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
      await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
      if (refundAmount) {
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);
      }

      cardPaymentProcessorShell.model.confirmPayment(payment.id, confirmationAmount);
      const tx = cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.id, confirmationAmount);

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      describe("The refund amount is zero, and", async () => {
        it("The confirmation amount is less than the reminder", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const confirmationAmount = Math.floor(payment.baseAmount + payment.extraAmount * 0.5);
          await checkConfirmation(context, confirmationAmount);
        });

        it("The confirmation amount equals the reminder", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const confirmationAmount = Math.floor(payment.baseAmount + payment.extraAmount);
          await checkConfirmation(context, confirmationAmount);
        });
      });

      describe("The refund amount is non-zero, and", async () => {
        it("The confirmation amount is less than the reminder", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const refundAmount = Math.floor(payment.baseAmount * 0.1);
          const confirmationAmount = Math.floor(payment.baseAmount + payment.extraAmount * 0.5);
          await checkConfirmation(context, confirmationAmount, refundAmount);
        });

        it("The confirmation amount equals the reminder", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const refundAmount = Math.floor(payment.baseAmount * 0.1);
          const confirmationAmount = Math.floor(payment.baseAmount + payment.extraAmount - refundAmount);
          await checkConfirmation(context, confirmationAmount, refundAmount);
        });

        it("The confirmation is zero", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const confirmationAmount = 0;
          await checkConfirmation(context, confirmationAmount);
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.id, ZERO_CONFIRMATION_AMOUNT)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).confirmPayment(payment.id, ZERO_CONFIRMATION_AMOUNT)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).confirmPayment(ZERO_PAYMENT_ID, ZERO_CONFIRMATION_AMOUNT)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("The payment with the provided ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).confirmPayment(
            payment.id,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(payment.id);
      });

      it("The confirmation amount is greater than the reminder", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
        await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit });
        const refundAmount = Math.floor(payment.baseAmount * 0.1);
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);
        const confirmationAmount = Math.floor(payment.baseAmount + payment.extraAmount - refundAmount) + 1;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).confirmPayment(
            payment.id,
            confirmationAmount
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_INAPPROPRIATE_CONFIRMATION_AMOUNT
        );
      });

      it("The cash-out account is the zero address", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makeCommonPayments([payment]);

        await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).confirmPayment(payment.id, ZERO_CONFIRMATION_AMOUNT)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_CASH_OUT_ACCOUNT_NOT_CONFIGURED
        );
      });
    });
  });

  describe("Function 'confirmPayments()'", async () => {
    it("Executes as expected", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makeCommonPayments([payments[0]]);
      const subsidyLimit = Math.floor(payments[1].baseAmount / 2);
      await cardPaymentProcessorShell.makePaymentFor(payments[1], { sponsor, subsidyLimit });
      const paymentConfirmations: PaymentConfirmation[] = [
        {
          paymentId: payments[0].id,
          amount: Math.floor(payments[0].baseAmount + payments[0].extraAmount * 0.5)
        },
        {
          paymentId: payments[1].id,
          amount: Math.floor(payments[1].baseAmount + payments[1].extraAmount)
        }
      ];
      const operationIndex1 = cardPaymentProcessorShell.model.confirmPayment(
        paymentConfirmations[0].paymentId,
        paymentConfirmations[0].amount
      );
      const operationIndex2 = cardPaymentProcessorShell.model.confirmPayment(
        paymentConfirmations[1].paymentId,
        paymentConfirmations[1].amount
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).confirmPayments(paymentConfirmations);
      await context.checkPaymentOperationsForTx(tx, [operationIndex1, operationIndex2]);
      await context.checkCardPaymentProcessorState();
    });

    it("Is reverted if the contract is paused", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      await pauseContract(cardPaymentProcessorShell.contract);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments(
          [{ paymentId: payment.id, amount: 0 }]
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(deployer).confirmPayments(
          [{ paymentId: payment.id, amount: 0 }]
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment confirmation array is empty", async () => {
      const context = await prepareForPayments();
      const { cardPaymentProcessorShell } = context;

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments([])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_CONFIRMATION_ARRAY_EMPTY
      );
    });

    it("Is reverted if one of the payment IDs is zero", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makeCommonPayments(payments);

      const paymentConfirmations: PaymentConfirmation[] = [
        {
          paymentId: payments[0].id,
          amount: Math.floor(payments[0].baseAmount + payments[0].extraAmount * 0.5)
        },
        {
          paymentId: ZERO_PAYMENT_ID,
          amount: Math.floor(payments[1].baseAmount + payments[1].extraAmount)
        }
      ];

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments(paymentConfirmations)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_ZERO_ID
      );
    });

    it("Is reverted if one of the payments with provided IDs does not exist", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makeCommonPayments([payments[0]]);

      const paymentConfirmations: PaymentConfirmation[] = [
        {
          paymentId: payments[0].id,
          amount: Math.floor(payments[0].baseAmount + payments[0].extraAmount * 0.5)
        },
        {
          paymentId: payments[1].id,
          amount: Math.floor(payments[1].baseAmount + payments[1].extraAmount)
        }
      ];

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments(paymentConfirmations)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
      ).withArgs(payments[1].id);
    });

    it("Is reverted if the confirmation amount is greater than the reminder for one of the payment", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makeCommonPayments(payments);

      const paymentConfirmations: PaymentConfirmation[] = [
        {
          paymentId: payments[0].id,
          amount: Math.floor(payments[0].baseAmount + payments[0].extraAmount * 0.5)
        },
        {
          paymentId: payments[1].id,
          amount: Math.floor(payments[1].baseAmount + payments[1].extraAmount) + 1
        }
      ];

      await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments(paymentConfirmations)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_INAPPROPRIATE_CONFIRMATION_AMOUNT
      );
    });

    it("Is reverted if the cash-out account is the zero address", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      await cardPaymentProcessorShell.makeCommonPayments(payments);

      const paymentConfirmations: PaymentConfirmation[] = [
        {
          paymentId: payments[0].id,
          amount: Math.floor(payments[0].baseAmount + payments[0].extraAmount * 0.5)
        },
        {
          paymentId: payments[1].id,
          amount: Math.floor(payments[1].baseAmount + payments[1].extraAmount)
        }
      ];

      await proveTx(cardPaymentProcessorShell.contract.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).confirmPayments(paymentConfirmations)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessorShell.contract,
        REVERT_ERROR_IF_CASH_OUT_ACCOUNT_NOT_CONFIGURED
      );
    });
  });

  describe("Function 'updateLazyAndConfirmPayment()'", async () => {
    async function checkLazyUpdating(context: TestContext, props: {
                                       newBaseAmount?: number,
                                       newExtraAmount?: number,
                                       confirmationAmount?: number,
                                     } = {}
    ) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;

      await cardPaymentProcessorShell.enableCashback();
      await cardPaymentProcessorShell.makePaymentFor(payment);

      await context.checkCardPaymentProcessorState();

      const newBaseAmount = props.newBaseAmount ?? payment.baseAmount;
      const newExtraAmount = props.newExtraAmount ?? payment.extraAmount;

      const operationIndex1 = cardPaymentProcessorShell.model.updatePayment(
        payment.id,
        newBaseAmount,
        newExtraAmount,
        UpdatingOperationKind.Lazy
      );
      const operationIndex2 = cardPaymentProcessorShell.model.confirmPayment(
        payment.id,
        props.confirmationAmount ?? ZERO_CONFIRMATION_AMOUNT
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).updateLazyAndConfirmPayment(
        payment.id,
        newBaseAmount,
        newExtraAmount,
        props.confirmationAmount ?? ZERO_CONFIRMATION_AMOUNT
      );

      await context.checkPaymentOperationsForTx(tx, [operationIndex1, operationIndex2]);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      describe("The confirmation amount is zero, and", async () => {
        it("The base amount is not changed, the extra amount is not changed", async () => {
          const context = await beforeMakingPayments();
          await checkLazyUpdating(context);
        });

        it("The base amount is changed, but the extra amount is not changed", async () => {
          const context = await beforeMakingPayments();
          const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
          await checkLazyUpdating(context, { newBaseAmount });
        });

        it("The base amount is not changed, but the extra amount is changed", async () => {
          const context = await beforeMakingPayments();
          const newExtraAmount = Math.floor(context.payments[0].extraAmount * 0.9);
          await checkLazyUpdating(context, { newExtraAmount });
        });
      });

      describe("The confirmation amount is non-zero, and", async () => {
        it("The base amount is not changed, the extra amount is not changed", async () => {
          const context = await beforeMakingPayments();
          const confirmationAmount = Math.floor(context.payments[0].baseAmount * 0.5);
          await checkLazyUpdating(context, { confirmationAmount });
        });

        it("The base amount is changed, but the extra amount is not changed", async () => {
          const context = await beforeMakingPayments();
          const confirmationAmount = Math.floor(context.payments[0].baseAmount * 0.5);
          const newBaseAmount = Math.floor(context.payments[0].baseAmount * 0.9);
          await checkLazyUpdating(context, { newBaseAmount, confirmationAmount });
        });

        it("The base amount is not changed, but the extra amount is changed", async () => {
          const context = await beforeMakingPayments();
          const confirmationAmount = Math.floor(context.payments[0].baseAmount * 0.5);
          const newExtraAmount = Math.floor(context.payments[0].extraAmount * 0.9);
          await checkLazyUpdating(context, { newExtraAmount, confirmationAmount });
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updateLazyAndConfirmPayment(
            payment.id,
            payment.baseAmount,
            payment.extraAmount,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).updateLazyAndConfirmPayment(
            payment.id,
            payment.baseAmount,
            payment.extraAmount,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updateLazyAndConfirmPayment(
            ZERO_PAYMENT_ID,
            payment.baseAmount,
            payment.extraAmount,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("The payment with the provided ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updateLazyAndConfirmPayment(
            payment.id,
            payment.baseAmount,
            payment.extraAmount,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(payment.id);
      });

      it("The new sum amount is less than the refund amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await cardPaymentProcessorShell.makeCommonPayments([payment]);
        const refundAmount = Math.floor((payment.baseAmount + payment.extraAmount) * 0.5);
        const newBaseAmount = Math.floor(payment.baseAmount * 0.4);
        const newExtraAmount = Math.floor(payment.baseAmount * 0.4);
        await cardPaymentProcessorShell.refundPayment(payment, refundAmount);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).updateLazyAndConfirmPayment(
            payment.id,
            newBaseAmount,
            newExtraAmount,
            ZERO_CONFIRMATION_AMOUNT
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_INAPPROPRIATE_SUM_AMOUNT
        );
      });
    });
  });

  describe("Function 'refundPayment()'", async () => {
    async function checkRefunding(context: TestContext, props: {
                                    refundAmount: number,
                                    cashbackCondition?: CashbackConditionType,
                                    confirmedAmount?: number,
                                    subsidyLimit?: number,
                                  } = { refundAmount: 0, cashbackCondition: CashbackConditionType.CashbackEnabled }
    ) {
      const { cardPaymentProcessorShell, payments: [payment] } = context;
      const { cashbackCondition, subsidyLimit, confirmedAmount } = props;

      if (cashbackCondition !== CashbackConditionType.CashbackDisabledBeforePaymentMaking) {
        await cardPaymentProcessorShell.enableCashback();
      }

      await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit, confirmedAmount });

      if (cashbackCondition === CashbackConditionType.CashbackDisabledAfterPaymentMaking) {
        await cardPaymentProcessorShell.disableCashback();
      }

      if (cashbackCondition === CashbackConditionType.CashbackEnabledButIncreasingPartial) {
        const actualCashbackChange = 2 * CASHBACK_ROUNDING_COEF;
        await context.cashbackDistributorMockShell.setIncreaseCashbackAmountResult(actualCashbackChange);
      }
      if (cashbackCondition === CashbackConditionType.CashbackEnabledButRevokingFails) {
        await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);
      }
      if (cashbackCondition === CashbackConditionType.CashbackEnabledButIncreasingFails) {
        await context.cashbackDistributorMockShell.setIncreaseCashbackSuccessResult(false);
      }

      await context.checkCardPaymentProcessorState();

      cardPaymentProcessorShell.model.refundPayment(
        payment.id,
        props.refundAmount
      );
      const tx = cardPaymentProcessorShell.contract.connect(executor).refundPayment(
        payment.id,
        props.refundAmount
      );

      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      describe("The payment is subsidized but not confirmed, and", async () => {
        describe("The refund amount is less than base amount, and cashback is", async () => {
          it("Enabled, and cashback operation is executed successfully", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const refundAmount = Math.floor(payment.baseAmount * 0.9);
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            await checkRefunding(context, { refundAmount, subsidyLimit });
          });

          it("Disabled before payment making", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const refundAmount = Math.floor(payment.baseAmount * 0.9);
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            await checkRefunding(context, {
              refundAmount,
              subsidyLimit,
              cashbackCondition: CashbackConditionType.CashbackDisabledBeforePaymentMaking
            });
          });

          it("Disabled after payment making", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const refundAmount = Math.floor(payment.baseAmount * 0.9);
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            await checkRefunding(context, {
              refundAmount,
              subsidyLimit,
              cashbackCondition: CashbackConditionType.CashbackDisabledAfterPaymentMaking
            });
          });

          it("Enabled but cashback operation fails", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const refundAmount = Math.floor(payment.baseAmount * 0.9);
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            await checkRefunding(context, {
              refundAmount,
              subsidyLimit,
              cashbackCondition: CashbackConditionType.CashbackEnabledButRevokingFails
            });
          });
        });

        describe("The refund amount equals the sum amount, and cashback is", async () => {
          it("Enabled, and cashback operation is executed successfully", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const refundAmount = Math.floor(payment.baseAmount + payment.extraAmount);
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            await checkRefunding(context, { refundAmount, subsidyLimit });
          });
        });

        describe("The refund amount is zero, and cashback is", async () => {
          it("Enabled, and cashback operation is executed successfully", async () => {
            const context = await beforeMakingPayments();
            const { payments: [payment] } = context;
            const refundAmount = 0;
            const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
            await checkRefunding(context, { refundAmount, subsidyLimit });
          });
        });
      });

      describe("The payment is subsidized and confirmed, and cashback is enabled, and", async () => {
        it("The refund amount is less than non-confirmed amount", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const confirmedAmount = Math.floor(payment.baseAmount * 0.2);
          const refundAmount = Math.floor(payment.baseAmount * 0.3);
          const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
          await checkRefunding(context, { refundAmount, subsidyLimit, confirmedAmount });
        });

        it("The refund amount is the same as non-confirmed amount", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const sumAmount = Math.floor(payment.baseAmount + payment.extraAmount);
          const confirmedAmount = Math.floor(payment.baseAmount * 0.2);
          const refundAmount = sumAmount - confirmedAmount;
          const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
          await checkRefunding(context, { refundAmount, subsidyLimit, confirmedAmount });
        });

        it("The refund amount is greater than non-confirmed amount", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const sumAmount = Math.floor(payment.baseAmount + payment.extraAmount);
          const confirmedAmount = Math.floor(payment.baseAmount * 0.2);
          const refundAmount = Math.floor(sumAmount - payment.baseAmount * 0.1);
          const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
          await checkRefunding(context, { refundAmount, subsidyLimit, confirmedAmount });
        });

        it("The refund amount is zero", async () => {
          const context = await beforeMakingPayments();
          const { payments: [payment] } = context;
          const confirmedAmount = Math.floor(payment.baseAmount * 0.2);
          const refundAmount = 0;
          const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
          await checkRefunding(context, { refundAmount, subsidyLimit, confirmedAmount });
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundPayment(payment.id, ZERO_REFUND_AMOUNT)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).refundPayment(payment.id, ZERO_REFUND_AMOUNT)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundPayment(ZERO_PAYMENT_ID, ZERO_REFUND_AMOUNT)
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ZERO_ID);
      });

      it("The payment with the provided ID does not exist", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundPayment(payment.id, ZERO_REFUND_AMOUNT)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(payment.id);
      });

      it("The payment status is 'Revoked'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makeCommonPayments([payment]);
        await cardPaymentProcessorShell.revokePayment(payment);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundPayment(payment.id, ZERO_REFUND_AMOUNT)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
        ).withArgs(
          payment.id,
          PaymentStatus.Revoked
        );
      });

      it("The payment status is 'Reversed'", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        await cardPaymentProcessorShell.makeCommonPayments([payment]);
        await cardPaymentProcessorShell.reversePayment(payment);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundPayment(payment.id, ZERO_REFUND_AMOUNT)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
        ).withArgs(
          payment.id,
          PaymentStatus.Reversed
        );
      });

      it("The refund amount exceeds the sum amount", async () => {
        const context = await beforeMakingPayments();
        const { cardPaymentProcessorShell, payments: [payment] } = context;
        const subsidyLimit = Math.floor(payment.baseAmount * 0.5);
        const confirmedAmount = Math.floor(payment.baseAmount * 0.2);
        await cardPaymentProcessorShell.makePaymentFor(payment, { sponsor, subsidyLimit, confirmedAmount });
        const refundAmount = payment.baseAmount + payment.extraAmount + 1;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundPayment(payment.id, refundAmount)
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_INAPPROPRIATE_REFUNDING_AMOUNT
        );
      });
    });
  });

  describe("Function 'mergePayments()'", async () => {

    async function checkPaymentMerging(context: TestContext, props: {
                                         cashbackCondition?: CashbackConditionType,
                                         targetPaymentRefundAmount?: number,
                                         targetPaymentConfirmationAmount?: number
                                       } = { cashbackCondition: CashbackConditionType.CashbackEnabled }
    ) {
      const { cardPaymentProcessorShell, payments } = context;
      const { cashbackCondition, targetPaymentRefundAmount, targetPaymentConfirmationAmount } = props;
      const targetPayment = payments[0];
      const mergedPayments = payments.slice(1);
      const mergedPaymentIds: string[] = [];
      mergedPayments.forEach(payment => {
        payment.payer = targetPayment.payer;
        mergedPaymentIds.push(payment.id);
      });

      if (cashbackCondition !== CashbackConditionType.CashbackDisabledBeforePaymentMaking) {
        await cardPaymentProcessorShell.enableCashback();
      }

      await cardPaymentProcessorShell.makePaymentFor(
        targetPayment,
        { confirmationAmount: targetPaymentConfirmationAmount }
      );
      if (targetPaymentRefundAmount) {
        await cardPaymentProcessorShell.refundPayment(targetPayment, targetPaymentRefundAmount);
      }
      await context.cashbackDistributorMockShell.increaseSendCashbackNonceResult();
      await cardPaymentProcessorShell.makePaymentFor(mergedPayments[0]);

      if (payments.length > 2) {
        const confirmationAmount = Math.floor(mergedPayments[1].baseAmount * 0.2);
        const refundAmount = Math.floor(mergedPayments[1].baseAmount * 0.1);
        await context.cashbackDistributorMockShell.increaseSendCashbackNonceResult();
        await cardPaymentProcessorShell.makePaymentFor(
          mergedPayments[1],
          { confirmationAmount }
        );
        await cardPaymentProcessorShell.refundPayment(mergedPayments[1], refundAmount);

        await cardPaymentProcessorShell.makePaymentFor(
          mergedPayments[2], { cashbackRate: ZERO_CASHBACK_RATE }
        );

        if (mergedPaymentIds.length > 3) {
          for (let i = 3; i < mergedPaymentIds.length; ++i) {
            await context.cashbackDistributorMockShell.increaseSendCashbackNonceResult();
            await cardPaymentProcessorShell.makePaymentFor(mergedPayments[i]);
          }
        }
      }

      if (cashbackCondition === CashbackConditionType.CashbackDisabledAfterPaymentMaking) {
        await cardPaymentProcessorShell.disableCashback();
      }

      if (cashbackCondition === CashbackConditionType.CashbackEnabledButIncreasingPartial) {
        const actualCashbackChange = 2 * CASHBACK_ROUNDING_COEF;
        await context.cashbackDistributorMockShell.setIncreaseCashbackAmountResult(actualCashbackChange);
      }
      if (cashbackCondition === CashbackConditionType.CashbackEnabledButRevokingFails) {
        await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);
      }
      if (cashbackCondition === CashbackConditionType.CashbackEnabledButIncreasingFails) {
        await context.cashbackDistributorMockShell.setIncreaseCashbackSuccessResult(false);
      }

      await context.checkCardPaymentProcessorState();

      const operationIndexes: number[] =
        cardPaymentProcessorShell.model.mergePayments(targetPayment.id, mergedPaymentIds);
      const tx = cardPaymentProcessorShell.contract.connect(executor).mergePayments(
        targetPayment.id,
        mergedPaymentIds
      );
      await context.checkPaymentOperationsForTx(tx, operationIndexes);
      await context.checkCardPaymentProcessorState();
    }

    describe("Executes as expected if", async () => {
      it("There are several different payments to merge and cashback is enabled", async () => {
        const context = await beforeMakingPayments({ paymentNumber: 4 });
        const targetPaymentConfirmationAmount = Math.floor(context.payments[0].baseAmount * 0.2);
        const targetPaymentRefundAmount = Math.floor(context.payments[0].baseAmount * 0.1);
        await checkPaymentMerging(context, { targetPaymentConfirmationAmount, targetPaymentRefundAmount });
      });

      it("There are two payments to merge and cashback is disabled before payment making", async () => {
        const context = await beforeMakingPayments({ paymentNumber: 2 });
        await checkPaymentMerging(
          context,
          { cashbackCondition: CashbackConditionType.CashbackDisabledBeforePaymentMaking }
        );
      });

      it("There are two payments to merge and cashback is disabled after payment making", async () => {
        const context = await beforeMakingPayments({ paymentNumber: 2 });
        await checkPaymentMerging(
          context,
          { cashbackCondition: CashbackConditionType.CashbackDisabledAfterPaymentMaking }
        );
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        await pauseContract(cardPaymentProcessorShell.contract);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(targetPayment.id, [mergedPayment.id])
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).mergePayments(targetPayment.id, [mergedPayment.id])
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The target payment ID is zero", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [mergedPayment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(ZERO_PAYMENT_ID, [mergedPayment.id])
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("The array of payment IDs to merge is empty", async () => {
        const context = await prepareForPayments();
        const { cardPaymentProcessorShell, payments: [targetPayment] } = context;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment]);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(targetPayment.id, [])
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_MERGED_PAYMENT_ID_ARRAY_EMPTY
        );
      });

      it("The target payment with the provided ID does not exist", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(targetPayment.id, [mergedPayment.id])
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(targetPayment.id);
      });

      it("The target payment with the provided ID is subsidized", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makePaymentFor(targetPayment, { sponsor, subsidyLimit: 1 });
        await cardPaymentProcessorShell.makePaymentFor(mergedPayment);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(targetPayment.id, [mergedPayment.id])
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_SUBSIDIZED
        ).withArgs(targetPayment.id);
      });

      it("One of the merged payment IDs is zero", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        mergedPayment.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment, mergedPayment]);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment.id, ZERO_PAYMENT_ID]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_ZERO_ID
        );
      });

      it("One of the merged payment does not exist", async () => {
        const context = await prepareForPayments({ paymentNumber: 3 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment1, mergedPayment2] } = context;
        mergedPayment1.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment, mergedPayment1]);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment1.id, mergedPayment2.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_NON_EXISTENT
        ).withArgs(mergedPayment2.id);
      });

      it("One of the merged payment id equals the target payment id", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        mergedPayment.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment, mergedPayment]);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment.id, targetPayment.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_MERGED_PAYMENT_ID_AND_TARGET_PAYMENT_ID_EQUALITY
        );
      });

      it("One of the merged payment has another payer address", async () => {
        const context = await prepareForPayments({ paymentNumber: 3 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment1, mergedPayment2] } = context;
        targetPayment.payer = user1;
        mergedPayment1.payer = user1;
        mergedPayment2.payer = user2;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makeCommonPayments(context.payments);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment1.id, mergedPayment2.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_MERGED_PAYMENT_PAYER_MISMATCH
        ).withArgs(
          mergedPayment2.id, mergedPayment2.payer.address, targetPayment.payer.address
        );
      });

      it("One of the merged payment has another payer address", async () => {
        const context = await prepareForPayments({ paymentNumber: 3 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment1, mergedPayment2] } = context;
        mergedPayment1.payer = targetPayment.payer;
        mergedPayment2.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment, mergedPayment1]);
        await cardPaymentProcessorShell.makePaymentFor(mergedPayment2, { sponsor, subsidyLimit: 1 });

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment1.id, mergedPayment2.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_PAYMENT_SUBSIDIZED
        ).withArgs(
          mergedPayment2.id
        );
      });

      it("One of the merged payment has a greater cashback rate than the target payment", async () => {
        const context = await prepareForPayments({ paymentNumber: 3 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment1, mergedPayment2] } = context;
        mergedPayment1.payer = targetPayment.payer;
        mergedPayment2.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment, mergedPayment1]);
        await cardPaymentProcessorShell.makePaymentFor(mergedPayment2, { cashbackRate: CASHBACK_RATE_DEFAULT * 2 });

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment1.id, mergedPayment2.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_MERGED_PAYMENT_CASHBACK_RATE_MISMATCH
        ).withArgs(
          mergedPayment2.id, CASHBACK_RATE_DEFAULT * 2, CASHBACK_RATE_DEFAULT
        );
      });

      it("The result sum payment amount is greater than 64-bit unsigned integer", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        mergedPayment.payer = targetPayment.payer;
        const targetPaymentBaseAmount: BigNumber = MAX_UINT_64.sub(5);
        targetPayment.baseAmount = 0;
        targetPayment.extraAmount = 3;
        mergedPayment.baseAmount = 2;
        mergedPayment.extraAmount = 1;
        await context.setUpContractsForPayments();
        await proveTx(context.tokenMock.mint(targetPayment.payer.address, targetPaymentBaseAmount));
        await proveTx(cardPaymentProcessorShell.contract.connect(executor).makeCommonPaymentFor(
          targetPayment.id,
          targetPayment.payer.address,
          targetPaymentBaseAmount,
          targetPayment.extraAmount
        ));
        await proveTx(cardPaymentProcessorShell.contract.connect(executor).makeCommonPaymentFor(
          mergedPayment.id,
          mergedPayment.payer.address,
          mergedPayment.baseAmount,
          mergedPayment.extraAmount
        ));

        await expect(cardPaymentProcessorShell.contract.connect(executor).mergePayments(
          targetPayment.id,
          [mergedPayment.id]
        )).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_OVERFLOW_OF_SUM_AMOUNT);
      });

      it("The processor contract has not enough balance to merge the cashback", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        mergedPayment.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makePaymentFor(
          targetPayment,
          { confirmationAmount: targetPayment.baseAmount + targetPayment.extraAmount }
        );
        await cardPaymentProcessorShell.makePaymentFor(
          mergedPayment,
          { confirmationAmount: mergedPayment.baseAmount + mergedPayment.extraAmount }
        );

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_CASHBACK_MERGING_FAILURE
        ).withArgs(
          mergedPayment.id,
          CashbackMergingFailureKind.NotEnoughBalance
        );
      });

      it("The cashback revocation fails", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        mergedPayment.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment, mergedPayment]);
        await context.cashbackDistributorMockShell.setRevokeCashbackSuccessResult(false);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_CASHBACK_MERGING_FAILURE
        ).withArgs(
          mergedPayment.id,
          CashbackMergingFailureKind.RevocationError
        );
      });

      it("The cashback increase is executed partially", async () => {
        const context = await prepareForPayments({ paymentNumber: 2 });
        const { cardPaymentProcessorShell, payments: [targetPayment, mergedPayment] } = context;
        mergedPayment.payer = targetPayment.payer;
        await context.setUpContractsForPayments();
        await cardPaymentProcessorShell.enableCashback();
        await cardPaymentProcessorShell.makeCommonPayments([targetPayment, mergedPayment]);
        await context.cashbackDistributorMockShell.setIncreaseCashbackAmountResult(CASHBACK_ROUNDING_COEF);

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).mergePayments(
            targetPayment.id,
            [mergedPayment.id]
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessorShell.contract,
          REVERT_ERROR_IF_CASHBACK_MERGING_FAILURE
        ).withArgs(
          mergedPayment.id,
          CashbackMergingFailureKind.IncreaseError
        );
      });
    });
  });

  describe("Function 'refundAccount()'", async () => {
    const nonZeroTokenAmount = 123;
    const zeroTokenAmount = 0;

    async function checkRefundingAccount(tokenAmount: number) {
      const { cardPaymentProcessorShell, tokenMock } = await prepareForPayments();
      await proveTx(tokenMock.mint(cashOutAccount.address, tokenAmount));

      const tx = await cardPaymentProcessorShell.contract.connect(executor).refundAccount(
        user1.address,
        tokenAmount
      );

      await expect(tx).to.emit(
        cardPaymentProcessorShell.contract,
        EVENT_NAME_ACCOUNT_REFUNDED
      ).withArgs(
        user1.address,
        tokenAmount,
        "0x"
      );

      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [user1, cashOutAccount, cardPaymentProcessorShell.contract],
        [+tokenAmount, -tokenAmount, 0]
      );
    }

    describe("Executes as expected and emits the correct events if the refund amount is", async () => {
      it("Non-zero", async () => {
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
          cardPaymentProcessorShell.contract.connect(executor).refundAccount(
            user1.address,
            nonZeroTokenAmount,
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const { cardPaymentProcessorShell } = await prepareForPayments();

        await expect(
          cardPaymentProcessorShell.contract.connect(deployer).refundAccount(
            user1.address,
            nonZeroTokenAmount,
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The account address is zero", async () => {
        const { cardPaymentProcessorShell } = await prepareForPayments();

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundAccount(
            ZERO_ADDRESS,
            nonZeroTokenAmount,
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_ACCOUNT_ZERO_ADDRESS);
      });

      it("The cash-out account does not have enough token balance", async () => {
        const { cardPaymentProcessorShell, tokenMock } = await prepareForPayments();
        const tokenAmount = nonZeroTokenAmount;
        await proveTx(tokenMock.mint(cashOutAccount.address, tokenAmount - 1));

        await expect(
          cardPaymentProcessorShell.contract.connect(executor).refundAccount(
            user1.address,
            tokenAmount,
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });
    });
  });

  describe("Complex scenarios without cashback", async () => {
    async function checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
      cardPaymentProcessor: Contract,
      payments: TestPayment[],
      status: PaymentStatus
    ) {
      const paymentIds = payments.map(payment => payment.id);

      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(paymentIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(
        paymentIds[0],
        status
      );

      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(paymentIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(
        paymentIds[0],
        status
      );

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(paymentIds[0], ZERO_CONFIRMATION_AMOUNT)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(
        paymentIds[0],
        status
      );

      const paymentConfirmations: PaymentConfirmation[] = paymentIds.map(id => {
        return {
          paymentId: id,
          amount: ZERO_CONFIRMATION_AMOUNT
        };
      });

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(paymentConfirmations)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(
        paymentIds[0],
        status
      );

      await expect(
        cardPaymentProcessor.connect(executor).updatePayment(
          paymentIds[0],
          payments[0].baseAmount,
          payments[0].extraAmount
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(
        paymentIds[0],
        status
      );

      await expect(
        cardPaymentProcessor.connect(executor).updateLazyAndConfirmPayment(
          paymentIds[0],
          payments[0].baseAmount,
          payments[0].extraAmount,
          ZERO_CONFIRMATION_AMOUNT
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(
        paymentIds[0],
        status
      );

      await expect(
        cardPaymentProcessor.connect(executor).refundPayment(
          paymentIds[0],
          ZERO_REFUND_AMOUNT
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_INAPPROPRIATE_PAYMENT_STATUS
      ).withArgs(
        paymentIds[0],
        status
      );
    }

    it("All payment processing functions except making are reverted if a payment was revoked", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;

      await cardPaymentProcessorShell.makeCommonPayments(payments);
      await cardPaymentProcessorShell.revokePayment(payments[0]);

      await context.checkCardPaymentProcessorState();

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
        cardPaymentProcessorShell.contract,
        payments,
        PaymentStatus.Revoked
      );

      cardPaymentProcessorShell.model.makePayment(payments[0], { sender: executor });
      const tx = cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
        payments[0].id,
        payments[0].payer.address,
        payments[0].baseAmount,
        payments[0].extraAmount,
        ZERO_SPONSOR_ADDRESS,
        ZERO_SUBSIDY_LIMIT,
        CASHBACK_RATE_AS_IN_CONTRACT,
        ZERO_CONFIRMATION_AMOUNT
      );
      await context.checkPaymentOperationsForTx(tx);
      await context.checkCardPaymentProcessorState();
    });

    it("All payment processing functions are reverted if a payment was reversed", async () => {
      const context = await beforeMakingPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;

      await cardPaymentProcessorShell.makeCommonPayments(payments);
      await cardPaymentProcessorShell.reversePayment(payments[0]);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
          payments[0].id,
          payments[0].payer.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          ZERO_SPONSOR_ADDRESS,
          ZERO_SUBSIDY_LIMIT,
          CASHBACK_RATE_AS_IN_CONTRACT,
          ZERO_CONFIRMATION_AMOUNT
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTENT);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
        cardPaymentProcessorShell.contract,
        payments,
        PaymentStatus.Reversed
      );
      await context.checkCardPaymentProcessorState();
    });

    it("All payment processing functions are reverted if a payment was merged", async () => {
      const context = await prepareForPayments({ paymentNumber: 2 });
      const { cardPaymentProcessorShell, payments } = context;
      const targetPayment: TestPayment = payments[1];
      const mergedPayment: TestPayment = payments[0];
      targetPayment.payer = mergedPayment.payer;
      await context.setUpContractsForPayments();

      await cardPaymentProcessorShell.makeCommonPayments(payments);
      await cardPaymentProcessorShell.mergePayments(targetPayment, [mergedPayment]);

      await expect(
        cardPaymentProcessorShell.contract.connect(executor).makePaymentFor(
          payments[0].id,
          payments[0].payer.address,
          payments[0].baseAmount,
          payments[0].extraAmount,
          ZERO_SPONSOR_ADDRESS,
          ZERO_SUBSIDY_LIMIT,
          CASHBACK_RATE_AS_IN_CONTRACT,
          ZERO_CONFIRMATION_AMOUNT
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessorShell.contract, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTENT);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
        cardPaymentProcessorShell.contract,
        payments,
        PaymentStatus.Merged
      );
      await context.checkCardPaymentProcessorState();
    });
  });
});
