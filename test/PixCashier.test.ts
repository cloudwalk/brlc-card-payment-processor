import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../test-utils/misc";

describe("Contract 'PixCashierUpgradeable'", async () => {
  const TRANSACTION_ID = ethers.utils.formatBytes32String("MOCK_TRANSACTION_ID");

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED = "BlacklistedAccount";
  const REVERT_ERROR_IF_ACCOUNT_IS_ZERO = "ZeroAccount";
  const REVERT_ERROR_IF_AMOUNT_IS_ZERO = "ZeroAmount";
  const REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO = "ZeroTxId";
  const REVERT_ERROR_IF_BALANCE_IS_INSUFFICIENT = "InsufficientCashOutBalance";

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
    await proveTx(tokenMock.initialize("BRL Coin", "BRLC"));

    // Deploy the being tested contract
    const PixCashier: ContractFactory = await ethers.getContractFactory("PixCashier");
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

  it("The initialize function can't be called more than once", async () => {
    await expect(
      pixCashier.initialize(tokenMock.address)
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
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
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the cashier role", async () => {
      await expect(
        pixCashier.connect(deployer).cashIn(user.address, tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, cashierRole));
    });

    it("Is reverted if the account address is zero", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(ethers.constants.AddressZero, tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_ZERO);
    });

    it("Is reverted if the token amount is zero", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, 0, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Mints correct amount of tokens and emits the correct event", async () => {
      await expect(
        pixCashier.connect(cashier).cashIn(user.address, tokenAmount, TRANSACTION_ID)
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
        TRANSACTION_ID
      );
    });
  });

  describe("Function 'cashOut()'", async () => {
    const tokenAmount: number = 100;

    beforeEach(async () => {
      await proveTx(tokenMock.connect(user).approve(pixCashier.address, ethers.constants.MaxUint256));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller is blacklisted", async () => {
      await proveTx(pixCashier.grantRole(blacklisterRole, deployer.address));
      await proveTx(pixCashier.blacklist(user.address));
      await expect(
        pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Is reverted if the token amount is zero", async () => {
      await expect(
        pixCashier.connect(user).cashOut(0, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await proveTx(tokenMock.mint(user.address, tokenAmount));
      await expect(
        pixCashier.connect(user).cashOut(tokenAmount, ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the user has not enough tokens", async () => {
      await proveTx(tokenMock.mint(user.address, tokenAmount - 1));
      await expect(pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID))
        .to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
    });

    it("Transfers tokens as expected, emits the correct event, changes cash-out balances accordingly", async () => {
      await proveTx(tokenMock.mint(user.address, tokenAmount));
      const oldCashOutBalance: number = await pixCashier.cashOutBalanceOf(user.address);
      await expect(
        pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID)
      ).to.changeTokenBalances(
        tokenMock,
        [user, pixCashier],
        [-tokenAmount, +tokenAmount]
      ).and.to.emit(
        pixCashier,
        "CashOut"
      ).withArgs(
        user.address,
        tokenAmount,
        tokenAmount,
        TRANSACTION_ID
      );
      const newCashOutBalance: number = await pixCashier.cashOutBalanceOf(user.address);
      expect(newCashOutBalance - oldCashOutBalance).to.equal(tokenAmount);
    });
  });

  describe("Function 'cashOutConfirm()'", async () => {
    const tokenAmount: number = 100;

    beforeEach(async () => {
      await proveTx(tokenMock.connect(user).approve(pixCashier.address, ethers.constants.MaxUint256));
      await proveTx(tokenMock.mint(user.address, tokenAmount));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(user).cashOutConfirm(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller is blacklisted", async () => {
      await proveTx(pixCashier.grantRole(blacklisterRole, deployer.address));
      await proveTx(pixCashier.blacklist(user.address));
      await expect(
        pixCashier.connect(user).cashOutConfirm(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Is reverted if the token amount is zero", async () => {
      await expect(
        pixCashier.connect(user).cashOutConfirm(0, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await proveTx(pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID));
      await expect(
        pixCashier.connect(user).cashOutConfirm(tokenAmount, ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the user's cash-out balance is not enough", async () => {
      await proveTx(pixCashier.connect(user).cashOut(tokenAmount - 1, TRANSACTION_ID));
      await expect(
        pixCashier.connect(user).cashOutConfirm(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BALANCE_IS_INSUFFICIENT);
    });

    it("Burns tokens as expected, emits the correct event, changes cash-out balances accordingly", async () => {
      await proveTx(pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID));
      const oldCashOutBalance: number = await pixCashier.cashOutBalanceOf(user.address);
      await expect(
        pixCashier.connect(user).cashOutConfirm(tokenAmount, TRANSACTION_ID)
      ).to.changeTokenBalances(
        tokenMock,
        [pixCashier, user],
        [-tokenAmount, 0]
      ).and.to.emit(
        pixCashier,
        "CashOutConfirm"
      ).withArgs(
        user.address,
        tokenAmount,
        0,
        TRANSACTION_ID
      );
      const newCashOutBalance: number = await pixCashier.cashOutBalanceOf(user.address);
      expect(newCashOutBalance - oldCashOutBalance).to.equal(-tokenAmount);
    });
  });

  describe("Function 'cashOutReverse()'", async () => {
    const tokenAmount: number = 100;

    beforeEach(async () => {
      await proveTx(tokenMock.connect(user).approve(pixCashier.address, ethers.constants.MaxUint256));
      await proveTx(tokenMock.mint(user.address, tokenAmount));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(pixCashier.grantRole(pauserRole, deployer.address));
      await proveTx(pixCashier.pause());
      await expect(
        pixCashier.connect(user).cashOutReverse(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller is blacklisted", async () => {
      await proveTx(pixCashier.grantRole(blacklisterRole, deployer.address));
      await proveTx(pixCashier.blacklist(user.address));
      await expect(
        pixCashier.connect(user).cashOutReverse(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Is reverted if the token amount is zero", async () => {
      await expect(
        pixCashier.connect(user).cashOutReverse(0, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_AMOUNT_IS_ZERO);
    });

    it("Is reverted if the off-chain transaction ID is zero", async () => {
      await proveTx(pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID));
      await expect(
        pixCashier.connect(user).cashOutReverse(tokenAmount, ethers.constants.HashZero)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_TRANSACTION_ID_IS_ZERO);
    });

    it("Is reverted if the user's cash-out balance is not enough", async () => {
      await proveTx(pixCashier.connect(user).cashOut(tokenAmount - 1, TRANSACTION_ID));
      await expect(
        pixCashier.connect(user).cashOutReverse(tokenAmount, TRANSACTION_ID)
      ).to.be.revertedWithCustomError(pixCashier, REVERT_ERROR_IF_BALANCE_IS_INSUFFICIENT);
    });

    it("Transfers tokens as expected, emits the correct event, changes cash-out balances accordingly", async () => {
      await proveTx(pixCashier.connect(user).cashOut(tokenAmount, TRANSACTION_ID));
      const oldCashOutBalance: number = await pixCashier.cashOutBalanceOf(user.address);
      await expect(
        pixCashier.connect(user).cashOutReverse(tokenAmount, TRANSACTION_ID)
      ).to.changeTokenBalances(
        tokenMock,
        [user, pixCashier],
        [+tokenAmount, -tokenAmount]
      ).and.to.emit(
        pixCashier,
        "CashOutReverse"
      ).withArgs(
        user.address,
        tokenAmount,
        0,
        TRANSACTION_ID
      );
      const newCashOutBalance: number = await pixCashier.cashOutBalanceOf(user.address);
      expect(newCashOutBalance - oldCashOutBalance).to.equal(-tokenAmount);
    });
  });

  describe("Complex scenario", async () => {
    const cashInTokenAmount: number = 100;
    const cashOutTokenAmount: number = 80;
    const cashOutReverseTokenAmount: number = 20;
    const cashOutConfirmTokenAmount: number = 50;
    const userFinalTokenBalance: number = cashInTokenAmount - cashOutTokenAmount + cashOutReverseTokenAmount;
    const userFinalCashOutBalance: number =
      cashOutTokenAmount - cashOutReverseTokenAmount - cashOutConfirmTokenAmount;

    beforeEach(async () => {
      await proveTx(tokenMock.connect(user).approve(pixCashier.address, ethers.constants.MaxUint256));
    });

    it("Leads to correct balances when using several functions", async () => {
      await proveTx(pixCashier.grantRole(cashierRole, cashier.address));
      await proveTx(pixCashier.connect(cashier).cashIn(user.address, cashInTokenAmount, TRANSACTION_ID));
      await proveTx(pixCashier.connect(user).cashOut(cashOutTokenAmount, TRANSACTION_ID));
      await proveTx(pixCashier.connect(user).cashOutReverse(cashOutReverseTokenAmount, TRANSACTION_ID));
      await proveTx(pixCashier.connect(user).cashOutConfirm(cashOutConfirmTokenAmount, TRANSACTION_ID));
      expect(await tokenMock.balanceOf(user.address)).to.equal(userFinalTokenBalance);
      expect(await pixCashier.cashOutBalanceOf(user.address)).to.equal(userFinalCashOutBalance);
      expect(await tokenMock.balanceOf(pixCashier.address)).to.equal(userFinalCashOutBalance);
    });
  });
});
