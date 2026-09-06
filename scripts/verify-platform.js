// Verifies every platform contract listed in deployments/<network>.json.
//
//   npx hardhat run scripts/verify-platform.js --network robinhoodTestnet
//   DRY_RUN=1      npx hardhat run scripts/verify-platform.js --network robinhoodTestnet
//   FORCE_MANUAL=1 npx hardhat run scripts/verify-platform.js --network robinhood
//
// The order matches the deploy order (they are independent, each one is verified on its own):
//   Treasury, LiquidityLocker, TokenFactory, Standard/Tax/RewardsTokenDeployer (read from
//   TokenFactory, not present in the deployments file), PresaleFactory, HoodSaleToken,
//   TokenMetadataRegistry, HoodSaleLens.
// "router" (Uniswap, external contract) and "marketingWallet" (EOA) are skipped.
// "Already Verified" responses count as success; a summary table is printed at the end.

const { verifyAddresses, loadDeployments, optionsFromEnv, printSummary, STATUS } = require("./verify-contract");

const ORDER = [
  ["treasury", "Treasury"],
  ["locker", "LiquidityLocker"],
  ["tokenFactory", "TokenFactory"],
  ["presaleFactory", "PresaleFactory"],
  ["hoodsale", "HoodSaleToken"],
  ["metadataRegistry", "TokenMetadataRegistry"],
  ["lens", "HoodSaleLens"],
];

/** The list of targets to verify (label, address) and the keys missing from deployments. */
async function platformTargets(hre, deployments) {
  const targets = [];
  const skipped = [];
  const zero = hre.ethers.ZeroAddress;
  for (const [key, name] of ORDER) {
    const address = deployments[key];
    if (!address || address === zero) {
      skipped.push({ label: key, address: address || "-", contract: name, status: "skipped", message: "not in deployments file", warnings: [] });
      continue;
    }
    targets.push({ label: key, address });
    if (key === "tokenFactory") {
      const tf = await hre.ethers.getContractAt("TokenFactory", address);
      const deployers = [
        ["standardDeployer", await tf.standardDeployer()],
        ["taxDeployer", await tf.taxDeployer()],
        ["rewardsDeployer", await tf.rewardsDeployer()],
      ];
      for (const [label, addr] of deployers) {
        if (addr && addr !== zero) targets.push({ label, address: addr });
        else skipped.push({ label, address: "-", contract: label, status: "skipped", message: "not set on TokenFactory", warnings: [] });
      }
    }
  }
  return { targets, skipped };
}

/**
 * @param options { dryRun, forceManual, outDir, deployments, fromBlock, log, quiet }
 * @returns results (including the summary table; the skipped rows are included too)
 */
async function run(hre, options = {}) {
  const deployments = options.deployments || loadDeployments(hre, { required: true });
  const log = options.log || console.log;
  const { targets, skipped } = await platformTargets(hre, deployments);
  log(`[verify-platform] network ${hre.network.name}, ${targets.length} contracts${options.dryRun ? " (DRY_RUN)" : ""}`);
  const results = await verifyAddresses(hre, targets, { ...options, deployments, quiet: true });
  const all = [...results, ...skipped];
  if (!options.quiet) printSummary(all, log);
  return all;
}

async function main() {
  const hre = require("hardhat");
  const results = await run(hre, optionsFromEnv(hre));
  if (results.some((r) => r.status === STATUS.FAILED)) process.exitCode = 1;
}

module.exports = { main, run, platformTargets, ORDER };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
