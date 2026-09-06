// Sets the platform's fees on the PresaleFactory: the share of a completed raise, the early exit
// penalty and the two creation fees. The share applies to every sale created from then on (each
// Presale keeps the fee it was created with). Nothing is deployed.
//
//   DEPLOYER_KEY=0x... ROBINHOOD_RPC=... PLATFORM_FEE_BPS=250 CREATION_FEE_ETH=0 QUICK_CREATION_FEE_ETH=0 npx hardhat run scripts/set-fees.js --network robinhood
//
//   PLATFORM_FEE_BPS        the platform share in basis points (default 250 = 2.5%)
//   EXIT_PENALTY_BPS        the early exit penalty in basis points (default: unchanged)
//   CREATION_FEE_ETH        the presale creation fee in ETH, "0" for none (default: unchanged)
//   QUICK_CREATION_FEE_ETH  the quick presale creation fee in ETH, "0" for none (default: unchanged)
//
// The signer must own the PresaleFactory. The share and the penalty are capped by the contract
// (MAX_FEE_BPS).
const fs = require("fs");
const path = require("path");

async function main() {
  const hre = require("hardhat");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.presaleFactory) throw new Error("deployments file has no presaleFactory");

  const [signer] = await hre.ethers.getSigners();
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory, signer);
  const owner = await presaleFactory.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`the signer must own PresaleFactory (owner is ${owner}, signer is ${signer.address})`);
  }

  const currentFee = Number(await presaleFactory.platformFeeBps());
  const currentPenalty = Number(await presaleFactory.exitPenaltyBps());
  const fee = process.env.PLATFORM_FEE_BPS ? Number(process.env.PLATFORM_FEE_BPS) : 250;
  const penalty = process.env.EXIT_PENALTY_BPS ? Number(process.env.EXIT_PENALTY_BPS) : currentPenalty;
  const max = Number(await presaleFactory.MAX_FEE_BPS());
  for (const [name, v] of [["PLATFORM_FEE_BPS", fee], ["EXIT_PENALTY_BPS", penalty]]) {
    if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${name} must be an integer between 0 and ${max}, got ${v}`);
  }
  const pct = (bps) => {
    const n = bps / 100;
    return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "")}%`;
  };

  const eth = (wei) => `${hre.ethers.formatEther(wei)} ETH`;
  const currentCreation = await presaleFactory.creationFee();
  const currentQuick = await presaleFactory.quickCreationFee();
  const creation = process.env.CREATION_FEE_ETH !== undefined ? hre.ethers.parseEther(process.env.CREATION_FEE_ETH) : currentCreation;
  const quick = process.env.QUICK_CREATION_FEE_ETH !== undefined ? hre.ethers.parseEther(process.env.QUICK_CREATION_FEE_ETH) : currentQuick;

  console.log(`PresaleFactory ${d.presaleFactory} on ${network}`);
  console.log(`  platform share          ${pct(currentFee)} (${currentFee} bps)`);
  console.log(`  exit penalty            ${pct(currentPenalty)} (${currentPenalty} bps)`);
  console.log(`  presale creation fee    ${eth(currentCreation)}`);
  console.log(`  quick creation fee      ${eth(currentQuick)}`);
  let changed = false;
  if (fee !== currentFee || penalty !== currentPenalty) {
    const tx = await presaleFactory.setFees(fee, penalty);
    console.log(`setFees(${fee}, ${penalty}) sent ${tx.hash}`);
    await tx.wait();
    changed = true;
  }
  if (creation !== currentCreation) {
    const tx = await presaleFactory.setCreationFee(creation);
    console.log(`setCreationFee(${eth(creation)}) sent ${tx.hash}`);
    await tx.wait();
    changed = true;
  }
  if (quick !== currentQuick) {
    const tx = await presaleFactory.setQuickCreationFee(quick);
    console.log(`setQuickCreationFee(${eth(quick)}) sent ${tx.hash}`);
    await tx.wait();
    changed = true;
  }
  if (!changed) {
    console.log("Nothing to change.");
    return;
  }
  console.log("Now");
  console.log(`  platform share          ${pct(Number(await presaleFactory.platformFeeBps()))}`);
  console.log(`  exit penalty            ${pct(Number(await presaleFactory.exitPenaltyBps()))}`);
  console.log(`  presale creation fee    ${eth(await presaleFactory.creationFee())}`);
  console.log(`  quick creation fee      ${eth(await presaleFactory.quickCreationFee())}`);
  console.log("Sales created from now on use these values; the frontend reads them from the chain.");
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
