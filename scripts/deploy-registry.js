// Upgrades an existing deployment to the current generation of the metadata registry.
//
// Reads deployments/<network>.json, deploys a new TokenMetadataRegistry(tokenFactory) (its
// canEdit lets the token owner, the wallet that renounced a platform token's ownership or the
// QuickLaunch creator write a token's profile at any time; controllerOf names the owner or
// renouncer who may also write the tokenomics),
// points it at the PresaleFactory (metadataRegistry.setPresaleFactory, by the TokenFactory owner),
// deploys a new QuickLaunch(tokenFactory, presaleFactory, newRegistry, rewardTokens) because the
// registry address inside QuickLaunch is immutable, and wires presaleFactory.setQuickLaunch. Treasury,
// LiquidityLocker, TokenFactory, PresaleFactory, PresaleCode, HoodSaleToken and HoodSaleLens are
// kept. Profiles and tokenomics written to the previous registry are not copied.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-registry.js --network robinhood
//
// Optional environment:
//   METADATA_REGISTRY=0x...  reuse an already deployed new TokenMetadataRegistry
//   QUICK_LAUNCH=0x...       reuse an already deployed new QuickLaunch (must point at the new registry)
//   ALLOW_DEAD_ROUTES=1      deploy although a stock with pools has no quotable V3 route (warns instead)
//
// Safe to re-run: every wiring step is skipped when the chain already holds the value, and the
// reuse variables let a run that stopped half way continue without deploying twice. The
// deployments file is rewritten with the new addresses; the other addresses are kept and the
// replaced contracts are remembered under previousMetadataRegistry / previousQuickLaunch.
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
  for (const key of ["tokenFactory", "presaleFactory", "hoodsale"]) {
    if (!d[key]) throw new Error(`deployments/${network}.json has no ${key}`);
  }
  console.log(`Upgrading ${network} with ${deployer.address}`);
  console.log(`Current metadataRegistry ${d.metadataRegistry || "-"}, quickLaunch ${d.quickLaunch || "-"}`);

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  // registry.setPresaleFactory is restricted to the TokenFactory owner, presaleFactory.setQuickLaunch
  // to the PresaleFactory owner: both must be the deployer for the wiring below
  const tokenFactoryOwner = await tokenFactory.owner();
  const presaleFactoryOwner = await presaleFactory.owner();
  if (!same(tokenFactoryOwner, deployer.address)) {
    throw new Error(`the deployer must own TokenFactory (owner is ${tokenFactoryOwner})`);
  }
  if (!same(presaleFactoryOwner, deployer.address)) {
    throw new Error(`the deployer must own PresaleFactory (owner is ${presaleFactoryOwner})`);
  }
  // The new QuickLaunch stores V3 routes for the stocks: on a chain with Uniswap V3 the rewards
  // deployer must carry the V3 router first (scripts/deploy-token-deployers.js)
  await requireV3Deployer(hre, d);
  // The V3 routes of the stocks are quoted before anything is deployed (every candidate on the
  // chain's QuoterV2): a round that fails or finds dead routes stops here, before any gas is spent
  const routes = await rewardRoutesFor(hre, d, { log: console.log });
  requireQuotableRoutes(routes);

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

  // 1. The new registry, pointed at the presale factory (allowlisted tokens and the quick creator path)
  const metadataRegistry = await deployOrReuse("METADATA_REGISTRY", "TokenMetadataRegistry", [d.tokenFactory]);
  if (!same(await metadataRegistry.tokenFactory(), d.tokenFactory)) {
    throw new Error("METADATA_REGISTRY does not point at this deployment's TokenFactory");
  }
  // Earlier generations of the registry have no controllerOf: a reused address must be the new one
  try {
    await metadataRegistry.controllerOf(d.hoodsale);
  } catch (e) {
    throw new Error(`${metadataRegistry.target} is not the current generation of TokenMetadataRegistry (no controllerOf)`);
  }
  await wire("metadataRegistry.presaleFactory", await metadataRegistry.presaleFactory(), presaleFactory.target, () =>
    metadataRegistry.setPresaleFactory(presaleFactory.target)
  );

  // 2. QuickLaunch writes the profile and the tokenomics of every quick token into the registry;
  //    its registry address is immutable, so it is redeployed on top of the new one
  //    (the token type generation takes the reward allowlist as well, scripts/lib/reward-tokens.js)
  const rewardTokens = await rewardAllowlistFor(hre, d);
  const quickLaunch = await deployOrReuse("QUICK_LAUNCH", "QuickLaunch", [
    d.tokenFactory,
    presaleFactory.target,
    metadataRegistry.target,
    rewardTokens,
    d.quickLaunch || hre.ethers.ZeroAddress, // the generation being replaced answers through this one
  ]);
  if (!same(await quickLaunch.metadataRegistry(), metadataRegistry.target)) {
    throw new Error("QUICK_LAUNCH does not point at the new registry");
  }
  if (!same(await quickLaunch.presaleFactory(), presaleFactory.target)) {
    throw new Error("QUICK_LAUNCH does not point at this deployment's PresaleFactory");
  }
  await wire("presaleFactory.quickLaunch", await presaleFactory.quickLaunch(), quickLaunch.target, () =>
    presaleFactory.setQuickLaunch(quickLaunch.target)
  );
  // The tokenized stocks swap through the V3 path stored here: the best quoted candidate per stock
  await applyRewardRoutes(hre, quickLaunch, routes, console.log);

  // 3. Deployments file: new addresses in, everything else kept
  const addresses = {
    ...d,
    metadataRegistry: metadataRegistry.target,
    quickLaunch: quickLaunch.target,
  };
  if (d.metadataRegistry && !same(d.metadataRegistry, metadataRegistry.target)) {
    addresses.previousMetadataRegistry = d.metadataRegistry;
  }
  if (d.quickLaunch && !same(d.quickLaunch, quickLaunch.target)) addresses.previousQuickLaunch = d.quickLaunch;
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
  console.log(`  metadataRegistry ${metadataRegistry.target}`);
  console.log(`  quickLaunch      ${quickLaunch.target}`);
  console.log(`  deployer can edit HOODS profile: ${await metadataRegistry.canEdit(d.hoodsale, deployer.address)}`);
  console.log(`  quickLaunch registry matches: ${same(await quickLaunch.metadataRegistry(), metadataRegistry.target)}`);
  if (network !== "hardhat" && network !== "localhost") {
    console.log("");
    console.log("Next: put metadataRegistry and quickLaunch into frontend/src/config/registry.js for this chain");
    console.log("(the lens and the presale factory are unchanged). Then verify the new contracts on Sourcify");
    console.log("(the keeper never verifies platform contracts on its own):");
    console.log(`  ADDRESSES=${metadataRegistry.target},${quickLaunch.target} npx hardhat run scripts/verify-contract.js --network ${network}`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
