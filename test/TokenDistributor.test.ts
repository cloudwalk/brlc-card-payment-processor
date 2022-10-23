import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../test-utils/eth";
import { countNumberArrayTotal, createRevertMessageDueToMissingRole } from "../test-utils/misc";

describe("Contract 'TokenDistributor'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED = "Pausable: paused";
  const REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE = "ERC20: transfer amount exceeds balance";

  const REVERT_ERROR_IF_TOKEN_ADDRESS_IS_ZERO = "ZeroTokenAddress";
  const REVERT_ERROR_IF_RECIPIENTS_ARRAY_IS_EMPTY = "EmptyRecipientsArray";
  const REVERT_ERROR_IF_BALANCES_ARRAY_LENGTH_MISMATCH = "BalancesArrayLengthMismatch";
  const REVERT_ERROR_IF_RECIPIENT_ADDRESS_IS_ZERO = "ZeroRecipientAddress";
  const REVERT_ERROR_IF_RECIPIENT_TARGET_BALANCE_IS_ZERO = "ZeroRecipientBalance";

  let tokenDistributor: Contract;
  let tokenMock: Contract;
  let deployer: SignerWithAddress;
  let distributor: SignerWithAddress;
  let user: SignerWithAddress;
  let ownerRole: string;
  let pauserRole: string;
  let rescuerRole: string;
  let distributorRole: string;

  beforeEach(async () => {
    // Deploy the token mock contract
    const TokenMock: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    tokenMock = await TokenMock.deploy();
    await tokenMock.deployed();
    await proveTx(tokenMock.initialize("ERC20 Test", "TEST"));

    // Deploy the being tested contract
    const TokenDistributor: ContractFactory = await ethers.getContractFactory("TokenDistributor");
    tokenDistributor = await TokenDistributor.deploy();
    await tokenDistributor.deployed();
    await proveTx(tokenDistributor.initialize());

    // Accounts
    [deployer, distributor, user] = await ethers.getSigners();

    // Roles
    ownerRole = (await tokenDistributor.OWNER_ROLE()).toLowerCase();
    pauserRole = (await tokenDistributor.PAUSER_ROLE()).toLowerCase();
    rescuerRole = (await tokenDistributor.RESCUER_ROLE()).toLowerCase();
    distributorRole = (await tokenDistributor.DISTRIBUTOR_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(
      tokenDistributor.initialize()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The role admins
    expect(await tokenDistributor.getRoleAdmin(ownerRole)).to.equal(ownerRole);
    expect(await tokenDistributor.getRoleAdmin(pauserRole)).to.equal(ownerRole);
    expect(await tokenDistributor.getRoleAdmin(rescuerRole)).to.equal(ownerRole);
    expect(await tokenDistributor.getRoleAdmin(distributorRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await tokenDistributor.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await tokenDistributor.hasRole(pauserRole, deployer.address)).to.equal(false);
    expect(await tokenDistributor.hasRole(rescuerRole, deployer.address)).to.equal(false);
    expect(await tokenDistributor.hasRole(distributorRole, deployer.address)).to.equal(false);

    // The initial contract state is unpaused
    expect(await tokenDistributor.paused()).to.equal(false);
  });

  describe("Function 'distributeToken()'", async () => {
    let recipientAddresses: string[];
    const balances: number[] = [10, 20];
    const balanceTotal: number = countNumberArrayTotal(balances);

    beforeEach(async () => {
      recipientAddresses = [deployer.address, user.address];
      await proveTx(tokenDistributor.grantRole(distributorRole, distributor.address));
    });

    it("Is reverted if the contract is paused", async () => {
      await proveTx(tokenDistributor.grantRole(pauserRole, deployer.address));
      await proveTx(tokenDistributor.pause());
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          tokenMock.address,
          recipientAddresses,
          balances
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_PAUSED);
    });

    it("Is reverted if the caller does not have the distributor role", async () => {
      await expect(
        tokenDistributor.connect(deployer).distributeTokens(
          tokenMock.address,
          recipientAddresses,
          balances
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, distributorRole));
    });

    it("Is reverted if the token address is zero", async () => {
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          ethers.constants.AddressZero,
          recipientAddresses,
          balances
        )
      ).to.be.revertedWithCustomError(tokenDistributor, REVERT_ERROR_IF_TOKEN_ADDRESS_IS_ZERO);
    });

    it("Is reverted if the array of recipients is empty", async () => {
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          tokenMock.address,
          [],
          balances
        )
      ).to.be.revertedWithCustomError(tokenDistributor, REVERT_ERROR_IF_RECIPIENTS_ARRAY_IS_EMPTY);
    });

    it("Is reverted if the recipients array differs in length from the balances array", async () => {
      let badBalances = [...balances];
      badBalances.pop();
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          tokenMock.address,
          recipientAddresses,
          badBalances
        )
      ).to.be.revertedWithCustomError(tokenDistributor, REVERT_ERROR_IF_BALANCES_ARRAY_LENGTH_MISMATCH);
    });

    it("Is reverted if the address of one of the recipients is zero", async () => {
      await proveTx(tokenMock.mint(tokenDistributor.address, balanceTotal));
      recipientAddresses[recipientAddresses.length - 1] = ethers.constants.AddressZero;
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          tokenMock.address,
          recipientAddresses,
          balances
        )
      ).to.be.revertedWithCustomError(tokenDistributor, REVERT_ERROR_IF_RECIPIENT_ADDRESS_IS_ZERO);
    });

    it("Is reverted if one of the values in balances array is zero", async () => {
      await proveTx(tokenMock.mint(tokenDistributor.address, balanceTotal));
      let badBalances = [...balances];
      badBalances[badBalances.length - 1] = 0;
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          tokenMock.address,
          recipientAddresses,
          badBalances
        )
      ).to.be.revertedWithCustomError(tokenDistributor, REVERT_ERROR_IF_RECIPIENT_TARGET_BALANCE_IS_ZERO);
    });

    it("Is reverted if the contract has not enough tokens to execute all transfers", async () => {
      await proveTx(tokenMock.mint(tokenDistributor.address, balanceTotal - balances[0]));
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          tokenMock.address,
          recipientAddresses,
          balances
        )
      ).to.be.revertedWith(REVERT_MESSAGE_IF_TOKEN_TRANSFER_AMOUNT_EXCEEDS_BALANCE);
    });

    it("Transfers correct amount of tokens and emits the correct event", async () => {
      await proveTx(tokenMock.mint(tokenDistributor.address, balanceTotal));
      await expect(
        tokenDistributor.connect(distributor).distributeTokens(
          tokenMock.address,
          recipientAddresses,
          balances
        )
      ).to.changeTokenBalances(
        tokenMock,
        [tokenDistributor, distributor, ...recipientAddresses],
        [-balanceTotal, 0, ...balances]
      ).and.to.emit(
        tokenDistributor,
        "DistributeTokens"
      ).withArgs(
        tokenMock.address,
        balanceTotal
      );
    });
  });
});
