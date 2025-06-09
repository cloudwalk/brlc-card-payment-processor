import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { connect, proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole, setUpFixture } from "../../test-utils/common";

describe("Contract 'BlocklistableUpgradeable'", async () => {
  // Events of the contract under test
  const EVENT_NAME_BLOCKLISTED = "Blocklisted";
  const EVENT_NAME_SELFBLOCKLISTED = "SelfBlocklisted";
  const EVENT_NAME_TEST_NOT_BLOCKLISTED_MODIFIER_SUCCEEDED = "TestNotBlocklistedModifierSucceeded";
  const EVENT_NAME_UNBLOCKLISTED = "UnBlocklisted";

  // Error messages of the library contracts
  const ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  // Errors of the contract under test
  const ERROR_NAME_BLOCKLISTED_ACCOUNT = "BlocklistedAccount";

  const OWNER_ROLE: string = ethers.id("OWNER_ROLE");
  const GRANTOR_ROLE: string = ethers.id("GRANTOR_ROLE");
  const BLOCKLISTER_ROLE: string = ethers.id("BLOCKLISTER_ROLE");

  let deployer: HardhatEthersSigner;
  let blocklister: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  before(async () => {
    [deployer, blocklister, user] = await ethers.getSigners();
  });

  async function deployBlocklistableMock(): Promise<{ blocklistableMock: Contract }> {
    // The contract factory with the explicitly specified deployer account
    let blocklistableMockFactory = await ethers.getContractFactory("BlocklistableUpgradeableMock");
    blocklistableMockFactory = blocklistableMockFactory.connect(deployer);

    let blocklistableMock = await upgrades.deployProxy(blocklistableMockFactory) as Contract;
    await blocklistableMock.waitForDeployment();
    blocklistableMock = connect(blocklistableMock, deployer); // Explicitly specifying the initial account

    return { blocklistableMock };
  }

  async function deployAndConfigureBlocklistableMock(): Promise<{ blocklistableMock: Contract }> {
    const { blocklistableMock } = await deployBlocklistableMock();
    await proveTx(blocklistableMock.grantRole(GRANTOR_ROLE, deployer.address));
    await proveTx(blocklistableMock.grantRole(BLOCKLISTER_ROLE, blocklister.address));
    return { blocklistableMock };
  }

  describe("Function 'initialize()' and internal initializers", async () => {
    it("The external initializer configures the contract as expected", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);

      // The roles
      expect(await blocklistableMock.OWNER_ROLE()).to.equal(OWNER_ROLE);
      expect(await blocklistableMock.GRANTOR_ROLE()).to.equal(GRANTOR_ROLE);
      expect(await blocklistableMock.BLOCKLISTER_ROLE()).to.equal(BLOCKLISTER_ROLE);

      // The role admins
      expect(await blocklistableMock.getRoleAdmin(OWNER_ROLE)).to.equal(OWNER_ROLE);
      expect(await blocklistableMock.getRoleAdmin(GRANTOR_ROLE)).to.equal(OWNER_ROLE);
      expect(await blocklistableMock.getRoleAdmin(BLOCKLISTER_ROLE)).to.equal(GRANTOR_ROLE);

      // The deployer should have the owner role, but not the other roles
      expect(await blocklistableMock.hasRole(OWNER_ROLE, deployer.address)).to.equal(true);
      expect(await blocklistableMock.hasRole(GRANTOR_ROLE, deployer.address)).to.equal(false);
      expect(await blocklistableMock.hasRole(BLOCKLISTER_ROLE, deployer.address)).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(blocklistableMock.initialize())
        .to.be.revertedWith(ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { blocklistableMock } = await setUpFixture(deployBlocklistableMock);
      await expect(blocklistableMock.callParentInitializerUnchained())
        .to.be.revertedWith(ERROR_MESSAGE_INITIALIZABLE_CONTRACT_IS_NOT_INITIALIZING);
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
      await expect(connect(blocklistableMock, blocklister).blocklist(user.address))
        .not.to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED);
    });
  });

  it("Is reverted if the caller does not have the blocklister role", async () => {
    const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
    await expect(blocklistableMock.blocklist(user.address))
      .to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BLOCKLISTER_ROLE));
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
      await expect(connect(blocklistableMock, blocklister).unBlocklist(user.address))
        .not.to.emit(blocklistableMock, EVENT_NAME_UNBLOCKLISTED);
    });

    it("Is reverted if the caller does not have the blocklister role", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await expect(
        blocklistableMock.unBlocklist(user.address)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, BLOCKLISTER_ROLE));
    });
  });

  describe("Function 'selfBlocklist()'", async () => {
    it("Executes as expected and emits the correct events if it is called by any account", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(false);

      const tx = connect(blocklistableMock, user).selfBlocklist();
      await expect(tx).to.emit(blocklistableMock, EVENT_NAME_BLOCKLISTED).withArgs(user.address);
      await expect(tx).to.emit(blocklistableMock, EVENT_NAME_SELFBLOCKLISTED).withArgs(user.address);
      expect(await blocklistableMock.isBlocklisted(user.address)).to.equal(true);

      // Second call should not emit an event
      await expect(connect(blocklistableMock, user).selfBlocklist())
        .not.to.emit(blocklistableMock, EVENT_NAME_SELFBLOCKLISTED);
    });
  });

  describe("Modifier 'notBlocklisted'", async () => {
    it("Reverts the target function if the caller is blocklisted", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);

      await proveTx(connect(blocklistableMock, blocklister).blocklist(deployer.address));
      await expect(blocklistableMock.testNotBlocklistedModifier())
        .to.be.revertedWithCustomError(blocklistableMock, ERROR_NAME_BLOCKLISTED_ACCOUNT);
    });

    it("Does not revert the target function if the caller is not blocklisted", async () => {
      const { blocklistableMock } = await setUpFixture(deployAndConfigureBlocklistableMock);
      await expect(connect(blocklistableMock, user).testNotBlocklistedModifier())
        .to.emit(blocklistableMock, EVENT_NAME_TEST_NOT_BLOCKLISTED_MODIFIER_SUCCEEDED);
    });
  });
});
