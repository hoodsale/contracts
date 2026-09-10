// Replaces the presale creation code of an existing deployment.
//
// PresaleFactory does not embed Presale's creation code (the factory would pass the 24KB contract
// size limit); it reads the code from a PresaleCode holder and deploys every sale with CREATE.
// Changing Presale therefore means deploying a fresh PresaleCode and pointing the factory at it.
//
// Reads deployments/<network>.json, deploys PresaleCode, checks that the code it returns is the
// Presale of the current build, wires presaleFactory.setPresaleCode and rewrites the file with the
// new address; the replaced holder is remembered under previousPresaleCode. Nothing else moves.
//
// The change reaches FUTURE sales only. A sale that already exists is a deployed contract with its
// own code, and no upgrade touches it, so an announced sale that has to gain the new behaviour has
// to be recreated.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/upgrade-presale-code.js --network robinhood
//
// Optional environment:
//   PRESALE_CODE=0x...   wire an already deployed PresaleCode instead of deploying one
//
// Safe to re-run: the wiring step is skipped when the factory already holds the address.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.presaleFactory) throw new Error(`deployments/${network}.json has no presaleFactory`);

  console.log(`Replacing the presale creation code on ${network} with ${deployer.address}`);
  console.log(`Factory ${d.presaleFactory}, current presaleCode ${d.presaleCode || "-"}`);

  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const owner = await presaleFactory.owner();
  if (!same(owner, deployer.address)) {
    throw new Error(`the deployer must own PresaleFactory (owner is ${owner})`);
  }

  // What the current build compiles to. The holder deployed below has to return exactly this,
  // otherwise the factory would keep creating sales from a different Presale than the repo's.
  const artifact = await hre.artifacts.readArtifact("Presale");
  const expected = artifact.bytecode.toLowerCase();

  let presaleCode;
  if (process.env.PRESALE_CODE) {
    const addr = process.env.PRESALE_CODE;
    if (!hre.ethers.isAddress(addr)) throw new Error(`PRESALE_CODE is not an address: ${addr}`);
    if ((await hre.ethers.provider.getCode(addr)) === "0x") {
      throw new Error(`PRESALE_CODE has no code on ${network}: ${addr}`);
    }
    presaleCode = await hre.ethers.getContractAt("PresaleCode", addr);
    console.log(`PresaleCode: reusing ${addr}`);
  } else {
    presaleCode = await hre.ethers.deployContract("PresaleCode");
    await presaleCode.waitForDeployment();
    console.log(`PresaleCode: deployed ${presaleCode.target}`);
  }

  const onChain = (await presaleCode.creationCode()).toLowerCase();
  if (onChain !== expected) {
    throw new Error(
      `${presaleCode.target} does not carry the Presale of this build ` +
        `(holder ${onChain.length} chars, build ${expected.length} chars). ` +
        `Compile the repo and deploy a fresh PresaleCode.`
    );
  }
  console.log(`PresaleCode carries the Presale of this build (${(onChain.length - 2) / 2} bytes)`);

  const current = await presaleFactory.presaleCode();
  if (same(current, presaleCode.target)) {
    console.log(`presaleFactory.presaleCode: already ${presaleCode.target}`);
  } else {
    await (await presaleFactory.setPresaleCode(presaleCode.target)).wait();
    console.log(`presaleFactory.presaleCode: set to ${presaleCode.target}`);
  }

  const addresses = { ...d, presaleCode: presaleCode.target };
  if (d.presaleCode && !same(d.presaleCode, presaleCode.target)) addresses.previousPresaleCode = d.presaleCode;
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
  console.log(`  presaleCode         ${presaleCode.target}`);
  console.log(`  previousPresaleCode ${addresses.previousPresaleCode || "-"}`);
  console.log("");
  console.log("Sales created from here on carry the new Presale. Sales that already exist keep");
  console.log("the code they were deployed with; recreate one to give it the new behaviour.");
  if (network !== "hardhat" && network !== "localhost") {
    console.log("");
    console.log("Next, verify the holder on Sourcify:");
    console.log(`  ADDRESSES=${presaleCode.target} npx hardhat run scripts/verify-contract.js --network ${network}`);
    console.log("and check the deployment reads clean:");
    console.log(`  npx hardhat run scripts/check-deployment.js --network ${network}`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
