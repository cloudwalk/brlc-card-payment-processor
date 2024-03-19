import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-contract-sizer";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000
      }
    }
  },
  networks: {
    hardhat: {
      accounts: {
        mnemonic: "test test test test test test test test test test test junk"
      }
    },
    ganache: {
      url: "http://127.0.0.1:7545",
      accounts: {
        mnemonic: "test test test test test test test test test test test junk"
      }
    }
  },
  gasReporter: {
    enabled: false
  }
};

export default config;
