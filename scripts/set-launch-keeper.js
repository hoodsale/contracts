// Points the PresaleFactory at a new launch keeper wallet (the wallet the keeper service runs
// with). Used to rotate the keeper wallet: the old one keeps nothing but its gas money.
//
//   DEPLOYER_KEY=0x... ROBINHOOD_RPC=... LAUNCH_KEEPER=0xNewWallet npx hardhat run scripts/set-launch-keeper.js --network robinhood
//
// The signer must own the PresaleFactory. After it, put the new wallet's private key into the
// keeper service's environment (/etc/hoodsale/keeper.env on the server) and restart the service;
// send the old wallet's ETH to the new one for gas.
const fs = require("fs");
const path = require("path");

async function main() {
  const hre = require("hardhat");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.presaleFactory) throw new Error("deployments file has no presaleFactory");
  const next = process.env.LAUNCH_KEEPER;
  if (!next || !hre.ethers.isAddress(next)) throw new Error("set LAUNCH_KEEPER to the new keeper wallet address");

  const [signer] = await hre.ethers.getSigners();
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory, signer);
  const owner = await presaleFactory.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`the signer must own PresaleFactory (owner is ${owner}, signer is ${signer.address})`);
  }
  const current = await presaleFactory.launchKeeper();
  console.log(`PresaleFactory ${d.presaleFactory} on ${network}`);
  console.log(`  launch keeper  ${current}`);
  if (current.toLowerCase() === next.toLowerCase()) {
    console.log("Nothing to change.");
    return;
  }
  const tx = await presaleFactory.setLaunchKeeper(next);
  console.log(`setLaunchKeeper(${next}) sent ${tx.hash}`);
  await tx.wait();
  console.log(`  launch keeper  ${await presaleFactory.launchKeeper()} (now)`);
  const addresses = { ...d, launchKeeper: next, previousLaunchKeeper: current };
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
  console.log(`Saved to deployments/${network}.json`);
  console.log("Next: put the new wallet's private key into the keeper service environment and restart it;");
  console.log(`send the old wallet's ETH (${hre.ethers.formatEther(await hre.ethers.provider.getBalance(current))} ETH) to the new one for gas.`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
