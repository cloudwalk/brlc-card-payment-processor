import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber, Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createRevertMessageDueToMissingRole } from "../test-utils/misc";
import { TransactionResponse } from "@ethersproject/abstract-provider";


enum CashInStatus {
  Nonexistent = 0,
  Executed = 1,
}

enum CashOutStatus {
  Nonexistent = 0,
  Pending = 1,
  Reversed = 2,
  Confirmed = 3,
}

interface TestCashIn {
  account: SignerWithAddress;
  amount: number;
  txId: string;
  status: CashInStatus;
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

function checkCashOutEquality(
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
    expect(actualOnChainCashOut.status).to.equal(
      expectedCashOut.status,
      `cashOut[${cashOutIndex}].status is incorrect`
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

function checkCashInEquality(
  actualOnChainCashIn: any,
  expectedCashIn: TestCashIn,
  cashInIndex: number
) {
  if (expectedCashIn.status == CashInStatus.Nonexistent) {
    expect(actualOnChainCashIn.account).to.equal(
      ethers.constants.AddressZero,
      `cashIns[${cashInIndex}].account is incorrect`
    );
    expect(actualOnChainCashIn.amount).to.equal(
      0,
      `cashIns[${cashInIndex}].amount is incorrect`
    );
    expect(actualOnChainCashIn.status).to.equal(
      CashInStatus.Nonexistent,
      `cashIns[${cashInIndex}].status is incorrect`
    );
  } else {
    expect(actualOnChainCashIn.account).to.equal(
      expectedCashIn.account.address,
      `cashIns[${cashInIndex}].account is incorrect`
    );
    expect(actualOnChainCashIn.amount).to.equal(
      expectedCashIn.amount,
      `cashIns[${cashInIndex}].amount is incorrect`
    );
    expect(actualOnChainCashIn.status).to.equal(
      expectedCashIn.status,
      `cashIns[${cashInIndex}].status is incorrect`
    );
  }
}

describe("Contract 'PixCashier'", async () => {
  const TRANSACTION_ID1 = ethers.utils.formatBytes32String("MOCK_TRANSACTION_ID1");
  const TRANSACTION_ID2 = ethers.utils.formatBytes32String("MOCK_TRANSACTION_ID2");
  const TRANSACTION_ID3 = ethers.utils.formatBytes32String("MOCK_TRANSACTION_ID3");
  const TRANSACTIONS_ARRAY: string[] = [TRANSACTION_ID1, TRANSACTION_ID2, TRANSACTION_ID3];
  const TOKEN_AMOUNTS: number[] = [100, 200, 300];

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_TOKEN_ADDRESS_IZ_ZERO = "ZeroTokenAddress";
  const REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED = "BlacklistedAccount";
  const REVERT_ERROR_IF_ACCOUNT_IS_ZERO = "ZeroAccount";
  const REVERT_ERROR_IF_AMOUNT_IS_ZERO = "ZeroAmount";
  const REVERT_ERROR_IF_CASH_IN_ALREADY_EXECUTED = "CashInAlreadyExecuted";
  const REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO = "ZeroTxId";
  const REVERT_ERROR_IF_TOKEN_MINTING_FAILURE = "TokenMintingFailure";
  const REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_ACCOUNT = "InappropriateCashOutAccount";
  const REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS = "InappropriateCashOutStatus";
  const REVERT_ERROR_IF_EMPTY_TRANSACTION_IDS_ARRAY = "EmptyTransactionIdsArray";
  const REVERT_ERROR_IF_BATCH_TRANSACTION_DIFFERENT = "InvalidBatchArrays";

  let PixCashier: ContractFactory;
  let pixCashier: Contract;
  let tokenMock: Contract;
  let deployer: SignerWithAddress;
  let cashier: SignerWithAddress;
  let user: SignerWithAddress;
  let secondUser: SignerWithAddress;
  let thirdUser: SignerWithAddress;
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
    [deployer, cashier, user, secondUser, thirdUser] = await ethers.getSigners();

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

  async function checkCashInStructuresOnBlockchain(cashIns: TestCashIn[]) {
    const txIds: string[] = cashIns.map(cashIn => cashIn.txId);
    const actualCashIns: any[] = await pixCashier.getCashIns(txIds);
    for (let i = 0; i < cashIns.length; ++i) {
      const cashIn: TestCashIn = cashIns[i];
      const actualCashIn: any = await pixCashier.getCashIn(cashIn.txId);
      checkCashInEquality(actualCashIn, cashIn, i);
      checkCashInEquality(actualCashIns[i], cashIn, i);
    }
  }

  async function checkCashOutStructuresOnBlockchain(cashOuts: TestCashOut[]) {
    const txIds: string[] = cashOuts.map(cashOut => cashOut.txId);
    const actualCashOuts: any[] = await pixCashier.getCashOuts(txIds);
    for (let i = 0; i < cashOuts.length; ++i) {
      const cashOut: TestCashOut = cashOuts[i];
      const actualCashOut: any = await pixCashier.getCashOut(cashOut.txId);
      checkCashOutEquality(actualCashOut, cashOut, i);
      checkCashOutEquality(actualCashOuts[i], cashOut, i);
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

  describe("Function 'cashIn()'", async () => {
    const tokenAmount: number = 100;

    beforeEach(async () => {
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
    });

    it("Executes as expected", async () => {
      const expectedCashIn: TestCashIn = {
        status: CashInStatus.Nonexistent,
        account: user,
        amount: tokenAmount,
        txId: TRANSACTION_ID1,
      };
      await expect(
        pixCashier.connect(cashier).cashIn(expectedCashIn.account.address, expectedCashIn.amount, expectedCashIn.txId)
      ).to.changeTokenBalances(
        tokenMock,
        [user, pixCashier],
        [+expectedCashIn.amount, 0]
      ).and.to.emit(
        pixCashier,
        "CashIn"
      ).withArgs(
        expectedCashIn.account.address,
        expectedCashIn.amount,
        expectedCashIn.txId
      );
      expectedCashIn.status = CashInStatus.Executed;

      await checkCashInStructuresOnBlockchain([expectedCashIn]);
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

    it("Is reverted if the account is blacklisted", async () => {
      await proveTx(pixCashier.grantRole(blacklisterRole, deployer.address));
      await proveTx(pixCashier.blacklist(user.address));
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, TRANSACTION_ID1)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
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

    it("Is reverted if the cash-in with the provided txId is already executed", async () => {
      const txId = TRANSACTION_ID1;
      await proveTx(pixCashier.connect(cashier).cashIn(user.address, tokenAmount, txId));
      expect(
        pixCashier.connect(cashier).cashIn(deployer.address, tokenAmount + 1, txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_CASH_IN_ALREADY_EXECUTED
      ).withArgs(txId);
    });
  });

  describe("Function 'cashInBatch()'", async () => {
    let users: SignerWithAddress[];
    let userAddresses: string[];
    let expectedCashIns: TestCashIn[];

    beforeEach(async () => {
      users = [user, secondUser, thirdUser];
      userAddresses = users.map(user => user.address);
      expectedCashIns = users.map((user: SignerWithAddress, index: number): TestCashIn => {
        return {
          account: user,
          amount: TOKEN_AMOUNTS[index],
          txId: TRANSACTIONS_ARRAY[index],
          status: CashInStatus.Executed,
        };
      });

      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
    });

    it("Executes as expected", async () => {
      const tx: TransactionResponse =
        await pixCashier.connect(cashier).cashInBatch(userAddresses, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY);
      await expect(tx).to.changeTokenBalances(
        tokenMock,
        [user, secondUser, thirdUser, pixCashier],
        [+TOKEN_AMOUNTS[0], +TOKEN_AMOUNTS[1], +TOKEN_AMOUNTS[2], 0]
      );
      await expect(tx).to.emit(
        pixCashier,
        "CashIn"
      ).withArgs(
        expectedCashIns[0].account.address,
        expectedCashIns[0].amount,
        expectedCashIns[0].txId
      );
      await expect(tx).to.emit(
        pixCashier,
        "CashIn"
      ).withArgs(
        expectedCashIns[1].account.address,
        expectedCashIns[1].amount,
        expectedCashIns[1].txId
      );
      await expect(tx).to.emit(
        pixCashier,
        "CashIn"
      ).withArgs(
        expectedCashIns[2].account.address,
        expectedCashIns[2].amount,
        expectedCashIns[2].txId
      );

      await checkCashInStructuresOnBlockchain(expectedCashIns);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      const users = [user.address, secondUser.address, thirdUser.address];
      await expect(
        pixCashier.connect(cashier).cashInBatch(users, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).cashInBatch(userAddresses, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if one of the account addresses is zero", async () => {
      const zeroAccountArray = [user.address, ethers.constants.AddressZero, user.address];
      await expect(
        pixCashier.connect(cashier).cashInBatch(zeroAccountArray, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_ZERO);
    });

    it("Is reverted if one of the accounts is blacklisted", async () => {
      await proveTx(pixCashier.grantRole(blacklisterRole, deployer.address));
      await proveTx(pixCashier.blacklist(secondUser.address));
      await expect(
        pixCashier.connect(cashier).cashInBatch(userAddresses, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Is reverted if one of the token amounts is zero", async () => {
      const zeroAmountArray = [100, 200, 0];
      await expect(
        pixCashier.connect(cashier).cashInBatch(userAddresses, zeroAmountArray, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if one of the off-chain transaction IDs is zero", async () => {
      const zeroTransactionIdArray = [TRANSACTION_ID1, ethers.constants.HashZero, TRANSACTION_ID3];
      await expect(
        pixCashier.connect(cashier).cashInBatch(userAddresses, TOKEN_AMOUNTS, zeroTransactionIdArray)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the length of any passed arrays is different to others", async () => {
      const moreUsers = [user.address, secondUser.address, thirdUser.address, user.address];
      const moreAmounts = [100, 200, 300, 400];
      const moreTransactions = [TRANSACTION_ID1, TRANSACTION_ID2, TRANSACTION_ID3, TRANSACTION_ID1];

      await expect(
        pixCashier.connect(cashier).cashInBatch(moreUsers, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BATCH_TRANSACTION_DIFFERENT);

      await expect(
        pixCashier.connect(cashier).cashInBatch(userAddresses, moreAmounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BATCH_TRANSACTION_DIFFERENT);

      await expect(
        pixCashier.connect(cashier).cashInBatch(userAddresses, TOKEN_AMOUNTS, moreTransactions)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BATCH_TRANSACTION_DIFFERENT);
    });

    it("Is reverted if minting function returns 'false'", async () => {
      await proveTx(tokenMock.setMintResult(false));
      await expect(
        pixCashier.connect(cashier).cashInBatch(userAddresses, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TOKEN_MINTING_FAILURE);
    });

    it("Is reverted if one of the cash-ins with the provided txIds is already executed", async () => {
      const lastTxId: string = TRANSACTIONS_ARRAY.slice(-1)[0];
      await proveTx(pixCashier.connect(cashier).cashIn(deployer.address, 1, lastTxId));
      await expect(
        pixCashier.connect(cashier).cashInBatch(userAddresses, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_CASH_IN_ALREADY_EXECUTED
      ).withArgs(lastTxId);
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

    it("Is reverted if the cash-out with the provided txId is already confirmed", async () => {
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount));
      await pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId);
      await pixCashier.connect(cashier).confirmCashOut(cashOut.txId);
      expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Confirmed);
    });

    it("Is reverted if txId of a reversed cash-out operation is reused for another account", async () => {
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount));
      await pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId);
      await pixCashier.connect(cashier).reverseCashOut(cashOut.txId);
      expect(
        pixCashier.connect(cashier).requestCashOutFrom(deployer.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_ACCOUNT
      ).withArgs(cashOut.txId, cashOut.account.address);
    });

    it("Is reverted if the user has not enough tokens", async () => {
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount - 1));
      await expect(
        pixCashier.connect(cashier).requestCashOutFrom(cashOut.account.address, cashOut.amount, cashOut.txId)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
    });
  });

  describe("Function 'requestCashOutFromBatch()'", async () => {
    let cashOut: TestCashOut;
    let secondCashOut: TestCashOut;
    let thirdCashOut: TestCashOut;
    let accounts: string[];
    let amounts: number[];

    beforeEach(async () => {
      cashOut = {
        account: user,
        amount: 200,
        txId: TRANSACTION_ID1,
        status: CashOutStatus.Nonexistent,
      };
      secondCashOut = {
        account: secondUser,
        amount: 300,
        txId: TRANSACTION_ID2,
        status: CashOutStatus.Nonexistent,
      };
      thirdCashOut = {
        account: thirdUser,
        amount: 400,
        txId: TRANSACTION_ID3,
        status: CashOutStatus.Nonexistent,
      };
      accounts = [cashOut.account.address, secondCashOut.account.address, thirdCashOut.account.address];
      amounts = [cashOut.amount, secondCashOut.amount, thirdCashOut.amount];
      await proveTx(tokenMock.connect(cashOut.account).approve(pixCashier.address, ethers.constants.MaxUint256));
      await proveTx(tokenMock.connect(secondCashOut.account).approve(pixCashier.address, ethers.constants.MaxUint256));
      await proveTx(tokenMock.connect(thirdCashOut.account).approve(pixCashier.address, ethers.constants.MaxUint256));
      await proveTx(tokenMock.mint(cashOut.account.address, cashOut.amount));
      await proveTx(tokenMock.mint(secondCashOut.account.address, secondCashOut.amount));
      await proveTx(tokenMock.mint(thirdCashOut.account.address, thirdCashOut.amount));
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
    });

    it("Transfers tokens as expected, emits the correct event, changes cash-out balances accordingly", async () => {
      const amountSum = cashOut.amount + secondCashOut.amount + thirdCashOut.amount;
      await checkPixCashierState([cashOut, secondCashOut, thirdCashOut]);
      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.changeTokenBalances(
        tokenMock,
        [cashOut.account, secondCashOut.account, thirdCashOut.account, pixCashier, cashier],
        [-cashOut.amount, -secondCashOut.amount, -thirdCashOut.amount, +amountSum, 0]
      ).and.to.emit(
        pixCashier,
        "RequestCashOut"
      ).withArgs(
        cashOut.account.address,
        cashOut.amount,
        cashOut.amount,
        cashOut.txId,
        cashier.address
      ).and.to.emit(
        pixCashier,
        "RequestCashOut"
      ).withArgs(
        secondCashOut.account.address,
        secondCashOut.amount,
        secondCashOut.amount,
        secondCashOut.txId,
        cashier.address
      ).and.to.emit(
        pixCashier,
        "RequestCashOut"
      ).withArgs(
        thirdCashOut.account.address,
        thirdCashOut.amount,
        thirdCashOut.amount,
        thirdCashOut.txId,
        cashier.address
      );
      cashOut.status = CashOutStatus.Pending;
      secondCashOut.status = CashOutStatus.Pending;
      thirdCashOut.status = CashOutStatus.Pending;
      await checkPixCashierState([cashOut, secondCashOut, thirdCashOut]);
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the length of any passed arrays is different to others", async () => {
      const users = [user.address, secondUser.address, thirdUser.address];
      const moreUsers = [user.address, secondUser.address, thirdUser.address, user.address];
      const moreAmounts = [100, 200, 300, 400];
      const moreTransactions = [TRANSACTION_ID1, TRANSACTION_ID2, TRANSACTION_ID3, TRANSACTION_ID1];

      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(moreUsers, TOKEN_AMOUNTS, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BATCH_TRANSACTION_DIFFERENT);

      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(users, moreAmounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BATCH_TRANSACTION_DIFFERENT);

      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(users, TOKEN_AMOUNTS, moreTransactions)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BATCH_TRANSACTION_DIFFERENT);
    });

    it("Is reverted if the account is blacklisted", async () => {
      await proveTx(pixCashier.grantRole(blacklisterRole, deployer.address));
      await proveTx(pixCashier.blacklist(secondCashOut.account.address));
      const accounts = [cashOut.account.address, secondCashOut.account.address, thirdCashOut.account.address];
      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Is reverted if the account address is zero", async () => {
      const accounts = [cashOut.account.address, ethers.constants.AddressZero, thirdCashOut.account.address];
      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_ZERO);
    });

    it("Is reverted if the token amount is zero", async () => {
      const amounts = [cashOut.amount, secondCashOut.amount, 0];
      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      const transactions = [TRANSACTION_ID1, ethers.constants.HashZero, TRANSACTION_ID3];
      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, transactions)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the cash-out with the provided txId is already pending", async () => {
      await pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY);
      expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Pending);
    });

    it("Is reverted if the user has not enough tokens", async () => {
      const amounts = [cashOut.amount, secondCashOut.amount, thirdCashOut.amount + 1];
      await expect(
        pixCashier.connect(cashier).requestCashOutFromBatch(accounts, amounts, TRANSACTIONS_ARRAY)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
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

  });

  describe("Function 'confirmCashOutBatch()'", async () => {
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

    it("Burns tokens as expected, emits the correct event, changes the contract state accordingly", async () => {
      await requestCashOuts(cashOuts);
      await checkPixCashierState(cashOuts);
      const totalTokens = countNumberArrayTotal(cashOuts.map(cashOut => cashOut.amount));
      await expect(
        pixCashier.connect(cashier).confirmCashOutBatch(txIds)
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

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).confirmCashOutBatch(txIds)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).confirmCashOutBatch(txIds)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the off-chain transaction IDs array is empty", async () => {
      await expect(
        pixCashier.connect(cashier).confirmCashOutBatch([])
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_EMPTY_TRANSACTION_IDS_ARRAY);
    });

    it("Is reverted if one of the off-chain transaction IDs is zero", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = ethers.constants.HashZero;
      await expect(
        pixCashier.connect(cashier).confirmCashOutBatch(txIds)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if one of the cash-outs was not requested previously", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = TRANSACTION_ID3;
      await expect(
        pixCashier.connect(cashier).confirmCashOutBatch(txIds)
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

  });

  describe("Function 'reverseCashOutBatch()'", async () => {
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

    it("Transfers tokens as expected, emits the correct event, changes the contract state accordingly", async () => {
      await requestCashOuts(cashOuts);
      await checkPixCashierState(cashOuts);
      const totalTokens = countNumberArrayTotal(cashOuts.map(cashOut => cashOut.amount));
      await expect(
        pixCashier.connect(cashier).reverseCashOutBatch(txIds)
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

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(cashier).reverseCashOutBatch(txIds)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).reverseCashOutBatch(txIds)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the off-chain transaction IDs array is empty", async () => {
      await expect(
        pixCashier.connect(cashier).reverseCashOutBatch([])
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_EMPTY_TRANSACTION_IDS_ARRAY);
    });

    it("Is reverted if one of the off-chain transaction IDs is zero", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = ethers.constants.HashZero;
      await expect(
        pixCashier.connect(cashier).reverseCashOutBatch(txIds)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if one of the cash-outs was not requested previously", async () => {
      await requestCashOuts(cashOuts);
      txIds[txIds.length - 1] = TRANSACTION_ID3;
      await expect(
        pixCashier.connect(cashier).reverseCashOutBatch(txIds)
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
        pixCashier.connect(cashier).reverseCashOutBatch([cashOut.txId])
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
        pixCashier.connect(cashier).confirmCashOutBatch([cashOut.txId])
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
        pixCashier.connect(cashier).reverseCashOutBatch([cashOut.txId])
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
        pixCashier.connect(cashier).confirmCashOutBatch([cashOut.txId])
      ).to.be.revertedWithCustomError(
        pixCashier,
        REVERT_ERROR_IF_INAPPROPRIATE_CASH_OUT_STATUS
      ).withArgs(cashOut.txId, CashOutStatus.Confirmed);

      expect(await tokenMock.balanceOf(cashOut.account.address)).to.equal(cashInTokenAmount - cashOut.amount);
    });
  });
});
