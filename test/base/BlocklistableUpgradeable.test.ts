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

describe("Contract 'BlocklistableUpgradeable'", async () => {
  const EVENT_NAME_BLOCKLISTED = "Blocklisted";
  const EVENT_NAME_SELFBLOCKLISTED = "SelfBlocklisted";
  const EVENT_NAME_TEST_NOT_BLOCKLISTED_MODIFIER_SUCCEEDED = "TestNotBlocklistedModifierSucceeded";
  const EVENT_NAME_UNBLOCKLISTED = "UnBlocklisted";

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  const REVERT_ERROR_IF_ACCOUNT_IS_BLOCKLISTED = "BlocklistedAccount";

  const ownerRole: string = ethers.utils.id("OWNER_ROLE");
  const blocklisterRole: string = ethers.utils.id("BLOCKLISTER_ROLE");

  let blocklistableMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let blocklister: SignerWithAddress;
  let user: SignerWithAddress;

  before(async () => {
    [deployer, blocklister, user] = await ethers.getSigners();
    blocklistableMockFactory = await ethers.getContractFactory("BlocklistableUpgradeableMock");
  });

  async function deployBlocklistableMock(): Promise<{ blocklistableMock: Contract }> {
    const blocklistableMock: Contract = await upgrades.deployProxy(blocklistableMockFactory);
    await blocklistableMock.deployed();

    return { blocklistableMock };
  }

  async function deployAndConfigureBlocklistableMock(): Promise<{ blocklistableMock: Contract }> {
    const { blocklistableMock } = await deployBlocklistableMock();
    await proveTx(blocklistableMock.grantRole(blocklisterRole, blocklister.address));
    return { blocklistableMock };
  }

  describe("Initializers", async () => {
    it("The external initializer configures the contract as expected", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);

      // The roles
      expect(await blocklistableMock.OWNER_ROLE()).to.equal(ownerRole);
      expect(await blocklistableMock.BLOCKLISTER_ROLE()).to.equal(blocklisterRole);

      // The role admins
      expect(await blocklistableMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
      expect(await blocklistableMock.getRoleAdmin(blocklisterRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await blocklistableMock.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await blocklistableMock.hasRole(blocklisterRole, deployer.address)).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(
        blocklistableMock.initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(
        blocklistableMock.call_parent_initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(
        blocklistableMock.call_parent_initialize_unchained()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });
  });

  describe("Function 'blocklist()'", async () => {
    it("Executes as expected and emits the correct event if it is called by a blocklister", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(false);

      await expect(blocklistableMock.connect(blocklister).blocklist(user.address))
        .to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED)
        .withArgs(user.address);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(true);

      // Second call with the same argument should not emit an event
      await expect(
        blocklistableMock.connect(blocklister).blocklist(user.address)
      ).not.to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED);
    });
  });

  it("Is reverted if it is called by an account without the blocklister role", async () => {
    const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
    await expect(
      blocklistableMock.blocklist(user.address)
    ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, blocklisterRole));
  });

  describe("Function 'unBlocklist()'", async () => {
    it("Executes as expected and emits the correct event if it is called by a blocklister", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await proveTx(blocklistableMock.connect(blocklister).blocklist(user.address));
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(true);

      await expect(blocklistableMock.connect(blocklister).unBlocklist(user.address))
        .to.emit(blocklistableMock, EVENT_NAME_UNBLOCKLISTED)
        .withArgs(user.address);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(false);

      // The second call with the same argument should not emit an event
      await expect(
        blocklistableMock.connect(blocklister).unBlocklist(user.address)
      ).not.to.emit(blocklistableMock, EVENT_NAME_UNBLOCKLISTED);
    });

    it("Is reverted if it is called by an account without the blocklister role", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await expect(
        blocklistableMock.unBlocklist(user.address)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, blocklisterRole));
    });
  });

  describe("Function 'selfBlocklist()'", async () => {
    it("Executes as expected and emits the correct events if it is called by any account", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(false);

      await expect(blocklistableMock.connect(user).selfBlocklist())
        .to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED)
        .withArgs(user.address)
        .and.to.emit(blocklistableMock, EVENT_NAME_SELFBLOCKLISTED)
        .withArgs(user.address);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(true);

      // Second call should not emit an event
      await expect(
        blocklistableMock.connect(user).selfBlocklist()
      ).not.to.emit(blocklistableMock, EVENT_NAME_SELFBLOCKLISTED);
    });
  });

  describe("Modifier 'notBlocklisted'", async () => {
    it("Reverts the target function if the caller is blocklisted", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);

      await proveTx(blocklistableMock.connect(blocklister).blocklist(deployer.address));
      await expect(
        blocklistableMock.testNotBlocklistedModifier()
      ).to.be.revertedWithCustomError(blocklistableMock, REVERT_ERROR_IF_ACCOUNT_IS_BLOCKLISTED);
    });

    it("Does not revert the target function if the caller is not blocklisted", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await expect(
        blocklistableMock.connect(user).testNotBlocklistedModifier()
      ).to.emit(blocklistableMock, EVENT_NAME_TEST_NOT_BLOCKLISTED_MODIFIER_SUCCEEDED);
    });
  });
});
