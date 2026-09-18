// Delivers every HOODS presale participant their tokens right after the launch.
//
// The HOODS sale is a normal sale, not a quick one, so finalize() opens the pool and stops there:
// each buyer would have to press Claim. Presale.distribute() is public and pushes the tokens to
// every wallet on the contributor list instead, so this script walks the list in batches until
// the sale reports delivery complete. Anyone may call distribute(), the caller only pays gas.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/distribute-hoods.js --network robinhood
//
// Environment:
//   PRESALE=0x...   the sale (default: the HOODS sale in deployments)
//   BATCH=<n>       contributor list entries visited per transaction (default 40)
//   DRY_RUN=1       check the state and estimate the first batch, send nothing
//
// A wallet whose token transfer fails is skipped, keeps its contribution, and can still claim
// on the sale page; the script names how many were left that way.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const FINALIZED = 5;

async function main() {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const saleAddr = process.env.PRESALE || d.hoodsalePresale;
  if (!saleAddr) throw new Error("set PRESALE, or record hoodsalePresale in the deployment file");
  const batch = BigInt(process.env.BATCH || "40");
  const dryRun = process.env.DRY_RUN === "1";

  const sale = await hre.ethers.getContractAt("Presale", saleAddr);
  const state = Number(await sale.status());
  const [sent0, total] = await sale.distributionProgress();
  console.log(`Delivering ${saleAddr} on ${network}`);
  console.log(`  status        ${["Upcoming", "Live", "Ended", "Failed", "Cancelled", "Finalized"][state] || state}`);
  console.log(`  delivered     ${sent0} of ${total} wallets`);

  if (state !== FINALIZED) {
    console.log("\nThe sale is not launched yet. Run this right after launch-hoods.js.");
    return;
  }
  if (await sale.distributionComplete()) {
    console.log("\nDelivery is already complete. Nothing to do.");
    return;
  }

  let sent = sent0;
  let round = 0;
  while (!(await sale.distributionComplete())) {
    round += 1;
    const cursorBefore = await sale.distributionCursor();
    const estimate = await sale.distribute.estimateGas(batch);
    const gasLimit = (estimate * 125n) / 100n;
    if (dryRun) {
      console.log(`\nDRY_RUN: the first batch of ${batch} would use about ${estimate} gas. Nothing was sent.`);
      return;
    }
    const tx = await sale.distribute(batch, { gasLimit });
    const rc = await tx.wait();
    const [now] = await sale.distributionProgress();
    const cursorAfter = await sale.distributionCursor();
    console.log(`  batch ${round}     ${rc.hash}  gas ${rc.gasUsed}  paid ${now - sent} wallets (${now}/${total})`);
    sent = now;
    if (cursorAfter === cursorBefore) {
      throw new Error("the cursor did not move; the list is not being walked, stopping");
    }
  }

  const [finalSent] = await sale.distributionProgress();
  console.log("");
  console.log(`Delivered ${finalSent} of ${total} wallets in ${round} transaction${round === 1 ? "" : "s"}.`);
  if (finalSent < total) {
    console.log(`${total - finalSent} wallet(s) could not receive a transfer; they can press Claim on the sale page.`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
