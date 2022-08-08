import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

describe("Contract 'PausableExUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = 'Initializable: contract is already initialized';

  let pausableExMock: Contract;
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let ownerRole: string;
  let pauserRole: string;

  beforeEach(async () => {
    const PausableExMock: ContractFactory = await ethers.getContractFactory("PausableExUpgradeableMock");
    pausableExMock = await upgrades.deployProxy(PausableExMock);
    await pausableExMock.deployed();

    [deployer, user] = await ethers.getSigners();

    //Roles
    ownerRole = (await pausableExMock.OWNER_ROLE()).toLowerCase();
    pauserRole = (await pausableExMock.PAUSER_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(pausableExMock.initialize())
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initialize unchained function can't be called more than once", async () => {
    await expect(pausableExMock.initialize_unchained())
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  describe("Function 'pause()'", async () => {
    beforeEach(async () => {
      await proveTx(pausableExMock.grantRole(pauserRole, user.address));
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      await expect(pausableExMock.pause())
        .to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });

    it("Executes successfully if is called by an account with the pauser role", async () => {
      await proveTx(pausableExMock.connect(user).pause());
      expect(await pausableExMock.paused()).to.equal(true);
    });

    it("Emits the correct event", async () => {
      await expect(pausableExMock.connect(user).pause())
        .to.emit(pausableExMock, "Paused")
        .withArgs(user.address);
    });
  });

  describe("Function 'unpause()'", async () => {
    beforeEach(async () => {
      await proveTx(pausableExMock.grantRole(pauserRole, user.address));
      await proveTx(pausableExMock.connect(user).pause());
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      await expect(pausableExMock.unpause())
        .to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });

    it("Executes successfully if is called by an account with the pauser role", async () => {
      await proveTx(pausableExMock.connect(user).unpause());
      expect(await pausableExMock.paused()).to.equal(false);
    });

    it("Emits the correct event", async () => {
      await expect(pausableExMock.connect(user).unpause())
        .to.emit(pausableExMock, "Unpaused")
        .withArgs(user.address);
    });
  });
});
