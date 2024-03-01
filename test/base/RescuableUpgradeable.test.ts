import { ethers, network, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { proveTx } from "../../test-utils/eth";

async function setUpFixture<T>(func: () => Promise<T>): Promise<T> {
  if (network.name === "hardhat") {
    return loadFixture(func);
  } else {
    return func();
  }
}

describe("Contract 'RescuableUpgradeable'", async () => {
  const TOKEN_AMOUNT = 123;

  const EVENT_NAME_TRANSFER = "Transfer";

  const REVERT_ERROR_IF_CONTRACT_INITIALIZATION_IS_INVALID = "InvalidInitialization";
  const REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING = "NotInitializing";
  const REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT = "AccessControlUnauthorizedAccount";

  const ownerRole: string = ethers.utils.id("OWNER_ROLE");
  const rescuerRole: string = ethers.utils.id("RESCUER_ROLE");

  let rescuableMockFactory: ContractFactory;
  let tokenMockFactory: ContractFactory;

  let deployer: SignerWithAddress;
  let rescuer: SignerWithAddress;

  before(async () => {
    rescuableMockFactory = await ethers.getContractFactory("RescuableUpgradeableMock");
    tokenMockFactory = await ethers.getContractFactory("ERC20TokenMock");

    [deployer, rescuer] = await ethers.getSigners();
  });

  async function deployRescuableMock(): Promise<{ rescuableMock: Contract }> {
    const rescuableMock: Contract = await upgrades.deployProxy(rescuableMockFactory);
    await rescuableMock.deployed();
    return { rescuableMock };
  }

  async function deployTokenMock(): Promise<{ tokenMock: Contract }> {
    const tokenMock: Contract = await upgrades.deployProxy(tokenMockFactory, ["ERC20 Test", "TEST"]);
    await tokenMock.deployed();
    return { tokenMock };
  }

  async function deployAndConfigureAllContracts(): Promise<{ rescuableMock: Contract; tokenMock: Contract }> {
    const { rescuableMock } = await deployRescuableMock();
    const { tokenMock } = await deployTokenMock();

    await proveTx(tokenMock.mint(rescuableMock.address, TOKEN_AMOUNT));
    await proveTx(rescuableMock.grantRole(rescuerRole, rescuer.address));

    return {
      rescuableMock,
      tokenMock
    };
  }

  describe("Function 'initialize()'", async () => {
    it("The external initializer configures the contract as expected", async () => {
      const { rescuableMock } = await setUpFixture(deployRescuableMock);

      // The roles
      expect((await rescuableMock.OWNER_ROLE()).toLowerCase()).to.equal(ownerRole);
      expect((await rescuableMock.RESCUER_ROLE()).toLowerCase()).to.equal(rescuerRole);

      // The role admins
      expect(await rescuableMock.getRoleAdmin(ownerRole)).to.equal(ethers.constants.HashZero);
      expect(await rescuableMock.getRoleAdmin(rescuerRole)).to.equal(ownerRole);

      // The deployer should have the owner role, but not the other roles
      expect(await rescuableMock.hasRole(ownerRole, deployer.address)).to.equal(true);
      expect(await rescuableMock.hasRole(rescuerRole, deployer.address)).to.equal(false);
    });

    it("The external initializer is reverted if it is called a second time", async () => {
      const { rescuableMock } = await setUpFixture(deployRescuableMock);
      await expect(
        rescuableMock.initialize()
      ).to.be.revertedWithCustomError(rescuableMock, REVERT_ERROR_IF_CONTRACT_INITIALIZATION_IS_INVALID);
    });

    it("The internal initializer is reverted if it is called outside the init process", async () => {
      const { rescuableMock } = await setUpFixture(deployRescuableMock);
      await expect(
        rescuableMock.call_parent_initialize()
      ).to.be.revertedWithCustomError(rescuableMock, REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING);
    });

    it("The internal unchained initializer is reverted if it is called outside the init process", async () => {
      const { rescuableMock } = await setUpFixture(deployRescuableMock);
      await expect(
        rescuableMock.call_parent_initialize_unchained()
      ).to.be.revertedWithCustomError(rescuableMock, REVERT_ERROR_IF_CONTRACT_IS_NOT_INITIALIZING);
    });
  });

  describe("Function 'rescueERC20()'", async () => {
    it("Executes as expected and emits the correct event", async () => {
      const { rescuableMock, tokenMock } = await setUpFixture(deployAndConfigureAllContracts);

      await expect(rescuableMock.connect(rescuer).rescueERC20(tokenMock.address, deployer.address, TOKEN_AMOUNT))
        .to.changeTokenBalances(tokenMock, [rescuableMock, deployer, rescuer], [-TOKEN_AMOUNT, +TOKEN_AMOUNT, 0])
        .and.to.emit(tokenMock, EVENT_NAME_TRANSFER)
        .withArgs(rescuableMock.address, deployer.address, TOKEN_AMOUNT);
    });

    it("Is reverted if it is called by an account without the rescuer role", async () => {
      const { rescuableMock, tokenMock } = await setUpFixture(deployAndConfigureAllContracts);
      await expect(
        rescuableMock.rescueERC20(tokenMock.address, deployer.address, TOKEN_AMOUNT)
      ).to.be.revertedWithCustomError(
        rescuableMock,
        REVERT_ERROR_IF_UNAUTHORIZED_ACCOUNT
      ).withArgs(deployer.address, rescuerRole);
    });
  });
});
