import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

describe("Contract 'PauseControlUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  let pauseControlMock: Contract;
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let ownerRole: string;
  let pauserRole: string;

  beforeEach(async () => {
    const PauseControlMock: ContractFactory = await ethers.getContractFactory("PauseControlUpgradeableMock");
    pauseControlMock = await upgrades.deployProxy(PauseControlMock);
    await pauseControlMock.deployed();

    [deployer, user] = await ethers.getSigners();

    // Roles
    ownerRole = (await pauseControlMock.OWNER_ROLE()).toLowerCase();
    pauserRole = (await pauseControlMock.PAUSER_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(pauseControlMock.initialize())
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The init function of the ancestor contract can't be called outside the init process", async () => {
    await expect(pauseControlMock.call_parent_initialize())
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
  });

  it("The init unchained function of the ancestor contract can't be called outside the init process", async () => {
    await expect(pauseControlMock.call_parent_initialize_unchained())
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The role admins
    expect(await pauseControlMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
    expect(await pauseControlMock.getRoleAdmin(pauserRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await pauseControlMock.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await pauseControlMock.hasRole(pauserRole, deployer.address)).to.equal(false);
  });

  describe("Function 'pause()'", async () => {
    beforeEach(async () => {
      await proveTx(pauseControlMock.grantRole(pauserRole, user.address));
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      await expect(pauseControlMock.pause())
        .to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });

    it("Executes successfully if is called by an account with the pauser role", async () => {
      await proveTx(pauseControlMock.connect(user).pause());
      expect(await pauseControlMock.paused()).to.equal(true);
    });

    it("Emits the correct event", async () => {
      await expect(pauseControlMock.connect(user).pause())
        .to.emit(pauseControlMock, "Paused")
        .withArgs(user.address);
    });
  });

  describe("Function 'unpause()'", async () => {
    beforeEach(async () => {
      await proveTx(pauseControlMock.grantRole(pauserRole, user.address));
      await proveTx(pauseControlMock.connect(user).pause());
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      await expect(pauseControlMock.unpause())
        .to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });

    it("Executes successfully if is called by an account with the pauser role", async () => {
      await proveTx(pauseControlMock.connect(user).unpause());
      expect(await pauseControlMock.paused()).to.equal(false);
    });

    it("Emits the correct event", async () => {
      await expect(pauseControlMock.connect(user).unpause())
        .to.emit(pauseControlMock, "Unpaused")
        .withArgs(user.address);
    });
  });
});
