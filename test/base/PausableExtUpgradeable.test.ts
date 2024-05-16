import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { connect, proveTx } from "../../test-utils/eth";

async function setUpFixture<T>(func: () => Promise<T>): Promise<T> {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'PausableExtUpgradeable'", async () => {
  const REVERT_ERROR_IF_CONTRACT_INITIALIZATION_IS_INVALID = "InvalidInitialization";
  const REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING = "NotInitializing";
  const REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT = "AccessControlUnauthorizedAccount";

  const ownerRole: string = ethers.id("OWNER_ROLE");
  const pauserRole: string = ethers.id("PAUSER_ROLE");

  let pausableExtMockFactory: ContractFactory;

  let deployer: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;

  before(async () => {
    [deployer, pauser] = await ethers.getSigners();
    pausableExtMockFactory = await ethers.getContractFactory("PausableExtUpgradeableMock");
    pausableExtMockFactory = pausableExtMockFactory.connect(deployer); // Explicitly specifying the deployer account
  });

  async function deployPausableExtMock(): Promise<{ pausableExtMock: Contract }> {
    let pausableExtMock: Contract = await upgrades.deployProxy(pausableExtMockFactory);
    await pausableExtMock.waitForDeployment();
    pausableExtMock = connect(pausableExtMock, deployer); // Explicitly specifying the initial account
    return { pausableExtMock };
  }

  async function deployAndConfigurePausableExtMock(): Promise<{ pausableExtMock: Contract }> {
    const { pausableExtMock } = await deployPausableExtMock();
    await proveTx(pausableExtMock.grantRole(pauserRole, pauser.address));

    return { pausableExtMock };
  }

  describe("Function 'initialize()'", async () => {
    it("The external initializer configures the contract as expected", async () => {
      const { pausableExtMock } = await setUpFixture(deployPausableExtMock);

      // The roles
      expect((await pausableExtMock.OWNER_ROLE()).toLowerCase()).to.equal(ownerRole);
      expect((await pausableExtMock.PAUSER_ROLE()).toLowerCase()).to.equal(pauserRole);

      // The role admins
      expect(await pausableExtMock.getRoleAdmin(ownerRole)).to.equal(ethers.ZeroHash);
      expect(await pausableExtMock.getRoleAdmin(pauserRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await pausableExtMock.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await pausableExtMock.hasRole(pauserRole, deployer.address)).to.equal(false);

      // The initial contract state is unpaused
      expect(await pausableExtMock.paused()).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { pausableExtMock } = await setUpFixture(deployPausableExtMock);
      await expect(
        pausableExtMock.initialize()
      ).to.be.revertedWithCustomError(pausableExtMock, REVERT_ERROR_IF_CONTRACT_INITIALIZATION_IS_INVALID);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { pausableExtMock } = await setUpFixture(deployPausableExtMock);
      await expect(
        pausableExtMock.call_parent_initialize()
      ).to.be.revertedWithCustomError(pausableExtMock, REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { pausableExtMock } = await setUpFixture(deployPausableExtMock);
      await expect(
        pausableExtMock.call_parent_initialize_unchained()
      ).to.be.revertedWithCustomError(pausableExtMock, REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING);
    });
  });

  describe("Function 'pause()'", async () => {
    it("Executes successfully and emits the correct event", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);

      await expect(connect(pausableExtMock, pauser).pause())
        .to.emit(pausableExtMock, "Paused")
        .withArgs(pauser.address);

      expect(await pausableExtMock.paused()).to.equal(true);
    });

    it("Is reverted if it is called by an account without the pauser role", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);
      await expect(
        pausableExtMock.pause()
      ).to.be.revertedWithCustomError(
        pausableExtMock,
        REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT
      ).withArgs(deployer.address, pauserRole);
    });
  });

  describe("Function 'unpause()'", async () => {
    it("Executes successfully and emits the correct event", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);
      await proveTx(connect(pausableExtMock, pauser).pause());

      await expect(connect(pausableExtMock, pauser).unpause())
        .to.emit(pausableExtMock, "Unpaused")
        .withArgs(pauser.address);

      expect(await pausableExtMock.paused()).to.equal(false);
    });

    it("Is reverted if it is called by an account without the pauser role", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);
      await expect(
        pausableExtMock.unpause()
      ).to.be.revertedWithCustomError(
        pausableExtMock,
        REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT
      ).withArgs(deployer.address, pauserRole);
    });
  });
});
