import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { TransactionResponse } from "@ethersproject/abstract-provider";

const MAX_UINT256 = ethers.constants.MaxUint256;
const MAX_INT256 = ethers.constants.MaxInt256;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const ZERO_TRANSACTION_HASH: string = ethers.constants.HashZero;
const BYTES16_LENGTH: number = 16;
const BYTES32_LENGTH: number = 32;

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
  authorizationId: string;
  account: SignerWithAddress;
  amount: number;
  status: PaymentStatus;
  revocationCounter?: number;
  correlationId: string;
  parentTxHash: string;
  compensationAmount?: number;
  cashbackNonce?: number;
  cashbackRateInPermil?: number;
  refundAmount?: number;
  unrevokedCashback?: number;
}

interface CashbackDistributorMockConfig {
  sendCashbackSuccessResult: boolean;
  sendCashbackAmountResult: number;
  sendCashbackNonceResult: number;
  revokeCashbackSuccessResult: boolean;
  increaseCashbackSuccessResult: boolean;
  increaseCashbackAmountResult: number;
}

interface Fixture {
  cardPaymentProcessor: Contract;
  tokenMock: Contract;
  cashbackDistributorMock: Contract;
  cashbackDistributorMockConfig: CashbackDistributorMockConfig;
}

function checkNonexistentPayment(
  actualOnChainPayment: any,
  paymentIndex: number
) {
  expect(actualOnChainPayment.account).to.equal(
    ZERO_ADDRESS,
    `payment[${paymentIndex}].account is incorrect`
  );
  expect(actualOnChainPayment.amount).to.equal(
    0,
    `payment[${paymentIndex}].amount is incorrect`
  );
  expect(actualOnChainPayment.status).to.equal(
    0,
    `payment[${paymentIndex}].status is incorrect`
  );
  expect(actualOnChainPayment.revocationCounter).to.equal(0);
  expect(actualOnChainPayment.compensationAmount).to.equal(0);
  expect(actualOnChainPayment.refundAmount).to.equal(0);
  expect(actualOnChainPayment.cashbackRate).to.equal(0);
}

function checkEquality(
  actualOnChainPayment: any,
  expectedPayment: TestPayment,
  paymentIndex: number
) {
  if (expectedPayment.status == PaymentStatus.Nonexistent) {
    checkNonexistentPayment(actualOnChainPayment, paymentIndex);
  } else {
    expect(actualOnChainPayment.account).to.equal(
      expectedPayment.account.address,
      `payment[${paymentIndex}].account is incorrect`
    );
    expect(actualOnChainPayment.amount).to.equal(
      expectedPayment.amount,
      `payment[${paymentIndex}].amount is incorrect`
    );
    expect(actualOnChainPayment.status).to.equal(
      expectedPayment.status,
      `payment[${paymentIndex}].status is incorrect`
    );
    expect(actualOnChainPayment.revocationCounter).to.equal(
      expectedPayment.revocationCounter || 0,
      `payment[${paymentIndex}].revocationCounter is incorrect`
    );
    expect(actualOnChainPayment.compensationAmount).to.equal(
      (expectedPayment.compensationAmount || 0),
      `payment[${paymentIndex}].compensationAmount is incorrect`
    );
    expect(actualOnChainPayment.refundAmount).to.equal(
      expectedPayment.refundAmount || 0,
      `payment[${paymentIndex}].refundAmount is incorrect`
    );
    expect(actualOnChainPayment.cashbackRate).to.equal(
      expectedPayment.cashbackRateInPermil || 0,
      `payment[${paymentIndex}].cashbackRate is incorrect`
    );
  }
}

function increaseBytesString(bytesString: string, targetLength: number) {
  return createBytesString(
    parseInt(bytesString.substring(2), 16) + 1,
    targetLength
  );
}

function calculateCashback(
  payment: TestPayment,
  cashbackRateInPermil = payment.cashbackRateInPermil || 0,
  paymentAmount = payment.amount
): number {
  return Math.floor((paymentAmount - (payment.refundAmount || 0)) * cashbackRateInPermil / 1000);
}

function calculateInitialCashback(payment: TestPayment): number {
  return Math.floor(payment.amount * (payment.cashbackRateInPermil || 0) / 1000);
}

function calculateRefundCashbackDifference(payment: TestPayment): number {
  return calculateInitialCashback(payment) - calculateCashback(payment);
}

function calculateCompensationAmount(payment: TestPayment): number {
  return (payment.refundAmount || 0) + calculateCashback(payment);
}

function calculateCashbackChangeIfNewPaymentAmount(payment: TestPayment, newPaymentAmount: number) {
  return calculateCashback(payment, payment.cashbackRateInPermil, newPaymentAmount) - calculateCashback(payment);
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

  const EVENT_NAME_CONFIRM_PAYMENT = "ConfirmPayment";
  const EVENT_NAME_CLEAR_PAYMENT = "ClearPayment";
  const EVENT_NAME_ENABLE_CASHBACK = "EnableCashback";
  const EVENT_NAME_DISABLE_CASHBACK = "DisableCashback";
  const EVENT_NAME_INCREASE_CASHBACK_FAILURE = "IncreaseCashbackFailure";
  const EVENT_NAME_INCREASE_CASHBACK_MOCK = "IncreaseCashbackMock";
  const EVENT_NAME_INCREASE_CASHBACK_SUCCESS = "IncreaseCashbackSuccess";
  const EVENT_NAME_MAKE_PAYMENT = "MakePayment";
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
  const REVERT_ERROR_IF_NEW_PAYMENT_AMOUNT_IS_INAPPROPRIATE = "InappropriateNewPaymentAmount";

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

  async function setUpContractsForPayments(fixture: Fixture, payments: TestPayment[]) {
    const { tokenMock, cardPaymentProcessor } = fixture;
    for (let payment of payments) {
      await proveTx(tokenMock.mint(payment.account.address, payment.amount));
      const allowance: BigNumber = await tokenMock.allowance(payment.account.address, cardPaymentProcessor.address);
      if (allowance.lt(MAX_UINT256)) {
        await proveTx(
          tokenMock.connect(payment.account).approve(
            cardPaymentProcessor.address,
            MAX_UINT256
          )
        );
      }
    }
  }

  function setCashbackNonce(payment: TestPayment, fixture: Fixture) {
    payment.cashbackNonce = fixture.cashbackDistributorMockConfig.sendCashbackNonceResult;
  }

  function setCashback(
    payment: TestPayment,
    fixture: Fixture,
    newCashbackRateInPermil: number = CASHBACK_RATE_IN_PERMIL
  ) {
    payment.cashbackRateInPermil = newCashbackRateInPermil;
    payment.compensationAmount = calculateCompensationAmount(payment);
    setCashbackNonce(payment, fixture);
  }

  function setRefundAmount(payment: TestPayment, newRefundAmount: number) {
    payment.refundAmount = newRefundAmount;
    payment.compensationAmount = calculateCompensationAmount(payment);
  }

  function setNewAmount(payment: TestPayment, newAmount: number, isCashbackIncreasingFails: boolean = false) {
    payment.amount = newAmount;
    if (!isCashbackIncreasingFails) {
      payment.compensationAmount = calculateCompensationAmount(payment);
    }
  }

  async function pauseContract(contract: Contract) {
    await proveTx(contract.grantRole(pauserRole, deployer.address));
    await proveTx(contract.pause());
  }

  async function makePayments(cardPaymentProcessor: Contract, payments: TestPayment[]) {
    for (let payment of payments) {
      await proveTx(
        cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount,
          payment.authorizationId,
          payment.correlationId,
        )
      );
      payment.status = PaymentStatus.Uncleared;
      if (!!payment.revocationCounter) {
        payment.parentTxHash = increaseBytesString(payment.parentTxHash, BYTES32_LENGTH);
      }
    }
  }

  async function clearPayments(cardPaymentProcessor: Contract, payments: TestPayment[]) {
    const authorizationIds: string[] = [];
    payments.forEach((payment: TestPayment) => {
      authorizationIds.push(payment.authorizationId);
      payment.status = PaymentStatus.Cleared;
    });
    await proveTx(cardPaymentProcessor.connect(executor).clearPayments(authorizationIds));
  }

  async function unclearPayments(cardPaymentProcessor: Contract, payments: TestPayment[]) {
    const authorizationIds: string[] = [];
    payments.forEach((payment: TestPayment) => {
      authorizationIds.push(payment.authorizationId);
      payment.status = PaymentStatus.Uncleared;
    });
    await proveTx(cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds));
  }

  async function confirmPayments(cardPaymentProcessor: Contract, payments: TestPayment[]) {
    const authorizationIds: string[] = [];
    payments.forEach((payment: TestPayment) => {
      authorizationIds.push(payment.authorizationId);
      payment.status = PaymentStatus.Confirmed;
    });
    await proveTx(cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds));
  }

  async function checkPaymentStructures(cardPaymentProcessor: Contract, payments: TestPayment[]) {
    for (let i = 0; i < payments.length; ++i) {
      const expectedPayment: TestPayment = payments[i];
      const actualPayment = await cardPaymentProcessor.paymentFor(expectedPayment.authorizationId);
      checkEquality(actualPayment, expectedPayment, i);
      if (!!expectedPayment.parentTxHash) {
        expect(
          await cardPaymentProcessor.isPaymentReversed(expectedPayment.parentTxHash)
        ).to.equal(
          expectedPayment.status == PaymentStatus.Reversed,
          `The reversing status of payment[${i}] is wrong`
        );
        expect(
          await cardPaymentProcessor.isPaymentRevoked(expectedPayment.parentTxHash)
        ).to.equal(
          expectedPayment.status == PaymentStatus.Revoked,
          `The revoking status of payment[${i}] is wrong`
        );
      }
    }
  }

  async function checkCashbackNonces(cardPaymentProcessor: Contract, payments: TestPayment[]) {
    for (let i = 0; i < payments.length; ++i) {
      const payment: TestPayment = payments[i];
      const expectedNonce: BigNumber = payment.status != PaymentStatus.Nonexistent
        ? BigNumber.from(payment.cashbackNonce || 0)
        : ethers.constants.Zero;
      const cashback = await cardPaymentProcessor.getCashback(payment.authorizationId);
      expect(cashback.lastCashbackNonce).to.equal(expectedNonce);
    }
  }

  async function checkClearedAndUnclearedBalances(cardPaymentProcessor: Contract, payments: TestPayment[]) {
    const expectedBalancesPerAccount: Map<string, { unclearedBalance: number, clearedBalance: number, }> = new Map();
    let expectedTotalUnclearedBalance = 0;
    let expectedTotalClearedBalance = 0;

    payments.forEach((payment: TestPayment) => {
      const address: string = payment.account.address;
      let newBalances = expectedBalancesPerAccount.get(address) || { unclearedBalance: 0, clearedBalance: 0 };
      const amount = payment.amount - (payment.refundAmount || 0);
      if (payment.status == PaymentStatus.Uncleared) {
        newBalances.unclearedBalance += amount;
        expectedTotalUnclearedBalance += amount;
      } else if (payment.status == PaymentStatus.Cleared) {
        newBalances.clearedBalance += amount;
        expectedTotalClearedBalance += amount;
      }
      expectedBalancesPerAccount.set(address, newBalances);
    });

    for (const account of expectedBalancesPerAccount.keys()) {
      const expectedBalances = expectedBalancesPerAccount.get(account);
      if (!expectedBalances) {
        continue;
      }
      expect(
        await cardPaymentProcessor.clearedBalanceOf(account)
      ).to.equal(
        expectedBalances.clearedBalance,
        `The cleared balance for account ${account} is wrong`
      );
      expect(
        await cardPaymentProcessor.unclearedBalanceOf(account)
      ).to.equal(
        expectedBalances.unclearedBalance,
        `The uncleared balance for account ${account} is wrong`
      );
    }
    expect(
      await cardPaymentProcessor.totalUnclearedBalance()
    ).to.equal(
      expectedTotalUnclearedBalance,
      `The total uncleared balance is wrong`
    );

    expect(
      await cardPaymentProcessor.totalClearedBalance()
    ).to.equal(
      expectedTotalClearedBalance,
      `The total cleared balance is wrong`
    );
  }

  async function checkTokenBalance(fixture: Fixture, payments: TestPayment[]) {
    const { cardPaymentProcessor, tokenMock } = fixture;
    const expectedTokenBalance: number = countNumberArrayTotal(
      payments.map(
        function (payment: TestPayment): number {
          if (payment.status == PaymentStatus.Uncleared || payment.status == PaymentStatus.Cleared) {
            return payment.amount - (payment.refundAmount || 0) + (payment.unrevokedCashback || 0);
          } else {
            return (payment.unrevokedCashback || 0);
          }
        }
      )
    );
    expect(
      await tokenMock.balanceOf(cardPaymentProcessor.address)
    ).to.equal(
      expectedTokenBalance,
      `The processor token balance is wrong`
    );
  }

  async function checkCardPaymentProcessorState(fixture: Fixture, payments: TestPayment[]) {
    await checkPaymentStructures(fixture.cardPaymentProcessor, payments);
    await checkCashbackNonces(fixture.cardPaymentProcessor, payments);
    await checkClearedAndUnclearedBalances(fixture.cardPaymentProcessor, payments);
    await checkTokenBalance(fixture, payments);
  }

  function createTestPayments(): TestPayment[] {
    return [
      {
        authorizationId: createBytesString(123, BYTES16_LENGTH),
        account: user1,
        amount: 234,
        status: PaymentStatus.Nonexistent,
        correlationId: createBytesString(345, BYTES16_LENGTH),
        parentTxHash: createBytesString("aaa1", BYTES32_LENGTH),
        compensationAmount: 0,
        refundAmount: 0,
      },
      {
        authorizationId: createBytesString(456, BYTES16_LENGTH),
        account: user2,
        amount: 567,
        status: PaymentStatus.Nonexistent,
        correlationId: createBytesString(789, BYTES16_LENGTH),
        parentTxHash: createBytesString("aaa2", BYTES32_LENGTH),
        compensationAmount: 0,
        refundAmount: 0,
      },
    ];
  }

  async function prepareForSinglePayment(): Promise<{ fixture: Fixture, payment: TestPayment }> {
    const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
    const [payment] = createTestPayments();

    return { fixture, payment };
  }

  async function beforeMakingPayment(): Promise<{ fixture: Fixture, payment: TestPayment }> {
    const { fixture, payment } = await prepareForSinglePayment();
    await setUpContractsForPayments(fixture, [payment]);

    return { fixture, payment };
  }

  describe("Function 'initialize()'", async () => {
    it("Configures the contract as expected", async () => {
      const { cardPaymentProcessor, tokenMock } = await setUpFixture(deployTokenMockAndCardPaymentProcessor);

      // The underlying contract address
      expect(await cardPaymentProcessor.underlyingToken()).to.equal(tokenMock.address);

      // The revocation limit
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(255);

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

  describe("Function 'makePayment()'", async () => {
    /* Because the functions 'makePayment()' and 'makePaymentFrom()' use the same common internal function to execute,
     * the main checks of the functions are provided in the section for the 'makePaymentFrom()' function.
     * In this section, only specific checks for the 'makePayment()' function are provided.
     */
    describe("Executes as expected if the cashback is enabled and the payment amount is", async () => {
      it("Nonzero", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        await proveTx(fixture.cardPaymentProcessor.enableCashback());
        setCashback(payment, fixture);
        const cashbackAmount: number = calculateCashback(payment);

        await checkCardPaymentProcessorState(fixture, [payment]);

        const tx: TransactionResponse = await cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount,
          payment.authorizationId,
          payment.correlationId
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [+payment.amount, -payment.amount + cashbackAmount, -cashbackAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_MAKE_PAYMENT
        ).withArgs(
          payment.authorizationId,
          payment.correlationId,
          payment.account.address,
          payment.amount,
          payment.revocationCounter || 0,
          payment.account.address
        );
        await expect(tx).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_SEND_CASHBACK_SUCCESS
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_SEND_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          tokenMock.address,
          CashbackKind.CardPayment,
          payment.authorizationId.padEnd(BYTES32_LENGTH * 2 + 2, "0"),
          payment.account.address,
          cashbackAmount
        );

        payment.status = PaymentStatus.Uncleared;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await pauseContract(cardPaymentProcessor);

        await expect(
          cardPaymentProcessor.connect(payment.account).makePayment(
            payment.amount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller is blacklisted", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await proveTx(cardPaymentProcessor.grantRole(blacklisterRole, deployer.address));
        await proveTx(cardPaymentProcessor.blacklist(payment.account.address));

        await expect(
          cardPaymentProcessor.connect(payment.account).makePayment(
            payment.amount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
      });
    });
  });

  describe("Function 'makePaymentFrom()'", async () => {
    enum CashbackSendingConditions {
      Success = 0,
      PartialWithNonZeroAmount = 1,
      PartialWithZeroAmount = 2,
    }

    async function checkPaymentMakingFromWithCashback(
      fixture: Fixture,
      payment: TestPayment,
      cashbackSendingConditions: CashbackSendingConditions
    ) {
      const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
      await proveTx(fixture.cardPaymentProcessor.enableCashback());
      setCashback(payment, fixture);
      const requestedCashbackAmount: number = calculateCashback(payment);
      let sentCashbackAmount = requestedCashbackAmount;
      if (cashbackSendingConditions === CashbackSendingConditions.PartialWithZeroAmount) {
        sentCashbackAmount = 0;
        await proveTx(fixture.cashbackDistributorMock.setSendCashbackAmountResult(sentCashbackAmount));
        payment.compensationAmount = sentCashbackAmount;
      } else if (cashbackSendingConditions === CashbackSendingConditions.PartialWithNonZeroAmount) {
        sentCashbackAmount = 1;
        await proveTx(fixture.cashbackDistributorMock.setSendCashbackAmountResult(sentCashbackAmount));
        payment.compensationAmount = sentCashbackAmount;
      }

      await checkCardPaymentProcessorState(fixture, [payment]);

      const tx: TransactionResponse = await cardPaymentProcessor.connect(executor).makePaymentFrom(
        payment.account.address,
        payment.amount,
        payment.authorizationId,
        payment.correlationId
      );
      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account, executor, cashbackDistributorMock],
        [+payment.amount, -payment.amount + sentCashbackAmount, 0, -sentCashbackAmount]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_MAKE_PAYMENT
      ).withArgs(
        payment.authorizationId,
        payment.correlationId,
        payment.account.address,
        payment.amount,
        payment.revocationCounter || 0,
        executor.address
      );
      await expect(tx).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_SEND_CASHBACK_SUCCESS
      ).withArgs(
        cashbackDistributorMock.address,
        sentCashbackAmount,
        payment.cashbackNonce || 0
      );
      await expect(tx).to.emit(
        cashbackDistributorMock,
        EVENT_NAME_SEND_CASHBACK_MOCK
      ).withArgs(
        cardPaymentProcessor.address,
        tokenMock.address,
        CashbackKind.CardPayment,
        payment.authorizationId.padEnd(BYTES32_LENGTH * 2 + 2, "0"),
        payment.account.address,
        requestedCashbackAmount
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState(fixture, [payment]);
    }

    describe("Executes as expected if the cashback is enabled and the payment amount is", async () => {
      it("Nonzero", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        await checkPaymentMakingFromWithCashback(fixture, payment, CashbackSendingConditions.Success);
      });

      it("Zero", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        payment.amount = 0;
        payment.compensationAmount = calculateCompensationAmount(payment);
        await checkPaymentMakingFromWithCashback(fixture, payment, CashbackSendingConditions.Success);
      });

      it("Nonzero even if the revocation limit of payments is zero", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        await proveTx(fixture.cardPaymentProcessor.setRevocationLimit(0));
        await checkPaymentMakingFromWithCashback(fixture, payment, CashbackSendingConditions.Success);
      });

      it("Nonzero and if cashback is partially sent with non-zero amount", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const sentCashbackAmount = 1;
        await proveTx(fixture.cashbackDistributorMock.setSendCashbackAmountResult(sentCashbackAmount));
        await checkPaymentMakingFromWithCashback(fixture, payment, CashbackSendingConditions.PartialWithNonZeroAmount);
      });

      it("Nonzero and if cashback is partially sent with zero amount", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const sentCashbackAmount = 0;
        await proveTx(fixture.cashbackDistributorMock.setSendCashbackAmountResult(sentCashbackAmount));
        await checkPaymentMakingFromWithCashback(fixture, payment, CashbackSendingConditions.PartialWithZeroAmount);
      });
    });

    describe("Executes successfully if the payment amount is nonzero but does not send cashback if", async () => {
      it("Cashback is disabled", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;

        await expect(
          cardPaymentProcessor.connect(executor).makePaymentFrom(
            payment.account.address,
            payment.amount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [+payment.amount, -payment.amount, 0]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_MAKE_PAYMENT
        ).and.not.to.emit(
          cashbackDistributorMock,
          EVENT_NAME_SEND_CASHBACK_MOCK
        );

        payment.status = PaymentStatus.Uncleared;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });

      it("Cashback sending fails", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        await proveTx(cashbackDistributorMock.setSendCashbackSuccessResult(false));
        await proveTx(cardPaymentProcessor.enableCashback());

        const cashbackAmount: number = calculateCashback(payment, CASHBACK_RATE_IN_PERMIL);
        setCashbackNonce(payment, fixture);

        const tx: TransactionResponse = await cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          payment.authorizationId,
          payment.correlationId
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [+payment.amount, -payment.amount, 0]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_MAKE_PAYMENT
        ).withArgs(
          payment.authorizationId,
          payment.correlationId,
          payment.account.address,
          payment.amount,
          payment.revocationCounter || 0,
          executor.address
        ).and.not.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_SEND_CASHBACK_SUCCESS
        );
        await expect(tx).to.emit(
          cardPaymentProcessor,
          EVENT_NAME_SEND_CASHBACK_FAILURE
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_SEND_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          tokenMock.address,
          CashbackKind.CardPayment,
          payment.authorizationId.padEnd(BYTES32_LENGTH * 2 + 2, "0"),
          payment.account.address,
          cashbackAmount,
        );

        payment.status = PaymentStatus.Uncleared;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await pauseContract(cardPaymentProcessor);

        await expect(
          cardPaymentProcessor.connect(executor).makePaymentFrom(
            payment.account.address,
            payment.amount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(payment.account).makePaymentFrom(
            payment.account.address,
            payment.amount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(payment.account.address, executorRole));
      });

      it("The payment account address is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).makePaymentFrom(
            ZERO_ADDRESS,
            payment.amount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ACCOUNT_IS_ZERO);
      });

      it("The payment authorization ID is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).makePaymentFrom(
            payment.account.address,
            payment.amount,
            ZERO_AUTHORIZATION_ID,
            payment.correlationId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
      });

      it("The account has not enough token balance", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        const excessTokenAmount: number = payment.amount + 1;

        await expect(
          cardPaymentProcessor.connect(executor).makePaymentFrom(
            payment.account.address,
            excessTokenAmount,
            payment.authorizationId,
            payment.correlationId
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
      });

      it("The payment with the provided authorization ID already exists", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        await makePayments(cardPaymentProcessor, [payment]);
        const otherMakingPaymentCorrelationsId: string = increaseBytesString(
          payment.correlationId,
          BYTES16_LENGTH
        );

        await expect(
          cardPaymentProcessor.connect(executor).makePaymentFrom(
            payment.account.address,
            payment.amount,
            payment.authorizationId,
            otherMakingPaymentCorrelationsId
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
      });
    });
  });

  describe("Function 'updatePaymentAmount()'", async () => {
    enum NewPaymentAmountType {
      Same = 0,
      Less = 1,
      More = 2
    }

    enum UpdatingConditionType {
      CashbackEnabled = 0,
      CashbackDisabledBeforePaymentMaking = 1,
      CashbackDisabledAfterPaymentMaking = 2,
      CashbackEnabledButRevokingFails = 3,
      CashbackEnabledButIncreasingFails = 4,
      CashbackEnabledButIncreasingPartial = 5,
    }

    async function checkUpdating(newPaymentAmountType: NewPaymentAmountType, updatingCondition: UpdatingConditionType) {
      const { fixture, payment } = await beforeMakingPayment();
      const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
      if (updatingCondition !== UpdatingConditionType.CashbackDisabledBeforePaymentMaking) {
        setCashback(payment, fixture);
        await proveTx(fixture.cardPaymentProcessor.enableCashback());
      }
      await makePayments(cardPaymentProcessor, [payment]);
      if (updatingCondition === UpdatingConditionType.CashbackDisabledAfterPaymentMaking) {
        await proveTx(cardPaymentProcessor.disableCashback());
      }

      let newAmount = payment.amount;
      if (newPaymentAmountType === NewPaymentAmountType.Less) {
        newAmount = Math.floor(payment.amount * 0.5);
      } else if (newPaymentAmountType === NewPaymentAmountType.More) {
        newAmount = Math.floor(payment.amount * 2);
        await proveTx(tokenMock.mint(payment.account.address, newAmount - payment.amount));
      }
      const refundAmount = Math.floor(payment.amount * 0.1);
      await cardPaymentProcessor.connect(executor).refundPayment(
        refundAmount,
        payment.authorizationId,
        PAYMENT_REFUNDING_CORRELATION_ID_STUB
      );
      setRefundAmount(payment, refundAmount);

      await checkCardPaymentProcessorState(fixture, [payment]);

      let requestCashbackChange = calculateCashbackChangeIfNewPaymentAmount(payment, newAmount);
      let actualCashbackChange = requestCashbackChange;
      if (
        updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingPartial
        && requestCashbackChange > 2
      ) {
        actualCashbackChange = 1;
        await proveTx(fixture.cashbackDistributorMock.setIncreaseCashbackAmountResult(actualCashbackChange));
      }
      let processorBalanceChange = newAmount - payment.amount;
      let accountBalanceChange = -processorBalanceChange + actualCashbackChange;
      let distributorBalanceChange = -actualCashbackChange;

      if (
        newPaymentAmountType === NewPaymentAmountType.Less
        && updatingCondition === UpdatingConditionType.CashbackEnabledButRevokingFails
      ) {
        processorBalanceChange -= actualCashbackChange;
        accountBalanceChange += 0;
        distributorBalanceChange = 0;
      }

      if (
        newPaymentAmountType !== NewPaymentAmountType.Less
        && updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingFails
      ) {
        processorBalanceChange += 0;
        accountBalanceChange -= actualCashbackChange;
        distributorBalanceChange = 0;
      }

      if (updatingCondition === UpdatingConditionType.CashbackEnabledButRevokingFails) {
        await proveTx(cashbackDistributorMock.setRevokeCashbackSuccessResult(false));
      }
      if (updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingFails) {
        await proveTx(cashbackDistributorMock.setIncreaseCashbackSuccessResult(false));
      }

      const tx: TransactionResponse = await cardPaymentProcessor.connect(executor).updatePaymentAmount(
        newAmount,
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB
      );
      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account, cashOutAccount, cashbackDistributorMock],
        [processorBalanceChange, accountBalanceChange, 0, distributorBalanceChange]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_UPDATE_PAYMENT_AMOUNT
      ).withArgs(
        payment.authorizationId,
        PAYMENT_UPDATING_CORRELATION_ID_STUB,
        payment.account.address,
        payment.amount,
        newAmount
      );

      if (updatingCondition === UpdatingConditionType.CashbackDisabledBeforePaymentMaking) {
        await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_REVOKE_CASHBACK_SUCCESS);
        await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_REVOKE_CASHBACK_FAILURE);
        await expect(tx).not.to.emit(cashbackDistributorMock, EVENT_NAME_REVOKE_CASHBACK_MOCK);
        await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_INCREASE_CASHBACK_SUCCESS);
        await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_INCREASE_CASHBACK_FAILURE);
        await expect(tx).not.to.emit(cashbackDistributorMock, EVENT_NAME_INCREASE_CASHBACK_MOCK);
      } else {
        if (newPaymentAmountType === NewPaymentAmountType.Less) {
          await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_INCREASE_CASHBACK_SUCCESS);
          await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_INCREASE_CASHBACK_FAILURE);
          await expect(tx).not.to.emit(cashbackDistributorMock, EVENT_NAME_INCREASE_CASHBACK_MOCK);

          await expect(tx).to.emit(
            cashbackDistributorMock,
            EVENT_NAME_REVOKE_CASHBACK_MOCK
          ).withArgs(
            cardPaymentProcessor.address,
            payment.cashbackNonce || 0,
            -requestCashbackChange
          );

          if (updatingCondition === UpdatingConditionType.CashbackEnabledButRevokingFails) {
            await expect(tx).to.emit(
              cardPaymentProcessor,
              EVENT_NAME_REVOKE_CASHBACK_FAILURE
            ).withArgs(
              cashbackDistributorMock.address,
              -requestCashbackChange,
              payment.cashbackNonce || 0
            );
          } else {
            await expect(tx).to.emit(
              cardPaymentProcessor,
              EVENT_NAME_REVOKE_CASHBACK_SUCCESS
            ).withArgs(
              cashbackDistributorMock.address,
              -actualCashbackChange,
              payment.cashbackNonce || 0
            );
          }
        } else { // newPaymentAmountType !== NewPaymentAmountType.Less
          await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_REVOKE_CASHBACK_SUCCESS);
          await expect(tx).not.to.emit(cardPaymentProcessor, EVENT_NAME_REVOKE_CASHBACK_FAILURE);
          await expect(tx).not.to.emit(cashbackDistributorMock, EVENT_NAME_REVOKE_CASHBACK_MOCK);

          await expect(tx).to.emit(
            cashbackDistributorMock,
            EVENT_NAME_INCREASE_CASHBACK_MOCK
          ).withArgs(
            cardPaymentProcessor.address,
            payment.cashbackNonce || 0,
            requestCashbackChange
          );

          if (updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingFails) {
            await expect(tx).to.emit(
              cardPaymentProcessor,
              EVENT_NAME_INCREASE_CASHBACK_FAILURE
            ).withArgs(
              cashbackDistributorMock.address,
              requestCashbackChange,
              payment.cashbackNonce || 0
            );
          } else {
            await expect(tx).to.emit(
              cardPaymentProcessor,
              EVENT_NAME_INCREASE_CASHBACK_SUCCESS
            ).withArgs(
              cashbackDistributorMock.address,
              actualCashbackChange,
              payment.cashbackNonce || 0
            );
          }
        }
      }

      setNewAmount(payment, newAmount, updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingFails);
      if (updatingCondition === UpdatingConditionType.CashbackEnabledButRevokingFails) {
        payment.unrevokedCashback = -actualCashbackChange;
      }
      if (updatingCondition === UpdatingConditionType.CashbackEnabledButIncreasingPartial) {
        payment.compensationAmount -= requestCashbackChange;
        payment.compensationAmount += actualCashbackChange;
      }
      await checkCardPaymentProcessorState(fixture, [payment]);
    }

    describe("Executes as expected and emits the correct events if the new amount is", async () => {
      describe("Less than the initial one and cashback sending is", async () => {
        it("Enabled and cashback revoking is executed successfully", async () => {
          await checkUpdating(NewPaymentAmountType.Less, UpdatingConditionType.CashbackEnabled);
        });
        it("Disabled before payment making", async () => {
          await checkUpdating(NewPaymentAmountType.Less, UpdatingConditionType.CashbackDisabledBeforePaymentMaking);
        });
        it("Disabled after payment making", async () => {
          await checkUpdating(NewPaymentAmountType.Less, UpdatingConditionType.CashbackDisabledAfterPaymentMaking);
        });
        it("Enabled but cashback revoking fails", async () => {
          await checkUpdating(NewPaymentAmountType.Less, UpdatingConditionType.CashbackEnabledButRevokingFails);
        });
      });
      describe("The same as the initial one and cashback sending is", async () => {
        it("Enabled and cashback revoking is executed successfully", async () => {
          await checkUpdating(NewPaymentAmountType.Same, UpdatingConditionType.CashbackEnabled);
        });
      });

      describe("More than the initial one and cashback sending is", async () => {
        it("Enabled and cashback increasing is executed successfully", async () => {
          await checkUpdating(NewPaymentAmountType.More, UpdatingConditionType.CashbackEnabled);
        });
        it("Disabled before payment making", async () => {
          await checkUpdating(NewPaymentAmountType.More, UpdatingConditionType.CashbackDisabledBeforePaymentMaking);
        });
        it("Disabled after payment making", async () => {
          await checkUpdating(NewPaymentAmountType.More, UpdatingConditionType.CashbackDisabledAfterPaymentMaking);
        });
        it("Enabled but cashback increasing fails", async () => {
          await checkUpdating(NewPaymentAmountType.More, UpdatingConditionType.CashbackEnabledButIncreasingFails);
        });
        it("Enabled but cashback increasing executes partially", async () => {
          await checkUpdating(NewPaymentAmountType.More, UpdatingConditionType.CashbackEnabledButIncreasingPartial);
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await pauseContract(cardPaymentProcessor);

        await expect(
          cardPaymentProcessor.connect(executor).updatePaymentAmount(
            payment.amount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(deployer).updatePaymentAmount(
            payment.amount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment authorization ID is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).updatePaymentAmount(
            payment.amount,
            ZERO_AUTHORIZATION_ID,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).updatePaymentAmount(
            payment.amount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });

      it("The new amount is less than the refund amount", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        await makePayments(cardPaymentProcessor, [payment]);
        const refundAmount = Math.floor(payment.amount * 0.5);
        await proveTx(cardPaymentProcessor.connect(executor).refundPayment(
          refundAmount,
          payment.authorizationId,
          PAYMENT_REFUNDING_CORRELATION_ID_STUB
        ));
        setRefundAmount(payment, refundAmount);

        await expect(
          cardPaymentProcessor.connect(executor).updatePaymentAmount(
            refundAmount - 1,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_NEW_PAYMENT_AMOUNT_IS_INAPPROPRIATE);
      });

      it("The payment status is 'Cleared'", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        await makePayments(cardPaymentProcessor, [payment]);
        await clearPayments(cardPaymentProcessor, [payment]);

        await expect(
          cardPaymentProcessor.connect(executor).updatePaymentAmount(
            payment.amount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessor,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Cleared);
      });
    });
  });

  describe("Function 'clearPayment()'", async () => {
    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      const { fixture, payment } = await beforeMakingPayment();
      const { cardPaymentProcessor, tokenMock } = fixture;
      await makePayments(fixture.cardPaymentProcessor, [payment]);
      const expectedClearedBalance: number = payment.amount;
      const expectedUnclearedBalance: number = 0;

      await checkCardPaymentProcessorState(fixture, [payment]);

      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(payment.authorizationId)
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account],
        [0, 0]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_CLEAR_PAYMENT
      ).withArgs(
        payment.authorizationId,
        payment.account.address,
        payment.amount,
        expectedClearedBalance,
        expectedUnclearedBalance,
        payment.revocationCounter || 0
      );

      payment.status = PaymentStatus.Cleared;
      await checkCardPaymentProcessorState(fixture, [payment]);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(deployer).clearPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the contract is paused", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await pauseContract(cardPaymentProcessor);

      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const { fixture: { cardPaymentProcessor } } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment has already been cleared", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
      await makePayments(cardPaymentProcessor, [payment]);
      await proveTx(cardPaymentProcessor.connect(executor).clearPayment(payment.authorizationId));

      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });
  });

  describe("Function 'clearPayments()'", async () => {
    async function beforeClearingPayments(): Promise<{
      fixture: Fixture,
      payments: TestPayment[],
      accountAddresses: string[],
      authorizationIds: string[]
    }> {
      const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
      const payments: TestPayment[] = createTestPayments().slice(0, 2);
      await setUpContractsForPayments(fixture, payments);
      await makePayments(fixture.cardPaymentProcessor, payments);
      const accountAddresses: string[] = payments.map(payment => payment.account.address);
      const authorizationIds: string[] = payments.map(payment => payment.authorizationId);

      return {
        fixture,
        payments,
        accountAddresses,
        authorizationIds
      };
    }

    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      const { fixture, payments, accountAddresses, authorizationIds } = await beforeClearingPayments();
      const { cardPaymentProcessor, tokenMock } = fixture;
      const expectedClearedBalances: number[] = payments.map((payment: TestPayment) => payment.amount);
      const expectedUnclearedBalances: number[] = payments.map(() => 0);

      await checkCardPaymentProcessorState(fixture, payments);

      const tx: TransactionResponse = cardPaymentProcessor.connect(executor).clearPayments(authorizationIds);
      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, ...accountAddresses],
        [0, ...accountAddresses.map(() => 0)]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_CLEAR_PAYMENT
      ).withArgs(
        authorizationIds[0],
        payments[0].account.address,
        payments[0].amount,
        expectedClearedBalances[0],
        expectedUnclearedBalances[0],
        payments[0].revocationCounter || 0
      );
      await expect(tx).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_CLEAR_PAYMENT
      ).withArgs(
        authorizationIds[1],
        payments[1].account.address,
        payments[1].amount,
        expectedClearedBalances[1],
        expectedUnclearedBalances[1],
        payments[1].revocationCounter || 0
      );

      payments.forEach((payment: TestPayment) => payment.status = PaymentStatus.Cleared);
      await checkCardPaymentProcessorState(fixture, payments);
    });

    it("Is reverted if the contract is paused", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await pauseContract(cardPaymentProcessor);

      await expect(
        cardPaymentProcessor.connect(executor).clearPayments([payment.authorizationId])
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(deployer).clearPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const { fixture: { cardPaymentProcessor } } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).clearPayments([])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeClearingPayments();
      await expect(
        cardPaymentProcessor.connect(executor).clearPayments([authorizationIds[0], ZERO_AUTHORIZATION_ID])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeClearingPayments();
      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(
          [
            authorizationIds[0],
            increaseBytesString(authorizationIds[1], BYTES16_LENGTH)
          ]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments has been already cleared", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeClearingPayments();
      await proveTx(cardPaymentProcessor.connect(executor).clearPayment(authorizationIds[0]));

      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });
  });

  describe("Function 'unclearPayment()'", async () => {
    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      const { fixture, payment } = await beforeMakingPayment();
      const { cardPaymentProcessor, tokenMock } = fixture;
      await makePayments(cardPaymentProcessor, [payment]);
      await clearPayments(cardPaymentProcessor, [payment]);
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = payment.amount;

      await checkCardPaymentProcessorState(fixture, [payment]);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(payment.authorizationId)
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account],
        [0, 0]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_UNCLEAR_PAYMENT
      ).withArgs(
        payment.authorizationId,
        payment.account.address,
        payment.amount,
        expectedClearedBalance,
        expectedUnclearedBalance,
        payment.revocationCounter || 0
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState(fixture, [payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await pauseContract(cardPaymentProcessor);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(deployer).unclearPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const { fixture: { cardPaymentProcessor } } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
      await makePayments(cardPaymentProcessor, [payment]);
      await clearPayments(cardPaymentProcessor, [payment]);
      await proveTx(cardPaymentProcessor.connect(executor).unclearPayment(payment.authorizationId));

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'unclearPayments()'", async () => {
    async function beforeUnclearingPayments(): Promise<{
      fixture: Fixture,
      payments: TestPayment[],
      accountAddresses: string[],
      authorizationIds: string[]
    }> {
      const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
      const payments: TestPayment[] = createTestPayments().slice(0, 2);
      await setUpContractsForPayments(fixture, payments);
      await makePayments(fixture.cardPaymentProcessor, payments);
      await clearPayments(fixture.cardPaymentProcessor, payments);
      const accountAddresses: string[] = payments.map(payment => payment.account.address);
      const authorizationIds: string[] = payments.map(payment => payment.authorizationId);

      return {
        fixture,
        payments,
        accountAddresses,
        authorizationIds
      };
    }

    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      const { fixture, payments, accountAddresses, authorizationIds } = await beforeUnclearingPayments();
      const { cardPaymentProcessor, tokenMock } = fixture;
      const expectedClearedBalances: number[] = payments.map(() => 0);
      const expectedUnclearedBalances: number[] = payments.map((payment: TestPayment) => payment.amount);

      await checkCardPaymentProcessorState(fixture, payments);

      const tx: TransactionResponse = cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds);
      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, ...accountAddresses],
        [0, ...accountAddresses.map(() => 0)]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_UNCLEAR_PAYMENT
      ).withArgs(
        authorizationIds[0],
        payments[0].account.address,
        payments[0].amount,
        expectedClearedBalances[0],
        expectedUnclearedBalances[0],
        payments[0].revocationCounter || 0
      );
      await expect(tx).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_UNCLEAR_PAYMENT
      ).withArgs(
        authorizationIds[1],
        payments[1].account.address,
        payments[1].amount,
        expectedClearedBalances[1],
        expectedUnclearedBalances[1],
        payments[1].revocationCounter || 0
      );

      payments.forEach((payment: TestPayment) => payment.status = PaymentStatus.Uncleared);
      await checkCardPaymentProcessorState(fixture, payments);
    });

    it("Is reverted if the contract is paused", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await pauseContract(cardPaymentProcessor);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments([payment.authorizationId])
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(deployer).unclearPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const { fixture: { cardPaymentProcessor } } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments([])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeUnclearingPayments();
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments([authorizationIds[0], ZERO_AUTHORIZATION_ID])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeUnclearingPayments();
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(
          [
            authorizationIds[0],
            increaseBytesString(authorizationIds[1], BYTES16_LENGTH)
          ]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeUnclearingPayments();
      await proveTx(cardPaymentProcessor.connect(executor).unclearPayment(authorizationIds[1]));

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'revokePayment()'", async () => {
    describe("Executes as expected and emits the correct events if the payment status is", async () => {
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = 0;
      const expectedRevocationCounter: number = 1;

      async function checkRevocationWithCashback(props: { isPaymentCleared: boolean }) {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        setCashback(payment, fixture);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;
        await proveTx(cardPaymentProcessor.enableCashback());
        await makePayments(cardPaymentProcessor, [payment]);

        if (props.isPaymentCleared) {
          await clearPayments(cardPaymentProcessor, [payment]);
        }

        await checkCardPaymentProcessorState(fixture, [payment]);

        const tx: TransactionResponse = cardPaymentProcessor.connect(executor).revokePayment(
          payment.authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payment.parentTxHash
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-revokedPaymentAmount - cashbackAmount, +revokedPaymentAmount, +cashbackAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_PAYMENT
        ).withArgs(
          payment.authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payment.account.address,
          revokedPaymentAmount,
          expectedClearedBalance,
          expectedUnclearedBalance,
          props.isPaymentCleared,
          payment.parentTxHash,
          expectedRevocationCounter
        );
        await expect(tx).to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce || 0,
          cashbackAmount
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = expectedRevocationCounter;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState(fixture, [payment]);
      }

      it("Uncleared", async () => {
        await checkRevocationWithCashback({ isPaymentCleared: false });
      });

      it("Cleared", async () => {
        await checkRevocationWithCashback({ isPaymentCleared: true });
      });
    });

    describe("Executes successfully and does the following with cashback operations", async () => {
      it("Does not revoke cashback if cashback operations are disabled before sending", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        await makePayments(cardPaymentProcessor, [payment]);

        await expect(
          cardPaymentProcessor.connect(executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-payment.amount, +payment.amount, 0]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_PAYMENT
        ).and.not.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        ).and.not.to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = 1;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });

      it("Does revoke cashback if cashback operations are disabled after sending", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        setCashback(payment, fixture);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        await proveTx(cardPaymentProcessor.enableCashback());
        await makePayments(cardPaymentProcessor, [payment]);
        await proveTx(cardPaymentProcessor.disableCashback());

        const tx: TransactionResponse = await cardPaymentProcessor.connect(executor).revokePayment(
          payment.authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payment.parentTxHash
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-revokedPaymentAmount - cashbackAmount, +revokedPaymentAmount, cashbackAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_PAYMENT
        );
        await expect(tx).to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce || 0,
          cashbackAmount
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = 1;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });

      it("Emits correct events if cashback operations are enabled but cashback revoking fails", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        setCashback(payment, fixture);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        await proveTx(cardPaymentProcessor.enableCashback());
        await makePayments(cardPaymentProcessor, [payment]);
        await proveTx(cashbackDistributorMock.setRevokeCashbackSuccessResult(false));

        const tx: TransactionResponse = cardPaymentProcessor.connect(executor).revokePayment(
          payment.authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payment.parentTxHash
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-revokedPaymentAmount, +revokedPaymentAmount, 0]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_PAYMENT
        ).and.not.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        );
        await expect(tx).to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_FAILURE
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce || 0,
          cashbackAmount
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = 1;
        payment.compensationAmount = 0;
        payment.unrevokedCashback = cashbackAmount;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await pauseContract(cardPaymentProcessor);

        await expect(
          cardPaymentProcessor.connect(executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(deployer).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The configured revocation limit of payments is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await proveTx(cardPaymentProcessor.setRevocationLimit(0));

        await expect(
          cardPaymentProcessor.connect(executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT);
      });

      it("The payment authorization ID is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).revokePayment(
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
      });

      it("The parent transaction hash is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).revokePayment(
            payment.authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            ZERO_TRANSACTION_HASH,
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).revokePayment(
            increaseBytesString(payment.authorizationId, BYTES16_LENGTH),
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });
    });
  });

  describe("Function 'reversePayment()'", async () => {
    describe("Executes as expected and emits the correct events if the payment is", async () => {
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = 0;

      async function checkReversionWithCashback(props: { isPaymentCleared: boolean }) {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        setCashback(payment, fixture);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;
        await proveTx(cardPaymentProcessor.enableCashback());
        await makePayments(cardPaymentProcessor, [payment]);

        if (props.isPaymentCleared) {
          await clearPayments(cardPaymentProcessor, [payment]);
        }

        const tx: TransactionResponse = cardPaymentProcessor.connect(executor).reversePayment(
          payment.authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payment.parentTxHash
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-revokedPaymentAmount - cashbackAmount, +revokedPaymentAmount, +cashbackAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVERSE_PAYMENT
        ).withArgs(
          payment.authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payment.account.address,
          revokedPaymentAmount,
          expectedClearedBalance,
          expectedUnclearedBalance,
          props.isPaymentCleared,
          payment.parentTxHash,
          payment.revocationCounter || 0
        );
        await expect(tx).to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce || 0,
          cashbackAmount
        );

        payment.status = PaymentStatus.Reversed;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState(fixture, [payment]);
      }

      it("Uncleared", async () => {
        await checkReversionWithCashback({ isPaymentCleared: false });
      });

      it("Cleared", async () => {
        await checkReversionWithCashback({ isPaymentCleared: true });
      });
    });

    describe("Executes successfully and does the following with cashback operations", async () => {
      it("Does not revoke cashback if cashback operations are disabled before sending", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        await makePayments(cardPaymentProcessor, [payment]);

        await expect(
          cardPaymentProcessor.connect(executor).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-payment.amount, +payment.amount, 0]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVERSE_PAYMENT
        ).and.not.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        ).and.not.to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        );

        payment.status = PaymentStatus.Reversed;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });

      it("Does revoke cashback if cashback operations are disabled after sending", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        setCashback(payment, fixture);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        await proveTx(cardPaymentProcessor.enableCashback());
        await makePayments(cardPaymentProcessor, [payment]);
        await proveTx(cardPaymentProcessor.disableCashback());

        const tx: TransactionResponse = cardPaymentProcessor.connect(executor).reversePayment(
          payment.authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payment.parentTxHash
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-revokedPaymentAmount - cashbackAmount, +revokedPaymentAmount, +cashbackAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVERSE_PAYMENT
        );
        await expect(tx).to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce || 0,
          cashbackAmount
        );

        payment.status = PaymentStatus.Reversed;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });

      it("Does not revoke cashback if cashback operations are enabled but cashback revoking fails", async () => {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        setCashback(payment, fixture);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        await proveTx(cardPaymentProcessor.enableCashback());
        await makePayments(cardPaymentProcessor, [payment]);
        await proveTx(cashbackDistributorMock.setRevokeCashbackSuccessResult(false));

        const tx: TransactionResponse = cardPaymentProcessor.connect(executor).reversePayment(
          payment.authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payment.parentTxHash
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashbackDistributorMock],
          [-revokedPaymentAmount, +revokedPaymentAmount, 0]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVERSE_PAYMENT
        ).and.not.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_SUCCESS
        );
        await expect(tx).to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REVOKE_CASHBACK_FAILURE
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce || 0
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce || 0,
          cashbackAmount
        );

        payment.status = PaymentStatus.Reversed;
        payment.compensationAmount = 0;
        payment.unrevokedCashback = cashbackAmount;
        await checkCardPaymentProcessorState(fixture, [payment]);
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await pauseContract(cardPaymentProcessor);

        await expect(
          cardPaymentProcessor.connect(executor).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(deployer).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment authorization ID is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).reversePayment(
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
      });

      it("The parent transaction hash is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).reversePayment(
            payment.authorizationId,
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            ZERO_TRANSACTION_HASH,
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).reversePayment(
            increaseBytesString(payment.authorizationId, BYTES16_LENGTH),
            PAYMENT_REVERSING_CORRELATION_ID_STUB,
            payment.parentTxHash
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });
    });
  });

  describe("Function 'confirmPayment()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { fixture, payment } = await beforeMakingPayment();
      const { cardPaymentProcessor, tokenMock } = fixture;
      const expectedClearedBalance: number = 0;

      await checkCardPaymentProcessorState(fixture, [payment]);

      await makePayments(cardPaymentProcessor, [payment]);
      await clearPayments(cardPaymentProcessor, [payment]);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(payment.authorizationId)
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, cashOutAccount, payment.account],
        [-payment.amount, +payment.amount, 0]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_CONFIRM_PAYMENT
      ).withArgs(
        payment.authorizationId,
        payment.account.address,
        payment.amount,
        expectedClearedBalance,
        payment.revocationCounter || 0
      );

      payment.status = PaymentStatus.Confirmed;
      await checkCardPaymentProcessorState(fixture, [payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await pauseContract(cardPaymentProcessor);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(deployer).confirmPayment(payment.authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      const { fixture: { cardPaymentProcessor } } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(
          payment.authorizationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
      await makePayments(cardPaymentProcessor, [payment]);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(PaymentStatus.Uncleared);
    });

    it("Is reverted if the cash-out account is the zero address", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
      await makePayments(cardPaymentProcessor, [payment]);
      await clearPayments(cardPaymentProcessor, [payment]);
      await proveTx(cardPaymentProcessor.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(payment.authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO);
    });
  });

  describe("Function 'confirmPayments()'", async () => {
    async function beforeConfirmingPayments(): Promise<{
      fixture: Fixture,
      payments: TestPayment[],
      accountAddresses: string[],
      authorizationIds: string[]
    }> {
      const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
      const payments: TestPayment[] = createTestPayments().slice(0, 2);
      await setUpContractsForPayments(fixture, payments);
      await makePayments(fixture.cardPaymentProcessor, payments);
      await clearPayments(fixture.cardPaymentProcessor, payments);
      const accountAddresses: string[] = payments.map(payment => payment.account.address);
      const authorizationIds: string[] = payments.map(payment => payment.authorizationId);

      return {
        fixture,
        payments,
        accountAddresses,
        authorizationIds
      };
    }

    it("Executes as expected and emits the correct event", async () => {
      const { fixture, payments, accountAddresses, authorizationIds } = await beforeConfirmingPayments();
      const { cardPaymentProcessor, tokenMock } = fixture;
      const expectedClearedBalance: number = 0;
      const totalAmount: number = countNumberArrayTotal(
        payments.map(
          function (payment: TestPayment): number {
            return payment.amount;
          }
        )
      );

      await checkCardPaymentProcessorState(fixture, payments);

      const tx: TransactionResponse = await cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds);
      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, cashOutAccount, ...accountAddresses],
        [-totalAmount, +totalAmount, ...accountAddresses.map(() => 0)]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_CONFIRM_PAYMENT
      ).withArgs(
        authorizationIds[0],
        payments[0].account.address,
        payments[0].amount,
        expectedClearedBalance,
        payments[0].revocationCounter || 0
      );
      await expect(tx).to.emit(
        cardPaymentProcessor,
        EVENT_NAME_CONFIRM_PAYMENT
      ).withArgs(
        authorizationIds[1],
        payments[1].account.address,
        payments[1].amount,
        expectedClearedBalance,
        payments[1].revocationCounter || 0
      );

      payments.forEach((payment: TestPayment) => payment.status = PaymentStatus.Confirmed);
      await checkCardPaymentProcessorState(fixture, payments);
    });

    it("Is reverted if the contract is paused", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await pauseContract(cardPaymentProcessor);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments([payment.authorizationId])
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(deployer).confirmPayments([payment.authorizationId])
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      const { fixture: { cardPaymentProcessor } } = await prepareForSinglePayment();
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments([])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeConfirmingPayments();
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(
          [authorizationIds[0], ZERO_AUTHORIZATION_ID]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeConfirmingPayments();
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(
          [
            authorizationIds[0],
            increaseBytesString(authorizationIds[1], BYTES16_LENGTH)
          ]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeConfirmingPayments();
      await proveTx(cardPaymentProcessor.connect(executor).unclearPayment(authorizationIds[1]));

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(PaymentStatus.Uncleared);
    });

    it("Is reverted if the cash-out account is the zero address", async () => {
      const { fixture: { cardPaymentProcessor }, authorizationIds } = await beforeConfirmingPayments();
      await proveTx(cardPaymentProcessor.setCashOutAccount(ZERO_ADDRESS));

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO);
    });
  });

  describe("Function 'refundPayment()'", async () => {
    describe("Executes as expected and emits the correct events if the refund amount is", async () => {
      enum RefundType {
        Zero = 0,
        Nonzero = 1,
        Full = 2
      }

      async function checkRefunding(props: { refundType: RefundType, paymentStatus: PaymentStatus }) {
        const { fixture, payment } = await beforeMakingPayment();
        const { cardPaymentProcessor, tokenMock, cashbackDistributorMock } = fixture;
        setCashback(payment, fixture);
        await proveTx(fixture.cardPaymentProcessor.enableCashback());
        await makePayments(cardPaymentProcessor, [payment]);

        let refundAmount = 0;
        if (props.refundType === RefundType.Nonzero) {
          refundAmount = Math.floor(payment.amount * 0.1);
        } else if (props.refundType === RefundType.Full) {
          refundAmount = payment.amount;
        }

        let tokenSourceAccount: SignerWithAddress | Contract = cardPaymentProcessor;
        if (props.paymentStatus == PaymentStatus.Cleared) {
          await clearPayments(cardPaymentProcessor, [payment]);
        }
        if (props.paymentStatus == PaymentStatus.Confirmed) {
          tokenSourceAccount = cashOutAccount;
          await clearPayments(cardPaymentProcessor, [payment]);
          await confirmPayments(cardPaymentProcessor, [payment]);
        }

        await checkCardPaymentProcessorState(fixture, [payment]);

        setRefundAmount(payment, refundAmount);
        const revocationCashbackAmount = calculateRefundCashbackDifference(payment);
        const userSentAmount = refundAmount - revocationCashbackAmount;
        let processorSentAmount = -(userSentAmount + revocationCashbackAmount);
        let cashOutAccountSentAmount = 0;
        if (tokenSourceAccount == cashOutAccount) {
          cashOutAccountSentAmount = processorSentAmount;
          processorSentAmount = 0;
        }

        const tx: TransactionResponse = await cardPaymentProcessor.connect(executor).refundPayment(
          refundAmount,
          payment.authorizationId,
          PAYMENT_REFUNDING_CORRELATION_ID_STUB
        );
        await expect(tx).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashOutAccount, cashbackDistributorMock],
          [processorSentAmount, userSentAmount, cashOutAccountSentAmount, +revocationCashbackAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          EVENT_NAME_REFUND_PAYMENT
        ).withArgs(
          payment.authorizationId,
          PAYMENT_REFUNDING_CORRELATION_ID_STUB,
          payment.account.address,
          payment.refundAmount,
          userSentAmount,
          payment.status
        );
        await expect(tx).to.emit(
          cashbackDistributorMock,
          EVENT_NAME_REVOKE_CASHBACK_MOCK
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce || 0,
          revocationCashbackAmount
        );

        await checkCardPaymentProcessorState(fixture, [payment]);
      }

      describe("Nonzero and the payment status is", async () => {
        it("Uncleared", async () => {
          await checkRefunding({ refundType: RefundType.Nonzero, paymentStatus: PaymentStatus.Uncleared });
        });

        it("Cleared", async () => {
          await checkRefunding({ refundType: RefundType.Nonzero, paymentStatus: PaymentStatus.Cleared });
        });

        it("Confirmed", async () => {
          await checkRefunding({ refundType: RefundType.Nonzero, paymentStatus: PaymentStatus.Confirmed });
        })
        ;
      });

      describe("Equals the payment amount and the payment status is", async () => {
        it("Uncleared", async () => {
          await checkRefunding({ refundType: RefundType.Full, paymentStatus: PaymentStatus.Uncleared });
        });

        it("Cleared", async () => {
          await checkRefunding({ refundType: RefundType.Full, paymentStatus: PaymentStatus.Cleared });
        });

        it("Confirmed", async () => {
          await checkRefunding({ refundType: RefundType.Full, paymentStatus: PaymentStatus.Confirmed });
        });
      });

      describe("Zero and the payment status is", async () => {
        it("Uncleared", async () => {
          await checkRefunding({ refundType: RefundType.Zero, paymentStatus: PaymentStatus.Cleared });
        });

        it("Cleared", async () => {
          await checkRefunding({ refundType: RefundType.Zero, paymentStatus: PaymentStatus.Uncleared });
        });

        it("Confirmed", async () => {
          await checkRefunding({ refundType: RefundType.Zero, paymentStatus: PaymentStatus.Confirmed });
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await pauseContract(cardPaymentProcessor);

        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            payment.refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the executor role", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(deployer).refundPayment(
            payment.refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
      });

      it("The payment authorization ID is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            payment.refundAmount,
            ZERO_AUTHORIZATION_ID,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
      });

      it("The payment with the provided authorization ID does not exist", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await prepareForSinglePayment();
        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            payment.refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
      });

      it("The refund amount exceeds the payment amount", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        await makePayments(cardPaymentProcessor, [payment]);
        setRefundAmount(payment, payment.amount + 1);

        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            payment.refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_REFUND_AMOUNT_IS_INAPPROPRIATE);
      });

      it("The payment is confirmed, but the cash-out amount address is zero", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        await makePayments(cardPaymentProcessor, [payment]);
        await clearPayments(cardPaymentProcessor, [payment]);
        await confirmPayments(cardPaymentProcessor, [payment]);
        await proveTx(cardPaymentProcessor.setCashOutAccount(ZERO_ADDRESS));

        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            payment.refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO);
      });

      it("The payment status is 'Revoked'", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        await makePayments(cardPaymentProcessor, [payment]);
        await proveTx(cardPaymentProcessor.connect(executor).revokePayment(
          payment.authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payment.parentTxHash
        ));

        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            payment.refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessor,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Revoked);
      });

      it("The payment status is 'Reversed'", async () => {
        const { fixture: { cardPaymentProcessor }, payment } = await beforeMakingPayment();
        await makePayments(cardPaymentProcessor, [payment]);
        await proveTx(cardPaymentProcessor.connect(executor).reversePayment(
          payment.authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payment.parentTxHash
        ));

        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            payment.refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessor,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Reversed);
      });
    });
  });

  describe("Complex scenarios without cashback", async () => {
    async function beforeMakingPayments(): Promise<{
      fixture: Fixture,
      payments: TestPayment[],
    }> {
      const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
      const payments: TestPayment[] = createTestPayments().slice(0, 2);
      await setUpContractsForPayments(fixture, payments);

      return {
        fixture,
        payments,
      };
    }

    async function checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(
      cardPaymentProcessor: Contract,
      payments: TestPayment[]
    ) {
      const authorizationIds = payments.map(payment => payment.authorizationId);
      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationIds[0],
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationIds[0],
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);

      await expect(
        cardPaymentProcessor.connect(executor).updatePaymentAmount(
          payments[0].amount,
          authorizationIds[0],
          PAYMENT_UPDATING_CORRELATION_ID_STUB)
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
      ).withArgs(payments[0].status);
    }

    it("All payment processing functions except making are reverted if a payment was revoked", async () => {
      const { fixture, payments } = await beforeMakingPayments();
      const { cardPaymentProcessor, tokenMock } = fixture;

      await makePayments(cardPaymentProcessor, payments);

      await proveTx(
        cardPaymentProcessor.connect(executor).revokePayment(
          payments[0].authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      );
      payments[0].status = PaymentStatus.Revoked;
      payments[0].revocationCounter = 1;

      await checkCardPaymentProcessorState(fixture, payments);
      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(cardPaymentProcessor, payments);

      await expect(
        cardPaymentProcessor.connect(payments[0].account).makePayment(
          payments[0].amount,
          payments[0].authorizationId,
          payments[0].correlationId,
        )
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payments[0].account],
        [+payments[0].amount, -payments[0].amount]
      ).and.to.emit(
        cardPaymentProcessor,
        EVENT_NAME_MAKE_PAYMENT
      ).withArgs(
        payments[0].authorizationId,
        payments[0].correlationId,
        payments[0].account.address,
        payments[0].amount,
        payments[0].revocationCounter || 0,
        payments[0].account.address
      );

      payments[0].status = PaymentStatus.Uncleared;
      payments[0].parentTxHash = increaseBytesString(payments[0].parentTxHash, BYTES32_LENGTH);
      await checkCardPaymentProcessorState(fixture, payments);
    });

    it("All payment processing functions are reverted if a payment was reversed", async () => {
      const { fixture, payments } = await beforeMakingPayments();
      const { cardPaymentProcessor } = fixture;
      await makePayments(cardPaymentProcessor, payments);

      await proveTx(
        cardPaymentProcessor.connect(executor).reversePayment(
          payments[0].authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      );
      payments[0].status = PaymentStatus.Reversed;

      await expect(
        cardPaymentProcessor.makePayment(
          payments[0].amount,
          payments[0].authorizationId,
          payments[0].correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(cardPaymentProcessor, payments);
      await checkCardPaymentProcessorState(fixture, payments);
    });

    it("All payment processing functions are reverted if a payment was confirmed", async () => {
      const { fixture, payments } = await beforeMakingPayments();
      const { cardPaymentProcessor } = fixture;
      await makePayments(cardPaymentProcessor, payments);
      await clearPayments(cardPaymentProcessor, payments);

      await confirmPayments(cardPaymentProcessor, [payments[0]]);

      await expect(
        cardPaymentProcessor.makePayment(
          payments[0].amount,
          payments[0].authorizationId,
          payments[0].correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking(cardPaymentProcessor, payments);
      await checkCardPaymentProcessorState(fixture, payments);
    });

    it("Making payment function is reverted if the payment has the 'Cleared' status", async () => {
      const { fixture, payments } = await beforeMakingPayments();
      const { cardPaymentProcessor } = fixture;
      await makePayments(cardPaymentProcessor, [payments[0]]);
      await clearPayments(cardPaymentProcessor, [payments[0]]);

      await expect(
        cardPaymentProcessor.connect(payments[0].account).makePayment(
          payments[0].amount,
          payments[0].authorizationId,
          payments[0].correlationId,
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
    });

    it("Making payment function is reverted if the revocation counter has reached the limit", async () => {
      const { fixture, payments } = await beforeMakingPayments();
      const { cardPaymentProcessor } = fixture;
      const revocationCounterMax: number = 1;

      await proveTx(cardPaymentProcessor.setRevocationLimit(revocationCounterMax));
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(revocationCounterMax);

      for (let relocationCounter = 0; relocationCounter < revocationCounterMax; ++relocationCounter) {
        await makePayments(cardPaymentProcessor, [payments[0]]);
        await proveTx(
          cardPaymentProcessor.connect(executor).revokePayment(
            payments[0].authorizationId,
            PAYMENT_REVOKING_CORRELATION_ID_STUB,
            payments[0].parentTxHash
          )
        );
        payments[0].status = PaymentStatus.Revoked;
        payments[0].revocationCounter = relocationCounter + 1;
        await checkCardPaymentProcessorState(fixture, payments);
      }

      await expect(
        cardPaymentProcessor.connect(payments[0].account).makePayment(
          payments[0].amount,
          payments[0].authorizationId,
          payments[0].correlationId,
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT
      );
    });

    it("All payment processing functions execute successfully if the payment amount is zero", async () => {
      const { fixture, payments } = await beforeMakingPayments();
      const { cardPaymentProcessor, tokenMock } = fixture;
      payments.forEach(payment => payment.amount = 0);

      await makePayments(cardPaymentProcessor, payments);
      await checkCardPaymentProcessorState(fixture, payments);

      await clearPayments(cardPaymentProcessor, payments);
      await checkCardPaymentProcessorState(fixture, payments);

      await unclearPayments(cardPaymentProcessor, payments);
      await checkCardPaymentProcessorState(fixture, payments);

      await proveTx(
        cardPaymentProcessor.connect(executor).revokePayment(
          payments[0].authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payments[0].parentTxHash
        )
      );
      payments[0].status = PaymentStatus.Revoked;
      payments[0].revocationCounter = 1;

      await checkCardPaymentProcessorState(fixture, payments);

      await proveTx(
        cardPaymentProcessor.connect(executor).reversePayment(
          payments[1].authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payments[1].parentTxHash
        )
      );
      payments[1].status = PaymentStatus.Reversed;
      await checkCardPaymentProcessorState(fixture, payments);

      await makePayments(cardPaymentProcessor, [payments[0]]);
      await clearPayments(cardPaymentProcessor, [payments[0]]);

      const cashOutAccountBalanceBefore: BigNumber = await tokenMock.balanceOf(cashOutAccount.address);
      await confirmPayments(cardPaymentProcessor, [payments[0]]);
      const cashOutAccountBalanceAfter: BigNumber = await tokenMock.balanceOf(cashOutAccount.address);
      await checkCardPaymentProcessorState(fixture, payments);
      expect(cashOutAccountBalanceBefore).to.equal(cashOutAccountBalanceAfter);
    });
  });

  describe("Complex scenarios with cashback", async () => {

    it("No cashback distributor contract's function are called if the cashback operations are disabled", async () => {
      const { fixture: { cardPaymentProcessor, cashbackDistributorMock }, payment } = await beforeMakingPayment();
      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          payment.authorizationId,
          payment.correlationId
        )
      ).not.to.emit(
        cashbackDistributorMock,
        EVENT_NAME_SEND_CASHBACK_MOCK
      );
      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          payment.authorizationId,
          PAYMENT_REVOKING_CORRELATION_ID_STUB,
          payment.parentTxHash
        )
      ).not.to.emit(
        cashbackDistributorMock,
        EVENT_NAME_REVOKE_CASHBACK_MOCK
      );
      payment.revocationCounter = 1;
      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          payment.authorizationId,
          payment.correlationId
        )
      ).not.to.emit(
        cashbackDistributorMock,
        EVENT_NAME_SEND_CASHBACK_MOCK
      );
      payment.parentTxHash = increaseBytesString(payment.parentTxHash, BYTES32_LENGTH);
      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          payment.authorizationId,
          PAYMENT_REVERSING_CORRELATION_ID_STUB,
          payment.parentTxHash
        )
      ).not.to.emit(
        cashbackDistributorMock,
        EVENT_NAME_REVOKE_CASHBACK_MOCK
      );
    });

    it("Several refund and payment updating operations execute as expected if cashback is enabled", async () => {
      const { fixture, payment } = await prepareForSinglePayment();
      const { cardPaymentProcessor, tokenMock } = fixture;
      await proveTx(tokenMock.mint(payment.account.address, MAX_INT256));
      await proveTx(tokenMock.connect(payment.account).approve(cardPaymentProcessor.address, MAX_UINT256));
      await proveTx(cardPaymentProcessor.enableCashback());
      setCashback(payment, fixture);
      await makePayments(cardPaymentProcessor, [payment]);

      async function updatePaymentAmount(newPaymentAmount: number) {
        await proveTx(
          await cardPaymentProcessor.connect(executor).updatePaymentAmount(
            newPaymentAmount,
            payment.authorizationId,
            PAYMENT_UPDATING_CORRELATION_ID_STUB
          )
        );
        setNewAmount(payment, newPaymentAmount);
      }

      async function refundPayment(refundAmount: number) {
        await proveTx(
          await cardPaymentProcessor.connect(executor).refundPayment(
            refundAmount,
            payment.authorizationId,
            PAYMENT_REFUNDING_CORRELATION_ID_STUB
          )
        );
        setRefundAmount(payment, (payment.refundAmount || 0) + refundAmount);
      }

      async function checkCashOutAccountBalance() {
        expect(
          await tokenMock.balanceOf(cashOutAccount.address)
        ).to.equal(payment.amount - (payment.refundAmount || 0));
      }

      await checkCardPaymentProcessorState(fixture, [payment]);

      await updatePaymentAmount(Math.floor(payment.amount * 2));
      await refundPayment(Math.floor(payment.amount * 0.1));
      await updatePaymentAmount(Math.floor(payment.amount * 0.9));
      await refundPayment(Math.floor(payment.amount * 0.2));
      await updatePaymentAmount(Math.floor(payment.amount * 1.5));
      await checkCardPaymentProcessorState(fixture, [payment]);

      await clearPayments(cardPaymentProcessor, [payment]);
      await checkCardPaymentProcessorState(fixture, [payment]);

      await refundPayment(Math.floor(payment.amount * 0.3));
      await checkCardPaymentProcessorState(fixture, [payment]);

      await confirmPayments(cardPaymentProcessor, [payment]);
      await checkCardPaymentProcessorState(fixture, [payment]);
      await checkCashOutAccountBalance();

      await refundPayment(Math.floor(payment.amount * 0.4));
      await refundPayment(payment.amount - (payment.refundAmount || 0));
      await checkCardPaymentProcessorState(fixture, [payment]);
      await checkCashOutAccountBalance();
    });
  });
});
