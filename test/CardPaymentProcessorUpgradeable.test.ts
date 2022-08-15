import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";

const BYTES16_LENGTH: number = 16;
const BYTES32_LENGTH: number = 32;
const ZERO_BYTES16_STRING: string = createBytesString("00", BYTES16_LENGTH);
const ZERO_BYTES32_STRING: string = createBytesString("00", BYTES32_LENGTH);
const SOME_BYTES16_STRING = createBytesString("ABCD", BYTES16_LENGTH);
const SOME_BYTES32_STRING = createBytesString("DCBA", BYTES32_LENGTH);

enum PaymentStatus {
  Nonexistent = 0,
  Uncleared = 1,
  Cleared = 2,
  Revoked = 3,
  Reversed = 4,
  Confirmed = 5,
}

interface TestPayment {
  authorizationId: number;
  account: SignerWithAddress;
  amount: number;
  status: PaymentStatus;
  revocationCounter?: number;
  makingPaymentCorrelationId: number;
  parentTxHash?: string;
}

interface CardPaymentProcessorState {
  tokenBalance: number;
  totalClearedBalance: number;
  totalUnclearedBalance: number;
  clearedBalancesPerAccount: Map<string, number>;
  unclearedBalancesPerAccount: Map<string, number>;
}

function checkEquality(
  actualOnChainPayment: any,
  expectedPayment: TestPayment,
  paymentIndex: number
) {
  if (expectedPayment.status == PaymentStatus.Nonexistent) {
    expect(actualOnChainPayment.account).to.equal(
      ethers.constants.AddressZero,
      `payment[${paymentIndex}].account is incorrect`
    );
    expect(actualOnChainPayment.amount).to.equal(
      0,
      `payment[${paymentIndex}].amount is incorrect`
    );
    expect(actualOnChainPayment.amount).to.equal(
      0,
      `payment[${paymentIndex}].status is incorrect`
    );
    expect(actualOnChainPayment.revocationCounter).to.equal(0);
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
  }
}

describe("Contract 'CardPaymentProcessorUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_PAYMENT_AMOUNT_IS_ZERO = "ZeroPaymentAmount";
  const REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO = "ZeroAuthorizationId";
  const REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS = "PaymentAlreadyExists";
  const REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST = "PaymentDoesNotExit";
  const REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED = "PaymentAlreadyCleared";
  const REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY = "EmptyAuthorizationIdsArray";
  const REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED = "PaymentAlreadyUncleared";
  const REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO = "ZeroParentTransactionHash";
  const REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_ZERO_ADDRESS = "ZeroCashOutAccount";
  const REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS = "InappropriatePaymentStatus";
  const REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT = "RevocationLimitReached";

  let cardPaymentProcessor: Contract;
  let tokenMock: Contract;
  let deployer: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let ownerRole: string;
  let pauserRole: string;
  let rescuerRole: string;
  let executorRole: string;

  async function setUpContractsForPayments(payments: TestPayment[]) {
    for (let payment of payments) {
      await proveTx(tokenMock.mint(payment.account.address, payment.amount));
      const allowance: BigNumber = await tokenMock.allowance(payment.account.address, cardPaymentProcessor.address);
      if (allowance.lt(BigNumber.from(ethers.constants.MaxUint256))) {
        await proveTx(tokenMock.connect(payment.account).approve(
          cardPaymentProcessor.address,
          ethers.constants.MaxUint256
        ));
      }
    }
  }

  async function makePayments(payments: TestPayment[]) {
    for (let payment of payments) {
      await proveTx(cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount,
        createBytesString(payment.authorizationId, BYTES16_LENGTH),
        createBytesString(payment.makingPaymentCorrelationId, BYTES16_LENGTH)
      ));
      payment.status = PaymentStatus.Uncleared;
    }
  }

  async function setExecutorRole(account: SignerWithAddress) {
    await proveTx(cardPaymentProcessor.grantRole(executorRole, account.address));
  }

  async function clearPayments(payments: TestPayment[], adminAccount: SignerWithAddress) {
    const authorizationIds: string[] = [];
    payments.forEach((payment: TestPayment) => {
      authorizationIds.push(createBytesString(payment.authorizationId, BYTES16_LENGTH));
      payment.status = PaymentStatus.Cleared;
    });
    await proveTx(cardPaymentProcessor.connect(adminAccount).clearPayments(authorizationIds));
  }

  function defineBalancesPerAccount(payments: TestPayment[], targetPaymentStatus: PaymentStatus): Map<string, number> {
    const balancesPerAccount: Map<string, number> = new Map<string, number>();

    payments.forEach((payment: TestPayment) => {
      const address: string = payment.account.address;
      let newBalance: number = balancesPerAccount.get(address) || 0;
      if (payment.status == targetPaymentStatus) {
        newBalance += payment.amount;
      }
      balancesPerAccount.set(address, newBalance);
    });

    return balancesPerAccount;
  }

  function defineExpectedCardPaymentProcessorState(payments: TestPayment[]): CardPaymentProcessorState {
    const tokenBalance: number = countNumberArrayTotal(
      payments.map(
        function (payment: TestPayment): number {
          return payment.status == PaymentStatus.Uncleared || payment.status == PaymentStatus.Cleared
            ? payment.amount
            : 0;
        }
      )
    );
    const totalClearedBalance: number = countNumberArrayTotal(
      payments.map(
        function (payment: TestPayment): number {
          return payment.status == PaymentStatus.Cleared ? payment.amount : 0;
        }
      )
    );
    const totalUnclearedBalance: number = countNumberArrayTotal(payments.map(
        function (payment: TestPayment): number {
          return payment.status == PaymentStatus.Uncleared ? payment.amount : 0;
        }
      )
    );
    const clearedBalancesPerAccount: Map<string, number> =
      defineBalancesPerAccount(payments, PaymentStatus.Cleared);
    const unclearedBalancesPerAccount: Map<string, number> =
      defineBalancesPerAccount(payments, PaymentStatus.Uncleared);

    return {
      tokenBalance,
      totalUnclearedBalance,
      totalClearedBalance,
      clearedBalancesPerAccount,
      unclearedBalancesPerAccount,
    };
  }

  async function checkPaymentStructuresOnBlockchain(payments: TestPayment[]) {
    for (let i = 0; i < payments.length; ++i) {
      const expectedPayment: TestPayment = payments[i];
      const actualPayment = await cardPaymentProcessor.paymentFor(
        createBytesString(expectedPayment.authorizationId, BYTES16_LENGTH)
      );
      checkEquality(actualPayment, expectedPayment, i);
      if (!!expectedPayment.parentTxHash) {
        expect(await cardPaymentProcessor.isPaymentReversed(expectedPayment.parentTxHash)).to.equal(
          expectedPayment.status == PaymentStatus.Reversed
        );
        expect(await cardPaymentProcessor.isPaymentRevoked(expectedPayment.parentTxHash)).to.equal(
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
        expect(await cardPaymentProcessor.clearedBalanceOf(account)).to.equal(
          expectedBalance,
          `The cleared balance for account ${account} is wrong`
        );
      } else {
        expect(await cardPaymentProcessor.unclearedBalanceOf(account)).to.equal(
          expectedBalance,
          `The uncleared balance for account ${account} is wrong`
        );
      }
    }
  }

  async function checkCardPaymentProcessorState(payments: TestPayment[]) {
    const expectedState: CardPaymentProcessorState = defineExpectedCardPaymentProcessorState(payments);
    await checkPaymentStructuresOnBlockchain(payments);
    await checkBalancesOnBlockchain(expectedState.clearedBalancesPerAccount, true);
    await checkBalancesOnBlockchain(expectedState.unclearedBalancesPerAccount, false);

    expect(await cardPaymentProcessor.totalClearedBalance()).to.equal(
      expectedState.totalClearedBalance,
      `The total cleared balance is wrong`
    );

    expect(await cardPaymentProcessor.totalUnclearedBalance()).to.equal(
      expectedState.totalUnclearedBalance,
      `The total uncleared balance is wrong`
    );

    expect(await tokenMock.balanceOf(cardPaymentProcessor.address)).to.equal(
      expectedState.tokenBalance,
      `The processor token balance is wrong`
    );
  }

  beforeEach(async () => {
    // Deploy the token mock contract
    const TokenMock: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    tokenMock = await upgrades.deployProxy(TokenMock, ["BRL Coin", "BRLC"]);
    await tokenMock.deployed();

    // Deploy the being tested contract
    const CardPaymentProcessor: ContractFactory = await ethers.getContractFactory("CardPaymentProcessorUpgradeable");
    cardPaymentProcessor = await upgrades.deployProxy(CardPaymentProcessor, [tokenMock.address]);
    await cardPaymentProcessor.deployed();

    // Get user accounts
    [deployer, user1, user2] = await ethers.getSigners();

    // Roles
    ownerRole = (await cardPaymentProcessor.OWNER_ROLE()).toLowerCase();
    pauserRole = (await cardPaymentProcessor.PAUSER_ROLE()).toLowerCase();
    rescuerRole = (await cardPaymentProcessor.RESCUER_ROLE()).toLowerCase();
    executorRole = (await cardPaymentProcessor.EXECUTOR_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(cardPaymentProcessor.initialize(tokenMock.address))
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The underlying contract address
    expect(await cardPaymentProcessor.underlyingToken()).to.equal(tokenMock.address);

    // The revocation limit
    expect(await cardPaymentProcessor.revocationLimit()).to.equal(255);

    // The role admins
    expect(await cardPaymentProcessor.getRoleAdmin(ownerRole)).to.equal(ownerRole);
    expect(await cardPaymentProcessor.getRoleAdmin(pauserRole)).to.equal(ownerRole);
    expect(await cardPaymentProcessor.getRoleAdmin(rescuerRole)).to.equal(ownerRole);
    expect(await cardPaymentProcessor.getRoleAdmin(executorRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await cardPaymentProcessor.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await cardPaymentProcessor.hasRole(pauserRole, deployer.address)).to.equal(false);
    expect(await cardPaymentProcessor.hasRole(rescuerRole, deployer.address)).to.equal(false);
    expect(await cardPaymentProcessor.hasRole(executorRole, deployer.address)).to.equal(false);
  });

  describe("Function 'setRevocationLimit()'", async () => {
    const revocationCounterNewValue: number = 123;
    const revocationLimitDefaultValue: number = 255;

    it("Is reverted if is called not by the account with the owner role", async () => {
      await expect(cardPaymentProcessor.connect(user1).setRevocationLimit(
        revocationCounterNewValue
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(user1.address, ownerRole));
    });

    it("Emits the correct event, changes the revocation counter limit properly", async () => {
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(revocationLimitDefaultValue);
      await expect(cardPaymentProcessor.setRevocationLimit(
        revocationCounterNewValue
      )).to.emit(
        cardPaymentProcessor,
        "SetRevocationLimit"
      ).withArgs(
        revocationLimitDefaultValue,
        revocationCounterNewValue
      );
    });

    it("Does not emit events if the new value equals the old one", async () => {
      await expect(cardPaymentProcessor.setRevocationLimit(
        revocationLimitDefaultValue
      )).not.to.emit(
        cardPaymentProcessor,
        "SetRevocationLimit"
      );
    });
  });

  describe("Function 'makePayment()'", async () => {
    let payment: TestPayment;
    let authorizationId: string;
    let correlationId: string;

    beforeEach(async () => {
      payment = {
        authorizationId: 123,
        account: user1,
        amount: 234,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 345,
      };
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      correlationId = createBytesString(payment.makingPaymentCorrelationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount,
        authorizationId,
        correlationId
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the payment token amount is zero", async () => {
      const zeroAmount: number = 0;
      await expect(cardPaymentProcessor.connect(payment.account).makePayment(
        zeroAmount,
        authorizationId,
        correlationId
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount,
        ZERO_BYTES16_STRING,
        correlationId
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the user has not enough token balance", async () => {
      const excessTokenAmount: number = payment.amount + 1;
      await expect(cardPaymentProcessor.connect(payment.account).makePayment(
        excessTokenAmount,
        authorizationId,
        correlationId
      )).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
    });

    it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
      await checkCardPaymentProcessorState([payment]);
      await expect(cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount,
        authorizationId,
        correlationId
      )).to.changeTokenBalances(
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
        payment.revocationCounter || 0
      );
      payment.status = PaymentStatus.Uncleared;
      await checkCardPaymentProcessorState([payment]);
    });

    it("Executes successfully even if the revocation limit of payments is zero", async () => {
      await proveTx(cardPaymentProcessor.setRevocationLimit(0));
      await expect(cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount,
        authorizationId,
        correlationId
      )).to.emit(
        cardPaymentProcessor,
        "MakePayment"
      );
    });

    it("Is reverted if the payment authorization ID already exists", async () => {
      await makePayments([payment]);
      const otherMakingPaymentCorrelationsId: string = createBytesString(
        payment.makingPaymentCorrelationId + 1,
        BYTES16_LENGTH
      );
      await expect(cardPaymentProcessor.connect(payment.account).makePayment(
        payment.amount + 1,
        authorizationId,
        otherMakingPaymentCorrelationsId
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
    });
  });

  describe("Function 'clearPayment()'", async () => {
    let payment: TestPayment;
    let admin: SignerWithAddress;
    let authorizationId: string;

    beforeEach(async () => {
      payment = {
        authorizationId: 123,
        account: user1,
        amount: 234,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 345,
      };
      admin = user2;
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(admin);
      await makePayments([payment]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).clearPayment(
        authorizationId
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).clearPayment(
        authorizationId
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).clearPayment(
        ZERO_BYTES16_STRING
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).clearPayment(
        createBytesString(payment.authorizationId + 1, BYTES16_LENGTH)
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Does not transfer tokens, emits the correct event, changes the state properly", async () => {
      await checkCardPaymentProcessorState([payment]);
      const expectedClearedBalance: number = payment.amount;
      const expectedUnclearedBalance: number = 0;
      await expect(cardPaymentProcessor.connect(admin).clearPayment(
        authorizationId
      )).to.changeTokenBalances(
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
      await proveTx(cardPaymentProcessor.connect(admin).clearPayment(
        authorizationId
      ));
      await expect(cardPaymentProcessor.connect(admin).clearPayment(
        authorizationId
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });
  });

  describe("Function 'clearPayments()'", async () => {
    let payments: TestPayment[];
    let admin: SignerWithAddress;
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
      admin = user2;
      authorizationIds = payments.map(
        (payment: TestPayment) => createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      accountAddresses = payments.map(
        (payment: TestPayment) => payment.account.address
      );
      expectedClearedBalances = payments.map((payment: TestPayment) => payment.amount);
      expectedUnclearedBalances = payments.map(() => 0);
      await setUpContractsForPayments(payments);
      await setExecutorRole(admin);
      await makePayments(payments);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).clearPayments(
        authorizationIds
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).clearPayments(
        authorizationIds
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      await expect(cardPaymentProcessor.connect(admin).clearPayments(
        []
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).clearPayments(
        [authorizationIds[0], ZERO_BYTES16_STRING]
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).clearPayments(
        [
          authorizationIds[0],
          createBytesString(payments[payments.length - 1].authorizationId + 1, BYTES16_LENGTH),
        ]
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments has been already cleared", async () => {
      await proveTx(cardPaymentProcessor.connect(admin).clearPayment(
        authorizationIds[0]
      ));
      await expect(cardPaymentProcessor.connect(admin).clearPayments(
        authorizationIds
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_CLEARED);
    });

    it("Does not transfer tokens, emits the correct events, changes the state properly", async () => {
      await checkCardPaymentProcessorState(payments);
      await expect(cardPaymentProcessor.connect(admin).clearPayments(
        authorizationIds
      )).to.changeTokenBalances(
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
      ).and.to.emit(
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
    let admin: SignerWithAddress;
    let authorizationId: string;

    beforeEach(async () => {
      payment = {
        authorizationId: 543,
        account: user1,
        amount: 432,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 321,
      };
      admin = user2;
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(admin);
      await makePayments([payment]);
      await clearPayments([payment], admin);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationId
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).unclearPayment(
        authorizationId
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).unclearPayment(
        ZERO_BYTES16_STRING
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).unclearPayment(
        createBytesString(payment.authorizationId + 1, BYTES16_LENGTH)
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Does not transfer tokens, emits the correct event, changes the state properly", async () => {
      await checkCardPaymentProcessorState([payment]);
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = payment.amount;
      await expect(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationId
      )).to.changeTokenBalances(
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
      await proveTx(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationId
      ));
      await expect(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationId
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });
  });

  describe("Function 'unclearPayments()'", async () => {
    let payments: TestPayment[];
    let admin: SignerWithAddress;
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
      admin = user2;
      authorizationIds = payments.map(
        (payment: TestPayment) => createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      accountAddresses = payments.map((payment: TestPayment) => payment.account.address);
      expectedClearedBalances = payments.map(() => 0);
      expectedUnclearedBalances = payments.map((payment: TestPayment) => payment.amount);
      await setUpContractsForPayments(payments);
      await setExecutorRole(admin);
      await makePayments(payments);
      await clearPayments(payments, admin);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).unclearPayments(
        authorizationIds
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).unclearPayments(
        authorizationIds
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      await expect(cardPaymentProcessor.connect(admin).unclearPayments(
        []
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).unclearPayments(
        [authorizationIds[0], ZERO_BYTES16_STRING]
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).unclearPayments(
        [
          authorizationIds[0],
          createBytesString(payments[payments.length - 1].authorizationId + 1, BYTES16_LENGTH)
        ]
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      await proveTx(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationIds[0]
      ));
      await expect(cardPaymentProcessor.connect(admin).unclearPayments(
        authorizationIds
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });

    it("Does not transfer tokens, emits the correct events, changes the state properly", async () => {
      await checkCardPaymentProcessorState(payments);
      await expect(cardPaymentProcessor.connect(admin).unclearPayments(
        authorizationIds
      )).to.changeTokenBalances(
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
      ).and.to.emit(
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
    const reversingPaymentCorrelationId: string = SOME_BYTES16_STRING;
    const parentTxHash: string = SOME_BYTES32_STRING;

    let payment: TestPayment;
    let authorizationId: string;
    let admin: SignerWithAddress;

    beforeEach(async () => {
      payment = {
        authorizationId: 987,
        account: user1,
        amount: 876,
        status: PaymentStatus.Nonexistent,
        revocationCounter: 0,
        makingPaymentCorrelationId: 765,
        parentTxHash: parentTxHash,
      };
      admin = user2;
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await makePayments([payment]);
      await setExecutorRole(admin);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).revokePayment(
        authorizationId,
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).revokePayment(
        authorizationId,
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the configured revocation limit of payments is zero", async () => {
      await proveTx(cardPaymentProcessor.setRevocationLimit(0));
      await expect(cardPaymentProcessor.connect(admin).revokePayment(
        authorizationId,
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT);
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).revokePayment(
        ZERO_BYTES16_STRING,
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the parent transaction hash is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).revokePayment(
        authorizationId,
        reversingPaymentCorrelationId,
        ZERO_BYTES32_STRING,
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).revokePayment(
        createBytesString(payment.authorizationId + 1, BYTES16_LENGTH),
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    describe("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = 0;
      const expectedRevocationCounter: number = 1;

      async function checkRevocation(wasPaymentCleared: boolean) {
        await checkCardPaymentProcessorState([payment]);
        await expect(cardPaymentProcessor.connect(admin).revokePayment(
          authorizationId,
          reversingPaymentCorrelationId,
          parentTxHash
        )).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-payment.amount, +payment.amount]
        ).and.to.emit(
          cardPaymentProcessor,
          "RevokePayment"
        ).withArgs(
          authorizationId,
          reversingPaymentCorrelationId,
          payment.account.address,
          payment.amount,
          expectedClearedBalance,
          expectedUnclearedBalance,
          wasPaymentCleared,
          parentTxHash,
          expectedRevocationCounter
        );
        payment.status = PaymentStatus.Revoked;
        payment.revocationCounter = expectedRevocationCounter;
        await checkCardPaymentProcessorState([payment]);
      }

      it("If payment is uncleared", async () => {
        const wasPaymentCleared: boolean = false;
        await checkRevocation(wasPaymentCleared);
      });

      it("If payment is cleared", async () => {
        const wasPaymentCleared: boolean = true;
        await clearPayments([payment], admin);
        await checkRevocation(wasPaymentCleared);
      });
    });
  });

  describe("Function 'reversePayment()'", async () => {
    const reversingPaymentCorrelationId: string = SOME_BYTES16_STRING;
    const parentTxHash: string = SOME_BYTES32_STRING;

    let payment: TestPayment;
    let authorizationId: string;
    let admin: SignerWithAddress;

    beforeEach(async () => {
      payment = {
        authorizationId: 876,
        account: user1,
        amount: 765,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 543,
        parentTxHash: parentTxHash,
      };
      admin = user2;
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await makePayments([payment]);
      await setExecutorRole(admin);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).reversePayment(
        authorizationId,
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).reversePayment(
        authorizationId,
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).reversePayment(
        ZERO_BYTES16_STRING,
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the parent transaction hash is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).reversePayment(
        authorizationId,
        reversingPaymentCorrelationId,
        ZERO_BYTES32_STRING,
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PARENT_TX_HASH_IS_ZERO);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).reversePayment(
        createBytesString(payment.authorizationId + 1, BYTES16_LENGTH),
        reversingPaymentCorrelationId,
        parentTxHash
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    describe("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
      const expectedClearedBalance: number = 0;
      const expectedUnclearedBalance: number = 0;

      async function checkReversion(wasPaymentCleared: boolean) {
        await checkCardPaymentProcessorState([payment]);
        await expect(cardPaymentProcessor.connect(admin).reversePayment(
          authorizationId,
          reversingPaymentCorrelationId,
          parentTxHash
        )).to.changeTokenBalances(
          tokenMock,
          [cardPaymentProcessor, payment.account],
          [-payment.amount, +payment.amount]
        ).and.to.emit(
          cardPaymentProcessor,
          "ReversePayment"
        ).withArgs(
          authorizationId,
          reversingPaymentCorrelationId,
          payment.account.address,
          payment.amount,
          expectedClearedBalance,
          expectedUnclearedBalance,
          wasPaymentCleared,
          parentTxHash,
          payment.revocationCounter || 0
        );
        payment.status = PaymentStatus.Reversed;
        await checkCardPaymentProcessorState([payment]);
      }

      it("If payment is uncleared", async () => {
        const wasPaymentCleared: boolean = false;
        await checkReversion(wasPaymentCleared);
      });

      it("If payment is cleared", async () => {
        const wasPaymentCleared: boolean = true;
        await clearPayments([payment], admin);
        await checkReversion(wasPaymentCleared);
      });
    });
  });

  describe("Function 'confirmPayment()'", async () => {
    let payment: TestPayment;
    let authorizationId: string;
    let admin: SignerWithAddress;
    let cashOutAccount: SignerWithAddress;

    beforeEach(async () => {
      payment = {
        authorizationId: 123,
        account: user1,
        amount: 234,
        status: PaymentStatus.Nonexistent,
        makingPaymentCorrelationId: 345,
      };
      admin = user2;
      cashOutAccount = deployer;
      authorizationId = createBytesString(payment.authorizationId, BYTES16_LENGTH);
      await setUpContractsForPayments([payment]);
      await setExecutorRole(admin);
      await makePayments([payment]);
      await clearPayments([payment], admin);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).confirmPayment(
        authorizationId,
        cashOutAccount.address
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).confirmPayment(
        authorizationId,
        cashOutAccount.address
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization ID is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).confirmPayment(
        ZERO_BYTES16_STRING,
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if the input cash out account is the zero address", async () => {
      await expect(cardPaymentProcessor.connect(admin).confirmPayment(
        authorizationId,
        ethers.constants.AddressZero
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_ZERO_ADDRESS);
    });

    it("Is reverted if the payment with the provided authorization ID does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).confirmPayment(
        createBytesString(payment.authorizationId + 1, BYTES16_LENGTH),
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if the payment is uncleared", async () => {
      await proveTx(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationId
      ));
      await expect(cardPaymentProcessor.connect(admin).confirmPayment(
        authorizationId,
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });

    it("Transfers tokens as expected, emits the correct event, changes the state properly", async () => {
      await checkCardPaymentProcessorState([payment]);
      const expectedClearedBalance: number = 0;
      await expect(cardPaymentProcessor.connect(admin).confirmPayment(
        authorizationId,
        cashOutAccount.address
      )).to.changeTokenBalances(
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
    let admin: SignerWithAddress;
    let cashOutAccount: SignerWithAddress;
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
      admin = user2;
      cashOutAccount = deployer;
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
      await setExecutorRole(admin);
      await makePayments(payments);
      await clearPayments(payments, admin);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cardPaymentProcessor.grantRole(pauserRole, deployer.address));
      await proveTx(cardPaymentProcessor.pause());
      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        authorizationIds,
        cashOutAccount.address
      )).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the executor role", async () => {
      await expect(cardPaymentProcessor.connect(deployer).confirmPayments(
        authorizationIds,
        cashOutAccount.address
      )).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, executorRole));
    });

    it("Is reverted if the payment authorization IDs array is empty", async () => {
      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        [],
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_INPUT_ARRAY_OF_AUTHORIZATION_IDS_IS_EMPTY);
    });

    it("Is reverted if the input cash out account is the zero address", async () => {
      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        authorizationIds,
        ethers.constants.AddressZero
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_CASH_OUT_ACCOUNT_IS_ZERO_ADDRESS);
    });

    it("Is reverted if one of the payment authorization IDs is zero", async () => {
      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        [authorizationIds[0], ZERO_BYTES16_STRING],
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_AUTHORIZATION_ID_IS_ZERO);
    });

    it("Is reverted if one of the payments with provided authorization IDs does not exist", async () => {
      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        [
          authorizationIds[0],
          createBytesString(payments[payments.length - 1].authorizationId + 1, BYTES16_LENGTH)
        ],
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_DOES_NOT_EXIST);
    });

    it("Is reverted if one of the payments is uncleared", async () => {
      await proveTx(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationIds[1]
      ));
      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        authorizationIds,
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_IS_ALREADY_UNCLEARED);
    });

    it("Transfer tokens, emits the correct events, changes the state properly", async () => {
      const expectedClearedBalance: number = 0;
      await checkCardPaymentProcessorState(payments);
      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        authorizationIds,
        cashOutAccount.address
      )).to.changeTokenBalances(
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
      ).and.to.emit(
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

  describe("Complex scenarios", async () => {
    const someCorrelationId: string = SOME_BYTES16_STRING;
    const someParentTxHash: string = SOME_BYTES32_STRING;

    let payments: TestPayment[];
    let admin: SignerWithAddress;
    let cashOutAccount: SignerWithAddress;
    let authorizationIds: string[];

    async function checkRevertingOfAllPaymentProcessingFunctionsExceptMaking() {
      await expect(cardPaymentProcessor.connect(admin).clearPayment(
        authorizationIds[0],
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(cardPaymentProcessor.connect(admin).clearPayments(
        authorizationIds,
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(cardPaymentProcessor.connect(admin).unclearPayment(
        authorizationIds[0],
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(cardPaymentProcessor.connect(admin).unclearPayments(
        authorizationIds,
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(cardPaymentProcessor.connect(admin).revokePayment(
        authorizationIds[0],
        someCorrelationId,
        someParentTxHash
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(cardPaymentProcessor.connect(admin).reversePayment(
        authorizationIds[0],
        someCorrelationId,
        someParentTxHash
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(cardPaymentProcessor.connect(admin).confirmPayment(
        authorizationIds[0],
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);

      await expect(cardPaymentProcessor.connect(admin).confirmPayments(
        authorizationIds,
        cashOutAccount.address
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_HAS_INAPPROPRIATE_STATUS);
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
      admin = user2;
      cashOutAccount = deployer;
      authorizationIds = payments.map(
        (payment: TestPayment) => createBytesString(payment.authorizationId, BYTES16_LENGTH)
      );
      await setUpContractsForPayments(payments);
      await setExecutorRole(admin);
    });

    it("All payment processing functions except making are reverted if a payment was revoked", async () => {
      await makePayments(payments);
      await proveTx(cardPaymentProcessor.connect(admin).revokePayment(
        authorizationIds[0],
        someCorrelationId,
        someParentTxHash
      ));
      payments[0].status = PaymentStatus.Revoked;
      payments[0].revocationCounter = 1;

      await checkCardPaymentProcessorState(payments);
      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking();

      await expect(cardPaymentProcessor.connect(payments[0].account).makePayment(
        payments[0].amount,
        authorizationIds[0],
        someCorrelationId,
      )).to.changeTokenBalances(
        tokenMock,
        [cardPaymentProcessor, payments[0].account],
        [+payments[0].amount, -payments[0].amount]
      ).and.to.emit(
        cardPaymentProcessor,
        "MakePayment"
      ).withArgs(
        authorizationIds[0],
        someCorrelationId,
        payments[0].account.address,
        payments[0].amount,
        payments[0].revocationCounter || 0
      );
      payments[0].status = PaymentStatus.Uncleared;

      await checkCardPaymentProcessorState(payments);
    });

    it("All payment processing functions are reverted if a payment was reversed", async () => {
      await makePayments(payments);
      await proveTx(cardPaymentProcessor.connect(admin).reversePayment(
        authorizationIds[0],
        someCorrelationId,
        someParentTxHash
      ));
      payments[0].status = PaymentStatus.Reversed;

      await expect(cardPaymentProcessor.makePayment(
        payments[0].amount,
        authorizationIds[0],
        createBytesString(payments[0].makingPaymentCorrelationId, BYTES16_LENGTH)
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking();
      await checkCardPaymentProcessorState(payments);
    });

    it("All payment processing functions are reverted if a payment was confirmed", async () => {
      await makePayments(payments);
      await clearPayments(payments, admin);
      await proveTx(cardPaymentProcessor.connect(admin).confirmPayment(authorizationIds[0], cashOutAccount.address));
      payments[0].status = PaymentStatus.Confirmed;

      await expect(cardPaymentProcessor.makePayment(
        payments[0].amount,
        authorizationIds[0],
        createBytesString(payments[0].makingPaymentCorrelationId, BYTES16_LENGTH)
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);

      await checkRevertingOfAllPaymentProcessingFunctionsExceptMaking();
      await checkCardPaymentProcessorState(payments);
    });

    it("Making payment function is reverted if the payment has the 'Cleared' status", async () => {
      await makePayments([payments[0]]);
      await clearPayments([payments[0]], admin);

      await expect(cardPaymentProcessor.connect(payments[0].account).makePayment(
        payments[0].amount,
        authorizationIds[0],
        someCorrelationId
      )).to.be.revertedWithCustomError(cardPaymentProcessor, REVERT_ERROR_IF_PAYMENT_ALREADY_EXISTS);
    });

    it("Making payment function is reverted if the revocation counter has reached the limit", async () => {
      const revocationCounterMax: number = 1;

      await proveTx(cardPaymentProcessor.setRevocationLimit(revocationCounterMax));
      expect(await cardPaymentProcessor.revocationLimit()).to.equal(revocationCounterMax);

      for (let relocationCounter = 0; relocationCounter < revocationCounterMax; ++relocationCounter) {
        await makePayments([payments[0]]);
        await proveTx(cardPaymentProcessor.connect(admin).revokePayment(
          authorizationIds[0],
          someCorrelationId,
          someParentTxHash
        ));
        payments[0].status = PaymentStatus.Revoked;
        payments[0].revocationCounter = relocationCounter + 1;
        await checkCardPaymentProcessorState(payments);
      }
      await expect(cardPaymentProcessor.connect(payments[0].account).makePayment(
        payments[0].amount,
        authorizationIds[0],
        someCorrelationId
      )).to.be.revertedWithCustomError(
        cardPaymentProcessor,
        REVERT_ERROR_IF_PAYMENT_REVOCATION_COUNTER_REACHED_LIMIT
      );
    });
  });
});
