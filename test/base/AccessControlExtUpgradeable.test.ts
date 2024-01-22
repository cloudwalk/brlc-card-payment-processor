import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../../test-utils/eth";
import { TransactionResponse } from "@ethersproject/abstract-provider";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

async function setUpFixture<T>(func: () => Promise<T>): Promise<T> {
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
  let attacker: SignerWithAddress;
  let users: SignerWithAddress[];
  let userAddresses: string[];

  before(async () => {
    accessControlExtMockFactory = await ethers.getContractFactory("AccessControlExtUpgradeableMock");
    [deployer, attacker, ...users] = await ethers.getSigners();

    userAddresses = [users[0].address, users[1].address, users[2].address];
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
      expect((await accessControlExtMock.USER_ROLE()).toLowerCase()).to.equal(userRole);

      // The role admins
      expect(await accessControlExtMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
      expect(await accessControlExtMock.getRoleAdmin(userRole)).to.equal(ownerRole);

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
    describe("Executes as expected if the input account array contains", async () => {
      it("A single account without the previously granted role", async () => {
        const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
        expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(false);

        await expect(accessControlExtMock.grantRoleBatch(userRole, [userAddresses[0]]))
          .to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED)
          .withArgs(userRole, userAddresses[0], deployer.address);

        expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(true);
      });

      it("A single account with the previously granted role", async () => {
        const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
        await proveTx(accessControlExtMock.grantRoleBatch(userRole, [userAddresses[0]]));
        expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(true);

        await expect(
          accessControlExtMock.grantRoleBatch(userRole, [userAddresses[0]])
        ).not.to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED);
      });

      it("Multiple accounts without the previously granted role", async () => {
        const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
        for (const userAddress of userAddresses) {
          expect(await accessControlExtMock.hasRole(userRole, userAddress)).to.equal(false);
        }

        const tx: Promise<TransactionResponse> = accessControlExtMock.grantRoleBatch(userRole, userAddresses);

        for (const userAddress of userAddresses) {
          await expect(tx)
            .to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED)
            .withArgs(userRole, userAddress, deployer.address);
          expect(await accessControlExtMock.hasRole(userRole, userAddress)).to.equal(true);
        }
      });

      it("No accounts", async () => {
        const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);

        await expect(
          accessControlExtMock.grantRoleBatch(userRole, [])
        ).not.to.emit(accessControlExtMock, EVENT_NAME_ROLE_GRANTED);
      });
    });

    describe("Is reverted if", async () => {
      it("The sender does not have the expected admin role", async () => {
        const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);

        await expect(
          accessControlExtMock.connect(attacker).grantRoleBatch(userRole, [])
        ).to.be.revertedWith(createRevertMessageDueToMissingRole(attacker.address, ownerRole));
      });
    });

    describe("Function 'revokeRoleBatch()'", async () => {
      describe("Executes as expected if the input account array contains", async () => {
        it("A single account with the previously granted role", async () => {
          const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
          await proveTx(accessControlExtMock.grantRoleBatch(userRole, [userAddresses[0]]));
          expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(true);

          await expect(accessControlExtMock.revokeRoleBatch(userRole, [userAddresses[0]]))
            .to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED)
            .withArgs(userRole, userAddresses[0], deployer.address);

          expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(false);
        });

        it("A single account without the previously granted role", async () => {
          const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
          expect(await accessControlExtMock.hasRole(userRole, userAddresses[0])).to.equal(false);

          await expect(
            accessControlExtMock.revokeRoleBatch(userRole, [userAddresses[0]])
          ).not.to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED);
        });

        it("Multiple accounts with the previously granted role", async () => {
          const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);
          await proveTx(accessControlExtMock.grantRoleBatch(userRole, userAddresses));
          for (const userAddress of userAddresses) {
            expect(await accessControlExtMock.hasRole(userRole, userAddress)).to.equal(true);
          }

          const tx: Promise<TransactionResponse> = accessControlExtMock.revokeRoleBatch(userRole, userAddresses);

          for (const userAddress of userAddresses) {
            await expect(tx)
              .to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED)
              .withArgs(userRole, userAddress, deployer.address);
            expect(await accessControlExtMock.hasRole(userRole, userAddress)).to.equal(false);
          }
        });

        it("No accounts", async () => {
          const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);

          await expect(
            accessControlExtMock.revokeRoleBatch(userRole, [])
          ).not.to.emit(accessControlExtMock, EVENT_NAME_ROLE_REVOKED);
        });
      });

      describe("Is reverted if", async () => {
        it("The sender does not have the expected admin role", async () => {
          const { accessControlExtMock } = await setUpFixture(deployAccessControlExtMock);

          await expect(
            accessControlExtMock.connect(attacker).revokeRoleBatch(userRole, [])
          ).to.be.revertedWith(createRevertMessageDueToMissingRole(attacker.address, ownerRole));
        });
      });
    });
  });
});
