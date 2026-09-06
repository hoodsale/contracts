require("@nomicfoundation/hardhat-toolbox");

// Robinhood Chain (Arbitrum Orbit L2). Official RPC and Blockscout explorer endpoints.
const ROBINHOOD_MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ROBINHOOD_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";
const ROBINHOOD_MAINNET_EXPLORER = "https://robinhoodchain.blockscout.com";
const ROBINHOOD_TESTNET_EXPLORER = "https://explorer.testnet.chain.robinhood.com";

const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      // With FORK_URL set this is a mainnet fork: integration tests against the real Uniswap V2
      // (test/fork/*.test.js). Without it, the normal offline test network.
      ...(process.env.FORK_URL
        ? {
            forking: {
              url: process.env.FORK_URL,
              ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
            },
            chains: { 4663: { hardforkHistory: { cancun: 0 } } },
          }
        : {}),
    },
    robinhood: {
      url: process.env.ROBINHOOD_RPC || ROBINHOOD_MAINNET_RPC,
      chainId: 4663,
      accounts,
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC || ROBINHOOD_TESTNET_RPC,
      chainId: 46630,
      accounts,
    },
  },
  // Blockscout exposes an Etherscan-compatible verification API; no key is required.
  etherscan: {
    apiKey: {
      robinhood: process.env.BLOCKSCOUT_API_KEY || "blockscout",
      robinhoodTestnet: process.env.BLOCKSCOUT_API_KEY || "blockscout",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: { apiURL: `${ROBINHOOD_MAINNET_EXPLORER}/api`, browserURL: ROBINHOOD_MAINNET_EXPLORER },
      },
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: { apiURL: `${ROBINHOOD_TESTNET_EXPLORER}/api`, browserURL: ROBINHOOD_TESTNET_EXPLORER },
      },
    ],
  },
  sourcify: { enabled: false },
  mocha: { timeout: 180000 },
};
