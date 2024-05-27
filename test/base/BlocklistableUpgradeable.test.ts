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

describe("Contract 'BlocklistableUpgradeable'", async () => {
  const EVENT_NAME_BLOCKLISTED = "Blocklisted";
  const EVENT_NAME_SELFBLOCKLISTED = "SelfBlocklisted";
  const EVENT_NAME_TEST_NOT_BLOCKLISTED_MODIFIER_SUCCEEDED = "TestNotBlocklistedModifierSucceeded";
  const EVENT_NAME_UNBLOCKLISTED = "UnBlocklisted";

  const REVERT_ERROR_IF_CONTRACT_INITIALIZATION_IS_INVALID = "InvalidInitialization";
  const REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING = "NotInitializing";
  const REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT = "AccessControlUnauthorizedAccount";

  const REVERT_ERROR_IF_ACCOUNT_IS_BLOCKLISTED = "BlocklistedAccount";

  const ownerRole: string = ethers.id("OWNER_ROLE");
  const blocklisterRole: string = ethers.id("BLOCKLISTER_ROLE");

  let blocklistableMockFactory: ContractFactory;

  let deployer: HardhatEthersSigner;
  let blocklister: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  before(async () => {
    [deployer, blocklister, user] = await ethers.getSigners();
    blocklistableMockFactory = await ethers.getContractFactory("BlocklistableUpgradeableMock");
    // Explicitly specifying the deployer account
    blocklistableMockFactory = blocklistableMockFactory.connect(deployer);
  });

  async function deployBlocklistableMock(): Promise<{ blocklistableMock: Contract }> {
    let blocklistableMock: Contract = await upgrades.deployProxy(blocklistableMockFactory);
    await blocklistableMock.waitForDeployment();
    blocklistableMock = connect(blocklistableMock, deployer); // Explicitly specifying the initial account

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
      expect(await blocklistableMock.getRoleAdmin(ownerRole)).to.equal(ethers.ZeroHash);
      expect(await blocklistableMock.getRoleAdmin(blocklisterRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await blocklistableMock.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await blocklistableMock.hasRole(blocklisterRole, deployer.address)).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(
        blocklistableMock.initialize()
      ).to.be.revertedWithCustomError(blocklistableMock, REVERT_ERROR_IF_CONTRACT_INITIALIZATION_IS_INVALID);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(
        blocklistableMock.call_parent_initialize()
      ).to.be.revertedWithCustomError(blocklistableMock, REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(
        blocklistableMock.call_parent_initialize_unchained()
      ).to.be.revertedWithCustomError(blocklistableMock, REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING);
    });
  });

  describe("Function 'blocklist()'", async () => {
    it("Executes as expected and emits the correct event if it is called by a blocklister", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(false);

      await expect(connect(blocklistableMock, blocklister).blocklist(user.address))
        .to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED)
        .withArgs(user.address);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(true);

      // Second call with the same argument should not emit an event
      await expect(
        connect(blocklistableMock, blocklister).blocklist(user.address)
      ).not.to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED);
    });
  });

  it("Is reverted if it is called by an account without the blocklister role", async () => {
    const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
    await expect(
      blocklistableMock.blocklist(user.address)
    ).to.be.revertedWithCustomError(
      blocklistableMock,
      REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT
    ).withArgs(deployer.address, blocklisterRole);
  });

  describe("Function 'unBlocklist()'", async () => {
    it("Executes as expected and emits the correct event if it is called by a blocklister", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await proveTx(connect(blocklistableMock, blocklister).blocklist(user.address));
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(true);

      await expect(connect(blocklistableMock, blocklister).unBlocklist(user.address))
        .to.emit(blocklistableMock, EVENT_NAME_UNBLOCKLISTED)
        .withArgs(user.address);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(false);

      // The second call with the same argument should not emit an event
      await expect(
        connect(blocklistableMock, blocklister).unBlocklist(user.address)
      ).not.to.emit(blocklistableMock, EVENT_NAME_UNBLOCKLISTED);
    });

    it("Is reverted if it is called by an account without the blocklister role", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await expect(
        blocklistableMock.unBlocklist(user.address)
      ).to.be.revertedWithCustomError(
        blocklistableMock,
        REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT
      ).withArgs(deployer.address, blocklisterRole);
    });
  });

  describe("Function 'selfBlocklist()'", async () => {
    it("Executes as expected and emits the correct events if it is called by any account", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(false);

      await expect(connect(blocklistableMock, user).selfBlocklist())
        .to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED)
        .withArgs(user.address)
        .and.to.emit(blocklistableMock, EVENT_NAME_SELFBLOCKLISTED)
        .withArgs(user.address);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(true);

      // Second call should not emit an event
      await expect(
        connect(blocklistableMock, user).selfBlocklist()
      ).not.to.emit(blocklistableMock, EVENT_NAME_SELFBLOCKLISTED);
    });
  });

  describe("Modifier 'notBlocklisted'", async () => {
    it("Reverts the target function if the caller is blocklisted", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);

      await proveTx(connect(blocklistableMock, blocklister).blocklist(deployer.address));
      await expect(
        blocklistableMock.testNotBlocklistedModifier()
      ).to.be.revertedWithCustomError(blocklistableMock, REVERT_ERROR_IF_ACCOUNT_IS_BLOCKLISTED);
    });

    it("Does not revert the target function if the caller is not blocklisted", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await expect(
        connect(blocklistableMock, user).testNotBlocklistedModifier()
      ).to.emit(blocklistableMock, EVENT_NAME_TEST_NOT_BLOCKLISTED_MODIFIER_SUCCEEDED);
    });
  });
});
