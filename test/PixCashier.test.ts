import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createRevertMessageDueToMissingRole } from "../test-utils/misc";

enum CashOutStatus {
  Nonexistent = 0,
  Pending = 1,
  Reversed = 2,
  Confirmed = 3,
}

interface TestCashOut {
  account: SignerWithAddress;
  amount: number;
  txId: string;
  status: CashOutStatus;
}

interface PixCashierState {
  tokenBalance: number;
  pendingCashOutCounter: number;
  processedCashOutCounter: number;
  pendingCashOutTxIds: string[];
  cashOutBalancePerAccount: Map<string, number>;
}

function checkEquality(
  actualOnChainCashOut: any,
  expectedCashOut: TestCashOut,
  cashOutIndex: number
) {
  if (expectedCashOut.status == CashOutStatus.Nonexistent) {
    expect(actualOnChainCashOut.account).to.equal(
      ethers.constants.AddressZero,
      `cashOuts[${cashOutIndex}].account is incorrect`
    );
    expect(actualOnChainCashOut.amount).to.equal(
      0,
      `cashOuts[${cashOutIndex}].amount is incorrect`
    );
  } else {
    expect(actualOnChainCashOut.account).to.equal(
      expectedCashOut.account.address,
      `cashOuts[${cashOutIndex}].account is incorrect`
    );
    expect(actualOnChainCashOut.amount).to.equal(
      expectedCashOut.amount,
      `cashOuts[${cashOutIndex}].amount is incorrect`
    );
    expect(actualOnChainCashOut.status).to.equal(
      expectedCashOut.status,
      `cashOut[${cashOutIndex}].status is incorrect`
    );
  }
}

describe("Contract 'PixCashier'", async () => {
  const TRANSACTION_ID1 = ethers.utils.formatBytes32String("MOCK_TRANSACTION_ID1");
  const TRANSACTION_ID2 = ethers.utils.formatBytes32String("MOCK_TRANSACTION_ID2");
  const TRANSACTION_ID3 = ethers.utils.formatBytes32String("MOCK_TRANSACTION_ID3");

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_TOKEN_ADDRESS_IZ_ZERO = "ZeroTokenAddress";
  const REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED = "BlacklistedAccount";
  const REVERT_ERROR_IF_ACCOUNT_IS_ZERO = "ZeroAccount";
  const REVERT_ERROR_IF_AMOUNT_IS_ZERO = "ZeroAmount";
  const REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO = "ZeroTxId";
  const REVERT_ERROR_IF_TOKEN_MINTING_FAILURE = "TokenMintingFailure";
  const REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS = "InappropriateCashOutStatus";
  const REVERT_ERROR_IF_EMPTY_TRANSACTION_IDS_ARRAY = "EmptyTransactionIdsArray";

  let PixCashier: ContractFactory;
  let pixCashier: Contract;
  let tokenMock: Contract;
  let deployer: SignerWithAddress;
  let cashier: SignerWithAddress;
  let user: SignerWithAddress;
  let ownerRole: string;
  let blacklisterRole: string;
  let pauserRole: string;
  let rescuerRole: string;
  let cashierRole: string;

  beforeEach(async () => {
    // Deploy the token mock contract
    const TokenMock: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    tokenMock = await TokenMock.deploy();
    await tokenMock.deployed();
    await proveTx(tokenMock.initialize("ERC20 Test", "TEST"));

    // Deploy the being tested contract
    PixCashier = await ethers.getContractFactory("PixCashier");
    pixCashier = await PixCashier.deploy();
    await pixCashier.deployed();
    await proveTx(pixCashier.initialize(tokenMock.address));

    // Accounts
    [deployer, cashier, user] = await ethers.getSigners();

    // Roles
    ownerRole = (await pixCashier.OWNER_ROLE()).toLowerCase();
    blacklisterRole = (await pixCashier.BLACKLISTER_ROLE()).toLowerCase();
    pauserRole = (await pixCashier.PAUSER_ROLE()).toLowerCase();
    rescuerRole = (await pixCashier.RESCUER_ROLE()).toLowerCase();
    cashierRole = (await pixCashier.CASHIER_ROLE()).toLowerCase();
  });

  async function setUpContractsForCashOuts(cashOuts: TestCashOut[]) {
    for (let cashOut of cashOuts) {
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount));
      const allowance: BigNumber = await tokenMock.allowance(cashOut.account.address, pixCashier.address);
      if (allowance.lt(BigNumber.from(ethers.constants.MaxUint256))) {
        await proveTx(
          tokenMock.connect(cashOut.account).approve(
            pixCashier.address,
            ethers.constants.MaxUint256
          )
        );
      }
    }
  }

  async function requestCashOuts(cashOuts: TestCashOut[]) {
    for (let cashOut of cashOuts) {
      await proveTx(
        pixCashier.connect(cashier).requestCashOutFrom(
          cashOut.account.address,
          cashOut.amount,
          cashOut.txId
        )
      );
      cashOut.status = CashOutStatus.Pending;
    }
  }

  function defineExpectedPixCashierState(cashOuts: TestCashOut[]): PixCashierState {
    let tokenBalance: number = 0;
    let pendingCashOutCounter: number = 0;
    let processedCashOutCounter: number = 0;
    const pendingCashOutTxIds: string[] = [];
    const cashOutBalancePerAccount: Map<string, number> = new Map<string, number>();

    for (let cashOut of cashOuts) {
      let newCashOutBalance: number = cashOutBalancePerAccount.get(cashOut.account.address) || 0;
      if (cashOut.status == CashOutStatus.Pending) {
        pendingCashOutTxIds.push(cashOut.txId);
        ++pendingCashOutCounter;
        tokenBalance += cashOut.amount;
        newCashOutBalance += cashOut.amount;
      }
      cashOutBalancePerAccount.set(cashOut.account.address, newCashOutBalance);
      if (cashOut.status == CashOutStatus.Reversed || cashOut.status == CashOutStatus.Confirmed) {
        ++processedCashOutCounter;
      }
    }

    return {
      tokenBalance,
      pendingCashOutCounter,
      processedCashOutCounter,
      pendingCashOutTxIds,
      cashOutBalancePerAccount,
    };
  }

  async function checkCashOutStructuresOnBlockchain(cashOuts: TestCashOut[]) {
    const txIds: string[] = cashOuts.map(cashOut => cashOut.txId);
    const actualCashOuts: any[] = await pixCashier.getCashOuts(txIds);
    for (let i = 0; i < cashOuts.length; ++i) {
      const cashOut: TestCashOut = cashOuts[i];
      const actualCashOut: any = await pixCashier.getCashOut(cashOut.txId);
      checkEquality(actualCashOut, cashOut, i);
      checkEquality(actualCashOuts[i], cashOut, i);
    }
  }

  async function checkPixCashierState(cashOuts: TestCashOut[], expectedProcessedCashOutCounter?: number) {
    const expectedState: PixCashierState = defineExpectedPixCashierState(cashOuts);
    await checkCashOutStructuresOnBlockchain(cashOuts);

    expect(
      await tokenMock.balanceOf(pixCashier.address)
    ).to.equal(
      expectedState.tokenBalance,
      `The PIX cashier total balance is wrong`
    );

    const actualPendingCashOutCounter = await pixCashier.pendingCashOutCounter();
    expect(actualPendingCashOutCounter).to.equal(
      expectedState.pendingCashOutCounter,
      `The pending cash-out counter is wrong`
    );

    if (!expectedProcessedCashOutCounter) {
      expectedProcessedCashOutCounter = expectedState.processedCashOutCounter;
    }
    expect(await pixCashier.processedCashOutCounter()).to.equal(
      expectedProcessedCashOutCounter,
      `The processed cash-out counter is wrong`
    );

    let actualPendingCashOutTxIds: string[] = await pixCashier.getPendingCashOutTxIds(0, actualPendingCashOutCounter);
    expect(actualPendingCashOutTxIds).to.deep.equal(
      expectedState.pendingCashOutTxIds,
      `The pending cash-out tx ids are wrong`
    );

    for (const account of expectedState.cashOutBalancePerAccount.keys()) {
      const expectedCashOutBalance = expectedState.cashOutBalancePerAccount.get(account);
      if (!expectedCashOutBalance) {
        continue;
      }
      expect(
        await pixCashier.cashOutBalanceOf(account)
      ).to.equal(
        expectedCashOutBalance,
        `The cash-out balance for account ${account} is wrong`
      );
    }
  }

  it("The initialize function can't be called more than once", async () => {
    await expect(
      pixCashier.initialize(tokenMock.address)
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initialize function is reverted if the passed token address is zero", async () => {
    const anotherPixCashier: Contract = await PixCashier.deploy();
    await anotherPixCashier.deployed();
    await expect(
      anotherPixCashier.initialize(ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(PixCashier, REVERT_ERROR_IF_TOKEN_ADDRESS_IZ_ZERO);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The underlying contract address
    expect(await pixCashier.underlyingToken()).to.equal(tokenMock.address);

    // The role admins
    expect(await pixCashier.getRoleAdmin(ownerRole)).to.equal(ownerRole);
    expect(await pixCashier.getRoleAdmin(blacklisterRole)).to.equal(ownerRole);
    expect(await pixCashier.getRoleAdmin(pauserRole)).to.equal(ownerRole);
    expect(await pixCashier.getRoleAdmin(rescuerRole)).to.equal(ownerRole);
    expect(await pixCashier.getRoleAdmin(cashierRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await pixCashier.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await pixCashier.hasRole(blacklisterRole, deployer.address)).to.equal(false);
    expect(await pixCashier.hasRole(pauserRole, deployer.address)).to.equal(false);
    expect(await pixCashier.hasRole(rescuerRole, deployer.address)).to.equal(false);
    expect(await pixCashier.hasRole(cashierRole, deployer.address)).to.equal(false);

    // The initial contract state is unpaused
    expect(await pixCashier.paused()).to.equal(false);

    // The initial values of counters and pending cash-outs
    expect(await pixCashier.pendingCashOutCounter()).to.equal(0);
    expect(await pixCashier.processedCashOutCounter()).to.equal(0);
    expect(await pixCashier.getPendingCashOutTxIds(0, 1)).to.be.empty;
  });

  describe("Function 'cashIn()'", async () => {
    const tokenAmount: number = 100;

    beforeEach(async () => {
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, TRANSACTION_ID1)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).cashIn(user.address, tokenAmount, TRANSACTION_ID1)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the account address is zero", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(ethers.constants.AddressZero, tokenAmount, TRANSACTION_ID1)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_ZERO);
    });

    it("Is reverted if the token amount is zero", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, 0, TRANSACTION_ID1)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if minting function returns 'false'", async () => {
      await proveTx(tokenMock.setMintResult(false));
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, TRANSACTION_ID1)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TOKEN_MINTING_FAILURE);
    });

    it("Mints correct amount of tokens and emits the correct event", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, TRANSACTION_ID1)
      ).to.changeTokenBalances(
        tokenMock,
        [user, pixCashier],
        [+tokenAmount, 0]
      ).and.to.emit(
        pixCashier,
        "CashIn"
      ).withArgs(
        user.address,
        tokenAmount,
        TRANSACTION_ID1
      );
    });
  });

  describe("Function 'requestCashOutFrom()'", async () => {
    let cashOut: TestCashOut;

    beforeEach(async () => {
      cashOut = {
        account: user,
        amount: 200,
        txId: TRANSACTION_ID1,
        status: CashOutStatus.Nonexistent,
      };
      await proveTx(tokenMock.connect(cashOut.account).approve(pixCashier.address, ethers.constants.MaxUint256));
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the account is blacklisted", async () => {
      await proveTx(pixCashier.grantRole(blacklisterRole, deployer.address));
      await proveTx(pixCashier.blacklist(cashOut.account.address));
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Is reverted if the account address is zero", async () => {
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(ethers.constants.AddressZero, cashOut.amount, cashOut.txId)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_ZERO);
    });

    it("Is reverted if the token amount is zero", async () => {
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, 0, cashOut.txId)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(
          cashOut.account.address,
          cashOut.amount,
          ethers.constants.HashZero
        )
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the cash-out with the provided txId is already pending", async () => {
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount));
      await pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId);
      expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Pending);
    });

    it("Is reverted if the user has not enough tokens", async () => {
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount - 1));
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
    });

    it("Transfers tokens as expected, emits the correct event, changes cash-out balances accordingly", async () => {
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount));
      await checkPixCashierState([cashOut]);
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.changeTokenBalances(
        tokenMock,
        [cashOut.account, pixCashier, cashier],
        [-cashOut.amount, +cashOut.amount, 0]
      ).and.to.emit(
        pixCashier,
        "RequestCashOut"
      ).withArgs(
        cashOut.account.address,
        cashOut.amount,
        cashOut.amount,
        cashOut.txId,
        cashier.address
      );
      cashOut.status = CashOutStatus.Pending;
      await checkPixCashierState([cashOut]);
    });
  });

  describe("Function 'confirmCashOut()'", async () => {
    let cashOut: TestCashOut;

    beforeEach(async () => {
      cashOut = {
        account: user,
        amount: 100,
        txId: TRANSACTION_ID1,
        status: CashOutStatus.Nonexistent,
      };
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
      await setUpContractsForCashOuts([cashOut]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).confirmCashOut(cashOut.txId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).confirmCashOut(cashOut.txId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await expect(
        pixCashier.connect(cashier).confirmCashOut(ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the cash-out with the provided txId was not requested previously", async () => {
      await expect(
        pixCashier.connect(cashier).confirmCashOut(cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Nonexistent);
    });

    it("Burns tokens as expected, emits the correct event, changes the contract state accordingly", async () => {
      await requestCashOuts([cashOut]);
      cashOut.status = CashOutStatus.Pending;
      await checkPixCashierState([cashOut]);
      await expect(
        pixCashier.connect(cashier).confirmCashOut(cashOut.txId)
      ).to.changeTokenBalances(
        tokenMock,
        [pixCashier, cashOut.account],
        [-cashOut.amount, 0]
      ).and.to.emit(
        pixCashier,
        "ConfirmCashOut"
      ).withArgs(
        cashOut.account.address,
        cashOut.amount,
        0,
        cashOut.txId
      );
      cashOut.status = CashOutStatus.Confirmed;
      await checkPixCashierState([cashOut]);
    });
  });

  describe("Function 'confirmCashOuts()'", async () => {
    let cashOuts: TestCashOut[];
    let txIds: string[];

    beforeEach(async () => {
      cashOuts = [
        {
          account: user,
          amount: 100,
          txId: TRANSACTION_ID1,
          status: CashOutStatus.Nonexistent,
        },
        {
          account: deployer,
          amount: 200,
          txId: TRANSACTION_ID2,
          status: CashOutStatus.Nonexistent,
        },
      ];
      txIds = cashOuts.map(cashOut => cashOut.txId);
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
      await setUpContractsForCashOuts(cashOuts);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).confirmCashOuts(txIds)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).confirmCashOuts(txIds)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the off-chain transaction IDs array is empty", async () => {
      await expect(
        pixCashier.connect(cashier).confirmCashOuts([])
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_EMPTY_TRANSACTION_IDS_ARRAY);
    });

    it("Burns tokens as expected, emits the correct event, changes the contract state accordingly", async () => {
      await requestCashOuts(cashOuts);
      await checkPixCashierState(cashOuts);
      const totalTokens = countNumberArrayTotal(cashOuts.map(cashOut => cashOut.amount));
      await expect(
        pixCashier.connect(cashier).confirmCashOuts(txIds)
      ).to.changeTokenBalances(
        tokenMock,
        [pixCashier, ...cashOuts.map(cashOut => cashOut.account)],
        [-totalTokens, ...cashOuts.map(() => 0)]
      ).and.to.emit(
        pixCashier,
        "ConfirmCashOut"
      ).withArgs(
        cashOuts[0].account.address,
        cashOuts[0].amount,
        0,
        cashOuts[0].txId
      ).and.to.emit(
        pixCashier,
        "ConfirmCashOut"
      ).withArgs(
        cashOuts[1].account.address,
        cashOuts[1].amount,
        0,
        cashOuts[1].txId
      );
      cashOuts.forEach(cashOut => cashOut.status = CashOutStatus.Confirmed);
      await checkPixCashierState(cashOuts);
    });

    it("Is reverted if one of the off-chain transaction IDs is zero", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = ethers.constants.HashZero;
      await expect(
        pixCashier.connect(cashier).confirmCashOuts(txIds)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if one of the cash-outs was not requested previously", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = TRANSACTION_ID3;
      await expect(
        pixCashier.connect(cashier).confirmCashOuts(txIds)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(TRANSACTION_ID3, CashOutStatus.Nonexistent);
    });
  });

  describe("Function 'reverseCashOut()'", async () => {
    let cashOut: TestCashOut;

    beforeEach(async () => {
      cashOut = {
        account: user,
        amount: 100,
        txId: TRANSACTION_ID1,
        status: CashOutStatus.Nonexistent,
      };
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
      await setUpContractsForCashOuts([cashOut]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).reverseCashOut(cashOut.txId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).reverseCashOut(cashOut.txId)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await expect(
        pixCashier.connect(cashier).reverseCashOut(ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the cash-out with the provided txId was not requested previously", async () => {
      await expect(
        pixCashier.connect(cashier).reverseCashOut(cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Nonexistent);
    });

    it("Transfers tokens as expected, emits the correct event, changes the contract state accordingly", async () => {
      await requestCashOuts([cashOut]);
      cashOut.status = CashOutStatus.Pending;
      await checkPixCashierState([cashOut]);
      await expect(
        pixCashier.connect(cashier).reverseCashOut(cashOut.txId)
      ).to.changeTokenBalances(
        tokenMock,
        [cashOut.account, pixCashier, cashier],
        [+cashOut.amount, -cashOut.amount, 0]
      ).and.to.emit(
        pixCashier,
        "ReverseCashOut"
      ).withArgs(
        cashOut.account.address,
        cashOut.amount,
        0,
        cashOut.txId
      );
      cashOut.status = CashOutStatus.Reversed;
      await checkPixCashierState([cashOut]);
    });
  });

  describe("Function 'reverseCashOuts()'", async () => {
    let cashOuts: TestCashOut[];
    let txIds: string[];

    beforeEach(async () => {
      cashOuts = [
        {
          account: user,
          amount: 123,
          txId: TRANSACTION_ID1,
          status: CashOutStatus.Nonexistent,
        },
        {
          account: deployer,
          amount: 456,
          txId: TRANSACTION_ID2,
          status: CashOutStatus.Nonexistent,
        },
      ];
      txIds = cashOuts.map(cashOut => cashOut.txId);
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
      await setUpContractsForCashOuts(cashOuts);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).reverseCashOuts(txIds)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).reverseCashOuts(txIds)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the off-chain transaction IDs array is empty", async () => {
      await expect(
        pixCashier.connect(cashier).reverseCashOuts([])
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_EMPTY_TRANSACTION_IDS_ARRAY);
    });

    it("Transfers tokens as expected, emits the correct event, changes the contract state accordingly", async () => {
      await requestCashOuts(cashOuts);
      await checkPixCashierState(cashOuts);
      const totalTokens = countNumberArrayTotal(cashOuts.map(cashOut => cashOut.amount));
      await expect(
        pixCashier.connect(cashier).reverseCashOuts(txIds)
      ).to.changeTokenBalances(
        tokenMock,
        [pixCashier, cashier, ...cashOuts.map(cashOut => cashOut.account)],
        [-totalTokens, 0, ...cashOuts.map(cashOut => cashOut.amount)]
      ).and.to.emit(
        pixCashier,
        "ReverseCashOut"
      ).withArgs(
        cashOuts[0].account.address,
        cashOuts[0].amount,
        0,
        cashOuts[0].txId
      ).and.to.emit(
        pixCashier,
        "ReverseCashOut"
      ).withArgs(
        cashOuts[1].account.address,
        cashOuts[1].amount,
        0,
        cashOuts[1].txId
      );
      cashOuts.forEach(cashOut => cashOut.status = CashOutStatus.Reversed);
      await checkPixCashierState(cashOuts);
    });

    it("Is reverted if one of the off-chain transaction IDs is zero", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = ethers.constants.HashZero;
      await expect(
        pixCashier.connect(cashier).reverseCashOuts(txIds)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if one of the cash-outs was not requested previously", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = TRANSACTION_ID3;
      await expect(
        pixCashier.connect(cashier).reverseCashOuts(txIds)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(TRANSACTION_ID3, CashOutStatus.Nonexistent);
    });
  });

  describe("Function 'getPendingCashOutTxIds()'", async () => {
    let cashOuts: TestCashOut[];
    let txIds: string[];

    beforeEach(async () => {
      cashOuts = [
        {
          account: user,
          amount: 100,
          txId: TRANSACTION_ID1,
          status: CashOutStatus.Nonexistent,
        },
        {
          account: deployer,
          amount: 200,
          txId: TRANSACTION_ID2,
          status: CashOutStatus.Nonexistent,
        },
        {
          account: user,
          amount: 300,
          txId: TRANSACTION_ID3,
          status: CashOutStatus.Nonexistent,
        },
      ];
      txIds = cashOuts.map(cashOut => cashOut.txId);
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
      await setUpContractsForCashOuts(cashOuts);
    });

    it("Returns expected values in different cases", async () => {
      await requestCashOuts(cashOuts);
      let actualTxIds: string[];

      actualTxIds = await pixCashier.getPendingCashOutTxIds(0, 50);
      expect(actualTxIds).to.be.deep.equal(txIds);

      actualTxIds = await pixCashier.getPendingCashOutTxIds(0, 2);
      expect(actualTxIds).to.be.deep.equal([txIds[0], txIds[1]]);

      actualTxIds = await pixCashier.getPendingCashOutTxIds(1, 2);
      expect(actualTxIds).to.be.deep.equal([txIds[1], txIds[2]]);

      actualTxIds = await pixCashier.getPendingCashOutTxIds(1, 1);
      expect(actualTxIds).to.be.deep.equal([txIds[1]]);

      actualTxIds = await pixCashier.getPendingCashOutTxIds(1, 50);
      expect(actualTxIds).to.be.deep.equal([txIds[1], txIds[2]]);

      actualTxIds = await pixCashier.getPendingCashOutTxIds(3, 50);
      expect(actualTxIds).to.be.deep.equal([]);

      actualTxIds = await pixCashier.getPendingCashOutTxIds(1, 0);
      expect(actualTxIds).to.be.deep.equal([]);
    });
  });

  describe("Complex scenarios", async () => {
    const cashInTokenAmount: number = 100;
    let cashOut: TestCashOut;

    beforeEach(async () => {
      cashOut = {
        account: user,
        amount: 80,
        txId: TRANSACTION_ID1,
        status: CashOutStatus.Nonexistent,
      };
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
      await proveTx(tokenMock.connect(cashOut.account).approve(pixCashier.address, ethers.constants.MaxUint256));
    });

    it("Scenario 1 with cash-out reversing executes successfully", async () => {
      await proveTx(pixCashier.connect(cashier).cashIn(cashOut.account.address, cashInTokenAmount, cashOut.txId));
      await requestCashOuts([cashOut]);
      await proveTx(pixCashier.connect(cashier).reverseCashOut(cashOut.txId));
      cashOut.status = CashOutStatus.Reversed;
      await checkPixCashierState([cashOut]);

      // After reversing a cash-out with the same txId can't be reversed again.
      await expect(
        pixCashier.connect(cashier).reverseCashOut(cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Reversed);
      await expect(
        pixCashier.connect(cashier).reverseCashOuts([cashOut.txId])
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Reversed);

      // After reversing a cash-out with the same txId can't be confirmed.
      await expect(
        pixCashier.connect(cashier).confirmCashOut(cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Reversed);
      await expect(
        pixCashier.connect(cashier).confirmCashOuts([cashOut.txId])
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Reversed);

      expect(await tokenMock.balanceOf(cashOut.account.address)).to.equal(cashInTokenAmount);

      // After reversing a cash-out with the same txId can be requested again.
      await requestCashOuts([cashOut]);
      await checkPixCashierState([cashOut], 1);
      expect(await tokenMock.balanceOf(cashOut.account.address)).to.equal(cashInTokenAmount - cashOut.amount);
    });

    it("Scenario 2 with cash-out confirming executes successfully", async () => {
      await proveTx(pixCashier.connect(cashier).cashIn(cashOut.account.address, cashInTokenAmount, cashOut.txId));
      await requestCashOuts([cashOut]);
      await proveTx(pixCashier.connect(cashier).confirmCashOut(cashOut.txId));
      cashOut.status = CashOutStatus.Confirmed;
      await checkPixCashierState([cashOut]);

      // After confirming a cash-out with the same txId can't be reversed again.
      await expect(
        pixCashier.connect(cashier).reverseCashOut(cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Confirmed);
      await expect(
        pixCashier.connect(cashier).reverseCashOuts([cashOut.txId])
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Confirmed);

      // After confirming a cash-out with the same txId can't be confirmed.
      await expect(
        pixCashier.connect(cashier).confirmCashOut(cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Confirmed);
      await expect(
        pixCashier.connect(cashier).confirmCashOuts([cashOut.txId])
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Confirmed);

      expect(await tokenMock.balanceOf(cashOut.account.address)).to.equal(cashInTokenAmount - cashOut.amount);

      // After confirming a cash-out with the same txId can be requested again.
      cashOut.amount = cashInTokenAmount - cashOut.amount;
      await requestCashOuts([cashOut]);
      cashOut.status = CashOutStatus.Pending;
      await checkPixCashierState([cashOut], 1);
      expect(await tokenMock.balanceOf(cashOut.account.address)).to.equal(0);
    });
  });
});
