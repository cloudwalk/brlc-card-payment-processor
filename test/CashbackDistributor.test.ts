import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { createBytesString, createRevertMessageDueToMissingRole } from "../test-utils/misc";

const BYTES32_LENGTH: number = 32;
const CASHBACK_EXTERNAL_ID_STUB1 = createBytesString("01", BYTES32_LENGTH);
const CASHBACK_EXTERNAL_ID_STUB2 = createBytesString("02", BYTES32_LENGTH);
const TOKEN_ADDRESS_STUB = "0x0000000000000000000000000000000000000001";

enum CashbackStatus {
  Nonexistent = 0,
  Success = 1,
  Blacklisted = 2,
  OutOfFunds = 3,
  Disabled = 4,
  Revoked = 5,
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
}

function checkNonexistentCashback(
  actualOnChainCashback: any,
  cashbackNonce: number
) {
  expect(actualOnChainCashback.token).to.equal(
    ethers.constants.AddressZero,
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
    ethers.constants.HashZero,
    `cashback[${cashbackNonce}].externalId is incorrect`
  );
  expect(actualOnChainCashback.recipient).to.equal(
    ethers.constants.AddressZero,
    `cashback[${cashbackNonce}].recipient is incorrect`
  );
  expect(actualOnChainCashback.amount).to.equal(
    0,
    `cashback[${cashbackNonce}].amount is incorrect`
  );
  expect(actualOnChainCashback.sender).to.equal(
    ethers.constants.AddressZero,
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

async function deployTokenMock(symbol: string = "TEST"): Promise<Contract> {
  const tokenMockFactory: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
  const tokenMock = await tokenMockFactory.deploy();
  await tokenMock.deployed();
  await proveTx(tokenMock.initialize("ERC20 Test", symbol));

  return tokenMock;
}

describe("Contract 'CashbackDistributor'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";

  const REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED = "CashbackAlreadyEnabled";
  const REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED = "CashbackAlreadyDisabled";
  const REVERT_ERROR_IF_TOKEN_ADDRESS_IS_ZERO = "ZeroTokenAddress";
  const REVERT_ERROR_IF_RECIPIENT_ADDRESS_IS_ZERO = "ZeroRecipientAddress";
  const REVERT_ERROR_IF_EXTERNAL_ID_IS_ZERO = "ZeroExternalId";

  let cashbackDistributorFactory: ContractFactory;
  let cashbackDistributor: Contract;
  let tokenMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let distributor: SignerWithAddress;
  let user: SignerWithAddress;

  let ownerRole: string;
  let blacklisterRole: string;
  let pauserRole: string;
  let rescuerRole: string;
  let distributorRole: string;

  beforeEach(async () => {
    // Token mock factory
    tokenMockFactory = await ethers.getContractFactory("ERC20UpgradeableMock");

    // Deploy the contract under test
    cashbackDistributorFactory = await ethers.getContractFactory("CashbackDistributor");
    cashbackDistributor = await cashbackDistributorFactory.deploy();
    await cashbackDistributor.deployed();
    await proveTx(cashbackDistributor.initialize());

    // Accounts
    [deployer, distributor, user] = await ethers.getSigners();

    // Roles
    ownerRole = (await cashbackDistributor.OWNER_ROLE()).toLowerCase();
    blacklisterRole = (await cashbackDistributor.BLACKLISTER_ROLE()).toLowerCase();
    pauserRole = (await cashbackDistributor.PAUSER_ROLE()).toLowerCase();
    rescuerRole = (await cashbackDistributor.RESCUER_ROLE()).toLowerCase();
    distributorRole = (await cashbackDistributor.DISTRIBUTOR_ROLE()).toLowerCase();
  });

  async function setUpContractsForSendingCashbacks(cashbacks: TestCashback[]): Promise<Map<Contract, number>> {
    const cashbackDistributorBalanceByToken: Map<Contract, number> = new Map<Contract, number>();
    cashbacks.forEach(cashback => {
      let totalCashbackAmount: number = cashbackDistributorBalanceByToken.get(cashback.token) || 0;
      totalCashbackAmount += cashback.amount;
      cashbackDistributorBalanceByToken.set(cashback.token, totalCashbackAmount);
    });
    for (let [token, totalCashbackAmount] of cashbackDistributorBalanceByToken.entries()) {
      await proveTx(token.mint(cashbackDistributor.address, totalCashbackAmount));
    }
    return cashbackDistributorBalanceByToken;
  }

  async function sendCashbacks(cashbacks: TestCashback[], targetStatus: CashbackStatus) {
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

  async function checkCashbackStructures(cashbacks: TestCashback[]) {
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

  async function checkCashbackNonceByExternalId(cashbacks: TestCashback[]) {
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

  async function checkTotalCashbackByTokenAndExternalId(cashbacks: TestCashback[]) {
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

  async function checkTotalCashbackByTokenAndRecipient(cashbacks: TestCashback[]) {
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

  async function checkCashbackDistributorBalanceByTokens(
    cashbacks: TestCashback[],
    cashbackDistributorInitialBalanceByToken: Map<Contract, number>
  ) {
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

  async function checkCashbackDistributorState(
    cashbacks: TestCashback[],
    cashbackDistributorInitialBalanceByToken: Map<Contract, number>
  ) {
    await checkCashbackStructures(cashbacks);
    await checkCashbackNonceByExternalId(cashbacks);
    await checkTotalCashbackByTokenAndExternalId(cashbacks);
    await checkTotalCashbackByTokenAndRecipient(cashbacks);
    await checkCashbackDistributorBalanceByTokens(cashbacks, cashbackDistributorInitialBalanceByToken);
  }

  it("The initialize function can't be called more than once", async () => {
    await expect(
      cashbackDistributor.initialize()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initial contract configuration should be as expected", async () => {
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
    await checkCashbackDistributorState([], cashbackDistributorInitialBalanceByToken);
  });

  describe("Function 'enable()'", async () => {
    it("Is reverted if the caller does not have the owner role", async () => {
      await expect(
        cashbackDistributor.connect(user).enable()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user.address, ownerRole));
    });

    it("Executes as expected and emits the correct event", async () => {
      await expect(
        cashbackDistributor.enable()
      ).to.emit(
        cashbackDistributor,
        "Enable"
      ).withArgs(
        deployer.address
      );
      expect(await cashbackDistributor.enabled()).to.equal(true);
    });

    it("Is reverted if cashback operations are already enabled", async () => {
      await proveTx(cashbackDistributor.enable());
      await expect(
        cashbackDistributor.enable()
      ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_CASHBACK_ALREADY_ENABLED);
    });
  });

  describe("Function 'disable()'", async () => {
    it("Is reverted if the caller does not have the owner role", async () => {
      await expect(
        cashbackDistributor.connect(user).disable()
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(user.address, ownerRole));
    });

    it("Is reverted if cashback operations are already disabled", async () => {
      await expect(
        cashbackDistributor.disable()
      ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_CASHBACK_ALREADY_DISABLED);
    });

    it("Executes as expected and emits the correct event", async () => {
      await proveTx(cashbackDistributor.enable());
      expect(await cashbackDistributor.enabled()).to.equal(true);
      await expect(
        cashbackDistributor.disable()
      ).to.emit(
        cashbackDistributor,
        "Disable"
      ).withArgs(
        deployer.address
      );
      expect(await cashbackDistributor.enabled()).to.equal(false);
    });
  });

  describe("Function 'sendCashback()'", async () => {
    let cashback: TestCashback;

    beforeEach(async () => {
      cashback = {
        token: tokenMockFactory.attach(TOKEN_ADDRESS_STUB),
        kind: CashbackKind.CardPayment,
        status: CashbackStatus.Nonexistent,
        externalId: CASHBACK_EXTERNAL_ID_STUB1,
        recipient: user,
        amount: 123,
        sender: distributor,
        nonce: 1,
      };
      await proveTx(cashbackDistributor.grantRole(distributorRole, distributor.address));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cashbackDistributor.grantRole(pauserRole, deployer.address));
      await proveTx(cashbackDistributor.pause());
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

    it("Is reverted if the caller does not have the distributor role", async () => {
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

    it("Is reverted if the token address is zero", async () => {
      await expect(
        cashbackDistributor.connect(cashback.sender).sendCashback(
          ethers.constants.AddressZero,
          cashback.kind,
          cashback.externalId,
          cashback.recipient.address,
          cashback.amount
        )
      ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_TOKEN_ADDRESS_IS_ZERO);
    });

    it("Is reverted if the recipient address is zero", async () => {
      await expect(
        cashbackDistributor.connect(cashback.sender).sendCashback(
          cashback.token.address,
          cashback.kind,
          cashback.externalId,
          ethers.constants.AddressZero,
          cashback.amount
        )
      ).to.be.revertedWithCustomError(cashbackDistributor, REVERT_ERROR_IF_RECIPIENT_ADDRESS_IS_ZERO);
    });

    it("Is reverted if the cashback external ID is zero", async () => {
      cashback.externalId = ethers.constants.HashZero;
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

    describe("Executes as expected and emits the correct event if the sending succeeds and", async () => {
      let cashbackDistributorInitialBalanceByToken: Map<Contract, number>;

      beforeEach(async () => {
        cashback.token = await deployTokenMock();
        cashbackDistributorInitialBalanceByToken = await setUpContractsForSendingCashbacks([cashback]);
      });

      async function checkSuccessfulCashbackSending() {
        await proveTx(cashbackDistributor.enable());
        cashback.status = CashbackStatus.Success;
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
          [-cashback.amount, +cashback.amount, 0]
        ).and.to.emit(
          cashbackDistributor,
          "SendCashback"
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
        await checkCashbackDistributorState([cashback], cashbackDistributorInitialBalanceByToken);
      }

      it("The cashback amount is nonzero", async () => {
        await checkSuccessfulCashbackSending();
      });

      it("The cashback amount is zero", async () => {
        cashback.amount = 0;
        await checkSuccessfulCashbackSending();
      });
    });

    describe("Executes as expected and emits the correct event if the sending fails because", async () => {
      let cashbackDistributorInitialBalanceByToken: Map<Contract, number>;

      beforeEach(async () => {
        cashback.token = await deployTokenMock();
        cashbackDistributorInitialBalanceByToken = await setUpContractsForSendingCashbacks([cashback]);
      });

      async function checkUnsuccessfulCashbackSending() {
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
          [0, 0, 0]
        ).and.to.emit(
          cashbackDistributor,
          "SendCashback"
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
        await checkCashbackDistributorState([cashback], cashbackDistributorInitialBalanceByToken);
      }

      it("Cashback operations are disabled", async () => {
        cashback.status = CashbackStatus.Disabled;
        await checkUnsuccessfulCashbackSending();
      });

      it("The cashback distributor contract has not enough balance", async () => {
        await proveTx(cashbackDistributor.enable());
        cashback.amount = cashback.amount + 1;
        cashback.status = CashbackStatus.OutOfFunds;
        await checkUnsuccessfulCashbackSending();
      });

      it("The cashback recipient is blacklisted", async () => {
        await proveTx(cashbackDistributor.enable());
        await proveTx(cashbackDistributor.grantRole(blacklisterRole, deployer.address));
        await proveTx(cashbackDistributor.blacklist(cashback.recipient.address));
        cashback.status = CashbackStatus.Blacklisted;
        await checkUnsuccessfulCashbackSending();
      });
    });
  });

  describe("Function 'revokeCashback()'", async () => {
    let cashback: TestCashback;

    beforeEach(async () => {
      cashback = {
        token: tokenMockFactory.attach(TOKEN_ADDRESS_STUB),
        kind: CashbackKind.CardPayment,
        status: CashbackStatus.Nonexistent,
        externalId: CASHBACK_EXTERNAL_ID_STUB1,
        recipient: user,
        amount: 123,
        sender: distributor,
        nonce: 1,
        revokedAmount: 12,
      };
      await proveTx(cashbackDistributor.grantRole(distributorRole, distributor.address));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(cashbackDistributor.grantRole(pauserRole, deployer.address));
      await proveTx(cashbackDistributor.pause());
      await expect(
        cashbackDistributor.connect(cashback.sender).revokeCashback(cashback.nonce, cashback.revokedAmount)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the distributor role", async () => {
      await expect(
        cashbackDistributor.revokeCashback(cashback.nonce, cashback.revokedAmount)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, distributorRole));
    });

    describe("Executes as expected and emits the correct event if the revocation succeeds and", async () => {
      let cashbackDistributorInitialBalanceByToken: Map<Contract, number>;

      beforeEach(async () => {
        cashback.token = await deployTokenMock();
        cashbackDistributorInitialBalanceByToken = await setUpContractsForSendingCashbacks([cashback]);
      });

      async function checkRevokingOfSuccessfulCashback() {
        await proveTx(cashbackDistributor.enable());
        await sendCashbacks([cashback], CashbackStatus.Success);
        await proveTx(cashback.token.mint(cashback.sender.address, cashback.revokedAmount));
        await proveTx(cashback.token.connect(cashback.sender).approve(
          cashbackDistributor.address,
          ethers.constants.MaxUint256
        ));

        await expect(
          cashbackDistributor.connect(cashback.sender).revokeCashback(cashback.nonce, cashback.revokedAmount)
        ).to.changeTokenBalances(
          cashback.token,
          [cashbackDistributor, cashback.recipient, cashback.sender],
          [+(cashback.revokedAmount || 0), 0, -(cashback.revokedAmount || 0)]
        ).and.to.emit(
          cashbackDistributor,
          "RevokeCashback"
        ).withArgs(
          cashback.token.address,
          cashback.kind,
          cashback.status,
          RevocationStatus.Success,
          cashback.externalId,
          cashback.recipient.address,
          cashback.revokedAmount,
          cashback.sender.address,
          cashback.nonce,
        );
        await checkCashbackDistributorState([cashback], cashbackDistributorInitialBalanceByToken);
      }

      it("The revocation amount is less than the initial cashback amount", async () => {
        await checkRevokingOfSuccessfulCashback();
      });

      it("The revocation amount equals the initial cashback amount", async () => {
        cashback.revokedAmount = cashback.amount;
        await checkRevokingOfSuccessfulCashback();
      });

      it("The revocation amount is zero", async () => {
        cashback.revokedAmount = 0;
        await checkRevokingOfSuccessfulCashback();
      });
    });

    describe("Executes as expected and emits the correct event if the revocation fails because", async () => {
      let cashbackDistributorInitialBalanceByToken: Map<Contract, number>;

      beforeEach(async () => {
        cashback.token = await deployTokenMock();
        cashbackDistributorInitialBalanceByToken = await setUpContractsForSendingCashbacks([cashback]);
      });

      async function checkRevokingOfUnsuccessfulCashback(targetRevocationStatus: RevocationStatus) {
        await expect(
          cashbackDistributor.connect(cashback.sender).revokeCashback(cashback.nonce, cashback.revokedAmount)
        ).to.changeTokenBalances(
          cashback.token,
          [cashbackDistributor, cashback.recipient, cashback.sender],
          [0, 0, 0]
        ).and.to.emit(
          cashbackDistributor,
          "RevokeCashback"
        ).withArgs(
          cashback.token.address,
          cashback.kind,
          cashback.status,
          targetRevocationStatus,
          cashback.externalId,
          cashback.recipient.address,
          cashback.revokedAmount,
          cashback.sender.address,
          cashback.nonce,
        );
        cashback.revokedAmount = 0;
        await checkCashbackDistributorState([cashback], cashbackDistributorInitialBalanceByToken);
      }

      it("The caller has not enough tokens", async () => {
        await proveTx(cashbackDistributor.enable());
        await sendCashbacks([cashback], CashbackStatus.Success);
        await proveTx(cashback.token.mint(cashback.sender.address, (cashback.revokedAmount || 0) - 1));
        await proveTx(cashback.token.connect(cashback.sender).approve(
          cashbackDistributor.address,
          ethers.constants.MaxUint256
        ));
        await checkRevokingOfUnsuccessfulCashback(RevocationStatus.OutOfFunds);
      });

      it("The cashback distributor has not enough allowance from the caller", async () => {
        await proveTx(cashbackDistributor.enable());
        await sendCashbacks([cashback], CashbackStatus.Success);
        await proveTx(cashback.token.mint(cashback.sender.address, cashback.revokedAmount));
        await proveTx(cashback.token.connect(cashback.sender).approve(
          cashbackDistributor.address,
          (cashback.revokedAmount || 0) - 1
        ));
        await checkRevokingOfUnsuccessfulCashback(RevocationStatus.OutOfAllowance);
      });

      it("Cashback operations were disabled prior cashback sending", async () => {
        await sendCashbacks([cashback], CashbackStatus.Disabled);
        await checkRevokingOfUnsuccessfulCashback(RevocationStatus.Inapplicable);
      });

      it("The cashback distributor had not enough balance prior cashback sending", async () => {
        await proveTx(cashbackDistributor.enable());
        cashback.amount = cashback.amount + 1;
        await sendCashbacks([cashback], CashbackStatus.OutOfFunds);
        await checkRevokingOfUnsuccessfulCashback(RevocationStatus.Inapplicable);
      });

      it("The cashback recipient was blacklisted prior cashback sending", async () => {
        await proveTx(cashbackDistributor.enable());
        await proveTx(cashbackDistributor.grantRole(blacklisterRole, deployer.address));
        await proveTx(cashbackDistributor.blacklist(cashback.recipient.address));
        await sendCashbacks([cashback], CashbackStatus.Blacklisted);
        await checkRevokingOfUnsuccessfulCashback(RevocationStatus.Inapplicable);
      });

      it("The initial cashback amount is less than revocation amount", async () => {
        await proveTx(cashbackDistributor.enable());
        await sendCashbacks([cashback], CashbackStatus.Success);
        await proveTx(cashback.token.mint(cashback.sender.address, cashback.amount + 1));
        await proveTx(cashback.token.connect(cashback.sender).approve(
          cashbackDistributor.address,
          ethers.constants.MaxUint256
        ));
        cashback.revokedAmount = cashback.amount + 1;
        await checkRevokingOfUnsuccessfulCashback(RevocationStatus.OutOfBalance);
      });
    });
  });

  describe("Getter functions 'getCashbackNonces()' and 'getCashbacks()'", async () => {
    let cashbacks: TestCashback[];
    let cashbackNonces: BigNumber[];

    beforeEach(async () => {
      const tokenMock: Contract = await deployTokenMock();
      cashbacks = [1, 2, 3].map(nonceValue => {
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
      cashbackNonces = cashbacks.map(cashback => BigNumber.from(cashback.nonce));
      await proveTx(cashbackDistributor.grantRole(distributorRole, distributor.address));
    });

    it("Execute as expected", async () => {
      await proveTx(cashbackDistributor.enable());
      await setUpContractsForSendingCashbacks(cashbacks);
      await sendCashbacks(cashbacks, CashbackStatus.Success);

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
    let tokenMock1: Contract;
    let tokenMock2: Contract;
    let cashbacks: TestCashback[];
    let begNonce: number;
    let endNonce: number;
    let cashbackDistributorInitialBalanceByToken: Map<Contract, number>;

    beforeEach(async () => {
      tokenMock1 = await deployTokenMock("TEST1");
      tokenMock2 = await deployTokenMock("TEST2");

      cashbacks = [1, 2, 3, 4, 5, 6, 7, 8].map(nonce => {
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
      begNonce = cashbacks[0].nonce;
      endNonce = cashbacks[cashbacks.length - 1].nonce + 1;
      await proveTx(cashbackDistributor.grantRole(distributorRole, distributor.address));
      cashbackDistributorInitialBalanceByToken = await setUpContractsForSendingCashbacks(cashbacks);
    });

    async function revokeCashback(cashback: TestCashback) {
      await proveTx(cashback.token.mint(cashback.sender.address, cashback.revokedAmount || 0));
      await proveTx(
        cashback.token.connect(cashback.sender).approve(cashbackDistributor.address, cashback.revokedAmount || 0)
      );
      await proveTx(
        cashbackDistributor.connect(cashback.sender).revokeCashback(cashback.nonce, cashback.revokedAmount || 0)
      );
    }

    it("Execute as expected", async () => {
      await proveTx(cashbackDistributor.enable());
      await sendCashbacks(cashbacks, CashbackStatus.Success);
      await checkCashbackDistributorState(cashbacks, cashbackDistributorInitialBalanceByToken);

      await revokeCashback(cashbacks[3]);
      await checkCashbackDistributorState(cashbacks, cashbackDistributorInitialBalanceByToken);

      await revokeCashback(cashbacks[0]);
      await checkCashbackDistributorState(cashbacks, cashbackDistributorInitialBalanceByToken);

      await revokeCashback(cashbacks[1]);
      await checkCashbackDistributorState(cashbacks, cashbackDistributorInitialBalanceByToken);
    });
  });
});
