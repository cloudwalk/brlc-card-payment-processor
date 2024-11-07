import { ethers, upgrades } from "hardhat";

async function main() {
  const CONTRACT_NAME: string = ""; // TODO: Enter contract name
  const TOKEN_ADDRESS: string = ""; // TODO: Enter token contract address

  const factory = await ethers.getContractFactory(CONTRACT_NAME);
  const proxy = await upgrades.deployProxy(
    factory,
    [TOKEN_ADDRESS],
    { kind: "uups" }
  );

  await proxy.waitForDeployment();

  console.log("Proxy deployed to:", await proxy.getAddress());
}

main().then().catch(err => {
  throw err;
});
