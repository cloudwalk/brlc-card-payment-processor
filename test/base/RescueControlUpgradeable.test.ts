import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

describe("Contract 'RescueControlUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  let rescueControlMock: Contract;
  let tokenMock: Contract;
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let ownerRole: string;
  let rescuerRole: string;

  beforeEach(async () => {
    // Deploy the token mock contract
    const TokenMock: ContractFactory = await ethers.getContractFactory("ERC20UpgradeableMock");
    tokenMock = await TokenMock.deploy();
    await tokenMock.deployed();
    await proveTx(tokenMock.initialize("BRL Coin", "BRLC"));

    // Deploy the contract under test
    const RescueControlMock: ContractFactory = await ethers.getContractFactory("RescueControlUpgradeableMock");
    rescueControlMock = await RescueControlMock.deploy();
    await rescueControlMock.deployed();
    await proveTx(rescueControlMock.initialize());

    // Accounts
    [deployer, user] = await ethers.getSigners();

    // Roles
    ownerRole = (await rescueControlMock.OWNER_ROLE()).toLowerCase();
    rescuerRole = (await rescueControlMock.RESCUER_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(
      rescueControlMock.initialize()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The init function of the ancestor contract can't be called outside the init process", async () => {
    await expect(
      rescueControlMock.call_parent_initialize()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
  });

  it("The init unchained function of the ancestor contract can't be called outside the init process", async () => {
    await expect(
      rescueControlMock.call_parent_initialize_unchained()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The role admins
    expect(await rescueControlMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
    expect(await rescueControlMock.getRoleAdmin(rescuerRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await rescueControlMock.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await rescueControlMock.hasRole(rescuerRole, deployer.address)).to.equal(false);
  });

  describe("Function 'rescueERC20()'", async () => {
    const tokenAmount = 123;

    beforeEach(async () => {
      await proveTx(tokenMock.mint(rescueControlMock.address, tokenAmount));
      await proveTx(rescueControlMock.grantRole(rescuerRole, user.address));
    });

    it("Is reverted if is called by an account without the rescuer role", async () => {
      await expect(
        rescueControlMock.rescueERC20(
          tokenMock.address,
          deployer.address,
          tokenAmount
        )
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, rescuerRole));
    });

    it("Executes successfully, transfers tokens as expected, emits the correct event", async () => {
      await expect(
        rescueControlMock.connect(user).rescueERC20(
          tokenMock.address,
          deployer.address,
          tokenAmount
        )
      ).to.changeTokenBalances(
        tokenMock,
        [rescueControlMock, deployer, user],
        [-tokenAmount, +tokenAmount, 0]
      ).and.to.emit(
        tokenMock,
        "Transfer"
      ).withArgs(
        rescueControlMock.address,
        deployer.address,
        tokenAmount
      );
    });
  });
});
