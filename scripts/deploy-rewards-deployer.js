// Replaces RewardsTokenDeployer on an existing deployment with the Uniswap V3 generation: the
// deployer carries the chain's SwapRouter02 and QuoterV2, so every new Rewards token swaps its
// rewards from WETH on through a Uniswap V3 path (the tokenized stocks trade on V3 on Robinhood
// Chain; their V2 pools hold dust) and starts on the V3 route QuickLaunch stores for its reward
// token. TokenFactory itself does not move: setDeployers swaps the deployer, the standard and tax
// deployers are kept as they are.
//
//   DEPLOYER_KEY=0x... ROBINHOOD_RPC=... npx hardhat run scripts/deploy-rewards-deployer.js --network robinhood
//
// Optional environment:
//   REWARDS_DEPLOYER=0x...  reuse an already deployed new RewardsTokenDeployer (must point at this
//                           deployment's TokenFactory and the chain's V3 router and quoter)
//
// Safe to re-run: the wiring step is skipped when the factory already holds the deployer. The
// deployments file gains rewardsDeployer, previousRewardsDeployer, v3Router, v3Quoter and
// v3Factory; every other key is kept. Run scripts/deploy-quicklaunch.js afterwards: QuickLaunch
// finds the V3 factory through tokenFactory.rewardsDeployer().v3Router() and the V3 routes of the
// stocks are stored per QuickLaunch generation (setRewardRouteV3), so the routes are quoted and
// stored by that script. Nothing here prints or stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { v3For, rewardsDeployerV3 } = require("./lib/reward-tokens");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.tokenFactory) throw new Error(`deployments/${network}.json has no tokenFactory`);
  console.log(`Replacing RewardsTokenDeployer on ${network} with ${deployer.address}`);

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const owner = await tokenFactory.owner();
  if (!same(owner, deployer.address)) throw new Error(`the deployer must own TokenFactory (owner is ${owner})`);

  const v3 = await v3For(hre, d);
  if (!v3) {
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    throw new Error(`no Uniswap V3 addresses for chainId ${chainId}; add them to V3_ADDRESSES_BY_CHAIN in scripts/lib/reward-tokens.js`);
  }
  // The router and the quoter must agree on the factory (the official Uniswap V3 set of the chain)
  const routerFactory = await (await hre.ethers.getContractAt("IV3SwapRouter", v3.router)).factory();
  const quoterFactory = await (await hre.ethers.getContractAt("IQuoterV2", v3.quoter)).factory();
  if (!same(routerFactory, quoterFactory)) throw new Error(`V3 router factory ${routerFactory} and quoter factory ${quoterFactory} differ`);
  if (v3.factory && !same(routerFactory, v3.factory)) throw new Error(`V3 router factory ${routerFactory} is not the configured factory ${v3.factory}`);
  const v3Factory = routerFactory;
  console.log(`Uniswap V3: factory ${v3Factory}, router ${v3.router}, quoter ${v3.quoter}`);

  const [standardDeployer, taxDeployer, previousRewardsDeployer] = await Promise.all([
    tokenFactory.standardDeployer(),
    tokenFactory.taxDeployer(),
    tokenFactory.rewardsDeployer(),
  ]);
  console.log(`Current deployers: standard ${standardDeployer}, tax ${taxDeployer}, rewards ${previousRewardsDeployer}`);
  const current = await rewardsDeployerV3(hre, d.tokenFactory);
  if (current && same(current.v3Router, v3.router) && same(current.v3Quoter, v3.quoter) && !process.env.REWARDS_DEPLOYER) {
    console.log(`rewardsDeployer ${current.address} already carries the chain's V3 router and quoter; nothing to deploy`);
  }

  let rewardsDeployer;
  if (process.env.REWARDS_DEPLOYER) {
    const addr = process.env.REWARDS_DEPLOYER;
    if (!hre.ethers.isAddress(addr)) throw new Error(`REWARDS_DEPLOYER is not an address: ${addr}`);
    if ((await hre.ethers.provider.getCode(addr)) === "0x") throw new Error(`REWARDS_DEPLOYER has no code on ${network}: ${addr}`);
    rewardsDeployer = await hre.ethers.getContractAt("RewardsTokenDeployer", addr);
    console.log(`RewardsTokenDeployer: reusing ${addr}`);
  } else if (current && same(current.v3Router, v3.router) && same(current.v3Quoter, v3.quoter)) {
    rewardsDeployer = await hre.ethers.getContractAt("RewardsTokenDeployer", current.address);
  } else {
    rewardsDeployer = await hre.ethers.deployContract("RewardsTokenDeployer", [d.tokenFactory, v3.router, v3.quoter]);
    await rewardsDeployer.waitForDeployment();
    console.log(`RewardsTokenDeployer: deployed ${rewardsDeployer.target}`);
  }
  if (!same(await rewardsDeployer.factory(), d.tokenFactory)) throw new Error("RewardsTokenDeployer does not point at this deployment's TokenFactory");
  if (!same(await rewardsDeployer.v3Router(), v3.router)) throw new Error("RewardsTokenDeployer does not carry the chain's V3 router");
  if (!same(await rewardsDeployer.v3Quoter(), v3.quoter)) throw new Error("RewardsTokenDeployer does not carry the chain's V3 quoter");

  if (same(previousRewardsDeployer, rewardsDeployer.target)) {
    console.log(`tokenFactory.rewardsDeployer: already ${rewardsDeployer.target}`);
  } else {
    await (await tokenFactory.setDeployers(standardDeployer, taxDeployer, rewardsDeployer.target)).wait();
    console.log(`tokenFactory.rewardsDeployer: set to ${rewardsDeployer.target}`);
  }
  const wired = await tokenFactory.rewardsDeployer();
  if (!same(wired, rewardsDeployer.target)) throw new Error(`tokenFactory.rewardsDeployer() reads ${wired}, expected ${rewardsDeployer.target}`);
  if (!same(await tokenFactory.standardDeployer(), standardDeployer) || !same(await tokenFactory.taxDeployer(), taxDeployer)) {
    throw new Error("the standard or tax deployer changed; they were meant to be kept");
  }

  const addresses = {
    ...d,
    rewardsDeployer: rewardsDeployer.target,
    v3Factory,
    v3Router: v3.router,
    v3Quoter: v3.quoter,
  };
  if (previousRewardsDeployer !== hre.ethers.ZeroAddress && !same(previousRewardsDeployer, rewardsDeployer.target)) {
    addresses.previousRewardsDeployer = previousRewardsDeployer;
  }
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
  console.log(`Saved to deployments/${network}.json`);

  if (network === "hardhat" || network === "localhost") {
    const frontendConfig = path.join(__dirname, "..", "..", "frontend", "src", "config", "localhost.json");
    if (fs.existsSync(path.dirname(frontendConfig))) {
      fs.writeFileSync(frontendConfig, JSON.stringify(addresses, null, 2));
      console.log("Updated frontend/src/config/localhost.json");
    }
  }

  console.log("");
  console.log("New addresses");
  console.log(`  rewardsDeployer         ${rewardsDeployer.target}`);
  console.log(`  previousRewardsDeployer ${addresses.previousRewardsDeployer || "-"}`);
  console.log(`  v3Factory               ${v3Factory}`);
  console.log(`  v3Router                ${v3.router}`);
  console.log(`  v3Quoter                ${v3.quoter}`);
  console.log(`  standardDeployer        ${standardDeployer} (kept)`);
  console.log(`  taxDeployer             ${taxDeployer} (kept)`);
  console.log("");
  console.log("Next: deploy the QuickLaunch generation that stores V3 routes and reads the V3 factory through this deployer:");
  console.log(`  DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-quicklaunch.js --network ${network}`);
  console.log("(it quotes the stock routes on QuoterV2 and stores the best path per stock with setRewardRouteV3), then");
  console.log(`  npx hardhat run scripts/check-deployment.js --network ${network}`);
  console.log("and check rewardsDeployer_matchesBuild and the route table. Rewards tokens created before this switch keep");
  console.log("their V2 route; only new tokens get the V3 leg.");
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
