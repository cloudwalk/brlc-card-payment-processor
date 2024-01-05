import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

async function setUpFixture(func: any) {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'PausableExtUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  const ownerRole: string = ethers.utils.id("OWNER_ROLE");
  const pauserRole: string = ethers.utils.id("PAUSER_ROLE");

  let pausableExtMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let pauser: SignerWithAddress;

  before(async () => {
    pausableExtMockFactory = await ethers.getContractFactory("PausableExtUpgradeableMock");
    [deployer, pauser] = await ethers.getSigners();
  });

  async function deployPausableExtMock(): Promise<{ pausableExtMock: Contract }> {
    const pausableExtMock: Contract = await upgrades.deployProxy(pausableExtMockFactory);
    await pausableExtMock.deployed();
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

      //The roles
      expect((await pausableExtMock.OWNER_ROLE()).toLowerCase()).to.equal(ownerRole);
      expect((await pausableExtMock.PAUSER_ROLE()).toLowerCase()).to.equal(pauserRole);

      // The role admins
      expect(await pausableExtMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
      expect(await pausableExtMock.getRoleAdmin(pauserRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await pausableExtMock.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await pausableExtMock.hasRole(pauserRole, deployer.address)).to.equal(false);

      // The initial contract state is unpaused
      expect(await pausableExtMock.paused()).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { pausableExtMock } = await setUpFixture(deployPausableExtMock);
      await expect(pausableExtMock.initialize()).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { pausableExtMock } = await setUpFixture(deployPausableExtMock);
      await expect(pausableExtMock.call_parent_initialize()).to.be.revertedWith(
        REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING
      );
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { pausableExtMock } = await setUpFixture(deployPausableExtMock);
      await expect(pausableExtMock.call_parent_initialize_unchained()).to.be.revertedWith(
        REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING
      );
    });
  });

  describe("Function 'pause()'", async () => {
    it("Executes successfully and emits the correct event", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);

      await expect(pausableExtMock.connect(pauser).pause()).to.emit(pausableExtMock, "Paused").withArgs(pauser.address);

      expect(await pausableExtMock.paused()).to.equal(true);
    });

    it("Is reverted if it is called by an account without the pauser role", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);
      await expect(pausableExtMock.pause()).to.be.revertedWith(
        createRevertMessageDueToMissingRole(deployer.address, pauserRole)
      );
    });
  });

  describe("Function 'unpause()'", async () => {
    it("Executes successfully and emits the correct event", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);
      await proveTx(pausableExtMock.connect(pauser).pause());

      await expect(pausableExtMock.connect(pauser).unpause())
        .to.emit(pausableExtMock, "Unpaused")
        .withArgs(pauser.address);

      expect(await pausableExtMock.paused()).to.equal(false);
    });

    it("Is reverted if it is called by an account without the pauser role", async () => {
      const { pausableExtMock } = await setUpFixture(deployAndConfigurePausableExtMock);
      await expect(pausableExtMock.unpause()).to.be.revertedWith(
        createRevertMessageDueToMissingRole(deployer.address, pauserRole)
      );
    });
  });
});
