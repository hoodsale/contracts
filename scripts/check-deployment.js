// Read-only sanity check of a deployment: prints the wiring between the platform
// contracts (including QuickLaunch, the quick creation fee and the launch keeper) and the
// HOODS token state. Usage:
//   npx hardhat run scripts/check-deployment.js --network robinhood
const hre = require("hardhat");
const { describeRewardRoutes } = require("./lib/reward-tokens");
const fs = require("fs");
const path = require("path");

/**
 * True when the code at `address` is the current build of `name`, with the immutable slots of
 * both masked out (their values differ per deployment, nothing else may).
 */
async function matchesBuild(hre, name, address) {
  const artifact = await hre.artifacts.readArtifact(name);
  const fqn = `${artifact.sourceName}:${artifact.contractName}`;
  const info = await hre.artifacts.getBuildInfo(fqn);
  const evm = info.output.contracts[artifact.sourceName][artifact.contractName].evm.deployedBytecode;
  const built = Buffer.from(evm.object, "hex");
  const onChain = Buffer.from((await hre.ethers.provider.getCode(address)).slice(2), "hex");
  if (built.length !== onChain.length) return false;
  for (const refs of Object.values(evm.immutableReferences || {})) {
    for (const { start, length } of refs) {
      built.fill(0, start, start + length);
      onChain.fill(0, start, start + length);
    }
  }
  // The CBOR metadata trailer (its length sits in the last two bytes) carries a hash of every
  // source of the compilation, so it changes whenever any imported file changes, comments
  // included; the code before it is what runs.
  const withoutMetadata = (code) => code.subarray(0, code.length - 2 - code.readUInt16BE(code.length - 2));
  return withoutMetadata(built).equals(withoutMetadata(onChain));
}

async function main() {
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const p = hre.ethers.provider;
  const [signer] = await hre.ethers.getSigners().catch(() => []);
  const deployer = process.env.DEPLOYER_ADDRESS || (signer ? signer.address : null);

  const tf = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const pf = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const tr = await hre.ethers.getContractAt("Treasury", d.treasury);
  const hs = await hre.ethers.getContractAt("HoodSaleToken", d.hoodsale);
  // Reads that only exist on the quick-presale generation of the contracts print "-" on an older deployment
  const safe = (fn) => fn().catch(() => "-");

  const out = {
    chainId: (await p.getNetwork()).chainId.toString(),
    block: await p.getBlockNumber(),
    tokenFactory_platformTaxBps: (await tf.platformTaxBps()).toString(),
    tokenFactory_presaleFactory: await tf.presaleFactory(),
    tokenFactory_treasury: await tf.treasury(),
    tokenFactory_rewardsDeployer: await tf.rewardsDeployer(),
    presaleFactory_tokenFactory: await pf.tokenFactory(),
    presaleFactory_treasury: await pf.treasury(),
    presaleFactory_locker: await pf.locker(),
    presaleFactory_hoodsaleAllowed: await pf.allowedToken(d.hoodsale),
    // The fee settings the frontend quotes from the chain (scripts/set-fees.js on mainnet: 2.5%
    // share, 10% exit penalty, no creation fees; the contract defaults are 10%, 10%, 0.1 and 0.03 ETH)
    presaleFactory_platformFeeBps: (await pf.platformFeeBps()).toString(),
    presaleFactory_exitPenaltyBps: (await pf.exitPenaltyBps()).toString(),
    presaleFactory_creationFee: `${hre.ethers.formatEther(await pf.creationFee())} ETH`,
    presaleFactory_quickCreationFee: await safe(async () => `${hre.ethers.formatEther(await pf.quickCreationFee())} ETH`),
    presaleFactory_presaleCode: await safe(() => pf.presaleCode()),
    presaleFactory_quickLaunch: await safe(() => pf.quickLaunch()),
    treasury_hoodsale: await tr.hoodsale(),
    treasury_owner: await tr.owner(),
    hoodsale_symbol: await hs.symbol(),
    hoodsale_totalSupply: hre.ethers.formatEther(await hs.totalSupply()),
    hoodsale_owner: await hs.owner(),
    hoodsale_mainPair: await hs.mainPair(),
    hoodsale_marketingWallet: await hs.marketingWallet(),
    hoodsale_presaleFactory: await hs.presaleFactory(),
  };
  if (d.metadataRegistry) {
    const reg = await hre.ethers.getContractAt("TokenMetadataRegistry", d.metadataRegistry);
    out.metadataRegistry_presaleFactory = await safe(() => reg.presaleFactory());
    // canEdit only exists on the editor generation of the registry
    if (deployer) out.metadataRegistry_deployerCanEditHoodsale = await safe(() => reg.canEdit(d.hoodsale, deployer));
  }
  if (d.lens) {
    const lens = await hre.ethers.getContractAt("HoodSaleLens", d.lens);
    out.lens_presaleFactory = await safe(() => lens.presaleFactory());
  }
  // The rewards deployer of the Uniswap V3 generation carries the chain's SwapRouter02 and QuoterV2
  // (the reward swap's V3 leg for the tokenized stocks); an earlier one prints "-" for both. The
  // address comes from the factory when the deployments file predates scripts/deploy-token-deployers.js.
  const rewardsDeployerAddr = d.rewardsDeployer || (await tf.rewardsDeployer());
  if (rewardsDeployerAddr && rewardsDeployerAddr !== hre.ethers.ZeroAddress) {
    const rd = await hre.ethers.getContractAt("RewardsTokenDeployer", rewardsDeployerAddr);
    out.rewardsDeployer = rewardsDeployerAddr;
    out.rewardsDeployer_v3Router = await safe(() => rd.v3Router());
    out.rewardsDeployer_v3Quoter = await safe(() => rd.v3Quoter());
    // The owner-locks generation holds RewardsToken's creation code in RewardsTokenCode
    out.rewardsDeployer_rewardsTokenCode = await safe(() => rd.rewardsTokenCode());
  }
  out.tokenFactory_standardDeployer = await tf.standardDeployer();
  out.tokenFactory_taxDeployer = await tf.taxDeployer();
  // The frontend ABIs come from the current build: a contract on chain that was deployed from
  // an earlier build answers with a different shape (the lens views, for instance) and breaks
  // the pages, so every upgradeable piece is compared with the build byte for byte
  // (immutable slots masked). "false" means redeploy before wiring the frontend.
  const builds = { ...d };
  if (rewardsDeployerAddr && rewardsDeployerAddr !== hre.ethers.ZeroAddress) builds.rewardsDeployer = rewardsDeployerAddr;
  builds.standardDeployer = out.tokenFactory_standardDeployer;
  builds.taxDeployer = out.tokenFactory_taxDeployer;
  if (out.rewardsDeployer_rewardsTokenCode && out.rewardsDeployer_rewardsTokenCode !== "-") builds.rewardsTokenCode = out.rewardsDeployer_rewardsTokenCode;
  for (const [key, name] of [
    ["lens", "HoodSaleLens"],
    ["quickLaunch", "QuickLaunch"],
    ["metadataRegistry", "TokenMetadataRegistry"],
    ["presaleFactory", "PresaleFactory"],
    ["presaleCode", "PresaleCode"],
    ["rewardsDeployer", "RewardsTokenDeployer"],
    ["standardDeployer", "StandardTokenDeployer"],
    ["taxDeployer", "TaxTokenDeployer"],
    ["rewardsTokenCode", "RewardsTokenCode"],
  ]) {
    if (builds[key]) out[`${key}_matchesBuild`] = await safe(() => matchesBuild(hre, name, builds[key]));
  }
  // Who may send QuickLaunch.distributeRewards (the keeper bot runs with the launch keeper wallet,
  // the deployer wallet owns QuickLaunch): the two are printed next to each other
  out.presaleFactory_launchKeeper = await pf.launchKeeper();
  out.quickLaunch = d.quickLaunch || "-";
  if (d.quickLaunch) {
    const ql = await hre.ethers.getContractAt("QuickLaunch", d.quickLaunch);
    out.quickLaunch_owner = await safe(() => ql.owner());
    out.quickLaunch_distributeRewardsBy = `launchKeeper ${out.presaleFactory_launchKeeper} or owner ${out.quickLaunch_owner}`;
    out.quickLaunch_tokenFactory = await safe(() => ql.tokenFactory());
    out.quickLaunch_presaleFactory = await safe(() => ql.presaleFactory());
    out.quickLaunch_metadataRegistry = await safe(() => ql.metadataRegistry());
    // QuickLaunch must write into the registry the frontend reads (deploy-registry.js replaces both)
    out.quickLaunch_registryMatches = await safe(
      async () => String(await ql.metadataRegistry()).toLowerCase() === String(d.metadataRegistry || "").toLowerCase()
    );
    out.quickLaunch_launches = await safe(async () => (await ql.allLaunchesLength()).toString());
    // Only the creator tax generation and later have this constant
    out.quickLaunch_maxCreatorTaxBps = await safe(async () => (await ql.MAX_CREATOR_TAX_BPS()).toString());
    // Only the token type generation has these (launch takes a QuickParams struct, Rewards type, allowlist)
    out.quickLaunch_minRewardsTaxBps = await safe(async () => (await ql.MIN_REWARDS_TAX_BPS()).toString());
    // Only the route depth generation has these (previousQuickLaunch fallback, isRewardRouteLive probes)
    out.quickLaunch_previousQuickLaunch = await safe(() => ql.previousQuickLaunch());
    out.quickLaunch_routeProbeWeth = await safe(async () => `${hre.ethers.formatEther(await ql.ROUTE_PROBE_WETH())} ETH`);
    out.quickLaunch_rewardTokens = await safe(async () => (await ql.rewardTokens()).join(", "));
    // V3 routes print as "TSLA: token -> WETH -0.3%-> TSLA (V3, pools live)", V2 ones without the fee tiers
    out.quickLaunch_rewardRoutes = await safe(async () => (await describeRewardRoutes(hre, ql)).join(" | "));
  }
  if (deployer) {
    out.deployer = deployer;
    out.deployer_hoodsale = hre.ethers.formatEther(await hs.balanceOf(deployer));
    out.deployer_eth = hre.ethers.formatEther(await p.getBalance(deployer));
  }
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(34), String(v));
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
