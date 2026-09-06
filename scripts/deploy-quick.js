// Upgrades an existing deployment to the quick presale generation of the contracts.
//
// Reads deployments/<network>.json, deploys PresaleCode, a new PresaleFactory (same constructor
// arguments as deploy.js), a new HoodSaleLens and QuickLaunch, then re-wires everything deploy.js
// wires for the factory: tokenFactory.setPresaleFactory, hoodsale.setPresaleFactory,
// presaleFactory.setTokenAllowed(hoodsale), presaleFactory.setLaunchKeeper,
// metadataRegistry.setPresaleFactory, presaleFactory.setPresaleCode and
// presaleFactory.setQuickLaunch. Treasury,
// LiquidityLocker, TokenFactory, HoodSaleToken and TokenMetadataRegistry are kept.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-quick.js --network robinhood
//
// Optional environment:
//   LAUNCH_KEEPER=0x...     wallet of the launch keeper bot (default: the deployer)
//   PRESALE_CODE=0x...      reuse an already deployed PresaleCode instead of deploying one
//   PRESALE_FACTORY=0x...   reuse an already deployed new PresaleFactory
//   LENS=0x...              reuse an already deployed new HoodSaleLens
//   QUICK_LAUNCH=0x...      reuse an already deployed QuickLaunch
//   ALLOW_DEAD_ROUTES=1     deploy although a stock with pools has no quotable V3 route (warns instead)
//
// Safe to re-run: every wiring step is skipped when the chain already holds the value, and the
// reuse variables let a run that stopped half way continue without deploying twice. The
// deployments file is rewritten with the new addresses; the other addresses are kept and the
// replaced factory and lens are remembered under previousPresaleFactory / previousLens.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { rewardAllowlistFor, rewardRoutesFor, applyRewardRoutes, requireV3Deployer, requireQuotableRoutes } = require("./lib/reward-tokens");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["router", "treasury", "locker", "tokenFactory", "hoodsale", "metadataRegistry"]) {
    if (!d[key]) throw new Error(`deployments/${network}.json has no ${key}`);
  }
  console.log(`Upgrading ${network} with ${deployer.address}`);
  console.log(`Current PresaleFactory ${d.presaleFactory || "-"}, lens ${d.lens || "-"}, quickLaunch ${d.quickLaunch || "-"}`);
  // The new QuickLaunch stores V3 routes for the stocks: on a chain with Uniswap V3 the rewards
  // deployer must carry the V3 router first (scripts/deploy-rewards-deployer.js)
  await requireV3Deployer(hre, d);
  // The V3 routes of the stocks are quoted before anything is deployed (every candidate on the
  // chain's QuoterV2): a round that fails or finds dead routes stops here, before any gas is spent
  const routes = await rewardRoutesFor(hre, d, { log: console.log });
  requireQuotableRoutes(routes);

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const hoodsale = await hre.ethers.getContractAt("HoodSaleToken", d.hoodsale);
  const metadataRegistry = await hre.ethers.getContractAt("TokenMetadataRegistry", d.metadataRegistry);

  const deployOrReuse = async (envKey, name, args) => {
    if (process.env[envKey]) {
      const addr = process.env[envKey];
      if (!hre.ethers.isAddress(addr)) throw new Error(`${envKey} is not an address: ${addr}`);
      if ((await hre.ethers.provider.getCode(addr)) === "0x") throw new Error(`${envKey} has no code on ${network}: ${addr}`);
      console.log(`${name}: reusing ${addr}`);
      return hre.ethers.getContractAt(name, addr);
    }
    const c = await hre.ethers.deployContract(name, args);
    await c.waitForDeployment();
    console.log(`${name}: deployed ${c.target}`);
    return c;
  };
  const wire = async (label, current, wanted, send) => {
    if (same(current, wanted)) {
      console.log(`${label}: already ${wanted}`);
      return;
    }
    await (await send()).wait();
    console.log(`${label}: set to ${wanted}`);
  };

  // 1. Presale creation code holder and the new factory
  const presaleCode = await deployOrReuse("PRESALE_CODE", "PresaleCode", []);
  const presaleFactory = await deployOrReuse("PRESALE_FACTORY", "PresaleFactory", [
    deployer.address,
    d.treasury,
    d.tokenFactory,
    d.locker,
    d.router,
  ]);
  await wire("presaleFactory.presaleCode", await presaleFactory.presaleCode(), presaleCode.target, () =>
    presaleFactory.setPresaleCode(presaleCode.target)
  );

  // 2. Everything deploy.js wires for the factory
  await wire("tokenFactory.presaleFactory", await tokenFactory.presaleFactory(), presaleFactory.target, () =>
    tokenFactory.setPresaleFactory(presaleFactory.target)
  );
  await wire("hoodsale.presaleFactory", await hoodsale.presaleFactory(), presaleFactory.target, () =>
    hoodsale.setPresaleFactory(presaleFactory.target)
  );
  if (await presaleFactory.allowedToken(d.hoodsale)) {
    console.log(`presaleFactory.allowedToken(hoodsale): already true`);
  } else {
    await (await presaleFactory.setTokenAllowed(d.hoodsale, true)).wait();
    console.log(`presaleFactory.allowedToken(hoodsale): set to true`);
  }
  const keeper = process.env.LAUNCH_KEEPER || deployer.address;
  await wire("presaleFactory.launchKeeper", await presaleFactory.launchKeeper(), keeper, () =>
    presaleFactory.setLaunchKeeper(keeper)
  );
  await wire("metadataRegistry.presaleFactory", await metadataRegistry.presaleFactory(), presaleFactory.target, () =>
    metadataRegistry.setPresaleFactory(presaleFactory.target)
  );

  // 3. Lens and QuickLaunch on top of the new factory
  const lens = await deployOrReuse("LENS", "HoodSaleLens", [presaleFactory.target, d.tokenFactory, d.router]);
  // The reward allowlist of quick Rewards launches (scripts/lib/reward-tokens.js)
  const rewardTokens = await rewardAllowlistFor(hre, d);
  // The generation being replaced answers for its own sales through the new one (creatorOf,
  // presaleOfToken), so every quick creator keeps editing their token profile
  const quickLaunch = await deployOrReuse("QUICK_LAUNCH", "QuickLaunch", [
    d.tokenFactory,
    presaleFactory.target,
    d.metadataRegistry,
    rewardTokens,
    d.quickLaunch || hre.ethers.ZeroAddress,
  ]);
  await wire("presaleFactory.quickLaunch", await presaleFactory.quickLaunch(), quickLaunch.target, () =>
    presaleFactory.setQuickLaunch(quickLaunch.target)
  );
  // The tokenized stocks swap through the V3 path stored here: the best quoted candidate per stock
  await applyRewardRoutes(hre, quickLaunch, routes, console.log);

  // 4. Deployments file: new addresses in, everything else kept
  const addresses = {
    ...d,
    presaleFactory: presaleFactory.target,
    presaleCode: presaleCode.target,
    lens: lens.target,
    quickLaunch: quickLaunch.target,
  };
  if (d.presaleFactory && !same(d.presaleFactory, presaleFactory.target)) addresses.previousPresaleFactory = d.presaleFactory;
  if (d.lens && !same(d.lens, lens.target)) addresses.previousLens = d.lens;
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
  console.log(`  presaleFactory  ${presaleFactory.target}`);
  console.log(`  presaleCode     ${presaleCode.target}`);
  console.log(`  lens            ${lens.target}`);
  console.log(`  quickLaunch     ${quickLaunch.target}`);
  console.log(`  launchKeeper    ${keeper}`);
  console.log(`  quickCreationFee ${hre.ethers.formatEther(await presaleFactory.quickCreationFee())} ETH`);
  if (network !== "hardhat" && network !== "localhost") {
    console.log("");
    console.log("Next: put presaleFactory into frontend/src/config/addresses.js and lens plus quickLaunch into");
    console.log("frontend/src/config/registry.js for this chain, then run the keeper with the launchKeeper wallet:");
    console.log(`  KEEPER_KEY=0x... npm run keeper -- --network ${network}`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
