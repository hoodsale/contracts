// Replaces QuickLaunch on an existing deployment (the token type generation: launch takes a
// QuickParams struct with tokenType Standard / Tax / Rewards, a tax wallet and a reward token;
// quickTokenOf; distributeRewards; the reward token allowlist; the extended QuickLaunched event).
//
// Reads deployments/<network>.json, deploys QuickLaunch(tokenFactory, presaleFactory,
// metadataRegistry, rewardTokens, previousQuickLaunch) on top of the CURRENT registry and
// factory, with the QuickLaunch currently in the file as previousQuickLaunch, wires
// presaleFactory.setQuickLaunch (PresaleFactory owner) and rewrites the file with the new
// address; the replaced contract is remembered under previousQuickLaunch. Nothing else moves
// and the sales created through the previous QuickLaunch keep running (their creator stays
// readable through PresaleFactory.quickCreatorOf). The new generation answers creatorOf and
// presaleOfToken for the sales of the one it replaces, so TokenMetadataRegistry.canEdit keeps
// letting every quick creator edit their token profile after the upgrade. The reward allowlist
// comes from scripts/lib/reward-tokens.js (WETH, USDG and the tokenized stocks on mainnet, plus
// the Uniswap V3 swap routes of the stocks: every candidate path of a stock is quoted on the
// chain's QuoterV2 and the best one is stored with setRewardRouteV3); the deployer becomes the
// owner of QuickLaunch, which only manages that allowlist and those routes (setRewardTokenAllowed,
// setRewardRoute, setRewardRouteV3). The Rewards tokens launched through it stay owned by it
// forever; a replacement QuickLaunch does not take them over, and their distributeRewards keeps
// working on the old one (the keeper follows each sale's owner).
//
// On a chain with Uniswap V3 the token factory's rewards deployer must carry the V3 router
// (scripts/deploy-rewards-deployer.js): QuickLaunch reads the V3 factory through it and
// setRewardRouteV3 reverts without it, so the script refuses to run before that upgrade.
//
// The stock routes are quoted BEFORE anything is deployed, so a quoting round that fails (the RPC
// down, a pool that cannot fill the quote) costs no gas: a stock whose pools exist but none of
// which can be quoted stops the script (ALLOW_DEAD_ROUTES=1 deploys without a route for it); a
// stock without any pool only warns. The route table printed before the wiring shows which reward
// tokens can be picked right now: a launch needs every pool of the reward route to exist with
// depth (isRewardRouteLive). A stock without such a pool prints a WARNING line and stays on the
// allowlist; the stock becomes pickable on its own once a pool with depth exists.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-quicklaunch.js --network robinhood
//
// Optional environment:
//   QUICK_LAUNCH=0x...    reuse an already deployed new QuickLaunch (must point at the current
//                         registry and factory)
//   ALLOW_DEAD_ROUTES=1   deploy although a stock with pools has no quotable route (warns instead)
//
// Safe to re-run: the wiring step is skipped when the chain already holds the value.
// The lens is not touched here; when HoodSaleLens changed as well (PresaleView.buyTaxBps /
// sellTaxBps), deploy it separately or run scripts/deploy-quick.js.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { rewardAllowlistFor, rewardRoutesFor, applyRewardRoutes, rewardRouteStatus, requireV3Deployer, requireQuotableRoutes } = require("./lib/reward-tokens");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["tokenFactory", "presaleFactory", "metadataRegistry"]) {
    if (!d[key]) throw new Error(`deployments/${network}.json has no ${key}`);
  }
  console.log(`Replacing QuickLaunch on ${network} with ${deployer.address}`);
  console.log(`Current quickLaunch ${d.quickLaunch || "-"}, registry ${d.metadataRegistry}, factory ${d.presaleFactory}`);

  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const presaleFactoryOwner = await presaleFactory.owner();
  if (!same(presaleFactoryOwner, deployer.address)) {
    throw new Error(`the deployer must own PresaleFactory (owner is ${presaleFactoryOwner})`);
  }

  // The V3 leg: on a chain with Uniswap V3 the rewards deployer must carry the router first
  const v3Deployer = await requireV3Deployer(hre, d);
  if (v3Deployer) console.log(`Rewards deployer ${v3Deployer.address}: V3 router ${v3Deployer.v3Router}, quoter ${v3Deployer.v3Quoter}`);

  const rewardTokens = await rewardAllowlistFor(hre, d);
  console.log(`Reward allowlist (${rewardTokens.length}): ${rewardTokens.join(", ")}`);
  // The V3 routes of the stocks are quoted first (every candidate on the chain's QuoterV2): a
  // round that fails or finds dead routes stops here, before any gas is spent
  const routes = await rewardRoutesFor(hre, d, { log: console.log });
  requireQuotableRoutes(routes);

  let quickLaunch;
  if (process.env.QUICK_LAUNCH) {
    const addr = process.env.QUICK_LAUNCH;
    if (!hre.ethers.isAddress(addr)) throw new Error(`QUICK_LAUNCH is not an address: ${addr}`);
    if ((await hre.ethers.provider.getCode(addr)) === "0x") throw new Error(`QUICK_LAUNCH has no code on ${network}: ${addr}`);
    quickLaunch = await hre.ethers.getContractAt("QuickLaunch", addr);
    console.log(`QuickLaunch: reusing ${addr}`);
  } else {
    // The generation being replaced answers for its own sales through the new one (creatorOf,
    // presaleOfToken), so every quick creator keeps editing their token profile
    quickLaunch = await hre.ethers.deployContract("QuickLaunch", [
      d.tokenFactory,
      d.presaleFactory,
      d.metadataRegistry,
      rewardTokens,
      d.quickLaunch || hre.ethers.ZeroAddress,
    ]);
    await quickLaunch.waitForDeployment();
    console.log(`QuickLaunch: deployed ${quickLaunch.target}`);
  }
  if (!same(await quickLaunch.tokenFactory(), d.tokenFactory)) {
    throw new Error("QuickLaunch does not point at this deployment's TokenFactory");
  }
  if (!same(await quickLaunch.presaleFactory(), d.presaleFactory)) {
    throw new Error("QuickLaunch does not point at this deployment's PresaleFactory");
  }
  if (!same(await quickLaunch.metadataRegistry(), d.metadataRegistry)) {
    throw new Error("QuickLaunch does not point at this deployment's TokenMetadataRegistry");
  }
  // Earlier generations have no token type and no previous generation link: a reused address
  // must be the new one
  for (const [marker, read] of [
    ["MIN_REWARDS_TAX_BPS", () => quickLaunch.MIN_REWARDS_TAX_BPS()],
    ["previousQuickLaunch", () => quickLaunch.previousQuickLaunch()],
  ]) {
    try {
      await read();
    } catch (e) {
      throw new Error(`${quickLaunch.target} is not the current generation of QuickLaunch (no ${marker})`);
    }
  }
  for (const t of rewardTokens) {
    if (!(await quickLaunch.isRewardTokenAllowed(t))) {
      throw new Error(`${quickLaunch.target} does not allow the reward token ${t}; run setRewardTokenAllowed or deploy a fresh one`);
    }
  }
  // The tokenized stocks swap through the V3 path stored here: the best quoted candidate per stock
  await applyRewardRoutes(hre, quickLaunch, routes, console.log);

  // The depth verdict of every allowed reward token before the factory switches over. A token
  // whose route has no pool with depth cannot be picked by a launch until one exists; that is
  // expected for stocks without a pool, so it is a warning, not a stop.
  const status = await rewardRouteStatus(hre, quickLaunch);
  console.log(`Reward routes (${status.length}):`);
  for (const r of status) console.log(`  ${r.line}`);
  for (const r of status.filter((r) => !r.live)) {
    console.log(`WARNING: ${r.symbol} cannot be picked as a reward token until a pool with depth exists for its route (token -> ${r.path.join(" -> ")})`);
  }

  const current = await presaleFactory.quickLaunch();
  if (same(current, quickLaunch.target)) {
    console.log(`presaleFactory.quickLaunch: already ${quickLaunch.target}`);
  } else {
    await (await presaleFactory.setQuickLaunch(quickLaunch.target)).wait();
    console.log(`presaleFactory.quickLaunch: set to ${quickLaunch.target}`);
  }

  const addresses = { ...d, quickLaunch: quickLaunch.target };
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
  console.log("New address");
  console.log(`  quickLaunch         ${quickLaunch.target}`);
  console.log(`  previousQuickLaunch ${await quickLaunch.previousQuickLaunch()}`);
  console.log(`  owner               ${await quickLaunch.owner()}`);
  console.log(`  maxCreatorTaxBps    ${await quickLaunch.MAX_CREATOR_TAX_BPS()}`);
  console.log(`  minRewardsTaxBps    ${await quickLaunch.MIN_REWARDS_TAX_BPS()}`);
  console.log(`  routeProbeWeth      ${hre.ethers.formatEther(await quickLaunch.ROUTE_PROBE_WETH())} ETH`);
  console.log(`  rewardTokens        ${(await quickLaunch.rewardTokens()).join(", ")}`);
  for (const r of await rewardRouteStatus(hre, quickLaunch)) console.log(`  route               ${r.line}`);
  console.log(`  quickCreationFee    ${hre.ethers.formatEther(await presaleFactory.quickCreationFee())} ETH`);
  console.log(`  launchKeeper        ${await presaleFactory.launchKeeper()} (may send distributeRewards, with the owner above)`);
  if (network !== "hardhat" && network !== "localhost") {
    console.log("");
    console.log("Next: put quickLaunch into frontend/src/config/registry.js for this chain and run");
    console.log(`  npx hardhat run scripts/check-deployment.js --network ${network}`);
    console.log("Every *_matchesBuild line must read true before the frontend is wired; a false lens means");
    console.log("scripts/deploy-lens.js, a false registry means scripts/deploy-registry.js.");
    console.log("Optional, only if the QuickLaunch source is meant to be public (Sourcify is the primary target,");
    console.log("the keeper never verifies platform contracts on its own):");
    console.log(`  ADDRESSES=${quickLaunch.target} npx hardhat run scripts/verify-contract.js --network ${network}`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
