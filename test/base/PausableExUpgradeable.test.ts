import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { Contract, ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { proveTx } from "../../test-utils/eth";
import { createRevertMessageDueToMissingRole } from "../../test-utils/misc";

describe("Contract 'PauseControlUpgradeable'", async () => {
  const REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED = 'Initializable: contract is already initialized';

  let PauseControlMock: Contract;
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let ownerRole: string;
  let pauserRole: string;

  beforeEach(async () => {
    const PauseControlMock: ContractFactory = await ethers.getContractFactory("PauseControlUpgradeableMock");
    PauseControlMock = await upgrades.deployProxy(PauseControlMock);
    await PauseControlMock.deployed();

    [deployer, user] = await ethers.getSigners();

    //Roles
    ownerRole = (await PauseControlMock.OWNER_ROLE()).toLowerCase();
    pauserRole = (await PauseControlMock.PAUSER_ROLE()).toLowerCase();
  });

  it("The initialize function can't be called more than once", async () => {
    await expect(PauseControlMock.initialize())
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  it("The initialize unchained function can't be called more than once", async () => {
    await expect(PauseControlMock.initialize_unchained())
      .to.be.revertedWith(REVERT_MESSAGE_IF_CONTRACT_IS_ALREADY_INITIALIZED);
  });

  describe("Function 'pause()'", async () => {
    beforeEach(async () => {
      await proveTx(PauseControlMock.grantRole(pauserRole, user.address));
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      await expect(PauseControlMock.pause())
        .to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });

    it("Executes successfully if is called by an account with the pauser role", async () => {
      await proveTx(PauseControlMock.connect(user).pause());
      expect(await PauseControlMock.paused()).to.equal(true);
    });

    it("Emits the correct event", async () => {
      await expect(PauseControlMock.connect(user).pause())
        .to.emit(PauseControlMock, "Paused")
        .withArgs(user.address);
    });
  });

  describe("Function 'unpause()'", async () => {
    beforeEach(async () => {
      await proveTx(PauseControlMock.grantRole(pauserRole, user.address));
      await proveTx(PauseControlMock.connect(user).pause());
    });

    it("Is reverted if is called by an account without the pauser role", async () => {
      await expect(PauseControlMock.unpause())
        .to.be.revertedWith(createRevertMessageDueToMissingRole(deployer.address, pauserRole));
    });

    it("Executes successfully if is called by an account with the pauser role", async () => {
      await proveTx(PauseControlMock.connect(user).unpause());
      expect(await PauseControlMock.paused()).to.equal(false);
    });

    it("Emits the correct event", async () => {
      await expect(PauseControlMock.connect(user).unpause())
        .to.emit(PauseControlMock, "Unpaused")
        .withArgs(user.address);
    });
  });
});
