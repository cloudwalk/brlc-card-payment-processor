import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

describe("Contract 'BlacklistControlUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  const REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED = "BlacklistedAccount";

  let blacklistControlMock: Contract;
  let deployer: SignerWithAddress;
  let blacklister: SignerWithAddress;
  let user: SignerWithAddress;
  let ownerRole: string;
  let blacklisterRole: string;

  beforeEach(async () => {
    // Deploy the contract under test
    const BlacklistControlMock: ContractFactory = await ethers.getContractFactory("BlacklistControlUpgradeableMock");
    blacklistControlMock = await BlacklistControlMock.deploy();
    await blacklistControlMock.deployed();
    await proveTx(blacklistControlMock.initialize());

    // Accounts
    [deployer, blacklister, user] = await ethers.getSigners();

    // Roles
    ownerRole = (await blacklistControlMock.OWNER_ROLE()).toLowerCase();
    blacklisterRole = (await blacklistControlMock.BLACKLISTER_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(
      blacklistControlMock.initialize()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The init function of the ancestor contract can't be called outside the init process", async () => {
    await expect(
      blacklistControlMock.call_parent_initialize()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
  });

  it("The init unchained function of the ancestor contract can't be called outside the init process", async () => {
    await expect(
      blacklistControlMock.call_parent_initialize_unchained()
    ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
  });

  it("The initial contract configuration should be as expected", async () => {
    // The role admins
    expect(await blacklistControlMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
    expect(await blacklistControlMock.getRoleAdmin(blacklisterRole)).to.equal(ownerRole);

    // The deployer should have the owner role, but not the other roles
    expect(await blacklistControlMock.hasRole(ownerRole, deployer.address)).to.equal(true);
    expect(await blacklistControlMock.hasRole(blacklisterRole, deployer.address)).to.equal(false);
  });

  describe("Function 'blacklist()'", async () => {
    beforeEach(async () => {
      await proveTx(blacklistControlMock.grantRole(blacklisterRole, blacklister.address));
    });

    it("Is reverted if is called by an account without the blacklister role", async () => {
      await expect(
        blacklistControlMock.blacklist(deployer.address)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, blacklisterRole));
    });

    it("Executes successfully and emits the correct event", async () => {
      expect(await blacklistControlMock.isBlacklisted(user.address)).to.equal(false);
      await expect(
        blacklistControlMock.connect(blacklister).blacklist(user.address)
      ).to.emit(
        blacklistControlMock,
        "Blacklisted"
      ).withArgs(user.address);
      expect(await blacklistControlMock.isBlacklisted(user.address)).to.equal(true);

      // Second call with the same argument should not emit an event
      await expect(
        blacklistControlMock.connect(blacklister).blacklist(user.address)
      ).not.to.emit(blacklistControlMock, "Blacklisted");
    });
  });

  describe("Function 'unBlacklist()'", async () => {
    beforeEach(async () => {
      await proveTx(blacklistControlMock.grantRole(blacklisterRole, blacklister.address));
      await proveTx(blacklistControlMock.connect(blacklister).blacklist(user.address));
    });

    it("Is reverted if is called by an account without the blacklister role", async () => {
      await expect(
        blacklistControlMock.unBlacklist(user.address)
      ).to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, blacklisterRole));
    });

    it("Executes successfully and emits the correct event", async () => {
      expect(await blacklistControlMock.isBlacklisted(user.address)).to.equal(true);
      await expect(
        blacklistControlMock.connect(blacklister).unBlacklist(user.address)
      ).to.emit(
        blacklistControlMock,
        "UnBlacklisted"
      ).withArgs(user.address);
      expect(await blacklistControlMock.isBlacklisted(user.address)).to.equal(false);

      // Second call with the same argument should not emit an event
      await expect(
        blacklistControlMock.connect(blacklister).unBlacklist(user.address)
      ).not.to.emit(blacklistControlMock, "UnBlacklisted");
    });
  });

  describe("Function 'selfBlacklist()'", async () => {
    it("Executes successfully and emits the correct events if is called by any account", async () => {
      expect(await blacklistControlMock.isBlacklisted(blacklister.address)).to.equal(false);
      await expect(
        blacklistControlMock.connect(blacklister).selfBlacklist()
      ).to.emit(
        blacklistControlMock,
        "Blacklisted"
      ).withArgs(
        blacklister.address
      ).and.to.emit(
        blacklistControlMock, "SelfBlacklisted"
      ).withArgs(
        blacklister.address
      );
      expect(await blacklistControlMock.isBlacklisted(blacklister.address)).to.equal(true);

      // Second call should not emit an event
      await expect(
        blacklistControlMock.connect(blacklister).selfBlacklist()
      ).not.to.emit(blacklistControlMock, "SelfBlacklisted");
    });
  });

  describe("Modifier 'notBlacklisted'", async () => {
    it("Reverts the target function if the caller is blacklisted", async () => {
      await proveTx(blacklistControlMock.grantRole(blacklisterRole, blacklister.address));
      await proveTx(blacklistControlMock.connect(blacklister).blacklist(deployer.address));
      await expect(
        blacklistControlMock.testNotBlacklistedModifier()
      ).to.be.revertedWithCustomError(blacklistControlMock, REVERT_ERROR_IF_ACCOUNT_IS_BLACKLISTED);
    });

    it("Does not revert the target function if the caller is not blacklisted", async () => {
      await expect(
        blacklistControlMock.connect(user).testNotBlacklistedModifier()
      ).to.emit(blacklistControlMock, "TestNotBlacklistedModifierSucceeded");
    });
  });
});
