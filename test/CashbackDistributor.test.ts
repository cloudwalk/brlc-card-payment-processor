import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Block, Contract, ContractFactory, TransactionReceipt } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, getAddress, increaseBlockTimestamp, proveTx } from "../test-utils/eth";
import { createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { checkEquality as checkInterfaceEquality } from "../test-utils/checkers";
import { setUpFixture } from "../test-utils/common";

const MAX_UINT256 = ethers.MaxUint256;
const MAX_INT256 = ethers.MaxInt256;
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_HASH = ethers.ZeroHash;
const BYTES32_LENGTH: number = 32;

enum CashbackStatus {
  Nonexistent = 0,
  Success = 1,
  Blocklisted = 2,
  OutOfFunds = 3,
  Disabled = 4,
  Revoked = 5,
  Capped = 6,
  Partial = 7
}

enum IncreaseStatus {
  Nonexistent = 0,
  Success = 1,
  Blocklisted = 2,
  OutOfFunds = 3,
  Disabled = 4,
  Inapplicable = 5,
  Capped = 6,
  Partial = 7
}

enum RevocationStatus {
  Success = 1,
  Inapplicable = 2,
  OutOfFunds = 3,
  OutOfAllowance = 4,
  OutOfBalance = 5
}

enum CashbackKind {
  Manual = 0,
  CardPayment = 1
}

interface TestCashback {
  token: Contract;
  kind: CashbackKind;
  status: CashbackStatus;
  externalId: string;
  recipient: HardhatEthersSigner;
  requestedAmount: number;
  sentAmount: number;
  sender: HardhatEthersSigner;
  nonce: number;
  revokedAmount?: number;
  increaseRequestedAmount?: number;
  increaseSentAmount?: number;
}

interface Fixture {
  cashbackDistributor: Contract;
  tokenMocks: Contract[];
}

interface TestContext {
  fixture: Fixture;
  cashbacks: TestCashback[];
  cashbackDistributorInitialBalanceByToken: Map<Contract, number>;
}

interface Version {
  major: number;
  minor: number;
  patch: number;

  [key: string]: number; // Indexing signature to ensure that fields are iterated over in a key-value style
}

function checkNonexistentCashback(
  actualOnChainCashback: Record<string, unknown>,
  cashbackNonce: number
) {
  expect(actualOnChainCashback.token).to.equal(
    ZERO_ADDRESS,
    `cashback[${cashbackNonce}].token is incorrect`
  );
  expect(actualOnChainCashback.kind).to.equal(
    CashbackKind.Manual,
    `cashback[${cashbackNonce}].account is incorrect`
  );
  expect(actualOnChainCashback.status).to.equal(
    CashbackStatus.Nonexistent,
    `cashback[${cashbackNonce}].status is incorrect`
  );
  expect(actualOnChainCashback.externalId).to.equal(
    ZERO_HASH,
    `cashback[${cashbackNonce}].externalId is incorrect`
  );
  expect(actualOnChainCashback.recipient).to.equal(
    ZERO_ADDRESS,
    `cashback[${cashbackNonce}].recipient is incorrect`
  );
  expect(actualOnChainCashback.amount).to.equal(
    0,
    `cashback[${cashbackNonce}].amount is incorrect`
  );
  expect(actualOnChainCashback.sender).to.equal(
    ZERO_ADDRESS,
    `cashback[${cashbackNonce}].sender is incorrect`
  );
  expect(actualOnChainCashback.revokedAmount).to.equal(
    0,
    `cashback[${cashbackNonce}].revokedAmount is incorrect`
  );
}

function checkEquality(
  actualOnChainCashback: Record<string, unknown>,
  expectedCashback: TestCashback
) {
  if (expectedCashback.status == CashbackStatus.Nonexistent) {
    checkNonexistentCashback(actualOnChainCashback, expectedCashback.nonce);
  } else {
    expect(actualOnChainCashback.token).to.equal(
      getAddress(expectedCashback.token),
      `cashback[${expectedCashback.nonce - 1}].token is incorrect`
    );
    expect(actualOnChainCashback.kind).to.equal(
      expectedCashback.kind,
      `cashback[${expectedCashback.nonce - 1}].account is incorrect`
    );
    expect(actualOnChainCashback.status).to.equal(
      expectedCashback.status,
      `cashback[${expectedCashback.nonce - 1}].status is incorrect`
    );
    expect(actualOnChainCashback.externalId).to.equal(
      expectedCashback.externalId,
      `cashback[${expectedCashback.nonce - 1}].externalId is incorrect`
    );
    expect(actualOnChainCashback.recipient).to.equal(
      expectedCashback.recipient.address,
      `cashback[${expectedCashback.nonce - 1}].recipient is incorrect`
    );
    if (actualOnChainCashback.status != CashbackStatus.Partial) {
      expect(actualOnChainCashback.amount).to.equal(
        expectedCashback.requestedAmount,
        `cashback[${expectedCashback.nonce - 1}].amount is incorrect`
      );
    } else {
      expect(actualOnChainCashback.amount).to.equal(
        expectedCashback.sentAmount,
        `cashback[${expectedCashback.nonce - 1}].amount is incorrect`
      );
    }
    expect(actualOnChainCashback.sender).to.equal(
      expectedCashback.sender.address,
      `cashback[${expectedCashback.nonce - 1}].sender is incorrect`
    );
    expect(actualOnChainCashback.revokedAmount).to.equal(
      expectedCashback.revokedAmount || 0,
      `cashback[${expectedCashback.nonce - 1}].revokedAmount is incorrect`
    );
  }
}

describe("Contract 'CashbackDistributor'", async () => {
  const CASHBACK_EXTERNAL_ID_STUB1 = createBytesString("01", BYTES32_LENGTH);
  const CASHBACK_EXTERNAL_ID_STUB2 = createBytesString("02", BYTES32_LENGTH);
  const TOKEN_ADDRESS_STUB = "0x0000000000000000000000000000000000000001";
  const CASHBACK_RESET_PERIOD = 30 * 24 * 60 * 60;
  const MAX_CASHBACK_FOR_PERIOD = 300 * 10 ** 6;
  const EXPECTED_VERSION: Version = {
    major: 1,
    minor: 1,
    patch: 0
  };

  // Events of the contract under test
  const EVENT_NAME_ENABLE = "Enable";
  const EVENT_NAME_DISABLE = "Disable";
  const EVENT_NAME_INCREASE_CASHBACK = "IncreaseCashback";
  const EVENT_NAME_REVOKE_CASHBACK = "RevokeCashback";
  const EVENT_NAME_SEND_CASHBACK = "SendCashback";

  // Error messages of the lib contracts
  const ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const ERROR_MESSAGE_PAUSABLE_PAUSED = "Pausable: paused";

  // Errors of the contract under test
  const ERROR_NAME_CASHBACK_ALREADY_DISABLED = "CashbackAlreadyDisabled";
  const ERROR_NAME_CASHBACK_ALREADY_ENABLED = "CashbackAlreadyEnabled";
  const ERROR_NAME_ZERO_EXTERNAL_ID = "ZeroExternalId";
  const ERROR_NAME_ZERO_RECIPIENT_ADDRESS = "ZeroRecipientAddress";
  const ERROR_NAME_ZERO_TOKEN_ADDRESS = "ZeroTokenAddress";

  const ownerRole: string = ethers.id("OWNER_ROLE");
  const grantorRole: string = ethers.id("GRANTOR_ROLE");
  const blocklisterRole: string = ethers.id("BLOCKLISTER_ROLE");
  const pauserRole: string = ethers.id("PAUSER_ROLE");
  const rescuerRole: string = ethers.id("RESCUER_ROLE");
  const distributorRole: string = ethers.id("DISTRIBUTOR_ROLE");

  let cashbackDistributorFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: HardhatEthersSigner;
  let distributor: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  before(async () => {
    [deployer, distributor, user] = await ethers.getSigners();

    // Contract factories with the explicitly specified deployer account
    cashbackDistributorFactory = await ethers.getContractFactory("CashbackDistributor");
    cashbackDistributorFactory = cashbackDistributorFactory.connect(deployer);
    tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");
    tokenMockFactory = tokenMockFactory.connect(deployer);
  });

  async function deployTokenMock(nameSuffix: string): Promise<Contract> {
    const name = "ERC20 Test" + nameSuffix;
    const symbol = "TEST" + nameSuffix;

    let tokenMock = await upgrades.deployProxy(tokenMockFactory, [name, symbol]) as Contract;
    await tokenMock.waitForDeployment();
    tokenMock = connect(tokenMock, deployer); // Explicitly specifying the initial account

    return tokenMock;
  }

  async function deployCashbackDistributor(): Promise<{ cashbackDistributor: Contract }> {
    let cashbackDistributor = await upgrades.deployProxy(cashbackDistributorFactory) as Contract;
    await cashbackDistributor.waitForDeployment();
    cashbackDistributor = connect(cashbackDistributor, deployer);

    return { cashbackDistributor };
  }

  async function deployAndConfigureAllContracts(): Promise<Fixture> {
    const { cashbackDistributor } = await deployCashbackDistributor();
    const tokenMock1 = await deployTokenMock("1");
    const tokenMock2 = await deployTokenMock("2");

    await proveTx(cashbackDistributor.grantRole(grantorRole, deployer.address));
    await proveTx(cashbackDistributor.grantRole(blocklisterRole, deployer.address));
    await proveTx(cashbackDistributor.grantRole(distributorRole, distributor.address));
    await proveTx(cashbackDistributor.enable());

    return {
      cashbackDistributor,
      tokenMocks: [tokenMock1, tokenMock2]
    };
  }

  async function setUpContractsForSendingCashbacks(
    cashbackDistributorAddress: Contract,
    cashbacks: TestCashback[]
  ): Promise<{ cashbackDistributorInitialBalanceByToken: Map<Contract, number> }> {
    const cashbackDistributorInitialBalanceByToken: Map<Contract, number> = new Map<Contract, number>();
    cashbacks.forEach(cashback => {
      let totalCashbackAmount: number = cashbackDistributorInitialBalanceByToken.get(cashback.token) || 0;
      totalCashbackAmount += cashback.requestedAmount;
      cashbackDistributorInitialBalanceByToken.set(cashback.token, totalCashbackAmount);
    });
    for (const [token, totalCashbackAmount] of cashbackDistributorInitialBalanceByToken.entries()) {
      await proveTx(token.mint(cashbackDistributorAddress, totalCashbackAmount));
    }
    return { cashbackDistributorInitialBalanceByToken };
  }

  async function pauseContract(contract: Contract) {
    await proveTx(contract.grantRole(grantorRole, deployer.address));
    await proveTx(contract.grantRole(pauserRole, deployer.address));
    await proveTx(contract.pause());
  }

  async function sendCashbacks(
    cashbackDistributor: Contract,
    cashbacks: TestCashback[],
    targetStatus: CashbackStatus
  ): Promise<TransactionReceipt[]> {
    const transactionReceipts: TransactionReceipt[] = [];
    for (const cashback of cashbacks) {
      const transactionReceipt = await proveTx(
        connect(cashbackDistributor, cashback.sender).sendCashback(
          getAddress(cashback.token),
          cashback.kind,
          cashback.externalId,
          cashback.recipient.address,
          cashback.requestedAmount
        )
      );
      transactionReceipts.push(transactionReceipt);
      expect(
        (await cashbackDistributor.getCashback(cashback.nonce)).status
      ).to.equal(
        targetStatus,
        `The sent cashback has unexpected status. The cashback nonce = ${cashback.nonce}`
      );
      cashback.status = targetStatus;
      if (targetStatus == CashbackStatus.Success) {
        cashback.sentAmount = cashback.requestedAmount;
      }
    }
    return transactionReceipts;
  }

  async function revokeCashback(cashbackDistributor: Contract, cashback: TestCashback, amount: number) {
    cashback.revokedAmount = amount + (cashback.revokedAmount || 0);

    await expect(connect(cashbackDistributor, distributor).revokeCashback(cashback.nonce, amount))
      .to.emit(cashbackDistributor, EVENT_NAME_REVOKE_CASHBACK)
      .withArgs(
        anyValue,
        anyValue,
        anyValue,
        RevocationStatus.Success,
        anyValue,
        anyValue,
        anyValue,
        cashback.sentAmount - (cashback.revokedAmount ?? 0), // totalAmount
        anyValue,
        anyValue
      );
  }

  async function increaseCashback(cashbackDistributor: Contract, cashback: TestCashback, amount: number) {
    cashback.requestedAmount += amount;
    cashback.sentAmount += amount;

    await expect(connect(cashbackDistributor, distributor).increaseCashback(cashback.nonce, amount))
      .to.emit(cashbackDistributor, EVENT_NAME_INCREASE_CASHBACK)
      .withArgs(
        anyValue,
        anyValue,
        anyValue,
        IncreaseStatus.Success,
        anyValue,
        anyValue,
        anyValue,
        cashback.sentAmount - (cashback.revokedAmount ?? 0), // totalAmount
        anyValue,
        anyValue
      );
  }

  async function checkCashbackStructures(context: TestContext) {
    const { fixture: { cashbackDistributor }, cashbacks } = context;
    // The cashback structure with the zero nonce must be always nonexistent one.
    checkNonexistentCashback(await cashbackDistributor.getCashback(0), 0);

    // Check other structures
    for (const cashback of cashbacks) {
      const actualCashback = await cashbackDistributor.getCashback(cashback.nonce);
      checkEquality(actualCashback, cashback);
    }

    // Check the cashback structure after the last expected one. It must be nonexistent one.
    if (cashbacks.length > 0) {
      checkNonexistentCashback(await cashbackDistributor.getCashback(0), cashbacks[cashbacks.length - 1].nonce);
    }
  }

  async function checkCashbackNonceByExternalId(context: TestContext) {
    const { fixture: { cashbackDistributor }, cashbacks } = context;
    const expectedMap = new Map<string, bigint[]>();

    cashbacks.forEach(cashback => {
      const nonces: bigint[] = expectedMap.get(cashback.externalId) || [];
      nonces.push(BigInt(cashback.nonce));
      expectedMap.set(cashback.externalId, nonces);
    });

    for (const [externalId, expectedNonces] of expectedMap) {
      expect(await cashbackDistributor.getCashbackNonces(externalId, 0, 50)).to.deep.equal(
        expectedNonces,
        `Wrong array of nonces for the external ID ${externalId}`
      );
    }
  }

  async function checkTotalCashbackByTokenAndExternalId(context: TestContext) {
    const { fixture: { cashbackDistributor }, cashbacks } = context;
    const expectedMap = new Map<Contract, Map<string, number>>();

    cashbacks.forEach(cashback => {
      const totalCashbackMap: Map<string, number> = expectedMap.get(cashback.token) || new Map<string, number>();
      let totalCashback: number = totalCashbackMap.get(cashback.externalId) || 0;
      totalCashback += cashback.sentAmount - (cashback.revokedAmount || 0);
      totalCashbackMap.set(cashback.externalId, totalCashback);
      expectedMap.set(cashback.token, totalCashbackMap);
    });

    for (const [token, expectedTotalCashbackByExternalId] of expectedMap) {
      for (const [externalId, expectedTotalCashback] of expectedTotalCashbackByExternalId) {
        expect(
          await cashbackDistributor.getTotalCashbackByTokenAndExternalId(getAddress(token), externalId)
        ).to.equal(
          expectedTotalCashback,
          `Wrong total cashback for the token with symbol ${await token.symbol()} and external ID ${externalId}`
        );
      }
    }
  }

  async function checkTotalCashbackByTokenAndRecipient(context: TestContext) {
    const { fixture: { cashbackDistributor }, cashbacks } = context;
    const expectedMap = new Map<Contract, Map<string, number>>();

    cashbacks.forEach(cashback => {
      const recipientAddress: string = cashback.recipient.address;
      const totalCashbackMap: Map<string, number> = expectedMap.get(cashback.token) || new Map<string, number>();
      let totalCashback: number = totalCashbackMap.get(recipientAddress) || 0;
      totalCashback += cashback.sentAmount - (cashback.revokedAmount || 0);
      totalCashbackMap.set(recipientAddress, totalCashback);
      expectedMap.set(cashback.token, totalCashbackMap);
    });

    for (const [token, expectedTotalCashbackByRecipient] of expectedMap) {
      const tokenSymbol: string = await token.symbol();
      for (const [recipientAddress, expectedTotalCashback] of expectedTotalCashbackByRecipient) {
        expect(
          await cashbackDistributor.getTotalCashbackByTokenAndRecipient(getAddress(token), recipientAddress)
        ).to.equal(
          expectedTotalCashback,
          `Wrong total cashback for the token with symbol "${tokenSymbol}" and recipient address ${recipientAddress}`
        );
      }
    }
  }

  async function checkCashbackDistributorBalanceByTokens(context: TestContext) {
    const {
      fixture: { cashbackDistributor },
      cashbacks,
      cashbackDistributorInitialBalanceByToken
    } = context;
    const expectedMap = new Map<Contract, number>();

    cashbacks.forEach(cashback => {
      let balance: number =
        expectedMap.get(cashback.token) ?? (cashbackDistributorInitialBalanceByToken.get(cashback.token) || 0);
      balance -= cashback.sentAmount - (cashback.revokedAmount || 0);
      expectedMap.set(cashback.token, balance);
    });

    for (const [token, expectedBalance] of expectedMap) {
      const tokenSymbol: string = await token.symbol();
      expect(await token.balanceOf(getAddress(cashbackDistributor))).to.equal(
        expectedBalance,
        `Wrong balance of the cashback distributor for token address with symbol "${tokenSymbol}"`
      );
    }
  }

  async function checkCashbackDistributorState(context: TestContext) {
    await checkCashbackStructures(context);
    await checkCashbackNonceByExternalId(context);
    await checkTotalCashbackByTokenAndExternalId(context);
    await checkTotalCashbackByTokenAndRecipient(context);
    await checkCashbackDistributorBalanceByTokens(context);
  }

  async function prepareForSingleCashback(
    cashbackRequestedAmount?: number
  ): Promise<{ fixture: Fixture; cashback: TestCashback }> {
    const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
    const cashback: TestCashback = {
      token: tokenMockFactory.attach(TOKEN_ADDRESS_STUB) as Contract,
      kind: CashbackKind.CardPayment,
      status: CashbackStatus.Nonexistent,
      externalId: CASHBACK_EXTERNAL_ID_STUB1,
      recipient: user,
      requestedAmount: cashbackRequestedAmount || 123,
      sentAmount: 0,
      revokedAmount: 0,
      sender: distributor,
      nonce: 1
    };
    cashback.token = fixture.tokenMocks[0];

    return { fixture, cashback };
  }

  async function beforeSendingCashback(options?: { cashbackRequestedAmount?: number }): Promise<TestContext> {
    const { fixture, cashback } = await prepareForSingleCashback(options?.cashbackRequestedAmount);
    const { cashbackDistributorInitialBalanceByToken } = await setUpContractsForSendingCashbacks(
      fixture.cashbackDistributor,
      [cashback]
    );

    return { fixture, cashbacks: [cashback], cashbackDistributorInitialBalanceByToken };
  }

  describe("Function 'initialize()'", async () => {
    it("Configures the contract as expected", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);

      // The role hashes
      expect(await cashbackDistributor.OWNER_ROLE()).to.equal(ownerRole);
      expect(await cashbackDistributor.GRANTOR_ROLE()).to.equal(grantorRole);
      expect(await cashbackDistributor.BLOCKLISTER_ROLE()).to.equal(blocklisterRole);
      expect(await cashbackDistributor.PAUSER_ROLE()).to.equal(pauserRole);
      expect(await cashbackDistributor.RESCUER_ROLE()).to.equal(rescuerRole);
      expect(await cashbackDistributor.DISTRIBUTOR_ROLE()).to.equal(distributorRole);

      // The admins of roles
      expect(await cashbackDistributor.getRoleAdmin(ownerRole)).to.equal(ownerRole);
      expect(await cashbackDistributor.getRoleAdmin(grantorRole)).to.equal(ownerRole);
      expect(await cashbackDistributor.getRoleAdmin(blocklisterRole)).to.equal(grantorRole);
      expect(await cashbackDistributor.getRoleAdmin(pauserRole)).to.equal(grantorRole);
      expect(await cashbackDistributor.getRoleAdmin(rescuerRole)).to.equal(grantorRole);
      expect(await cashbackDistributor.getRoleAdmin(distributorRole)).to.equal(grantorRole);

      // The deployer should have the owner role, but not the other roles
      expect(await cashbackDistributor.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await cashbackDistributor.hasRole(grantorRole, deployer.address)).to.equal(false);
      expect(await cashbackDistributor.hasRole(blocklisterRole, deployer.address)).to.equal(false);
      expect(await cashbackDistributor.hasRole(pauserRole, deployer.address)).to.equal(false);
      expect(await cashbackDistributor.hasRole(rescuerRole, deployer.address)).to.equal(false);
      expect(await cashbackDistributor.hasRole(distributorRole, deployer.address)).to.equal(false);

      // The initial contract state is unpaused
      expect(await cashbackDistributor.paused()).to.equal(false);

      // Cashback related values
      expect(await cashbackDistributor.enabled()).to.equal(false);
      expect(await cashbackDistributor.nextNonce()).to.equal(1);
      const cashbackDistributorInitialBalanceByToken = new Map<Contract, number>();
      const fixture: Fixture = { cashbackDistributor, tokenMocks: [] };
      await checkCashbackDistributorState({ fixture, cashbacks: [], cashbackDistributorInitialBalanceByToken });
      expect(await cashbackDistributor.CASHBACK_RESET_PERIOD()).to.equal(CASHBACK_RESET_PERIOD);
      expect(await cashbackDistributor.MAX_CASHBACK_FOR_PERIOD()).to.equal(MAX_CASHBACK_FOR_PERIOD);
    });

    it("Is reverted if it is called a second time", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        cashbackDistributor.initialize()
      ).to.be.revertedWith(ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("Is reverted for the contract implementation if it is called even for the first time", async () => {
      const cashierImplementation = await cashbackDistributorFactory.deploy() as Contract;
      await cashierImplementation.waitForDeployment();

      await expect(cashierImplementation.initialize())
        .to.be.revertedWith(ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED);
    });
  });

  describe("Function '$__VERSION()'", async () => {
    it("Returns expected values", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      const cashbackDistributorVersion = await cashbackDistributor.$__VERSION();
      checkInterfaceEquality(cashbackDistributorVersion, EXPECTED_VERSION);
    });
  });

  describe("Function 'enable()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);

      await expect(cashbackDistributor.enable())
        .to.emit(cashbackDistributor, EVENT_NAME_ENABLE)
        .withArgs(deployer.address);
      expect(await cashbackDistributor.enabled()).to.equal(true);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        connect(cashbackDistributor, user).enable()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user.address, ownerRole));
    });

    it("Is reverted if cashback operations are already enabled", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await proveTx(cashbackDistributor.enable());
      await expect(
        cashbackDistributor.enable()
      ).to.be.revertedWithCustomError(cashbackDistributor, ERROR_NAME_CASHBACK_ALREADY_ENABLED);
    });
  });

  describe("Function 'disable()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await proveTx(cashbackDistributor.enable());
      expect(await cashbackDistributor.enabled()).to.equal(true);

      await expect(cashbackDistributor.disable())
        .to.emit(cashbackDistributor, EVENT_NAME_DISABLE)
        .withArgs(deployer.address);
      expect(await cashbackDistributor.enabled()).to.equal(false);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        connect(cashbackDistributor, user).disable()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user.address, ownerRole));
    });

    it("Is reverted if cashback operations are already disabled", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        cashbackDistributor.disable()
      ).to.be.revertedWithCustomError(cashbackDistributor, ERROR_NAME_CASHBACK_ALREADY_DISABLED);
    });
  });

  describe("Function 'sendCashback()'", async () => {
    async function checkSending(context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks } = context;
      const cashback: TestCashback = cashbacks[cashbacks.length - 1];
      const recipientBalanceChange = cashback.sentAmount;

      const returnValues = await connect(cashbackDistributor, cashback.sender).sendCashback.staticCall(
        getAddress(cashback.token),
        cashback.kind,
        cashback.externalId,
        cashback.recipient.address,
        cashback.requestedAmount
      );

      const tx = connect(cashbackDistributor, cashback.sender).sendCashback(
        getAddress(cashback.token),
        cashback.kind,
        cashback.externalId,
        cashback.recipient.address,
        cashback.requestedAmount
      );
      await expect(tx).to.changeTokenBalances(
        cashback.token,
        [cashbackDistributor, cashback.recipient, cashback.sender],
        [-recipientBalanceChange, +recipientBalanceChange, 0]
      );
      await expect(tx).to.emit(cashbackDistributor, EVENT_NAME_SEND_CASHBACK).withArgs(
        getAddress(cashback.token),
        cashback.kind,
        cashback.status,
        cashback.externalId,
        cashback.recipient.address,
        cashback.status != CashbackStatus.Partial ? cashback.requestedAmount : cashback.sentAmount,
        cashback.sender.address,
        cashback.nonce
      );

      expect(returnValues[0]).to.equal(
        cashback.status === CashbackStatus.Success || cashback.status === CashbackStatus.Partial
      );
      expect(returnValues[1]).to.equal(cashback.sentAmount);
      expect(returnValues[2]).to.equal(cashback.nonce);
      await checkCashbackDistributorState(context);
    }

    describe("Executes as expected and emits the correct event if the sending", async () => {
      describe("Succeeds and the the cashback amount is", async () => {
        it("Nonzero and less than the period cap", async () => {
          const context = await beforeSendingCashback({ cashbackRequestedAmount: MAX_CASHBACK_FOR_PERIOD - 1 });
          context.cashbacks[0].sentAmount = context.cashbacks[0].requestedAmount;
          context.cashbacks[0].status = CashbackStatus.Success;
          await checkSending(context);
        });

        it("Nonzero and equals the period cap", async () => {
          const context = await beforeSendingCashback({ cashbackRequestedAmount: MAX_CASHBACK_FOR_PERIOD });
          context.cashbacks[0].sentAmount = context.cashbacks[0].requestedAmount;
          context.cashbacks[0].status = CashbackStatus.Success;
          await checkSending(context);
        });

        it("Nonzero and higher than the period cap", async () => {
          const context = await beforeSendingCashback({ cashbackRequestedAmount: MAX_CASHBACK_FOR_PERIOD + 1 });
          context.cashbacks[0].sentAmount = MAX_CASHBACK_FOR_PERIOD;
          context.cashbacks[0].status = CashbackStatus.Partial;
          await checkSending(context);
        });

        it("Zero", async () => {
          const context = await beforeSendingCashback();
          context.cashbacks[0].requestedAmount = 0;
          context.cashbacks[0].status = CashbackStatus.Success;
          await checkSending(context);
        });
      });
      describe("Fails because", async () => {
        it("Cashback operations are disabled", async () => {
          const context = await beforeSendingCashback();
          await proveTx(context.fixture.cashbackDistributor.disable());
          context.cashbacks[0].status = CashbackStatus.Disabled;
          await checkSending(context);
        });

        it("The cashback distributor contract has not enough balance", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.requestedAmount = cashback.requestedAmount + 1;
          cashback.status = CashbackStatus.OutOfFunds;
          await checkSending(context);
        });

        it("The cashback recipient is blocklisted", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await proveTx(cashbackDistributor.blocklist(cashback.recipient.address));
          cashback.status = CashbackStatus.Blocklisted;
          await checkSending(context);
        });

        async function prepareCashbackSendingAfterPeriodCapReached(): Promise<TestContext> {
          const { fixture, cashback: cashback1 } = await prepareForSingleCashback(MAX_CASHBACK_FOR_PERIOD);
          const cashback2: TestCashback = Object.assign({}, cashback1);
          cashback2.nonce = cashback1.nonce + 1;
          cashback2.status = CashbackStatus.Capped;
          const { cashbackDistributorInitialBalanceByToken } = await setUpContractsForSendingCashbacks(
            fixture.cashbackDistributor,
            [cashback1, cashback2]
          );
          await proveTx(
            connect(fixture.cashbackDistributor, cashback1.sender).sendCashback(
              getAddress(cashback1.token),
              cashback1.kind,
              cashback1.externalId,
              cashback1.recipient.address,
              cashback1.requestedAmount
            )
          );
          cashback1.sentAmount = cashback1.requestedAmount;
          cashback1.status = CashbackStatus.Success;
          return { fixture, cashbacks: [cashback1, cashback2], cashbackDistributorInitialBalanceByToken };
        }

        it("The period cap for the recipient is reached and the requested amount is non-zero", async () => {
          const context = await prepareCashbackSendingAfterPeriodCapReached();
          context.cashbacks[context.cashbacks.length - 1].requestedAmount = 1;
          await checkSending(context);
        });

        it("The period cap for the recipient is reached and the requested amount is zero", async () => {
          const context = await prepareCashbackSendingAfterPeriodCapReached();
          context.cashbacks[context.cashbacks.length - 1].requestedAmount = 0;
          await checkSending(context);
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await pauseContract(cashbackDistributor);
        await expect(
          connect(cashbackDistributor, cashback.sender).sendCashback(
            getAddress(cashback.token),
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.requestedAmount
          )
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("The caller does not have the distributor role", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          cashbackDistributor.sendCashback(
            getAddress(cashback.token),
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.requestedAmount
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, distributorRole));
      });

      it("The token address is zero", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          connect(cashbackDistributor, cashback.sender).sendCashback(
            ZERO_ADDRESS,
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.requestedAmount
          )
        ).to.be.revertedWithCustomError(cashbackDistributor, ERROR_NAME_ZERO_TOKEN_ADDRESS);
      });

      it("The recipient address is zero", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          connect(cashbackDistributor, cashback.sender).sendCashback(
            getAddress(cashback.token),
            cashback.kind,
            cashback.externalId,
            ZERO_ADDRESS,
            cashback.requestedAmount
          )
        ).to.be.revertedWithCustomError(cashbackDistributor, ERROR_NAME_ZERO_RECIPIENT_ADDRESS);
      });

      it("The cashback external ID is zero", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        cashback.externalId = ZERO_HASH;
        await expect(
          connect(cashbackDistributor, cashback.sender).sendCashback(
            getAddress(cashback.token),
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.requestedAmount
          )
        ).to.be.revertedWithCustomError(cashbackDistributor, ERROR_NAME_ZERO_EXTERNAL_ID);
      });
    });
  });

  describe("Function 'revokeCashback()'", async () => {
    async function checkRevoking(targetRevocationStatus: RevocationStatus, context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      const contractBalanceChange =
        targetRevocationStatus === RevocationStatus.Success ? cashback.revokedAmount || 0 : 0;

      const returnValue = await connect(cashbackDistributor, cashback.sender).revokeCashback.staticCall(
        cashback.nonce,
        cashback.revokedAmount
      );

      const tx = connect(cashbackDistributor, distributor).revokeCashback(cashback.nonce, cashback.revokedAmount);
      await expect(tx).to.changeTokenBalances(
        cashback.token,
        [cashbackDistributor, cashback.recipient, cashback.sender],
        [+contractBalanceChange, 0, -contractBalanceChange]
      );
      await expect(tx).to.emit(cashbackDistributor, EVENT_NAME_REVOKE_CASHBACK).withArgs(
        getAddress(cashback.token),
        cashback.kind,
        cashback.status,
        targetRevocationStatus,
        cashback.externalId,
        cashback.recipient.address,
        cashback.revokedAmount,
        cashback.sentAmount - contractBalanceChange, // totalAmount
        distributor.address,
        cashback.nonce
      );
      if (targetRevocationStatus !== RevocationStatus.Success) {
        cashback.revokedAmount = 0;
      }
      expect(returnValue).to.equal(targetRevocationStatus === RevocationStatus.Success);
      await checkCashbackDistributorState(context);
    }

    async function prepareRevocation(context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      if (cashback.requestedAmount <= MAX_CASHBACK_FOR_PERIOD) {
        await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
      } else {
        await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Partial);
        cashback.sentAmount = MAX_CASHBACK_FOR_PERIOD;
      }
      await proveTx(cashback.token.mint(distributor.address, cashback.revokedAmount));
      await proveTx(connect(cashback.token, distributor).approve(getAddress(cashbackDistributor), MAX_UINT256));
    }

    describe("Executes as expected and emits the correct event if the revocation", async () => {
      describe("Succeeds and the revocation amount is", async () => {
        it("Less than the initial cashback amount", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.revokedAmount = Math.floor(cashback.requestedAmount * 0.1);
          await prepareRevocation(context);
          await checkRevoking(RevocationStatus.Success, context);
        });

        it("Less than the initial cashback amount and cashback operations are disabled before execution", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.revokedAmount = Math.floor(cashback.requestedAmount * 0.1);
          await prepareRevocation(context);
          await proveTx(cashbackDistributor.disable());
          await checkRevoking(RevocationStatus.Success, context);
        });

        it("The same as the initial cashback amount", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.revokedAmount = cashback.requestedAmount;
          await prepareRevocation(context);
          await checkRevoking(RevocationStatus.Success, context);
        });

        it("Zero", async () => {
          const context = await beforeSendingCashback();
          context.cashbacks[0].revokedAmount = 0;
          await prepareRevocation(context);
          await checkRevoking(RevocationStatus.Success, context);
        });

        it("Less than the initial cashback amount and initial sending operation is partially successful", async () => {
          const context = await beforeSendingCashback({ cashbackRequestedAmount: MAX_CASHBACK_FOR_PERIOD + 1 });
          const { cashbacks: [cashback] } = context;
          cashback.revokedAmount = Math.floor(MAX_CASHBACK_FOR_PERIOD * 0.1);
          await prepareRevocation(context);
          await checkRevoking(RevocationStatus.Success, context);
        });
      });

      describe("Fails because", async () => {
        it("The caller has not enough tokens", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
          cashback.revokedAmount = Math.floor(cashback.requestedAmount * 0.1);
          await proveTx(cashback.token.mint(distributor.address, (cashback.revokedAmount || 0) - 1));
          await proveTx(connect(cashback.token, distributor).approve(getAddress(cashbackDistributor), MAX_UINT256));
          await checkRevoking(RevocationStatus.OutOfFunds, context);
        });

        it("The caller has not enough tokens and the initial sending operation is partially successful", async () => {
          const context = await beforeSendingCashback({ cashbackRequestedAmount: MAX_CASHBACK_FOR_PERIOD + 1 });
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Partial);
          cashback.sentAmount = MAX_CASHBACK_FOR_PERIOD;
          cashback.revokedAmount = Math.floor(MAX_CASHBACK_FOR_PERIOD * 0.1);
          await proveTx(cashback.token.mint(distributor.address, (cashback.revokedAmount || 0) - 1));
          await proveTx(connect(cashback.token, distributor).approve(getAddress(cashbackDistributor), MAX_UINT256));
          await checkRevoking(RevocationStatus.OutOfFunds, context);
        });

        it("The cashback distributor has not enough allowance from the caller", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
          cashback.revokedAmount = Math.floor(cashback.requestedAmount * 0.1);
          await proveTx(cashback.token.mint(distributor.address, cashback.revokedAmount));
          await proveTx(connect(cashback.token, distributor).approve(
            getAddress(cashbackDistributor),
            (cashback.revokedAmount ?? 0) - 1
          ));
          await checkRevoking(RevocationStatus.OutOfAllowance, context);
        });

        it("The initial cashback amount is less than revocation amount", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
          await proveTx(cashback.token.mint(distributor.address, cashback.requestedAmount + 1));
          await proveTx(connect(cashback.token, distributor).approve(getAddress(cashbackDistributor), MAX_UINT256));
          cashback.revokedAmount = cashback.requestedAmount + 1;
          await checkRevoking(RevocationStatus.OutOfBalance, context);
        });

        it("The initial cashback operations failed", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.requestedAmount = cashback.requestedAmount + 1;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.OutOfFunds);
          await checkRevoking(RevocationStatus.Inapplicable, context);
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await pauseContract(cashbackDistributor);
        await expect(
          connect(cashbackDistributor, distributor).revokeCashback(cashback.nonce, cashback.revokedAmount)
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("Is reverted if the caller does not have the distributor role", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          cashbackDistributor.revokeCashback(cashback.nonce, cashback.revokedAmount)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, distributorRole));
      });
    });
  });

  describe("Function 'increaseCashback()'", async () => {
    async function checkIncreasing(targetIncreaseStatus: IncreaseStatus, context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      const recipientBalanceChange = cashback.increaseSentAmount || 0;

      const returnValues = await connect(cashbackDistributor, distributor).increaseCashback.staticCall(
        cashback.nonce,
        cashback.increaseRequestedAmount
      );

      cashback.requestedAmount += recipientBalanceChange;
      cashback.sentAmount += recipientBalanceChange;

      const tx = connect(cashbackDistributor, distributor).increaseCashback(
        cashback.nonce,
        cashback.increaseRequestedAmount
      );
      await expect(tx).to.changeTokenBalances(
        cashback.token,
        [cashbackDistributor, cashback.recipient, cashback.sender],
        [-recipientBalanceChange, +recipientBalanceChange, 0]
      );
      await expect(tx).to.emit(cashbackDistributor, EVENT_NAME_INCREASE_CASHBACK).withArgs(
        getAddress(cashback.token),
        cashback.kind,
        cashback.status,
        targetIncreaseStatus,
        cashback.externalId,
        cashback.recipient.address,
        targetIncreaseStatus != IncreaseStatus.Partial
          ? cashback.increaseRequestedAmount
          : cashback.increaseSentAmount,
        cashback.sentAmount - (cashback.revokedAmount ?? 0), // totalAmount
        distributor.address,
        cashback.nonce
      );

      expect(returnValues[0]).to.equal(
        targetIncreaseStatus === IncreaseStatus.Success || targetIncreaseStatus === IncreaseStatus.Partial
      );
      expect(returnValues[1]).to.equal(cashback.increaseSentAmount);
      await checkCashbackDistributorState(context);
    }

    async function prepareIncrease(context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
      await proveTx(cashback.token.mint(getAddress(cashbackDistributor), cashback.increaseRequestedAmount));
      context.cashbackDistributorInitialBalanceByToken.set(
        cashback.token,
        cashback.requestedAmount + (cashback.increaseRequestedAmount || 0)
      );
      cashback.increaseSentAmount = 0;
    }

    describe("Executes as expected and emits the correct event if the increase", async () => {
      describe("Succeeds and the increase amount is", async () => {
        it("Nonzero and less than the value than is needed to reach the period cap", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = MAX_CASHBACK_FOR_PERIOD - cashback.requestedAmount - 1;
          await prepareIncrease(context);
          cashback.increaseSentAmount = cashback.increaseRequestedAmount;
          await checkIncreasing(IncreaseStatus.Success, context);
        });

        it("Nonzero and equals the value than is needed to reach the period cap", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = MAX_CASHBACK_FOR_PERIOD - cashback.requestedAmount;
          await prepareIncrease(context);
          cashback.increaseSentAmount = cashback.increaseRequestedAmount;
          await checkIncreasing(IncreaseStatus.Success, context);
        });

        it("Nonzero and higher the value than is needed to reach the period cap", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = MAX_CASHBACK_FOR_PERIOD - cashback.requestedAmount + 1;
          await prepareIncrease(context);
          cashback.increaseSentAmount = MAX_CASHBACK_FOR_PERIOD - cashback.requestedAmount;
          await checkIncreasing(IncreaseStatus.Partial, context);
        });

        it("Zero", async () => {
          const context = await beforeSendingCashback();
          context.cashbacks[0].increaseRequestedAmount = 0;
          await prepareIncrease(context);
          await checkIncreasing(IncreaseStatus.Success, context);
        });
      });

      describe("Fails because", async () => {
        it("Cashback operations are disabled", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = Math.floor(cashback.requestedAmount * 0.1);
          await prepareIncrease(context);
          await proveTx(cashbackDistributor.disable());
          await checkIncreasing(IncreaseStatus.Disabled, context);
        });

        it("The cashback distributor contract has not enough balance", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = Math.floor(cashback.requestedAmount * 0.1);
          await prepareIncrease(context);
          cashback.increaseRequestedAmount += 1;
          await checkIncreasing(IncreaseStatus.OutOfFunds, context);
        });

        it("The cashback recipient is blocklisted", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = Math.floor(cashback.requestedAmount * 0.1);
          await prepareIncrease(context);
          await proveTx(cashbackDistributor.blocklist(cashback.recipient.address));
          await checkIncreasing(IncreaseStatus.Blocklisted, context);
        });

        it("The initial cashback operations failed", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.requestedAmount += 1;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.OutOfFunds);
          cashback.increaseRequestedAmount = Math.floor(cashback.requestedAmount * 0.1);
          cashback.increaseSentAmount = 0;
          await checkIncreasing(IncreaseStatus.Inapplicable, context);
        });

        it("The period cap for the recipient is reached and the requested increase amount is non-zero", async () => {
          const context = await beforeSendingCashback({ cashbackRequestedAmount: MAX_CASHBACK_FOR_PERIOD });
          const { cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = 1;
          await prepareIncrease(context);
          await checkIncreasing(IncreaseStatus.Capped, context);
        });

        it("The period cap for the recipient is reached and the requested increase amount is zero", async () => {
          const context = await beforeSendingCashback({ cashbackRequestedAmount: MAX_CASHBACK_FOR_PERIOD });
          const { cashbacks: [cashback] } = context;
          cashback.increaseRequestedAmount = 0;
          await prepareIncrease(context);
          await checkIncreasing(IncreaseStatus.Capped, context);
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await pauseContract(cashbackDistributor);
        await expect(
          connect(cashbackDistributor, distributor).increaseCashback(cashback.nonce, cashback.revokedAmount)
        ).to.be.revertedWith(ERROR_MESSAGE_PAUSABLE_PAUSED);
      });

      it("Is reverted if the caller does not have the distributor role", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          cashbackDistributor.increaseCashback(cashback.nonce, cashback.revokedAmount)
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, distributorRole));
      });
    });
  });

  describe("Getter functions 'getCashbackNonces()' and 'getCashbacks()'", async () => {
    it("Execute as expected", async () => {
      const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
      const { cashbackDistributor, tokenMocks: [tokenMock] } = fixture;
      const cashbacks: TestCashback[] = [1, 2, 3].map(nonceValue => {
        return {
          token: tokenMock,
          kind: CashbackKind.CardPayment,
          status: CashbackStatus.Nonexistent,
          externalId: CASHBACK_EXTERNAL_ID_STUB1,
          recipient: user,
          requestedAmount: 100 + nonceValue,
          sentAmount: 0,
          sender: distributor,
          nonce: nonceValue
        };
      });
      const cashbackNonces: bigint[] = cashbacks.map(cashback => BigInt(cashback.nonce));
      await setUpContractsForSendingCashbacks(cashbackDistributor, cashbacks);
      await sendCashbacks(cashbackDistributor, cashbacks, CashbackStatus.Success);

      // Check existing cashbacks
      let actualCashbacks: Record<string, unknown>[] = await cashbackDistributor.getCashbacks(cashbackNonces);
      expect(actualCashbacks.length).to.equal(cashbacks.length);
      cashbacks.forEach(cashback => {
        checkEquality(actualCashbacks[cashback.nonce - 1], cashback);
      });

      // Check nonexistent cashbacks
      const nonceAfterExistingCashbacks: number = cashbacks.length + 1;
      actualCashbacks = await cashbackDistributor.getCashbacks([0, nonceAfterExistingCashbacks]);
      expect(actualCashbacks.length).to.equal(2);
      checkNonexistentCashback(actualCashbacks[0], 0);
      checkNonexistentCashback(actualCashbacks[1], nonceAfterExistingCashbacks);

      // Check getting of cashback nonces in different cases
      let actualNonces: bigint[];

      actualNonces = await cashbackDistributor.getCashbackNonces(CASHBACK_EXTERNAL_ID_STUB1, 0, 50);
      expect(actualNonces).to.be.deep.equal(cashbackNonces);

      actualNonces = await cashbackDistributor.getCashbackNonces(CASHBACK_EXTERNAL_ID_STUB1, 0, 2);
      expect(actualNonces).to.be.deep.equal([cashbackNonces[0], cashbackNonces[1]]);

      actualNonces = await cashbackDistributor.getCashbackNonces(CASHBACK_EXTERNAL_ID_STUB1, 1, 2);
      expect(actualNonces).to.be.deep.equal([cashbackNonces[1], cashbackNonces[2]]);

      actualNonces = await cashbackDistributor.getCashbackNonces(CASHBACK_EXTERNAL_ID_STUB1, 1, 1);
      expect(actualNonces).to.be.deep.equal([cashbackNonces[1]]);

      actualNonces = await cashbackDistributor.getCashbackNonces(CASHBACK_EXTERNAL_ID_STUB1, 1, 50);
      expect(actualNonces).to.be.deep.equal([cashbackNonces[1], cashbackNonces[2]]);

      actualNonces = await cashbackDistributor.getCashbackNonces(CASHBACK_EXTERNAL_ID_STUB1, 3, 50);
      expect(actualNonces).to.be.deep.equal([]);

      actualNonces = await cashbackDistributor.getCashbackNonces(CASHBACK_EXTERNAL_ID_STUB1, 1, 0);
      expect(actualNonces).to.be.deep.equal([]);
    });
  });

  describe("Complex scenario", async () => {
    it("Execute as expected", async () => {
      const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
      const { cashbackDistributor, tokenMocks: [tokenMock1, tokenMock2] } = fixture;
      const cashbacks: TestCashback[] = [1, 2, 3, 4].map(nonce => {
        return {
          token: [tokenMock2, tokenMock1][(nonce >> 0) & 1],
          kind: CashbackKind.CardPayment,
          status: CashbackStatus.Nonexistent,
          externalId: [CASHBACK_EXTERNAL_ID_STUB1, CASHBACK_EXTERNAL_ID_STUB2][(nonce >> 1) & 1],
          recipient: [user, deployer][(nonce >> 2) & 1],
          requestedAmount: 100 + nonce,
          sentAmount: 0,
          sender: distributor,
          nonce: nonce
        };
      });
      const { cashbackDistributorInitialBalanceByToken } = await setUpContractsForSendingCashbacks(
        cashbackDistributor,
        cashbacks
      );
      const context: TestContext = { fixture, cashbacks, cashbackDistributorInitialBalanceByToken };
      await proveTx(tokenMock1.mint(distributor.address, MAX_INT256));
      await proveTx(connect(tokenMock1, distributor).approve(getAddress(cashbackDistributor), MAX_UINT256));
      await proveTx(tokenMock2.mint(distributor.address, MAX_INT256));
      await proveTx(connect(tokenMock2, distributor).approve(getAddress(cashbackDistributor), MAX_UINT256));

      await sendCashbacks(cashbackDistributor, cashbacks, CashbackStatus.Success);
      await checkCashbackDistributorState(context);

      await revokeCashback(cashbackDistributor, cashbacks[3], 1);
      await increaseCashback(cashbackDistributor, cashbacks[3], 1);
      await checkCashbackDistributorState(context);

      await revokeCashback(cashbackDistributor, cashbacks[0], 1);
      await revokeCashback(cashbackDistributor, cashbacks[0], 1);
      await increaseCashback(cashbackDistributor, cashbacks[0], 1);
      await increaseCashback(cashbackDistributor, cashbacks[0], 1);
      await checkCashbackDistributorState(context);

      await revokeCashback(cashbackDistributor, cashbacks[1], 1);
      await checkCashbackDistributorState(context);
    });
  });

  describe("Scenario with cashback period cap", async () => {
    it("Executes as expected", async () => {
      const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
      const { cashbackDistributor, tokenMocks: [tokenMock] } = fixture;
      const recipient: HardhatEthersSigner = user;
      const cashbacks: TestCashback[] = [1, 2, 3, 4, 5].map(nonce => {
        return {
          token: tokenMock,
          kind: CashbackKind.CardPayment,
          status: CashbackStatus.Nonexistent,
          externalId: CASHBACK_EXTERNAL_ID_STUB1,
          recipient: recipient,
          requestedAmount: 1,
          sentAmount: 0,
          sender: distributor,
          nonce: nonce
        };
      });
      cashbacks[0].requestedAmount = 123;
      cashbacks[1].requestedAmount = MAX_CASHBACK_FOR_PERIOD - cashbacks[0].requestedAmount + 1;
      cashbacks[2].requestedAmount = cashbacks[1].requestedAmount;
      const { cashbackDistributorInitialBalanceByToken } = await setUpContractsForSendingCashbacks(
        cashbackDistributor,
        cashbacks
      );
      const context: TestContext = { fixture, cashbacks, cashbackDistributorInitialBalanceByToken };
      await proveTx(tokenMock.mint(distributor.address, MAX_INT256));
      await proveTx(connect(tokenMock, distributor).approve(getAddress(cashbackDistributor), MAX_UINT256));

      async function checkPeriodCapRelatedValues(props: {
        expectedLastTimeReset: number;
        expectedCashbackSum: number;
      }) {
        expect(await cashbackDistributor.getCashbackLastTimeReset(getAddress(tokenMock), recipient.address)).to.equal(
          props.expectedLastTimeReset
        );

        expect(await cashbackDistributor.getCashbackSinceLastReset(getAddress(tokenMock), recipient.address)).to.equal(
          props.expectedCashbackSum
        );

        expect(
          await cashbackDistributor.previewCashbackCap(getAddress(tokenMock), recipient.address)
        ).to.deep.equal([props.expectedLastTimeReset, props.expectedCashbackSum]);
      }

      // Reset the cashback sum for period cashback cap control and check the cap-related values.
      cashbacks[0].sentAmount = cashbacks[0].requestedAmount;
      const [transactionReceipt1] = await sendCashbacks(cashbackDistributor, [cashbacks[0]], CashbackStatus.Success);
      const block1: Block | null = await ethers.provider.getBlock(transactionReceipt1.blockNumber);
      context.cashbacks = [cashbacks[0]];
      await checkCashbackDistributorState(context);
      await checkPeriodCapRelatedValues({
        expectedLastTimeReset: block1?.timestamp ?? 0,
        expectedCashbackSum: cashbacks[0].requestedAmount
      });

      // Reach the cashback period cap and check the cap-related values.
      cashbacks[1].sentAmount = MAX_CASHBACK_FOR_PERIOD - cashbacks[0].requestedAmount;
      await sendCashbacks(cashbackDistributor, [cashbacks[1]], CashbackStatus.Partial);
      context.cashbacks = [cashbacks[0], cashbacks[1]];
      await checkCashbackDistributorState(context);
      await checkPeriodCapRelatedValues({
        expectedLastTimeReset: block1?.timestamp ?? 0,
        expectedCashbackSum: MAX_CASHBACK_FOR_PERIOD
      });

      // Revoke the second (partial) cashback and check that the cap-related values are changed.
      await revokeCashback(cashbackDistributor, cashbacks[1], cashbacks[1].sentAmount);
      await checkCashbackDistributorState(context);
      await checkPeriodCapRelatedValues({
        expectedLastTimeReset: block1?.timestamp ?? 0,
        expectedCashbackSum: MAX_CASHBACK_FOR_PERIOD - cashbacks[1].sentAmount
      });

      // Reach the cashback period cap again and check the cap-related values.
      cashbacks[2].sentAmount = cashbacks[1].sentAmount;
      await sendCashbacks(cashbackDistributor, [cashbacks[2]], CashbackStatus.Partial);
      context.cashbacks = [cashbacks[0], cashbacks[1], cashbacks[2]];
      await checkCashbackDistributorState(context);
      await checkPeriodCapRelatedValues({
        expectedLastTimeReset: block1?.timestamp ?? 0,
        expectedCashbackSum: MAX_CASHBACK_FOR_PERIOD
      });

      // Check that next cashback sending to the same recipient failed because of the period cap.
      await sendCashbacks(cashbackDistributor, [cashbacks[3]], CashbackStatus.Capped);
      context.cashbacks = [cashbacks[0], cashbacks[1], cashbacks[2], cashbacks[3]];
      await checkCashbackDistributorState(context);
      await checkPeriodCapRelatedValues({
        expectedLastTimeReset: block1?.timestamp ?? 0,
        expectedCashbackSum: MAX_CASHBACK_FOR_PERIOD
      });

      // The following part of the test is executed only for some networks because we need to shift block time.
      if (network.name !== "hardhat" && network.name !== "stratus") {
        return;
      }

      // Shift next block time for a period of cap checking.
      await increaseBlockTimestamp(CASHBACK_RESET_PERIOD + 1);

      // Check that the cap state preview function returns expected values when a new cap period starts
      const blockAfterTimeShift = (await ethers.provider.getBlock("latest"));
      const actualPreview = await cashbackDistributor.previewCashbackCap(
        getAddress(tokenMock),
        recipient.address,
        { blockTag: blockAfterTimeShift!.number }
      );
      expect(actualPreview[0]).to.equal(blockAfterTimeShift!.timestamp);
      expect(actualPreview[1]).to.equal(0);

      // Check that next cashback sending executes successfully due to the cap period resets
      cashbacks[4].sentAmount = cashbacks[4].requestedAmount;
      const [transactionReceipt4] = await sendCashbacks(cashbackDistributor, [cashbacks[4]], CashbackStatus.Success);
      const block4: Block | null = await ethers.provider.getBlock(transactionReceipt4.blockNumber);
      context.cashbacks = cashbacks;
      await checkCashbackDistributorState(context);
      await checkPeriodCapRelatedValues({
        expectedLastTimeReset: block4?.timestamp ?? 0,
        expectedCashbackSum: cashbacks[4].requestedAmount
      });

      // Revoke the first cashback and check that the cap-related values are changed properly.
      await revokeCashback(cashbackDistributor, cashbacks[0], cashbacks[0].sentAmount);
      await checkCashbackDistributorState(context);
      await checkPeriodCapRelatedValues({
        expectedLastTimeReset: block4?.timestamp ?? 0,
        expectedCashbackSum: 0
      });
    });
  });
});
