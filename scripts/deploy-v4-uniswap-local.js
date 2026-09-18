// Puts Uniswap v4 itself on a local network, so the whole launch mode can be tried end to end
// against a dev node. On a real chain Uniswap is already there and this script is not used.
//
//   npx hardhat run scripts/deploy-v4-uniswap-local.js --network localhost
//
// PoolManager, PositionManager, StateView and V4Quoter are deployed from the artifacts the npm
// packages ship, which is the bytecode Uniswap runs on chain; this project compiles at evmVersion
// paris and cannot build them from source. Permit2 and the deterministic CREATE2 proxy have no
// constructor worth running, so their mainnet runtime code is planted at their canonical
// addresses, which only a dev node allows.
//
// The addresses land in deployments/localhost.json, where scripts/deploy-v4.js picks them up.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { PERMIT2, CREATE2_PROXY } = require("./lib/uniswap-v4");

const POOL_MANAGER = require("@uniswap/v4-core/out/PoolManager.sol/PoolManager.json");
const POSITION_MANAGER = require("@uniswap/v4-periphery/foundry-out/PositionManager.sol/PositionManager.json");
const STATE_VIEW = require("@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json");
const QUOTER = require("@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json");
const MAINNET = require("../test/v4/fixtures/mainnet-v4.json");

async function deployFromArtifact(artifact, signer, args) {
  const factory = new hre.ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function main() {
  const network = hre.network.name;
  if (network !== "localhost" && network !== "hardhat") {
    throw new Error(`refusing to run on ${network}: Uniswap v4 is already deployed on a real chain`);
  }
  const [deployer] = await hre.ethers.getSigners();
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: run scripts/deploy.js first`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.weth) throw new Error(`deployments/${network}.json lacks weth`);
  console.log(`Putting Uniswap v4 on ${network} with ${deployer.address}`);

  for (const [name, address, code] of [
    ["Permit2", PERMIT2, MAINNET.contracts.permit2.code],
    ["CREATE2 proxy", CREATE2_PROXY, MAINNET.contracts.create2Proxy.code],
  ]) {
    const existing = await hre.ethers.provider.getCode(address);
    if (existing === code) {
      console.log(`${name}: already at ${address}`);
      continue;
    }
    await hre.network.provider.send("hardhat_setCode", [address, code]);
    console.log(`${name}: planted at ${address}`);
  }

  const poolManager = await deployFromArtifact(POOL_MANAGER, deployer, [deployer.address]);
  console.log(`PoolManager: ${poolManager.target}`);
  // The descriptor only renders position art and is never called here.
  const positionManager = await deployFromArtifact(POSITION_MANAGER, deployer, [
    poolManager.target,
    PERMIT2,
    300_000n,
    hre.ethers.ZeroAddress,
    d.weth,
  ]);
  console.log(`PositionManager: ${positionManager.target}`);
  const stateView = await deployFromArtifact(STATE_VIEW, deployer, [poolManager.target]);
  console.log(`StateView: ${stateView.target}`);
  const quoter = await deployFromArtifact(QUOTER, deployer, [poolManager.target]);
  console.log(`V4Quoter: ${quoter.target}`);

  const next = {
    ...d,
    v4PoolManager: poolManager.target,
    v4PositionManager: positionManager.target,
    v4StateView: stateView.target,
    v4Quoter: quoter.target,
    permit2: PERMIT2,
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nSaved to deployments/${network}.json`);
  const frontendConfig = path.join(__dirname, "..", "..", "frontend", "src", "config", "localhost.json");
  if (fs.existsSync(path.dirname(frontendConfig))) {
    fs.writeFileSync(frontendConfig, JSON.stringify(next, null, 2));
    console.log("Updated frontend/src/config/localhost.json");
  }
  console.log("Next: npx hardhat run scripts/deploy-v4.js --network " + network);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
