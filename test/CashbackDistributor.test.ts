import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../test-utils/eth";
import { createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";

const MAX_UINT256 = ethers.constants.MaxUint256;
const MAX_INT256 = ethers.constants.MaxInt256;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const ZERO_HASH = ethers.constants.HashZero;
const BYTES32_LENGTH: number = 32;

enum CashbackStatus {
  Nonexistent = 0,
  Success = 1,
  Blacklisted = 2,
  OutOfFunds = 3,
  Disabled = 4,
  Revoked = 5,
}

enum IncreaseStatus {
  Nonexistent = 0,
  Success = 1,
  Blacklisted = 2,
  OutOfFunds = 3,
  Disabled = 4,
  Inapplicable = 5,
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
  CardPayment = 1,
}

interface TestCashback {
  token: Contract;
  kind: CashbackKind;
  status: CashbackStatus;
  externalId: string;
  recipient: SignerWithAddress;
  amount: number;
  sender: SignerWithAddress;
  nonce: number;
  revokedAmount?: number;
  increaseAmount?: number;
}

interface Fixture {
  cashbackDistributor: Contract;
  tokenMocks: Contract[];
}

interface TestContext {
  fixture: Fixture,
  cashbacks: TestCashback[],
  cashbackDistributorInitialBalanceByToken: Map<Contract, number>
}

function checkNonexistentCashback(
  actualOnChainCashback: any,
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
  actualOnChainCashback: any,
  expectedCashback: TestCashback,
) {
  if (expectedCashback.status == CashbackStatus.Nonexistent) {
    checkNonexistentCashback(actualOnChainCashback, expectedCashback.nonce);
  } else {
    expect(actualOnChainCashback.token).to.equal(
      expectedCashback.token.address,
      `cashback[${expectedCashback.nonce}].token is incorrect`
    );
    expect(actualOnChainCashback.kind).to.equal(
      expectedCashback.kind,
      `cashback[${expectedCashback.nonce}].account is incorrect`
    );
    expect(actualOnChainCashback.status).to.equal(
      expectedCashback.status,
      `cashback[${expectedCashback.nonce}].status is incorrect`
    );
    expect(actualOnChainCashback.externalId).to.equal(
      expectedCashback.externalId,
      `cashback[${expectedCashback.nonce}].externalId is incorrect`
    );
    expect(actualOnChainCashback.recipient).to.equal(
      expectedCashback.recipient.address,
      `cashback[${expectedCashback.nonce}].recipient is incorrect`
    );
    expect(actualOnChainCashback.amount).to.equal(
      expectedCashback.amount,
      `cashback[${expectedCashback.nonce}].amount is incorrect`
    );
    expect(actualOnChainCashback.sender).to.equal(
      expectedCashback.sender.address,
      `cashback[${expectedCashback.nonce}].sender is incorrect`
    );
    expect(actualOnChainCashback.revokedAmount).to.equal(
      expectedCashback.revokedAmount || 0,
      `cashback[${expectedCashback.nonce}].revokedAmount is incorrect`
    );
  }
}

async function setUpFixture(func: any) {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'CashbackDistributor'", async () => {
  const CASHBACK_EXTERNAL_ID_STUB1 = createBytesString("01", BYTES32_LENGTH);
  const CASHBACK_EXTERNAL_ID_STUB2 = createBytesString("02", BYTES32_LENGTH);
  const TOKEN_ADDRESS_STUB = "0x0000000000000000000000000000000000000001";

  const EVENT_NAME_ENABLE = "Enable";
  const EVENT_NAME_DISABLE = "Disable";
  const EVENT_NAME_INCREASE_CASHBACK = "IncreaseCashback";
  const EVENT_NAME_REVOKE_CASHBACK = "RevokeCashback";
  const EVENT_NAME_SEND_CASHBACK = "SendCashback";

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";

  const REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED = "CashbackAlreadyEnabled";
  const REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED = "CashbackAlreadyDisabled";
  const REVERT_ERROR_IF_TOKEN_ADDRESS_IS_ZERO = "ZeroTokenAddress";
  const REVERT_ERROR_IF_RECIPIENT_ADDRESS_IS_ZERO = "ZeroRecipientAddress";
  const REVERT_ERROR_IF_EXTERNAL_ID_IS_ZERO = "ZeroExternalId";

  const ownerRole: string = ethers.utils.id("OWNER_ROLE");
  const blacklisterRole: string = ethers.utils.id("BLACKLISTER_ROLE");
  const pauserRole: string = ethers.utils.id("PAUSER_ROLE");
  const rescuerRole: string = ethers.utils.id("RESCUER_ROLE");
  const distributorRole: string = ethers.utils.id("DISTRIBUTOR_ROLE");

  let cashbackDistributorFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let distributor: SignerWithAddress;
  let user: SignerWithAddress;

  before(async () => {
    cashbackDistributorFactory = await ethers.getContractFactory("CashbackDistributor");
    tokenMockFactory = await ethers.getContractFactory("ERC20UpgradeableMock");

    [deployer, distributor, user] = await ethers.getSigners();
  });

  async function deployTokenMock(nameSuffix: string): Promise<Contract> {
    const name = "ERC20 Test" + nameSuffix;
    const symbol = "TEST" + nameSuffix;

    const tokenMock: Contract = await upgrades.deployProxy(tokenMockFactory, [name, symbol]);
    await tokenMock.deployed();

    return tokenMock;
  }

  async function deployCashbackDistributor(): Promise<{ cashbackDistributor: Contract }> {
    const cashbackDistributor: Contract = await upgrades.deployProxy(cashbackDistributorFactory);
    await cashbackDistributor.deployed();

    return { cashbackDistributor };
  }

  async function deployAndConfigureAllContracts(): Promise<Fixture> {
    const { cashbackDistributor } = await deployCashbackDistributor();
    const tokenMock1 = await deployTokenMock("1");
    const tokenMock2 = await deployTokenMock("2");

    await proveTx(cashbackDistributor.grantRole(blacklisterRole, deployer.address));
    await proveTx(cashbackDistributor.grantRole(distributorRole, distributor.address));
    await proveTx(cashbackDistributor.enable());

    return {
      cashbackDistributor,
      tokenMocks: [tokenMock1, tokenMock2],
    };
  }

  async function setUpContractsForSendingCashbacks(
    cashbackDistributor: Contract,
    cashbacks: TestCashback[]
  ): Promise<{ cashbackDistributorInitialBalanceByToken: Map<Contract, number> }> {
    const cashbackDistributorInitialBalanceByToken: Map<Contract, number> = new Map<Contract, number>();
    cashbacks.forEach(cashback => {
      let totalCashbackAmount: number = cashbackDistributorInitialBalanceByToken.get(cashback.token) || 0;
      totalCashbackAmount += cashback.amount;
      cashbackDistributorInitialBalanceByToken.set(cashback.token, totalCashbackAmount);
    });
    for (let [token, totalCashbackAmount] of cashbackDistributorInitialBalanceByToken.entries()) {
      await proveTx(token.mint(cashbackDistributor.address, totalCashbackAmount));
    }
    return { cashbackDistributorInitialBalanceByToken };
  }

  async function pauseContract(contract: Contract) {
    await proveTx(contract.grantRole(pauserRole, deployer.address));
    await proveTx(contract.pause());
  }

  async function sendCashbacks(cashbackDistributor: Contract, cashbacks: TestCashback[], targetStatus: CashbackStatus) {
    for (let cashback of cashbacks) {
      await proveTx(
        cashbackDistributor.connect(cashback.sender).sendCashback(
          cashback.token.address,
          cashback.kind,
          cashback.externalId,
          cashback.recipient.address,
          cashback.amount
        )
      );
      expect(
        (await cashbackDistributor.getCashback(cashback.nonce)).status
      ).to.equal(
        targetStatus,
        "The sent cashback has unexpected status"
      );
      cashback.status = targetStatus;
    }
  }

  async function checkCashbackStructures(context: TestContext) {
    const { fixture: { cashbackDistributor }, cashbacks } = context;
    // The cashback structure with the zero nonce must be always nonexistent one.
    checkNonexistentCashback(await cashbackDistributor.getCashback(0), 0);

    // Check other structures
    for (let cashback of cashbacks) {
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
    const expectedMap = new Map<string, BigNumber[]>();

    cashbacks.forEach(cashback => {
      const nonces: BigNumber[] = expectedMap.get(cashback.externalId) || [];
      nonces.push(BigNumber.from(cashback.nonce));
      expectedMap.set(cashback.externalId, nonces);
    });

    for (let [externalId, expectedNonces] of expectedMap) {
      expect(
        await cashbackDistributor.getCashbackNonces(externalId, 0, 50)
      ).to.deep.equal(
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
      if (cashback.status == CashbackStatus.Success) {
        totalCashback += cashback.amount - (cashback.revokedAmount || 0);
      }
      totalCashbackMap.set(cashback.externalId, totalCashback);
      expectedMap.set(cashback.token, totalCashbackMap);
    });

    for (let [token, expectedTotalCashbackByExternalId] of expectedMap) {
      for (let [externalId, expectedTotalCashback] of expectedTotalCashbackByExternalId) {
        expect(
          await cashbackDistributor.getTotalCashbackByTokenAndExternalId(token.address, externalId)
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
      if (cashback.status == CashbackStatus.Success) {
        totalCashback += cashback.amount - (cashback.revokedAmount || 0);
      }
      totalCashbackMap.set(recipientAddress, totalCashback);
      expectedMap.set(cashback.token, totalCashbackMap);
    });

    for (let [token, expectedTotalCashbackByRecipient] of expectedMap) {
      const tokenSymbol: string = await token.symbol();
      for (let [recipientAddress, expectedTotalCashback] of expectedTotalCashbackByRecipient) {
        expect(
          await cashbackDistributor.getTotalCashbackByTokenAndRecipient(token.address, recipientAddress)
        ).to.equal(
          expectedTotalCashback,
          `Wrong total cashback for the token with symbol "${tokenSymbol}" and recipient address ${recipientAddress}`
        );
      }
    }
  }

  async function checkCashbackDistributorBalanceByTokens(context: TestContext) {
    const { fixture: { cashbackDistributor }, cashbacks, cashbackDistributorInitialBalanceByToken } = context;
    const expectedMap = new Map<Contract, number>();

    cashbacks.forEach(cashback => {
      let balance: number = expectedMap.get(cashback.token)
        || (cashbackDistributorInitialBalanceByToken.get(cashback.token) || 0);
      if (cashback.status == CashbackStatus.Success) {
        balance -= cashback.amount - (cashback.revokedAmount || 0);
      }
      expectedMap.set(cashback.token, balance);
    });

    for (let [token, expectedBalance] of expectedMap) {
      const tokenSymbol: string = await token.symbol();
      expect(
        await token.balanceOf(cashbackDistributor.address)
      ).to.equal(
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

  async function prepareForSingleCashback(): Promise<{ fixture: Fixture, cashback: TestCashback }> {
    const fixture: Fixture = await setUpFixture(deployAndConfigureAllContracts);
    const cashback: TestCashback = {
      token: tokenMockFactory.attach(TOKEN_ADDRESS_STUB),
      kind: CashbackKind.CardPayment,
      status: CashbackStatus.Nonexistent,
      externalId: CASHBACK_EXTERNAL_ID_STUB1,
      recipient: user,
      amount: 123,
      revokedAmount: 0,
      sender: distributor,
      nonce: 1,
    };
    cashback.token = fixture.tokenMocks[0];

    return { fixture, cashback };
  }

  async function beforeSendingCashback(): Promise<TestContext> {
    const { fixture, cashback } = await prepareForSingleCashback();
    const { cashbackDistributorInitialBalanceByToken } = await setUpContractsForSendingCashbacks(
      fixture.cashbackDistributor,
      [cashback]
    );

    return { fixture, cashbacks: [cashback], cashbackDistributorInitialBalanceByToken };
  }

  describe("Function 'initialize()'", async () => {
    it("Configures the contract as expected", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);

      // The admins of roles
      expect(await cashbackDistributor.getRoleAdmin(ownerRole)).to.equal(ownerRole);
      expect(await cashbackDistributor.getRoleAdmin(blacklisterRole)).to.equal(ownerRole);
      expect(await cashbackDistributor.getRoleAdmin(pauserRole)).to.equal(ownerRole);
      expect(await cashbackDistributor.getRoleAdmin(rescuerRole)).to.equal(ownerRole);
      expect(await cashbackDistributor.getRoleAdmin(distributorRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await cashbackDistributor.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await cashbackDistributor.hasRole(blacklisterRole, deployer.address)).to.equal(false);
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
    });

    it("Is reverted if it is called a second time", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        cashbackDistributor.initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });
  });

  describe("Function 'enable()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);

      await expect(
        cashbackDistributor.enable()
      ).to.emit(
        cashbackDistributor,
        EVENT_NAME_ENABLE
      ).withArgs(
        deployer.address
      );
      expect(await cashbackDistributor.enabled()).to.equal(true);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        cashbackDistributor.connect(user).enable()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user.address, ownerRole));
    });

    it("Is reverted if cashback operations are already enabled", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await proveTx(cashbackDistributor.enable());
      await expect(
        cashbackDistributor.enable()
      ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED);
    });
  });

  describe("Function 'disable()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await proveTx(cashbackDistributor.enable());
      expect(await cashbackDistributor.enabled()).to.equal(true);

      await expect(
        cashbackDistributor.disable()
      ).to.emit(
        cashbackDistributor,
        EVENT_NAME_DISABLE
      ).withArgs(
        deployer.address
      );
      expect(await cashbackDistributor.enabled()).to.equal(false);
    });

    it("Is reverted if the caller does not have the owner role", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        cashbackDistributor.connect(user).disable()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user.address, ownerRole));
    });

    it("Is reverted if cashback operations are already disabled", async () => {
      const { cashbackDistributor } = await setUpFixture(deployCashbackDistributor);
      await expect(
        cashbackDistributor.disable()
      ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED);
    });
  });

  describe("Function 'sendCashback()'", async () => {
    async function checkSending(context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      const recipientBalanceChange = cashback.status === CashbackStatus.Success ? cashback.amount : 0;

      await expect(
        cashbackDistributor.connect(cashback.sender).sendCashback(
          cashback.token.address,
          cashback.kind,
          cashback.externalId,
          cashback.recipient.address,
          cashback.amount
        )
      ).to.changeTokenBalances(
        cashback.token,
        [cashbackDistributor, cashback.recipient, cashback.sender],
        [-recipientBalanceChange, +recipientBalanceChange, 0]
      ).and.to.emit(
        cashbackDistributor,
        EVENT_NAME_SEND_CASHBACK
      ).withArgs(
        cashback.token.address,
        cashback.kind,
        cashback.status,
        cashback.externalId,
        cashback.recipient.address,
        cashback.amount,
        cashback.sender.address,
        cashback.nonce,
      );

      await checkCashbackDistributorState(context);
    }

    describe("Executes as expected and emits the correct event if the sending", async () => {
      describe("Succeeds and the the cashback amount is", async () => {
        it("Nonzero", async () => {
          const context = await beforeSendingCashback();
          context.cashbacks[0].status = CashbackStatus.Success;
          await checkSending(context);
        });

        it("Zero", async () => {
          const context = await beforeSendingCashback();
          context.cashbacks[0].amount = 0;
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
          cashback.amount = cashback.amount + 1;
          cashback.status = CashbackStatus.OutOfFunds;
          await checkSending(context);
        });

        it("The cashback recipient is blacklisted", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await proveTx(cashbackDistributor.blacklist(cashback.recipient.address));
          cashback.status = CashbackStatus.Blacklisted;
          await checkSending(context);
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await pauseContract(cashbackDistributor);
        await expect(
          cashbackDistributor.connect(cashback.sender).sendCashback(
            cashback.token.address,
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.amount
          )
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
      });

      it("The caller does not have the distributor role", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          cashbackDistributor.sendCashback(
            cashback.token.address,
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.amount
          )
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, distributorRole));
      });

      it("The token address is zero", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          cashbackDistributor.connect(cashback.sender).sendCashback(
            ZERO_ADDRESS,
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.amount
          )
        ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_TOKEN_ADDRESS_IS_ZERO);
      });

      it("The recipient address is zero", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await expect(
          cashbackDistributor.connect(cashback.sender).sendCashback(
            cashback.token.address,
            cashback.kind,
            cashback.externalId,
            ZERO_ADDRESS,
            cashback.amount
          )
        ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_RECIPIENT_ADDRESS_IS_ZERO);
      });

      it("The cashback external ID is zero", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        cashback.externalId = ZERO_HASH;
        await expect(
          cashbackDistributor.connect(cashback.sender).sendCashback(
            cashback.token.address,
            cashback.kind,
            cashback.externalId,
            cashback.recipient.address,
            cashback.amount
          )
        ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_EXTERNAL_ID_IS_ZERO);
      });
    });
  });

  describe("Function 'revokeCashback()'", async () => {
    async function checkRevoking(
      targetRevocationStatus: RevocationStatus,
      context: TestContext
    ) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      const contractBalanceChange =
        targetRevocationStatus === RevocationStatus.Success ? (cashback.revokedAmount || 0) : 0;

      await expect(
        cashbackDistributor.connect(distributor).revokeCashback(cashback.nonce, cashback.revokedAmount)
      ).to.changeTokenBalances(
        cashback.token,
        [cashbackDistributor, cashback.recipient, cashback.sender],
        [+contractBalanceChange, 0, -contractBalanceChange]
      ).and.to.emit(
        cashbackDistributor,
        EVENT_NAME_REVOKE_CASHBACK
      ).withArgs(
        cashback.token.address,
        cashback.kind,
        cashback.status,
        targetRevocationStatus,
        cashback.externalId,
        cashback.recipient.address,
        cashback.revokedAmount,
        distributor.address,
        cashback.nonce,
      );
      if (targetRevocationStatus !== RevocationStatus.Success) {
        cashback.revokedAmount = 0;
      }
      await checkCashbackDistributorState(context);
    }

    async function prepareRevocation(context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
      await proveTx(cashback.token.mint(distributor.address, cashback.revokedAmount));
      await proveTx(cashback.token.connect(distributor).approve(cashbackDistributor.address, MAX_UINT256));
    }

    describe("Executes as expected and emits the correct event if the revocation", async () => {
      describe("Succeeds and the revocation amount is", async () => {
        it("Less than the initial cashback amount", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.revokedAmount = Math.floor(cashback.amount * 0.1);
          await prepareRevocation(context);
          await checkRevoking(RevocationStatus.Success, context);
        });

        it("Less than the initial cashback amount and cashback operations are disabled before execution", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.revokedAmount = Math.floor(cashback.amount * 0.1);
          await prepareRevocation(context);
          await proveTx(cashbackDistributor.disable());
          await checkRevoking(RevocationStatus.Success, context);
        });

        it("The same as the initial cashback amount", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.revokedAmount = cashback.amount;
          await prepareRevocation(context);
          await checkRevoking(RevocationStatus.Success, context);
        });

        it("Zero", async () => {
          const context = await beforeSendingCashback();
          context.cashbacks[0].revokedAmount = 0;
          await prepareRevocation(context);
          await checkRevoking(RevocationStatus.Success, context);
        });
      });

      describe("Fails because", async () => {
        it("The caller has not enough tokens", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
          cashback.revokedAmount = Math.floor(cashback.amount * 0.1);
          await proveTx(cashback.token.mint(distributor.address, (cashback.revokedAmount || 0) - 1));
          await proveTx(cashback.token.connect(distributor).approve(cashbackDistributor.address, MAX_UINT256));
          await checkRevoking(RevocationStatus.OutOfFunds, context);
        });

        it("The cashback distributor has not enough allowance from the caller", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
          cashback.revokedAmount = Math.floor(cashback.amount * 0.1);
          await proveTx(cashback.token.mint(distributor.address, cashback.revokedAmount));
          await proveTx(cashback.token.connect(distributor).approve(
            cashbackDistributor.address,
            (cashback.revokedAmount || 0) - 1
          ));
          await checkRevoking(RevocationStatus.OutOfAllowance, context);
        });

        it("The initial cashback amount is less than revocation amount", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
          await proveTx(cashback.token.mint(distributor.address, cashback.amount + 1));
          await proveTx(cashback.token.connect(distributor).approve(cashbackDistributor.address, MAX_UINT256));
          cashback.revokedAmount = cashback.amount + 1;
          await checkRevoking(RevocationStatus.OutOfBalance, context);
        });

        it("The initial cashback operations failed.", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.amount = cashback.amount + 1;
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
          cashbackDistributor.connect(distributor).revokeCashback(cashback.nonce, cashback.revokedAmount)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
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
    async function checkIncreasing(
      targetIncreaseStatus: IncreaseStatus,
      context: TestContext
    ) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      const recipientBalanceChange =
        targetIncreaseStatus === IncreaseStatus.Success ? (cashback.increaseAmount || 0) : 0;

      await expect(
        cashbackDistributor.connect(distributor).increaseCashback(cashback.nonce, cashback.increaseAmount)
      ).to.changeTokenBalances(
        cashback.token,
        [cashbackDistributor, cashback.recipient, cashback.sender],
        [-recipientBalanceChange, +recipientBalanceChange, 0]
      ).and.to.emit(
        cashbackDistributor,
        EVENT_NAME_INCREASE_CASHBACK
      ).withArgs(
        cashback.token.address,
        cashback.kind,
        cashback.status,
        targetIncreaseStatus,
        cashback.externalId,
        cashback.recipient.address,
        cashback.increaseAmount,
        distributor.address,
        cashback.nonce,
      );

      cashback.amount += recipientBalanceChange;
      await checkCashbackDistributorState(context);
    }

    async function prepareIncrease(context: TestContext) {
      const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
      await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.Success);
      await proveTx(cashback.token.mint(cashbackDistributor.address, cashback.increaseAmount));
      context.cashbackDistributorInitialBalanceByToken.set(
        cashback.token,
        cashback.amount + (cashback.increaseAmount || 0)
      );
    }

    describe("Executes as expected and emits the correct event if the increase", async () => {
      describe("Succeeds and the increase amount is", async () => {
        it("Nonzero", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.increaseAmount = Math.floor(cashback.amount * 0.1);
          await prepareIncrease(context);
          await checkIncreasing(IncreaseStatus.Success, context);
        });

        it("Zero", async () => {
          const context = await beforeSendingCashback();
          context.cashbacks[0].increaseAmount = 0;
          await prepareIncrease(context);
          await checkIncreasing(IncreaseStatus.Success, context);
        });
      });

      describe("Fails because", async () => {
        it("Cashback operations are disabled", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.increaseAmount = Math.floor(cashback.amount * 0.1);
          await prepareIncrease(context);
          await proveTx(cashbackDistributor.disable());
          await checkIncreasing(IncreaseStatus.Disabled, context);
        });

        it("The cashback distributor contract has not enough balance", async () => {
          const context = await beforeSendingCashback();
          const { cashbacks: [cashback] } = context;
          cashback.increaseAmount = Math.floor(cashback.amount * 0.1);
          await prepareIncrease(context);
          cashback.increaseAmount += 1;
          await checkIncreasing(IncreaseStatus.OutOfFunds, context);
        });

        it("The cashback recipient is blacklisted", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.increaseAmount = Math.floor(cashback.amount * 0.1);
          await prepareIncrease(context);
          await proveTx(cashbackDistributor.blacklist(cashback.recipient.address));
          await checkIncreasing(IncreaseStatus.Blacklisted, context);
        });

        it("The initial cashback operations failed.", async () => {
          const context = await beforeSendingCashback();
          const { fixture: { cashbackDistributor }, cashbacks: [cashback] } = context;
          cashback.amount += 1;
          await sendCashbacks(cashbackDistributor, [cashback], CashbackStatus.OutOfFunds);
          cashback.increaseAmount = Math.floor(cashback.amount * 0.1);
          await checkIncreasing(IncreaseStatus.Inapplicable, context);
        });
      });
    });

    describe("Is reverted if", async () => {
      it("The contract is paused", async () => {
        const { fixture: { cashbackDistributor }, cashback } = await prepareForSingleCashback();
        await pauseContract(cashbackDistributor);
        await expect(
          cashbackDistributor.connect(distributor).increaseCashback(cashback.nonce, cashback.revokedAmount)
        ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
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
          amount: 100 + nonceValue,
          sender: distributor,
          nonce: nonceValue,
        };
      });
      const cashbackNonces: BigNumber[] = cashbacks.map(cashback => BigNumber.from(cashback.nonce));
      await setUpContractsForSendingCashbacks(cashbackDistributor, cashbacks);
      await sendCashbacks(cashbackDistributor, cashbacks, CashbackStatus.Success);

      // Check existing cashbacks
      let actualCashbacks: any[] = await cashbackDistributor.getCashbacks(cashbackNonces);
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
      let actualNonces: BigNumber[];

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

    async function revokeCashback(cashbackDistributor: Contract, cashback: TestCashback) {
      const revokedAmount = 1;
      await proveTx(
        cashbackDistributor.connect(distributor).revokeCashback(cashback.nonce, revokedAmount)
      );
      cashback.revokedAmount = revokedAmount + (cashback.revokedAmount || 0);
    }

    async function increaseCashback(cashbackDistributor: Contract, cashback: TestCashback) {
      const increaseAmount = 1;
      await proveTx(
        cashbackDistributor.connect(distributor).increaseCashback(cashback.nonce, increaseAmount)
      );
      cashback.amount += increaseAmount;
    }

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
          amount: 100 + nonce,
          sender: distributor,
          nonce: nonce,
        };
      });
      const { cashbackDistributorInitialBalanceByToken } = await setUpContractsForSendingCashbacks(
        cashbackDistributor,
        cashbacks
      );
      const context: TestContext = { fixture, cashbacks, cashbackDistributorInitialBalanceByToken };
      await proveTx(tokenMock1.mint(distributor.address, MAX_INT256));
      await proveTx(tokenMock1.connect(distributor).approve(cashbackDistributor.address, MAX_UINT256));
      await proveTx(tokenMock2.mint(distributor.address, MAX_INT256));
      await proveTx(tokenMock2.connect(distributor).approve(cashbackDistributor.address, MAX_UINT256));

      await sendCashbacks(cashbackDistributor, cashbacks, CashbackStatus.Success);
      await checkCashbackDistributorState(context);

      await revokeCashback(cashbackDistributor, cashbacks[3]);
      await increaseCashback(cashbackDistributor, cashbacks[3]);
      await checkCashbackDistributorState(context);

      await revokeCashback(cashbackDistributor, cashbacks[0]);
      await revokeCashback(cashbackDistributor, cashbacks[0]);
      await increaseCashback(cashbackDistributor, cashbacks[0]);
      await increaseCashback(cashbackDistributor, cashbacks[0]);
      await checkCashbackDistributorState(context);

      await revokeCashback(cashbackDistributor, cashbacks[1]);
      await checkCashbackDistributorState(context);
    });
  });
});
