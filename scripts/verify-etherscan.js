// Verifies a contract on an Etherscan-run explorer through the Etherscan V2 API.
//
// RobinScan (robin.etherscan.io) is served by the Etherscan V2 API under chainid 4663, while
// hardhat.config.js points hardhat-verify at Blockscout. This script submits the Standard JSON
// package that verify-standard-json.js writes, with the same field names hardhat-verify uses,
// then polls until Etherscan answers. It needs a free Etherscan API key, read from the
// environment and never printed.
//
//   ADDRESSES=0x... npx hardhat run scripts/verify-standard-json.js --network robinhood
//   read -s ETHERSCAN_API_KEY && export ETHERSCAN_API_KEY
//   ADDRESS=0x... npx hardhat run scripts/verify-etherscan.js --network robinhood
//
// Environment:
//   ADDRESS=0x...          the contract; its package must exist in verify-out/<network>/
//   ETHERSCAN_API_KEY=...  an Etherscan API key (etherscan.io, API Keys)
//   LICENSE_TYPE=<n>       Etherscan licence code (default 3, MIT)
//   DRY_RUN=1              print what would be submitted and send nothing; needs no key
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const API = process.env.ETHERSCAN_API_URL || "https://api.etherscan.io/v2/api";
const POLL_MS = 5000;
const POLL_TRIES = 36;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const address = process.env.ADDRESS;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("set ADDRESS=0x...");
  const network = hre.network.name;
  const chainId = hre.network.config.chainId;
  const file = path.join(__dirname, "..", "verify-out", network, `${address}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`no package at ${file}; run scripts/verify-standard-json.js for this address first`);
  }
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const sourceCode = JSON.stringify(pkg.standardJsonInput);
  const fields = {
    module: "contract",
    action: "verifysourcecode",
    contractaddress: address,
    sourceCode,
    codeformat: "solidity-standard-json-input",
    contractname: pkg.contractName,
    compilerversion: pkg.compilerVersion,
    // Etherscan's own spelling.
    constructorArguements: pkg.constructorArguments.abiEncodedNoPrefix,
    licenseType: process.env.LICENSE_TYPE || "3",
  };

  console.log(`Verifying ${address} on chainid ${chainId} through ${API}`);
  console.log(`  contract      ${fields.contractname}`);
  console.log(`  compiler      ${fields.compilerversion}, optimizer ${pkg.optimizer && pkg.optimizer.runs} runs, viaIR ${pkg.viaIR}, evm ${pkg.evmVersion}`);
  console.log(`  source        standard JSON, ${Object.keys(pkg.standardJsonInput.sources).length} files, ${Math.round(sourceCode.length / 1024)} KB`);
  console.log(`  constructor   ${fields.constructorArguements.length / 64} arguments`);

  if (process.env.DRY_RUN === "1") {
    console.log("\nDRY_RUN: nothing was sent.");
    return;
  }
  const apikey = process.env.ETHERSCAN_API_KEY;
  if (!apikey) throw new Error("set ETHERSCAN_API_KEY (read -s ETHERSCAN_API_KEY && export ETHERSCAN_API_KEY)");

  const submit = await fetch(`${API}?chainid=${chainId}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apikey, ...fields }),
  });
  const sent = await submit.json();
  if (sent.status !== "1") {
    if (/already verified/i.test(String(sent.result))) {
      console.log("\nAlready verified.");
      return;
    }
    throw new Error(`Etherscan refused the submission: ${sent.message}: ${sent.result}`);
  }
  const guid = sent.result;
  console.log(`  submitted     guid ${guid}`);

  for (let i = 0; i < POLL_TRIES; i++) {
    await sleep(POLL_MS);
    const q = new URLSearchParams({ chainid: String(chainId), module: "contract", action: "checkverifystatus", guid, apikey });
    const res = await (await fetch(`${API}?${q}`)).json();
    const result = String(res.result);
    if (/pending/i.test(result)) continue;
    if (/pass|already verified/i.test(result)) {
      console.log(`\n${result}`);
      console.log(`https://robin.etherscan.io/address/${address}#code`);
      return;
    }
    throw new Error(`verification failed: ${result}`);
  }
  throw new Error(`still pending after ${(POLL_MS * POLL_TRIES) / 1000}s; check guid ${guid} later`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
