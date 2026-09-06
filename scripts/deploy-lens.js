// Replaces HoodSaleLens on an existing deployment (read-only views; nothing else moves).
// Use it when the view structs changed (for example PresaleView gained buyTaxBps / sellTaxBps).
//
// Reads deployments/<network>.json, deploys HoodSaleLens(presaleFactory, tokenFactory, router)
// and rewrites the file with the new address; the replaced lens is remembered under previousLens.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-lens.js --network robinhood
//
// Then put the new lens into frontend/src/config/registry.js for the chain.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["presaleFactory", "tokenFactory", "router"]) {
    if (!d[k]) throw new Error(`deployments/${network}.json lacks ${k}`);
  }
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Replacing HoodSaleLens on ${network} with ${deployer.address}`);
  console.log(`Current lens ${d.lens || "-"}, presaleFactory ${d.presaleFactory}`);

  const lens = await hre.ethers.deployContract("HoodSaleLens", [d.presaleFactory, d.tokenFactory, d.router]);
  await lens.waitForDeployment();
  console.log(`HoodSaleLens: deployed ${lens.target}`);

  // Sanity: the new lens must read the same factory.
  const wired = await lens.presaleFactory();
  if (wired.toLowerCase() !== d.presaleFactory.toLowerCase()) throw new Error("lens factory mismatch");

  const next = { ...d, lens: lens.target };
  if (d.lens && d.lens.toLowerCase() !== lens.target.toLowerCase()) next.previousLens = d.lens;
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  console.log(`Saved to deployments/${network}.json`);
  console.log("\nNew addresses");
  console.log(`  lens  ${lens.target}`);
  console.log("\nNext: put lens into frontend/src/config/registry.js for this chain (and quickLaunch if it changed).");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
