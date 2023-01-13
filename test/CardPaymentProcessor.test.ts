import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { TransactionResponse } from "@ethersproject/abstract-provider";

const REVOCATION_LIMIT = 123;
const REVOCATION_LIMIT_DEFAULT_VALUE = 255;
const BYTES16_LENGTH: number = 16;
const BYTES32_LENGTH: number = 32;
const ZERO_AUTHORIZATION_ID: string = createBytesString("00", BYTES16_LENGTH);
const ZERO_TRANSACTION_HASH: string = ethers.constants.HashZero;
const REVERSING_PAYMENT_CORRELATION_ID: string = createBytesString("ABC1", BYTES16_LENGTH);
const CORRELATION_ID: string = createBytesString("ABC2", BYTES16_LENGTH);
const PARENT_TRANSACTION_HASH: string = createBytesString("ABC3", BYTES32_LENGTH);
const CASHBACK_DISTRIBUTOR_ADDRESS_STUB1 = "0x0000000000000000000000000000000000000001";
const CASHBACK_DISTRIBUTOR_ADDRESS_STUB2 = "0x0000000000000000000000000000000000000002";
const MAX_CASHBACK_RATE_IN_PERMIL = 250;
const CASHBACK_RATE_IN_PERMIL = 100; // 10%
const ZERO_CASHBACK_RATE = 0;
const CASHBACK_NONCE = 111222333;

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
  authorizationId: number;
  account: SignerWithAddress;
  amount: number;
  status: PaymentStatus;
  revocationCounter?: number;
  makingPaymentCorrelationId: number;
  parentTxHash?: string;
  compensationAmount?: number;
  cashbackNonce?: number;
  cashbackRateInPermil?: number;
  refundAmount?: number;
}

interface CashbackDistributorMockConfig {
  sendCashbackSuccessResult: boolean;
  sendCashbackNonceResult: number;
  revokeCashbackSuccessResult: boolean;
}

function checkNonexistentPayment(
  actualOnChainPayment: any,
  paymentIndex: number
) {
  expect(actualOnChainPayment.account).to.equal(
    ethers.constants.AddressZero,
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

function calculateCashback(payment: TestPayment): number {
  return Math.floor((payment.amount - (payment.refundAmount || 0)) * (payment.cashbackRateInPermil || 0) / 1000);
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

function setCashbackRate(payment: TestPayment, newCashbackRateInPermil: number) {
  payment.cashbackRateInPermil = newCashbackRateInPermil;
  payment.compensationAmount = calculateCompensationAmount(payment);
}

function setRefundAmount(payment: TestPayment, newRefundAmount: number) {
  payment.refundAmount = newRefundAmount;
  payment.compensationAmount = calculateCompensationAmount(payment);
}

async function deployCashbackDistributorMock():
  Promise<{ cashbackDistributorMock: Contract, cashbackDistributorMockConfig: CashbackDistributorMockConfig }> {

  const cashbackDistributorMockConfig: CashbackDistributorMockConfig = {
    sendCashbackSuccessResult: true,
    sendCashbackNonceResult: CASHBACK_NONCE,
    revokeCashbackSuccessResult: true,
  };

  const CashbackDistributor: ContractFactory = await ethers.getContractFactory("CashbackDistributorMock");
  const cashbackDistributorMock: Contract = await CashbackDistributor.deploy(
    cashbackDistributorMockConfig.sendCashbackSuccessResult,
    cashbackDistributorMockConfig.sendCashbackNonceResult,
    cashbackDistributorMockConfig.revokeCashbackSuccessResult,
  );
  await cashbackDistributorMock.deployed();

  return {
    cashbackDistributorMock,
    cashbackDistributorMockConfig
  };
}

describe("Contract 'CardPaymentProcessor'", async () => {
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

  let CardPaymentProcessor: ContractFactory;
  let cardPaymentProcessor: Contract;
  let tokenMock: Contract;
  let deployer: SignerWithAddress;
  let cashOutAccount: SignerWithAddress;
  let executor: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let ownerRole: string;
  let blacklisterRole: string;
  let pauserRole: string;
  let rescuerRole: string;
  let executorRole: string;

  async function setUpContractsForPayments(payments: TestPayment[]) {
    for (let payment of payments) {
      await proveTx(tokenMock.mint(payment.account.address, payment.amount));
      const allowance: BigNumber = await tokenMock.allowance(payment.account.address, cardPaymentProcessor.address);
      if (allowance.lt(BigNumber.from(ethers.constants.MaxUint256))) {
        await proveTx(
          tokenMock.connect(payment.account).approve(
            cardPaymentProcessor.address,
            ethers.constants.MaxUint256
          )
        );
      }
    }
  }

  async function setUpAndEnableCashback():
    Promise<{ cashbackDistributorMock: Contract, cashbackDistributorMockConfig: CashbackDistributorMockConfig }> {
    const { cashbackDistributorMock, cashbackDistributorMockConfig } = await deployCashbackDistributorMock();
    await proveTx(cardPaymentProcessor.setCashbackDistributor(cashbackDistributorMock.address));
    await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL));
    await proveTx(cardPaymentProcessor.enableCashback());
    return {
      cashbackDistributorMock,
      cashbackDistributorMockConfig
    };
  }

  async function makePayments(payments: TestPayment[]) {
    for (let payment of payments) {
      await proveTx(
        cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount,
          createBytesString(payment.authorizationId, BYTES16_LENGTH),
          createBytesString(payment.makingPaymentCorrelationId, BYTES16_LENGTH)
        )
      );
      payment.status = PaymentStatus.Uncleared;
    }
  }

  async function clearPayments(payments: TestPayment[]) {
    const authorizationIds: string[] = [];
    payments.forEach((payment: TestPayment) => {
      authorizationIds.push(createBytesString(payment.authorizationId, BYTES16_LENGTH));
      payment.status = PaymentStatus.Cleared;
    });
    await proveTx(cardPaymentProcessor.connect(executor).clearPayments(authorizationIds));
  }

  async function setExecutorRole(account: SignerWithAddress) {
    await proveTx(cardPaymentProcessor.grantRole(executorRole, account.address));
  }

  function defineBalancesPerAccount(payments: TestPayment[], targetPaymentStatus: PaymentStatus): Map<string, number> {
    const balancesPerAccount: Map<string, number> = new Map<string, number>();

    payments.forEach((payment: TestPayment) => {
      const address: string = payment.account.address;
      let newBalance: number = balancesPerAccount.get(address) || 0;
      if (payment.status == targetPaymentStatus) {
        newBalance += payment.amount - (payment.refundAmount || 0);
      }
      balancesPerAccount.set(address, newBalance);
    });

    return balancesPerAccount;
  }

  async function checkPaymentStructures(payments: TestPayment[]) {
    for (let i = 0; i < payments.length; ++i) {
      const expectedPayment: TestPayment = payments[i];
      const actualPayment = await cardPaymentProcessor.paymentFor(
        createBytesString(expectedPayment.authorizationId, BYTES16_LENGTH)
      );
      checkEquality(actualPayment, expectedPayment, i);
      if (!!expectedPayment.parentTxHash) {
        expect(
          await cardPaymentProcessor.isPaymentReversed(expectedPayment.parentTxHash)
        ).to.equal(
          expectedPayment.status == PaymentStatus.Reversed
        );
        expect(
          await cardPaymentProcessor.isPaymentRevoked(expectedPayment.parentTxHash)
        ).to.equal(
          expectedPayment.status == PaymentStatus.Revoked
        );
      }
    }
  }

  async function checkBalancesOnBlockchain(
    expectedBalancesPerAccount: Map<string, number>,
    isClearedBalance: boolean
  ) {
    for (const account of expectedBalancesPerAccount.keys()) {
      const expectedBalance = expectedBalancesPerAccount.get(account);
      if (!expectedBalance) {
        continue;
      }
      if (isClearedBalance) {
        expect(
          await cardPaymentProcessor.clearedBalanceOf(account)
        ).to.equal(
          expectedBalance,
          `The cleared balance for account ${account} is wrong`
        );
      } else {
        expect(
          await cardPaymentProcessor.unclearedBalanceOf(account)
        ).to.equal(
          expectedBalance,
          `The uncleared balance for account ${account} is wrong`
        );
      }
    }
  }

  async function checkCashbackNonces(payments: TestPayment[]) {
    for (let i = 0; i < payments.length; ++i) {
      const payment: TestPayment = payments[i];
      const expectedNonce: BigNumber = payment.status != PaymentStatus.Nonexistent
        ? BigNumber.from(payment.cashbackNonce || 0)
        : ethers.constants.Zero;
      const cashback = await cardPaymentProcessor.getCashback(
        createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      expect(cashback.lastCashbackNonce).to.equal(expectedNonce);
    }
  }

  async function checkUnclearedBalances(payments: TestPayment[]) {
    const expectedBalancesPerAccount: Map<string, number> = defineBalancesPerAccount(payments, PaymentStatus.Uncleared);
    await checkBalancesOnBlockchain(expectedBalancesPerAccount, false);
  }

  async function checkClearedBalances(payments: TestPayment[]) {
    const expectedBalancesPerAccount: Map<string, number> = defineBalancesPerAccount(payments, PaymentStatus.Cleared);
    await checkBalancesOnBlockchain(expectedBalancesPerAccount, true);
  }

  async function checkTotalUnclearedBalance(payments: TestPayment[]) {
    const expectedTotalUnclearedBalance: number = countNumberArrayTotal(payments.map(
        function (payment: TestPayment): number {
          return payment.status == PaymentStatus.Uncleared ? payment.amount - (payment.refundAmount || 0) : 0;
        }
      )
    );
    expect(
      await cardPaymentProcessor.totalUnclearedBalance()
    ).to.equal(
      expectedTotalUnclearedBalance,
      `The total uncleared balance is wrong`
    );
  }

  async function checkTotalClearedBalance(payments: TestPayment[]) {
    const expectedTotalClearedBalance: number = countNumberArrayTotal(
      payments.map(
        function (payment: TestPayment): number {
          return payment.status == PaymentStatus.Cleared ? payment.amount - (payment.refundAmount || 0) : 0;
        }
      )
    );
    expect(
      await cardPaymentProcessor.totalClearedBalance()
    ).to.equal(
      expectedTotalClearedBalance,
      `The total cleared balance is wrong`
    );
  }

  async function checkTokenBalance(payments: TestPayment[]) {
    const expectedTokenBalance: number = countNumberArrayTotal(
      payments.map(
        function (payment: TestPayment): number {
          if (payment.status == PaymentStatus.Nonexistent) {
            return 0;
          } else if (payment.status == PaymentStatus.Uncleared || payment.status == PaymentStatus.Cleared) {
            return payment.amount - (payment.refundAmount || 0) +
              calculateRefundCashbackDifference(payment);
          } else if (payment.status == PaymentStatus.Confirmed) {
            return calculateRefundCashbackDifference(payment);
          } else {
            return calculateCashback(payment);
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

  async function checkCardPaymentProcessorState(payments: TestPayment[]) {
    await checkPaymentStructures(payments);
    await checkCashbackNonces(payments);
    await checkUnclearedBalances(payments);
    await checkClearedBalances(payments);
    await checkTotalUnclearedBalance(payments);
    await checkTotalClearedBalance(payments);
    await checkTokenBalance(payments);
  }

  beforeEach(async () => {
    // Deploy the token mock contract
    const TokenMock: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    tokenMock = await TokenMock.deploy();
    await tokenMock.deployed();
    await proveTx(tokenMock.initialize("ERC20 Test", "TEST"));

    // Deploy the contract under test
    CardPaymentProcessor = await ethers.getContractFactory("CardPaymentProcessor");
    cardPaymentProcessor = await CardPaymentProcessor.deploy();
    await cardPaymentProcessor.deployed();
    await proveTx(cardPaymentProcessor.initialize(tokenMock.address));

    // Accounts
    [deployer, cashOutAccount, executor, user1, user2] = await ethers.getSigners();

    // Roles
    ownerRole = (await cardPaymentProcessor.OWNER_ROLE()).toLowerCase();
    blacklisterRole = (await cardPaymentProcessor.BLACKLISTER_ROLE()).toLowerCase();
    pauserRole = (await cardPaymentProcessor.PAUSER_ROLE()).toLowerCase();
    rescuerRole = (await cardPaymentProcessor.RESCUER_ROLE()).toLowerCase();
    executorRole = (await cardPaymentProcessor.EXECUTOR_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(
      cardPaymentProcessor.initialize(tokenMock.address)
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initialize function is reverted if the passed token address is zero", async () => {
    const anotherCardPaymentProcessor: Contract = await CardPaymentProcessor.deploy();
    await anotherCardPaymentProcessor.deployed();

    await expect(
      anotherCardPaymentProcessor.initialize(ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_TOKEN_ADDRESS_IZ_ZERO);
  });

  it("The initial contract configuration should be as expected", async () => {
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
    expect(await cardPaymentProcessor.cashbackDistributor()).to.equal(ethers.constants.AddressZero);
    expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(false);
    expect(await cardPaymentProcessor.cashbackRate()).to.equal(0);
    expect(await cardPaymentProcessor.MAX_CASHBACK_RATE_IN_PERMIL()).to.equal(MAX_CASHBACK_RATE_IN_PERMIL);

    // The cash-out account
    expect(await cardPaymentProcessor.cashOutAccount()).to.equal(ethers.constants.AddressZero);
  });

  describe("Function 'setRevocationLimit()'", async () => {
    it("Is reverted if is called not by the account with the owner role", async () => {
      await expect(
        cardPaymentProcessor.connect(user1).setRevocationLimit(REVOCATION_LIMIT)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Emits the correct event, changes the revocation counter limit properly", async () => {
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(REVOCATION_LIMIT_DEFAULT_VALUE);

      await expect(
        cardPaymentProcessor.setRevocationLimit(REVOCATION_LIMIT)
      ).to.emit(
        cardPaymentProcessor,
        "SetRevocationLimit"
      ).withArgs(
        REVOCATION_LIMIT_DEFAULT_VALUE,
        REVOCATION_LIMIT
      );
    });

    it("Does not emit events if the new value equals the old one", async () => {
      await expect(
        cardPaymentProcessor.setRevocationLimit(REVOCATION_LIMIT_DEFAULT_VALUE)
      ).not.to.emit(
        cardPaymentProcessor,
        "SetRevocationLimit"
      );
    });
  });

  describe("Function 'setCashbackDistributor()'", async () => {
    it("Is reverted if the caller does not have the owner role", async () => {
      await expect(
        cardPaymentProcessor.connect(user1).setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new cashback distributor address is zero", async () => {
      await expect(
        cardPaymentProcessor.setCashbackDistributor(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_IS_ZERO);
    });

    it("Executes as expected and emits the correct event", async () => {
      expect(
        await tokenMock.allowance(cardPaymentProcessor.address, CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.equal(0);

      await expect(
        cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.emit(
        cardPaymentProcessor,
        "SetCashbackDistributor"
      ).withArgs(
        ethers.constants.AddressZero,
        CASHBACK_DISTRIBUTOR_ADDRESS_STUB1
      );

      expect(await cardPaymentProcessor.cashbackDistributor()).to.equal(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1);
      expect(
        await tokenMock.allowance(cardPaymentProcessor.address, CASHBACK_DISTRIBUTOR_ADDRESS_STUB1)
      ).to.equal(ethers.constants.MaxUint256);
    });

    it("Is reverted if the cashback distributor has been already configured", async () => {
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));

      await expect(
        cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB2)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_IS_ALREADY_CONFIGURED);
    });
  });

  describe("Function 'setCashbackRate()'", async () => {
    it("Is reverted if the caller does not have the owner role", async () => {
      await expect(
        cardPaymentProcessor.connect(user1).setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the new rate exceeds the allowable maximum", async () => {
      await expect(
        cardPaymentProcessor.setCashbackRate(MAX_CASHBACK_RATE_IN_PERMIL + 1)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_RATE_EXCESS);
    });

    it("Executes as expected and emits the correct event", async () => {
      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.emit(
        cardPaymentProcessor,
        "SetCashbackRate"
      ).withArgs(
        0,
        CASHBACK_RATE_IN_PERMIL
      );

      expect(await cardPaymentProcessor.cashbackRate()).to.equal(CASHBACK_RATE_IN_PERMIL);
    });

    it("Is reverted if called with the same argument twice", async () => {
      await proveTx(cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL));

      await expect(
        cardPaymentProcessor.setCashbackRate(CASHBACK_RATE_IN_PERMIL)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_RATE_UNCHANGED);
    });
  });

  describe("Function 'enableCashback()'", async () => {
    it("Is reverted if the caller does not have the owner role", async () => {
      await expect(
        cardPaymentProcessor.connect(user1).enableCashback()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the cashback distributor was not configured", async () => {
      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_DISTRIBUTOR_NOT_CONFIGURED);
    });

    it("Executes as expected and emits the correct event", async () => {
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));

      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.emit(
        cardPaymentProcessor,
        "EnableCashback"
      );

      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(true);
    });

    it("Is reverted if the cashback operations are already enabled", async () => {
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));
      await proveTx(cardPaymentProcessor.enableCashback());

      await expect(
        cardPaymentProcessor.enableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED);
    });
  });

  describe("Function 'disableCashbackCashback()'", async () => {
    it("Is reverted if the caller does not have the owner role", async () => {
      await expect(
        cardPaymentProcessor.connect(user1).disableCashback()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Is reverted if the cashback operations are already disabled", async () => {
      await expect(
        cardPaymentProcessor.disableCashback()
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED);
    });

    it("Executes as expected and emits the correct event", async () => {
      await proveTx(cardPaymentProcessor.setCashbackDistributor(CASHBACK_DISTRIBUTOR_ADDRESS_STUB1));
      await proveTx(cardPaymentProcessor.enableCashback());
      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(true);

      await expect(
        cardPaymentProcessor.disableCashback()
      ).to.emit(
        cardPaymentProcessor,
        "DisableCashback"
      );

      expect(await cardPaymentProcessor.cashbackEnabled()).to.equal(false);
    });
  });

  describe("Function 'setCashOutAccount()'", async () => {
    it("Is reverted if the caller does not have the owner role", async () => {
      await expect(
        cardPaymentProcessor.connect(user1).setCashOutAccount(cashOutAccount.address)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Executes as expected and emits the correct event", async () => {
      await expect(
        cardPaymentProcessor.setCashOutAccount(cashOutAccount.address)
      ).to.emit(
        cardPaymentProcessor,
        "SetCashOutAccount"
      ).withArgs(
        ethers.constants.AddressZero,
        cashOutAccount.address
      );

      expect(await cardPaymentProcessor.cashOutAccount()).to.equal(cashOutAccount.address);

      await expect(
        cardPaymentProcessor.setCashOutAccount(ethers.constants.AddressZero)
      ).to.emit(
        cardPaymentProcessor,
        "SetCashOutAccount"
      ).withArgs(
        cashOutAccount.address,
        ethers.constants.AddressZero
      );

      expect(await cardPaymentProcessor.cashOutAccount()).to.equal(ethers.constants.AddressZero);
    });

    it("Is reverted if the new cash-out account is the same as the previous set one", async () => {
      await expect(
        cardPaymentProcessor.setCashOutAccount(ethers.constants.AddressZero)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_UNCHANGED);

      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));

      await expect(
        cardPaymentProcessor.setCashOutAccount(cashOutAccount.address)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_UNCHANGED);
    });
  });

  describe("Function 'makePayment()'", async () => {
    let cashbackDistributorMock: Contract;
    let cashbackDistributorMockConfig: CashbackDistributorMockConfig;
    let payment: TestPayment;
    let authorizationId: string;
    let correlationId: string;

    beforeEach(async () => {
      ({ cashbackDistributorMock, cashbackDistributorMockConfig } = await setUpAndEnableCashback());
      payment = {
        authorizationId: 123,
        account: user1,
        amount: 234,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 345,
        cashbackNonce: cashbackDistributorMockConfig.sendCashbackNonceResult,
        cashbackRateInPermil: CASHBACK_RATE_IN_PERMIL,
      };
      payment.compensationAmount = calculateCompensationAmount(payment);
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      correlationId = createBytesString(payment.makingPaymentCorrelationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount,
          authorizationId,
          correlationId
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller is blacklisted", async () => {
      await proveTx(cardPaymentProcessor.grantRole(blacklisterRole, deployer.address));
      await proveTx(cardPaymentProcessor.blacklist(payment.account.address));

      await expect(
        cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount,
          authorizationId,
          correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount,
          ZERO_AUTHORIZATION_ID,
          correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the user has not enough token balance", async () => {
      const excessTokenAmount: number = payment.amount + 1;

      await expect(
        cardPaymentProcessor.connect(payment.account).makePayment(
          excessTokenAmount,
          authorizationId,
          correlationId
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
    });

    async function checkPaymentMaking() {
      const cashbackAmount: number = calculateCashback(payment);
      await checkCardPaymentProcessorState([payment]);

      const txResponse: TransactionResponse = await cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount,
        authorizationId,
        correlationId
      );
      await expect(
        txResponse
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account],
        [+payment.amount, -payment.amount]
      ).and.to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).withArgs(
        authorizationId,
        correlationId,
        payment.account.address,
        payment.amount,
        payment.revocationCounter || 0,
        payment.account.address
      );
      await expect(
        txResponse
      ).and.to.emit(
        cardPaymentProcessor,
        "SendCashbackSuccess"
      ).withArgs(
        cashbackDistributorMock.address,
        cashbackAmount,
        payment.cashbackNonce
      );
      await expect(
        txResponse
      ).to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      ).withArgs(
        cardPaymentProcessor.address,
        tokenMock.address,
        CashbackKind.CardPayment,
        createBytesString(payment.authorizationId, BYTES16_LENGTH).padEnd(BYTES32_LENGTH * 2 + 2, "0"),
        payment.account.address,
        cashbackAmount
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    }

    it("Executes as expected and emits the correct events if the payment amount is nonzero", async () => {
      await checkPaymentMaking();
    });

    it("Executes as expected and emits the correct events if the payment amount is zero", async () => {
      payment.amount = 0;
      payment.compensationAmount = calculateCompensationAmount(payment);
      await checkPaymentMaking();
    });

    it("Executes successfully even if the revocation limit of payments is zero", async () => {
      await proveTx(cardPaymentProcessor.setRevocationLimit(0));
      await checkPaymentMaking();
    });

    it("Executes successfully but do not send a cashback if it is disabled", async () => {
      await proveTx(cardPaymentProcessor.disableCashback());
      setCashbackRate(payment, ZERO_CASHBACK_RATE);
      payment.cashbackNonce = undefined;

      await expect(
        cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount,
          authorizationId,
          correlationId
        )
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account],
        [+payment.amount, -payment.amount]
      ).and.to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).and.not.to.emit(
        cardPaymentProcessor,
        "SendCashbackSuccess"
      ).and.not.to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    });

    it("Executes successfully and emits the correct events if cashback sending fails", async () => {
      const cashbackAmount: number = calculateCashback(payment);
      await proveTx(cashbackDistributorMock.setSendCashbackSuccessResult(false));
      setCashbackRate(payment, ZERO_CASHBACK_RATE);

      const txResponse: TransactionResponse = await cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount,
        authorizationId,
        correlationId
      );
      await expect(
        txResponse
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account],
        [+payment.amount, -payment.amount]
      ).and.to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).withArgs(
        authorizationId,
        correlationId,
        payment.account.address,
        payment.amount,
        payment.revocationCounter || 0,
        payment.account.address
      ).and.not.to.emit(
        cardPaymentProcessor,
        "SendCashbackSuccess"
      );
      await expect(
        txResponse
      ).to.emit(
        cardPaymentProcessor,
        "SendCashbackFailure"
      ).withArgs(
        cashbackDistributorMock.address,
        cashbackAmount,
        payment.cashbackNonce
      );
      await expect(
        txResponse
      ).to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      ).withArgs(
        cardPaymentProcessor.address,
        tokenMock.address,
        CashbackKind.CardPayment,
        createBytesString(payment.authorizationId, BYTES16_LENGTH).padEnd(BYTES32_LENGTH * 2 + 2, "0"),
        payment.account.address,
        cashbackAmount,
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    });

    it("Is reverted if the payment authorization ID already exists", async () => {
      await makePayments([payment]);
      const otherMakingPaymentCorrelationsId: string = createBytesString(
        payment.makingPaymentCorrelationId + 1,
        BYTES16_LENGTH
      );

      await expect(
        cardPaymentProcessor.connect(payment.account).makePayment(
          payment.amount + 1,
          authorizationId,
          otherMakingPaymentCorrelationsId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
    });
  });

  describe("Function 'makePaymentFrom()'", async () => {
    let cashbackDistributorMock: Contract;
    let cashbackDistributorMockConfig: CashbackDistributorMockConfig;
    let payment: TestPayment;
    let authorizationId: string;
    let correlationId: string;

    beforeEach(async () => {
      ({ cashbackDistributorMock, cashbackDistributorMockConfig } = await setUpAndEnableCashback());
      payment = {
        authorizationId: 234,
        account: user1,
        amount: 345,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 456,
        cashbackNonce: cashbackDistributorMockConfig.sendCashbackNonceResult,
        cashbackRateInPermil: CASHBACK_RATE_IN_PERMIL,
      };
      payment.compensationAmount = calculateCompensationAmount(payment);
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      correlationId = createBytesString(payment.makingPaymentCorrelationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          authorizationId,
          correlationId
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(payment.account).makePaymentFrom(
          payment.account.address,
          payment.amount,
          authorizationId,
          correlationId
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(payment.account.address, executorRole));
    });

    it("Is reverted if the payment account address is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          ethers.constants.AddressZero,
          payment.amount,
          authorizationId,
          correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ACCOUNT_IS_ZERO);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          ZERO_AUTHORIZATION_ID,
          correlationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the user has not enough token balance", async () => {
      const excessTokenAmount: number = payment.amount + 1;

      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          excessTokenAmount,
          authorizationId,
          correlationId
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
    });

    async function checkPaymentMakingFrom() {
      const cashbackAmount: number = calculateCashback(payment);
      await checkCardPaymentProcessorState([payment]);

      const txResponse: TransactionResponse = await cardPaymentProcessor.connect(executor).makePaymentFrom(
        payment.account.address,
        payment.amount,
        authorizationId,
        correlationId
      );
      await expect(
        txResponse
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account, executor],
        [+payment.amount, -payment.amount, 0]
      ).and.to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).withArgs(
        authorizationId,
        correlationId,
        payment.account.address,
        payment.amount,
        payment.revocationCounter || 0,
        executor.address
      );
      await expect(
        txResponse
      ).to.emit(
        cardPaymentProcessor,
        "SendCashbackSuccess"
      ).withArgs(
        cashbackDistributorMock.address,
        cashbackAmount,
        payment.cashbackNonce
      );
      await expect(
        txResponse
      ).to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      ).withArgs(
        cardPaymentProcessor.address,
        tokenMock.address,
        CashbackKind.CardPayment,
        createBytesString(payment.authorizationId, BYTES16_LENGTH).padEnd(BYTES32_LENGTH * 2 + 2, "0"),
        payment.account.address,
        cashbackAmount
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    }

    it("Executes as expected and emits the correct events if the payment amount is nonzero", async () => {
      await checkPaymentMakingFrom();
    });

    it("Executes as expected and emits the correct events if the payment amount is zero", async () => {
      payment.amount = 0;
      payment.compensationAmount = calculateCompensationAmount(payment);
      await checkPaymentMakingFrom();
    });

    it("Executes successfully even if the revocation limit of payments is zero", async () => {
      await proveTx(cardPaymentProcessor.setRevocationLimit(0));
      await checkPaymentMakingFrom();
    });

    it("Executes successfully but do not send a cashback if it is disabled", async () => {
      await proveTx(cardPaymentProcessor.disableCashback());
      setCashbackRate(payment, ZERO_CASHBACK_RATE);
      payment.cashbackNonce = undefined;

      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          authorizationId,
          correlationId
        )
      ).to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).withArgs(
        authorizationId,
        correlationId,
        payment.account.address,
        payment.amount,
        payment.revocationCounter || 0,
        executor.address
      ).and.not.to.emit(
        cardPaymentProcessor,
        "SendCashbackSuccess"
      ).and.not.to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    });

    it("Executes successfully and emits the correct events if cashback sending fails", async () => {
      const cashbackAmount: number = calculateCashback(payment);
      await proveTx(cashbackDistributorMock.setSendCashbackSuccessResult(false));
      setCashbackRate(payment, ZERO_CASHBACK_RATE);

      const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).makePaymentFrom(
        payment.account.address,
        payment.amount,
        authorizationId,
        correlationId
      );
      await expect(
        txResponse
      ).to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).withArgs(
        authorizationId,
        correlationId,
        payment.account.address,
        payment.amount,
        payment.revocationCounter || 0,
        executor.address
      ).and.not.to.emit(
        cardPaymentProcessor,
        "SendCashbackSuccess"
      );
      await expect(
        txResponse
      ).to.emit(
        cardPaymentProcessor,
        "SendCashbackFailure"
      ).withArgs(
        cashbackDistributorMock.address,
        cashbackAmount,
        payment.cashbackNonce
      );
      await expect(
        txResponse
      ).to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      ).withArgs(
        cardPaymentProcessor.address,
        tokenMock.address,
        CashbackKind.CardPayment,
        createBytesString(payment.authorizationId, BYTES16_LENGTH).padEnd(BYTES32_LENGTH * 2 + 2, "0"),
        payment.account.address,
        cashbackAmount
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    });

    it("Is reverted if the payment authorization ID already exists", async () => {
      await makePayments([payment]);
      const otherMakingPaymentCorrelationsId: string = createBytesString(
        payment.makingPaymentCorrelationId + 1,
        BYTES16_LENGTH
      );

      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          authorizationId,
          otherMakingPaymentCorrelationsId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
    });
  });

  describe("Function 'clearPayment()'", async () => {
    let payment: TestPayment;
    let authorizationId: string;

    beforeEach(async () => {
      payment = {
        authorizationId: 123,
        account: user1,
        amount: 234,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 345,
      };
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
      await makePayments([payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).clearPayment(authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(
          createBytesString(payment.authorizationId + 1, BYTES16_LENGTH)
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      await checkCardPaymentProcessorState([payment]);
      const expectedClearedBalance: number = payment.amount;
      const expectedUnclearedBalance: number = 0;

      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(authorizationId)
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account],
        [0, 0]
      ).and.to.emit(
        cardPaymentProcessor,
        "ClearPayment"
      ).withArgs(
        authorizationId,
        payment.account.address,
        payment.amount,
        expectedClearedBalance,
        expectedUnclearedBalance,
        payment.revocationCounter || 0
      );

      payment.status = PaymentStatus.Cleared;
      await checkCardPaymentProcessorState([payment]);
    });

    it("Is reverted if the payment has already been cleared", async () => {
      await proveTx(cardPaymentProcessor.connect(executor).clearPayment(authorizationId));

      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });
  });

  describe("Function 'clearPayments()'", async () => {
    let payments: TestPayment[];
    let authorizationIds: string[];
    let accountAddresses: string[];
    let expectedClearedBalances: number[];
    let expectedUnclearedBalances: number[];

    beforeEach(async () => {
      payments = [
        {
          authorizationId: 123,
          account: user1,
          amount: 234,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 345,
        },
        {
          authorizationId: 456,
          account: user2,
          amount: 567,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 789,
        },
      ];
      authorizationIds = payments.map(
        (payment: TestPayment) => createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      accountAddresses = payments.map(
        (payment: TestPayment) => payment.account.address
      );
      expectedClearedBalances = payments.map((payment: TestPayment) => payment.amount);
      expectedUnclearedBalances = payments.map(() => 0);
      await setUpContractsForPayments(payments);
      await setExecutorRole(executor);
      await makePayments(payments);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(authorizationIds)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).clearPayments(authorizationIds)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).clearPayments([])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).clearPayments([authorizationIds[0], ZERO_AUTHORIZATION_ID])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(
          [
            authorizationIds[0],
            createBytesString(payments[payments.length - 1].authorizationId + 1, BYTES16_LENGTH),
          ]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments has been already cleared", async () => {
      await proveTx(cardPaymentProcessor.connect(executor).clearPayment(authorizationIds[0]));

      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });

    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      await checkCardPaymentProcessorState(payments);

      const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).clearPayments(authorizationIds);
      await expect(
        txResponse
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, ...accountAddresses],
        [0, ...accountAddresses.map(() => 0)]
      ).and.to.emit(
        cardPaymentProcessor,
        "ClearPayment"
      ).withArgs(
        authorizationIds[0],
        payments[0].account.address,
        payments[0].amount,
        expectedClearedBalances[0],
        expectedUnclearedBalances[0],
        payments[0].revocationCounter || 0
      );
      await expect(
        txResponse
      ).to.emit(
        cardPaymentProcessor,
        "ClearPayment"
      ).withArgs(
        authorizationIds[1],
        payments[1].account.address,
        payments[1].amount,
        expectedClearedBalances[1],
        expectedUnclearedBalances[1],
        payments[1].revocationCounter || 0
      );

      payments.forEach((payment: TestPayment) => payment.status = PaymentStatus.Cleared);
      await checkCardPaymentProcessorState(payments);
    });
  });

  describe("Function 'unclearPayment()'", async () => {
    let payment: TestPayment;
    let authorizationId: string;

    beforeEach(async () => {
      payment = {
        authorizationId: 543,
        account: user1,
        amount: 432,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 321,
      };
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
      await makePayments([payment]);
      await clearPayments([payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).unclearPayment(authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(
          createBytesString(payment.authorizationId + 1, BYTES16_LENGTH)
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      await checkCardPaymentProcessorState([payment]);
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = payment.amount;

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(authorizationId)
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payment.account],
        [0, 0]
      ).and.to.emit(
        cardPaymentProcessor,
        "UnclearPayment"
      ).withArgs(
        authorizationId,
        payment.account.address,
        payment.amount,
        expectedClearedBalance,
        expectedUnclearedBalance,
        payment.revocationCounter || 0
      );

      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    });

    it("Is reverted if the payment is uncleared", async () => {
      await proveTx(cardPaymentProcessor.connect(executor).unclearPayment(authorizationId));

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'unclearPayments()'", async () => {
    let payments: TestPayment[];

    let authorizationIds: string[];
    let accountAddresses: string[];
    let expectedClearedBalances: number[];
    let expectedUnclearedBalances: number[];

    beforeEach(async () => {
      payments = [
        {
          authorizationId: 987,
          account: user1,
          amount: 876,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 765,
        },
        {
          authorizationId: 654,
          account: user2,
          amount: 543,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 432,
        },
      ];
      authorizationIds = payments.map(
        (payment: TestPayment) => createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      accountAddresses = payments.map((payment: TestPayment) => payment.account.address);
      expectedClearedBalances = payments.map(() => 0);
      expectedUnclearedBalances = payments.map((payment: TestPayment) => payment.amount);
      await setUpContractsForPayments(payments);
      await setExecutorRole(executor);
      await makePayments(payments);
      await clearPayments(payments);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).unclearPayments(authorizationIds)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments([])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments([authorizationIds[0], ZERO_AUTHORIZATION_ID])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(
          [
            authorizationIds[0],
            createBytesString(payments[payments.length - 1].authorizationId + 1, BYTES16_LENGTH)
          ]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      await proveTx(cardPaymentProcessor.connect(executor).unclearPayment(authorizationIds[0]));

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });

    it("Executes as expected, emits the correct event, and does not transfer tokens", async () => {
      await checkCardPaymentProcessorState(payments);

      const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds);
      await expect(
        txResponse
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, ...accountAddresses],
        [0, ...accountAddresses.map(() => 0)]
      ).and.to.emit(
        cardPaymentProcessor,
        "UnclearPayment"
      ).withArgs(
        authorizationIds[0],
        payments[0].account.address,
        payments[0].amount,
        expectedClearedBalances[0],
        expectedUnclearedBalances[0],
        payments[0].revocationCounter || 0
      );
      await expect(
        txResponse
      ).to.emit(
        cardPaymentProcessor,
        "UnclearPayment"
      ).withArgs(
        authorizationIds[1],
        payments[1].account.address,
        payments[1].amount,
        expectedClearedBalances[1],
        expectedUnclearedBalances[1],
        payments[1].revocationCounter || 0
      );

      payments.forEach((payment: TestPayment) => payment.status = PaymentStatus.Uncleared);
      await checkCardPaymentProcessorState(payments);
    });
  });

  describe("Function 'revokePayment()'", async () => {
    let cashbackDistributorMock: Contract;
    let cashbackDistributorMockConfig: CashbackDistributorMockConfig;
    let payment: TestPayment;
    let authorizationId: string;

    beforeEach(async () => {
      ({ cashbackDistributorMock, cashbackDistributorMockConfig } = await setUpAndEnableCashback());
      payment = {
        authorizationId: 987,
        account: user1,
        amount: 876,
        status: PaymentStatus.Nonexistent,
        revocationCounter: 0,
        makingPaymentCorrelationId: 765,
        parentTxHash: PARENT_TRANSACTION_HASH,
        cashbackNonce: cashbackDistributorMockConfig.sendCashbackNonceResult,
        cashbackRateInPermil: CASHBACK_RATE_IN_PERMIL,
      };
      payment.compensationAmount = calculateCompensationAmount(payment);
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the configured revocation limit of payments is zero", async () => {
      await proveTx(cardPaymentProcessor.setRevocationLimit(0));

      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          ZERO_AUTHORIZATION_ID,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the parent transaction hash is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          ZERO_TRANSACTION_HASH,
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          createBytesString(payment.authorizationId + 1, BYTES16_LENGTH),
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    describe("Executes as expected and emits the correct events if the payment status is", async () => {
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = 0;
      const expectedRevocationCounter: number = 1;

      beforeEach(async () => {
        await makePayments([payment]);
      });

      async function checkRevocation(wasPaymentCleared: boolean) {
        await checkCardPaymentProcessorState([payment]);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        );
        await expect(
          txResponse
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-revokedPaymentAmount, +revokedPaymentAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          "RevokePayment"
        ).withArgs(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.account.address,
          revokedPaymentAmount,
          expectedClearedBalance,
          expectedUnclearedBalance,
          wasPaymentCleared,
          payment.parentTxHash,
          expectedRevocationCounter
        );
        await expect(
          txResponse
        ).to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce
        );
        await expect(
          txResponse
        ).to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce,
          cashbackAmount
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = expectedRevocationCounter;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState([payment]);
      }

      it("Uncleared", async () => {
        const wasPaymentCleared: boolean = false;
        await checkRevocation(wasPaymentCleared);
      });

      it("Cleared", async () => {
        const wasPaymentCleared: boolean = true;
        await clearPayments([payment]);
        await checkRevocation(wasPaymentCleared);
      });
    });

    describe("Executes successfully and do the following with cashback operations", async () => {
      it("Does not revoke a cashback if cashback operations are disabled before sending", async () => {
        await proveTx(cardPaymentProcessor.disableCashback());
        setCashbackRate(payment, ZERO_CASHBACK_RATE);
        payment.cashbackNonce = undefined;
        await makePayments([payment]);

        await expect(
          cardPaymentProcessor.connect(executor).revokePayment(
            authorizationId,
            REVERSING_PAYMENT_CORRELATION_ID,
            payment.parentTxHash
          )
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-payment.amount, +payment.amount]
        ).and.to.emit(
          cardPaymentProcessor,
          "RevokePayment"
        ).and.not.to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        ).and.not.to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = 1;
        await checkCardPaymentProcessorState([payment]);
      });

      it("Does revoke a cashback if cashback operations are disabled after sending", async () => {
        await makePayments([payment]);
        await proveTx(cardPaymentProcessor.disableCashback());
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        const txResponse: TransactionResponse = await cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        );
        await expect(
          txResponse
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-revokedPaymentAmount, +revokedPaymentAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          "RevokePayment"
        );
        await expect(
          txResponse
        ).to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce
        );
        await expect(
          txResponse
        ).to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce,
          cashbackAmount
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = 1;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState([payment]);
      });

      it("Emits correct events if cashback operations are enabled but cashback revoking fails", async () => {
        await makePayments([payment]);
        await proveTx(cashbackDistributorMock.setRevokeCashbackSuccessResult(false));
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        );
        await expect(
          txResponse
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-revokedPaymentAmount, +revokedPaymentAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          "RevokePayment"
        ).and.not.to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        );
        await expect(
          txResponse
        ).to.emit(
          cardPaymentProcessor,
          "RevokeCashbackFailure"
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce
        );
        await expect(
          txResponse
        ).to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce,
          cashbackAmount
        );

        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = 1;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState([payment]);
      });
    });
  });

  describe("Function 'reversePayment()'", async () => {
    let cashbackDistributorMock: Contract;
    let cashbackDistributorMockConfig: CashbackDistributorMockConfig;

    let payment: TestPayment;
    let authorizationId: string;

    beforeEach(async () => {
      ({ cashbackDistributorMock, cashbackDistributorMockConfig } = await setUpAndEnableCashback());
      payment = {
        authorizationId: 876,
        account: user1,
        amount: 765,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 543,
        parentTxHash: PARENT_TRANSACTION_HASH,
        cashbackNonce: cashbackDistributorMockConfig.sendCashbackNonceResult,
        cashbackRateInPermil: CASHBACK_RATE_IN_PERMIL,
      };
      payment.compensationAmount = calculateCompensationAmount(payment);
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).reversePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          ZERO_AUTHORIZATION_ID,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the parent transaction hash is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          ZERO_TRANSACTION_HASH,
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          createBytesString(payment.authorizationId + 1, BYTES16_LENGTH),
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    describe("Executes as expected and emits the correct events if the payment is", async () => {
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = 0;

      beforeEach(async () => {
        await makePayments([payment]);
      });

      async function checkReversion(wasPaymentCleared: boolean) {
        await checkCardPaymentProcessorState([payment]);
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).reversePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        );
        await expect(
          txResponse
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-revokedPaymentAmount, +revokedPaymentAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          "ReversePayment"
        ).withArgs(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.account.address,
          revokedPaymentAmount,
          expectedClearedBalance,
          expectedUnclearedBalance,
          wasPaymentCleared,
          payment.parentTxHash,
          payment.revocationCounter || 0
        );
        await expect(
          txResponse
        ).to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce
        );
        await expect(
          txResponse
        ).to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce,
          cashbackAmount
        );

        payment.status = PaymentStatus.Reversed;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState([payment]);
      }

      it("Uncleared", async () => {
        const wasPaymentCleared: boolean = false;
        await checkReversion(wasPaymentCleared);
      });

      it("Cleared", async () => {
        const wasPaymentCleared: boolean = true;
        await clearPayments([payment]);
        await checkReversion(wasPaymentCleared);
      });
    });

    describe("Executes successfully and do the following with cashback operations", async () => {
      it("Does not revoke a cashback if cashback operations are disabled before sending", async () => {
        await proveTx(cardPaymentProcessor.disableCashback());
        setCashbackRate(payment, ZERO_CASHBACK_RATE);
        payment.cashbackNonce = undefined;
        await makePayments([payment]);

        await expect(
          cardPaymentProcessor.connect(executor).reversePayment(
            authorizationId,
            REVERSING_PAYMENT_CORRELATION_ID,
            payment.parentTxHash
          )
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-payment.amount, +payment.amount]
        ).and.to.emit(
          cardPaymentProcessor,
          "ReversePayment"
        ).and.not.to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        ).and.not.to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        );

        payment.status = PaymentStatus.Reversed;
        await checkCardPaymentProcessorState([payment]);
      });

      it("Does revoke a cashback if cashback operations are disabled after sending", async () => {
        await makePayments([payment]);
        await proveTx(cardPaymentProcessor.disableCashback());
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).reversePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        );
        await expect(
          txResponse
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-revokedPaymentAmount, +revokedPaymentAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          "ReversePayment"
        );
        await expect(
          txResponse
        ).to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce
        );
        await expect(
          txResponse
        ).to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce,
          cashbackAmount
        );

        payment.status = PaymentStatus.Reversed;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState([payment]);
      });

      it("Emits correct events if cashback operations are enabled but cashback revoking fails", async () => {
        await makePayments([payment]);
        await proveTx(cashbackDistributorMock.setRevokeCashbackSuccessResult(false));
        const cashbackAmount: number = calculateCashback(payment);
        const revokedPaymentAmount: number = payment.amount - cashbackAmount;

        const txResponse: TransactionResponse = cardPaymentProcessor.connect(executor).reversePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        );
        await expect(
          txResponse
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-revokedPaymentAmount, +revokedPaymentAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          "ReversePayment"
        ).and.not.to.emit(
          cardPaymentProcessor,
          "RevokeCashbackSuccess"
        );
        await expect(
          txResponse
        ).to.emit(
          cardPaymentProcessor,
          "RevokeCashbackFailure"
        ).withArgs(
          cashbackDistributorMock.address,
          cashbackAmount,
          payment.cashbackNonce
        );
        await expect(
          txResponse
        ).to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce,
          cashbackAmount
        );

        payment.status = PaymentStatus.Reversed;
        payment.compensationAmount = 0;
        await checkCardPaymentProcessorState([payment]);
      });
    });
  });

  describe("Function 'confirmPayment()'", async () => {
    let payment: TestPayment;
    let authorizationId: string;

    beforeEach(async () => {
      payment = {
        authorizationId: 123,
        account: user1,
        amount: 234,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 345,
      };
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
      await makePayments([payment]);
      await clearPayments([payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).confirmPayment(authorizationId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(ZERO_AUTHORIZATION_ID)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(
          createBytesString(payment.authorizationId + 1, BYTES16_LENGTH)
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      await proveTx(cardPaymentProcessor.connect(executor).unclearPayment(authorizationId));

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });

    it("Is reverted if the cash-out account is not set", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO);
    });

    it("Executes as expected and emits the correct event", async () => {
      await checkCardPaymentProcessorState([payment]);
      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
      const expectedClearedBalance: number = 0;

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, cashOutAccount, payment.account],
        [-payment.amount, +payment.amount, 0]
      ).and.to.emit(
        cardPaymentProcessor,
        "ConfirmPayment"
      ).withArgs(
        authorizationId,
        payment.account.address,
        payment.amount,
        expectedClearedBalance,
        payment.revocationCounter || 0
      );

      payment.status = PaymentStatus.Confirmed;
      await checkCardPaymentProcessorState([payment]);
    });
  });

  describe("Function 'confirmPayments()'", async () => {
    let payments: TestPayment[];
    let authorizationIds: string[];
    let accountAddresses: string[];
    let totalAmount: number;

    beforeEach(async () => {
      payments = [
        {
          authorizationId: 123,
          account: user1,
          amount: 234,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 345,
        },
        {
          authorizationId: 456,
          account: user2,
          amount: 567,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 789,
        },
      ];
      authorizationIds = payments.map(
        (payment: TestPayment) => createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      accountAddresses = payments.map((payment: TestPayment) => payment.account.address);
      totalAmount = countNumberArrayTotal(
        payments.map(
          function (payment: TestPayment): number {
            return payment.amount;
          }
        )
      );
      await setUpContractsForPayments(payments);
      await setExecutorRole(executor);
      await makePayments(payments);
      await clearPayments(payments);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).confirmPayments(authorizationIds)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments([])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(
          [authorizationIds[0], ZERO_AUTHORIZATION_ID]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(
          [
            authorizationIds[0],
            createBytesString(payments[payments.length - 1].authorizationId + 1, BYTES16_LENGTH)
          ]
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      await proveTx(cardPaymentProcessor.connect(executor).unclearPayment(authorizationIds[1]));

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });

    it("Is reverted if the cash-out account is not set", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO);
    });

    it("Executes as expected and emits the correct event", async () => {
      const expectedClearedBalance: number = 0;
      await checkCardPaymentProcessorState(payments);
      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));

      const txResponse: TransactionResponse =
        await cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds);
      await expect(
        txResponse
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, cashOutAccount, ...accountAddresses],
        [-totalAmount, +totalAmount, ...accountAddresses.map(() => 0)]
      ).and.to.emit(
        cardPaymentProcessor,
        "ConfirmPayment"
      ).withArgs(
        authorizationIds[0],
        payments[0].account.address,
        payments[0].amount,
        expectedClearedBalance,
        payments[0].revocationCounter || 0
      );
      await expect(
        txResponse
      ).to.emit(
        cardPaymentProcessor,
        "ConfirmPayment"
      ).withArgs(
        authorizationIds[1],
        payments[1].account.address,
        payments[1].amount,
        expectedClearedBalance,
        payments[1].revocationCounter || 0
      );

      payments.forEach((payment: TestPayment) => payment.status = PaymentStatus.Confirmed);
      await checkCardPaymentProcessorState(payments);
    });
  });

  describe("Function 'refundPayment()'", async () => {
    let refundAmount = 123;
    let cashbackDistributorMock: Contract;
    let cashbackDistributorMockConfig: CashbackDistributorMockConfig;
    let payment: TestPayment;
    let authorizationId: string;

    beforeEach(async () => {
      ({ cashbackDistributorMock, cashbackDistributorMockConfig } = await setUpAndEnableCashback());
      payment = {
        authorizationId: 1234,
        account: user1,
        amount: 2345,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 3456,
        parentTxHash: PARENT_TRANSACTION_HASH,
        cashbackNonce: cashbackDistributorMockConfig.sendCashbackNonceResult,
        cashbackRateInPermil: CASHBACK_RATE_IN_PERMIL,
      };
      payment.compensationAmount = calculateCompensationAmount(payment);
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());

      await expect(
        cardPaymentProcessor.connect(executor).refundPayment(
          refundAmount,
          authorizationId
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(
        cardPaymentProcessor.connect(deployer).refundPayment(
          refundAmount,
          authorizationId
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      // await makePayments([payment]);
      await expect(
        cardPaymentProcessor.connect(executor).refundPayment(
          refundAmount,
          ZERO_AUTHORIZATION_ID
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(
        cardPaymentProcessor.connect(executor).refundPayment(
          refundAmount,
          authorizationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the refund amount exceeds the payment amount", async () => {
      await makePayments([payment]);

      await expect(
        cardPaymentProcessor.connect(executor).refundPayment(
          payment.amount + 1,
          authorizationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_REFUND_AMOUNT_IS_INAPPROPRIATE);
    });

    it("Is reverted if the payment is confirmed, but the cash-out amount address is zero", async () => {
      await makePayments([payment]);
      await clearPayments([payment]);
      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
      await proveTx(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
      );
      payment.status = PaymentStatus.Confirmed;
      await proveTx(cardPaymentProcessor.setCashOutAccount(ethers.constants.AddressZero));

      await expect(
        cardPaymentProcessor.connect(executor).refundPayment(
          refundAmount,
          authorizationId
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_ADDRESS_IS_ZERO);
    });

    describe("Is reverted if the payment status is", async () => {
      beforeEach(async () => {
        await makePayments([payment]);
      });

      it("Revoked", async () => {
        await proveTx(cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        ));

        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            refundAmount,
            authorizationId
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessor,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Revoked);
      });

      it("Reversed", async () => {
        await proveTx(cardPaymentProcessor.connect(executor).reversePayment(
          authorizationId,
          REVERSING_PAYMENT_CORRELATION_ID,
          payment.parentTxHash
        ));

        await expect(
          cardPaymentProcessor.connect(executor).refundPayment(
            refundAmount,
            authorizationId
          )
        ).to.be.revertedWithCustomError(
          cardPaymentProcessor,
          REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS
        ).withArgs(PaymentStatus.Reversed);
      });
    });

    describe("Executes as expected and emits the correct events if the payment amount is", async () => {
      beforeEach(async () => {
        await makePayments([payment]);
      });

      async function checkRefunding(tokenSourceAccount: SignerWithAddress | Contract) {
        await checkCardPaymentProcessorState([payment]);
        setRefundAmount(payment, refundAmount);
        const revocationCashbackAmount = calculateRefundCashbackDifference(payment);
        const userSentAmount = refundAmount - revocationCashbackAmount;
        let processorSentAmount = -userSentAmount;
        let cashOutAccountSentAmount = 0;
        if (tokenSourceAccount == cashOutAccount) {
          processorSentAmount = revocationCashbackAmount;
          cashOutAccountSentAmount = -(processorSentAmount + userSentAmount);
        }

        const txResponse: TransactionResponse =
          await cardPaymentProcessor.connect(executor).refundPayment(refundAmount, authorizationId);
        await expect(
          txResponse
        ).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account, cashOutAccount],
          [processorSentAmount, userSentAmount, cashOutAccountSentAmount]
        ).and.to.emit(
          cardPaymentProcessor,
          "RefundPayment"
        ).withArgs(
          authorizationId,
          payment.account.address,
          payment.refundAmount,
          userSentAmount,
          payment.status
        );
        await expect(
          txResponse
        ).to.emit(
          cashbackDistributorMock,
          "RevokeCashbackMock"
        ).withArgs(
          cardPaymentProcessor.address,
          payment.cashbackNonce,
          revocationCashbackAmount
        );

        await checkCardPaymentProcessorState([payment]);
      }

      describe("Nonzero and the payment status is", async () => {
        it("Uncleared", async () => {
          await checkRefunding(cardPaymentProcessor);
        });

        it("Cleared", async () => {
          await clearPayments([payment]);
          await checkRefunding(cardPaymentProcessor);
        });

        it("Confirmed", async () => {
          await clearPayments([payment]);
          await proveTx(
            tokenMock.connect(cashOutAccount).approve(cardPaymentProcessor.address, ethers.constants.MaxUint256)
          );
          await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
          await proveTx(
            cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
          );
          payment.status = PaymentStatus.Confirmed;
          await checkRefunding(cashOutAccount);
        });
      });

      describe("Equals the payment amount and the payment status is", async () => {
        beforeEach(() => {
          refundAmount = payment.amount;
        });

        it("Uncleared", async () => {
          await checkRefunding(cardPaymentProcessor);
        });

        it("Cleared", async () => {
          await clearPayments([payment]);
          await checkRefunding(cardPaymentProcessor);
        });

        it("Confirmed", async () => {
          await clearPayments([payment]);
          await proveTx(
            tokenMock.connect(cashOutAccount).approve(cardPaymentProcessor.address, ethers.constants.MaxUint256)
          );
          await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
          await proveTx(
            cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
          );
          payment.status = PaymentStatus.Confirmed;

          await checkRefunding(cashOutAccount);
        });
      });

      describe("Zero and the payment status is", async () => {
        beforeEach(() => {
          refundAmount = 0;
        });

        it("Uncleared", async () => {
          await checkRefunding(cardPaymentProcessor);
        });

        it("Cleared", async () => {
          await clearPayments([payment]);
          await checkRefunding(cardPaymentProcessor);
        });

        it("Confirmed", async () => {
          await clearPayments([payment]);
          await proveTx(
            tokenMock.connect(cashOutAccount).approve(cardPaymentProcessor.address, ethers.constants.MaxUint256)
          );
          await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
          await proveTx(
            cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
          );
          payment.status = PaymentStatus.Confirmed;

          await checkRefunding(cashOutAccount);
        });
      });
    });
  });

  describe("Complex scenarios without cashback", async () => {
    let payments: TestPayment[];
    let authorizationIds: string[];

    async function checkRevertingOfAllPaymentProcessingFunctionsExceptMaking() {
      await expect(
        cardPaymentProcessor.connect(executor).clearPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(
        cardPaymentProcessor.connect(executor).clearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(
        cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationIds[0],
          CORRELATION_ID,
          PARENT_TRANSACTION_HASH
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationIds[0],
          CORRELATION_ID,
          PARENT_TRANSACTION_HASH
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationIds[0])
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(
        cardPaymentProcessor.connect(executor).confirmPayments(authorizationIds)
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);
    }

    beforeEach(async () => {
      payments = [
        {
          authorizationId: 1234,
          account: user1,
          amount: 2345,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 3456,
        },
        {
          authorizationId: 4567,
          account: user2,
          amount: 5678,
          status: PaymentStatus.Nonexistent,
          makingPaymentCorrelationId: 6789,
        }
      ];
      authorizationIds = payments.map(
        (payment: TestPayment) => createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      await setUpContractsForPayments(payments);
      await setExecutorRole(executor);
    });

    it("All payment processing functions except making are reverted if a payment was revoked", async () => {
      await makePayments(payments);
      await proveTx(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationIds[0],
          CORRELATION_ID,
          PARENT_TRANSACTION_HASH
        )
      );
      payments[0].status = PaymentStatus.Revoked;
      payments[0].revocationCounter = 1;

      await checkCardPaymentProcessorState(payments);
      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking();

      await expect(
        cardPaymentProcessor.connect(payments[0].account).makePayment(
          payments[0].amount,
          authorizationIds[0],
          CORRELATION_ID,
        )
      ).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payments[0].account],
        [+payments[0].amount, -payments[0].amount]
      ).and.to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).withArgs(
        authorizationIds[0],
        CORRELATION_ID,
        payments[0].account.address,
        payments[0].amount,
        payments[0].revocationCounter || 0,
        payments[0].account.address
      );

      payments[0].status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState(payments);
    });

    it("All payment processing functions are reverted if a payment was reversed", async () => {
      await makePayments(payments);
      await proveTx(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationIds[0],
          CORRELATION_ID,
          PARENT_TRANSACTION_HASH
        )
      );
      payments[0].status = PaymentStatus.Reversed;

      await expect(
        cardPaymentProcessor.makePayment(
          payments[0].amount,
          authorizationIds[0],
          createBytesString(payments[0].makingPaymentCorrelationId, BYTES16_LENGTH)
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking();
      await checkCardPaymentProcessorState(payments);
    });

    it("All payment processing functions are reverted if a payment was confirmed", async () => {
      await makePayments(payments);
      await clearPayments(payments);
      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
      await proveTx(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationIds[0])
      );
      payments[0].status = PaymentStatus.Confirmed;

      await expect(
        cardPaymentProcessor.makePayment(
          payments[0].amount,
          authorizationIds[0],
          createBytesString(payments[0].makingPaymentCorrelationId, BYTES16_LENGTH)
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking();
      await checkCardPaymentProcessorState(payments);
    });

    it("Making payment function is reverted if the payment has the 'Cleared' status", async () => {
      await makePayments([payments[0]]);
      await clearPayments([payments[0]]);

      await expect(
        cardPaymentProcessor.connect(payments[0].account).makePayment(
          payments[0].amount,
          authorizationIds[0],
          CORRELATION_ID
        )
      ).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
    });

    it("Making payment function is reverted if the revocation counter has reached the limit", async () => {
      const revocationCounterMax: number = 1;

      await proveTx(cardPaymentProcessor.setRevocationLimit(revocationCounterMax));
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(revocationCounterMax);

      for (let relocationCounter = 0; relocationCounter < revocationCounterMax; ++relocationCounter) {
        await makePayments([payments[0]]);
        await proveTx(
          cardPaymentProcessor.connect(executor).revokePayment(
            authorizationIds[0],
            CORRELATION_ID,
            PARENT_TRANSACTION_HASH
          )
        );
        payments[0].status = PaymentStatus.Revoked;
        payments[0].revocationCounter = relocationCounter + 1;
        await checkCardPaymentProcessorState(payments);
      }

      await expect(
        cardPaymentProcessor.connect(payments[0].account).makePayment(
          payments[0].amount,
          authorizationIds[0],
          CORRELATION_ID
        )
      ).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT
      );
    });

    it("All payment processing functions execute successfully if the payment amount is zero", async () => {
      payments.forEach(payment => payment.amount = 0);

      await makePayments(payments);
      await checkCardPaymentProcessorState(payments);

      await proveTx(cardPaymentProcessor.connect(executor).clearPayments(authorizationIds));
      payments.forEach(payment => payment.status = PaymentStatus.Cleared);
      await checkCardPaymentProcessorState(payments);

      await proveTx(cardPaymentProcessor.connect(executor).unclearPayments(authorizationIds));
      payments.forEach(payment => payment.status = PaymentStatus.Uncleared);
      await checkCardPaymentProcessorState(payments);

      await proveTx(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationIds[0],
          CORRELATION_ID,
          PARENT_TRANSACTION_HASH
        )
      );
      payments[0].status = PaymentStatus.Revoked;
      payments[0].revocationCounter = 1;
      await checkCardPaymentProcessorState(payments);

      await proveTx(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationIds[1],
          CORRELATION_ID,
          PARENT_TRANSACTION_HASH
        )
      );
      payments[1].status = PaymentStatus.Reversed;
      await checkCardPaymentProcessorState(payments);

      await makePayments([payments[0]]);
      await clearPayments([payments[0]]);

      const cashOutAccountBalanceBefore: BigNumber = await tokenMock.balanceOf(cashOutAccount.address);
      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
      await proveTx(
        cardPaymentProcessor.connect(executor).confirmPayments([authorizationIds[0]])
      );
      payments[0].status = PaymentStatus.Confirmed;
      const cashOutAccountBalanceAfter: BigNumber = await tokenMock.balanceOf(cashOutAccount.address);
      await checkCardPaymentProcessorState(payments);
      expect(cashOutAccountBalanceBefore).to.equal(cashOutAccountBalanceAfter);
    });
  });

  describe("Complex scenarios with cashback", async () => {
    let payment: TestPayment;
    let authorizationId: string;
    let correlationId: string;

    beforeEach(async () => {
      payment = {
        authorizationId: 12345,
        account: user1,
        amount: 23456,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 34567,
      };
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      correlationId = createBytesString(payment.makingPaymentCorrelationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(executor);
    });

    it("No cashback distributor contract's function are called if the cashback operations are disabled", async () => {
      const { cashbackDistributorMock } = await deployCashbackDistributorMock();
      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          authorizationId,
          correlationId
        )
      ).not.to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      );
      await expect(
        cardPaymentProcessor.connect(executor).revokePayment(
          authorizationId,
          correlationId,
          PARENT_TRANSACTION_HASH
        )
      ).not.to.emit(
        cashbackDistributorMock,
        "RevokeCashbackMock"
      );
      payment.revocationCounter = 1;
      await expect(
        cardPaymentProcessor.connect(executor).makePaymentFrom(
          payment.account.address,
          payment.amount,
          authorizationId,
          correlationId
        )
      ).not.to.emit(
        cashbackDistributorMock,
        "SendCashbackMock"
      );
      await expect(
        cardPaymentProcessor.connect(executor).reversePayment(
          authorizationId,
          correlationId,
          PARENT_TRANSACTION_HASH
        )
      ).not.to.emit(
        cashbackDistributorMock,
        "RevokeCashbackMock"
      );
    });

    it("Several refund operations execute as expected if cashback is enabled", async () => {
      const { cashbackDistributorMockConfig } = await setUpAndEnableCashback();
      payment.cashbackNonce = cashbackDistributorMockConfig.sendCashbackNonceResult;
      setCashbackRate(payment, CASHBACK_RATE_IN_PERMIL);
      await makePayments([payment]);
      await checkCardPaymentProcessorState([payment]);

      let refundAmount = 123;
      await proveTx(await cardPaymentProcessor.connect(executor).refundPayment(refundAmount, authorizationId));
      setRefundAmount(payment, refundAmount);
      await checkCardPaymentProcessorState([payment]);

      await clearPayments([payment]);
      await checkCardPaymentProcessorState([payment]);

      refundAmount = 234;
      await proveTx(await cardPaymentProcessor.connect(executor).refundPayment(refundAmount, authorizationId));
      setRefundAmount(payment, (payment.refundAmount || 0) + refundAmount);
      await checkCardPaymentProcessorState([payment]);

      await proveTx(cardPaymentProcessor.setCashOutAccount(cashOutAccount.address));
      await proveTx(
        cardPaymentProcessor.connect(executor).confirmPayment(authorizationId)
      );
      payment.status = PaymentStatus.Confirmed;
      await checkCardPaymentProcessorState([payment]);
      expect(
        await tokenMock.balanceOf(cashOutAccount.address)
      ).to.equal(payment.amount - (payment.refundAmount || 0));

      await proveTx(
        tokenMock.connect(cashOutAccount).approve(cardPaymentProcessor.address, ethers.constants.MaxUint256)
      );

      refundAmount = 345;
      await proveTx(await cardPaymentProcessor.connect(executor).refundPayment(refundAmount, authorizationId));
      setRefundAmount(payment, (payment.refundAmount || 0) + refundAmount);
      await checkCardPaymentProcessorState([payment]);
      expect(
        await tokenMock.balanceOf(cashOutAccount.address)
      ).to.equal(payment.amount - (payment.refundAmount || 0));

      refundAmount = payment.amount - (payment.refundAmount || 0); // The remaining payment amount
      await proveTx(await cardPaymentProcessor.connect(executor).refundPayment(refundAmount, authorizationId));
      setRefundAmount(payment, (payment.refundAmount || 0) + refundAmount);
      await checkCardPaymentProcessorState([payment]);
      expect(
        await tokenMock.balanceOf(cashOutAccount.address)
      ).to.equal(0);
    });
  });
});
