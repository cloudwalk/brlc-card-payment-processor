import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../../test-utils/eth";

async function setUpFixture(func: any) {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'AccessControlExtUpgradeable'", async () => {
  const EVENT_NAME_ROLE_GRANTED = "RoleGranted";
  const EVENT_NAME_ROLE_REVOKED = "RoleRevoked";

  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = "Initializable: contract is already initialized";
  const REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING = "Initializable: contract is not initializing";

  const ownerRole: string = ethers.utils.id("OWNER_ROLE");
  const userRole: string = ethers.utils.id("USER_ROLE");

  let accessControlExtMockFactory: ContractFactory;
  let deployer: SignerWithAddress;
  let users: SignerWithAddress[];
  let userAddresses: string[];

  before(async () => {
    accessControlExtMockFactory = await ethers.getContractFactory("AccessControlExtUpgradeableMock");
    [deployer, ...users] = await ethers.getSigners();
    userAddresses = [
      users[0].address,
      users[1].address,
      users[2].address,
      users[3].address
    ];
  });

  async function deployAccessControlExtMock(): Promise<{ accessControlExtMock: Contract }> {
    const accessControlExtMock: Contract = await upgrades.deployProxy(accessControlExtMockFactory);
    await accessControlExtMock.deployed();
    return { accessControlExtMock };
  }

  describe("Function 'initialize()'", async () => {
    it("The external initializer configures the contract as expected", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);

      //The roles
      expect((await accessControlExtMock.OWNER_ROLE()).toLowerCase()).to.equal(ownerRole);

      // The role admins
      expect(await accessControlExtMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);

      // The deployer should have the owner role, but not the other roles
      expect(await accessControlExtMock.hasRole(ownerRole, deployer.address)).to.equal(true);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      await expect(
        accessControlExtMock.initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      await expect(
        accessControlExtMock.call_parent_initialize()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      await expect(
        accessControlExtMock.call_parent_initialize_unchained()
      ).to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_NOT_INITIALIZING);
    });
  });

  describe("Function 'grantRoleBatch()'", async () => {
    it("The function 'grantRoleBatch' executes as expected with 1 user", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      await proveTx(accessControlExtMock.setUserRoleAdmin());

      await expect(accessControlExtMock.grantRoleBatch(userRole, [userAddresses[0]]))
        .to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED)
        .withArgs(userRole, userAddresses[0], deployer.address);

      expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(true);
    });

    it("The function 'grantRoleBatch' executes as expected with multiple users", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      await proveTx(accessControlExtMock.setUserRoleAdmin());

      await expect(accessControlExtMock.grantRoleBatch(userRole, userAddresses))
        .to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED)
        .withArgs(userRole, userAddresses[0], deployer.address)
        .and.to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED)
        .withArgs(userRole, userAddresses[1], deployer.address)
        .and.to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED)
        .withArgs(userRole, userAddresses[2], deployer.address)
        .and.to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED)
        .withArgs(userRole, userAddresses[3], deployer.address)
      ;
      for (let userAddress of userAddresses) {
        expect(await accessControlExtMock.hasRole(userRole, userAddress)).to.equal(true);
      }
    });

    it("The function 'grantRoleBatch' revert if user does not have rights", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      const REVERT_MESSAGE_IF_USER_DOES_NOT_HAVE_RIGHTS = `AccessControl: account ${userAddresses[0].toLowerCase()} is missing role ${ownerRole.toLowerCase()}`;
      await proveTx(accessControlExtMock.setUserRoleAdmin());

      await expect(
        accessControlExtMock.connect(users[0]).grantRoleBatch(userRole, [])
      ).to.be.revertedWith(REVERT_MESSAGE_IF_USER_DOES_NOT_HAVE_RIGHTS);
    });

    it("The function 'revokeRoleBatch' executes as expected with 1 user", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      await proveTx(accessControlExtMock.setUserRoleAdmin());
      await proveTx(accessControlExtMock.grantRoleBatch(userRole, [userAddresses[0]]));
      await expect(accessControlExtMock.revokeRoleBatch(userRole, [
        userAddresses[0]
      ]))
        .to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED)
        .withArgs(userRole, userAddresses[0], deployer.address);

      expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(false);
    });

    it("The function 'revokeRoleBatch' executes as expected with multiple users", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      await proveTx(accessControlExtMock.setUserRoleAdmin());
      await proveTx(accessControlExtMock.grantRoleBatch(userRole, userAddresses));
      for (let userAddress of userAddresses) {
        expect(await accessControlExtMock.hasRole(userRole, userAddress)).to.equal(true);
      }
      await expect(accessControlExtMock.revokeRoleBatch(userRole, userAddresses))
        .to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED)
        .withArgs(userRole, userAddresses[0], deployer.address)
        .and.to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED)
        .withArgs(userRole, userAddresses[1], deployer.address)
        .and.to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED)
        .withArgs(userRole, userAddresses[2], deployer.address)
        .and.to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED)
        .withArgs(userRole, userAddresses[3], deployer.address)
      ;

      for (let userAddress of userAddresses) {
        expect(await accessControlExtMock.hasRole(userRole, userAddress)).to.equal(false);
      }
    });

    it("The function 'revokeRoleBatch' revert if user does not have rights", async () => {
      const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
      const REVERT_MESSAGE_IF_USER_DOES_NOT_HAVE_RIGHTS = `AccessControl: account ${userAddresses[0].toLowerCase()} is missing role ${ownerRole.toLowerCase()}`;
      await proveTx(accessControlExtMock.setUserRoleAdmin());
      await proveTx(accessControlExtMock.grantRoleBatch(userRole, userAddresses));
      await expect(
        accessControlExtMock.connect(users[0]).revokeRoleBatch(userRole, userAddresses)
      ).to.be.revertedWith(REVERT_MESSAGE_IF_USER_DOES_NOT_HAVE_RIGHTS);
    });
  });
});
