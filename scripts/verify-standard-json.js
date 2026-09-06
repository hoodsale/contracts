// Manual verification package generator (Blockscout "Verify & publish, Standard JSON input").
//
// The mainnet Blockscout API returns a Cloudflare challenge (HTTP 403) to non-browser
// clients, so hardhat-verify cannot reach it. This module takes the Standard JSON Input
// from the Hardhat build-info artifacts with exactly the same compiler settings, ABI-encodes
// the constructor arguments and writes verify-out/<network>/<address>.json (package)
// + <address>.input.json (the file to upload to the form).
//
// Usage (only produces packages, never touches the API):
//   ADDRESSES=0xabc,0xdef npx hardhat run scripts/verify-standard-json.js --network robinhood
//   PLATFORM=1 npx hardhat run scripts/verify-standard-json.js --network robinhood
//
// As a module: buildVerificationPackage(hre, target), writeVerificationPackage(hre, pkg, outDir)

const fs = require("fs");
const path = require("path");
const { reconstructConstructorArgs, toPlainArgs } = require("./lib/constructorArgs");

const DEFAULT_OUT_DIR = path.join(__dirname, "..", "verify-out");

function splitFqn(fqn) {
  const i = fqn.lastIndexOf(":");
  return { sourceName: fqn.slice(0, i), contractName: fqn.slice(i + 1) };
}

/** The hardhat.config.js etherscan.customChains entry for the current chainId (null if none). */
function chainConfigFor(hre, chainId) {
  const chains = (hre.config.etherscan && hre.config.etherscan.customChains) || [];
  return chains.find((c) => Number(c.chainId) === Number(chainId)) || null;
}

function apiKeyFor(hre, chainConfig) {
  const key = hre.config.etherscan && hre.config.etherscan.apiKey;
  if (!chainConfig) return null;
  if (typeof key === "string") return key;
  return (key && key[chainConfig.network]) || null;
}

/**
 * Takes the Standard JSON Input from build-info and reduces the sources to the import
 * closure of the target file (the "minimal input" approach of hardhat-verify). Returns the
 * full input if there is no AST. Compiler settings (optimizer, viaIR, evmVersion...) are kept as is.
 */
function pruneStandardJsonInput(buildInfo, sourceName) {
  const input = JSON.parse(JSON.stringify(buildInfo.input));
  const outSources = (buildInfo.output && buildInfo.output.sources) || {};
  if (!outSources[sourceName] || !outSources[sourceName].ast) return input;

  const keep = new Set();
  const stack = [sourceName];
  while (stack.length > 0) {
    const s = stack.pop();
    if (keep.has(s)) continue;
    keep.add(s);
    const ast = outSources[s] && outSources[s].ast;
    for (const node of (ast && ast.nodes) || []) {
      if (node.nodeType === "ImportDirective" && node.absolutePath) stack.push(node.absolutePath);
    }
  }
  input.sources = Object.fromEntries(Object.entries(input.sources).filter(([k]) => keep.has(k)));
  return input;
}

/**
 * @param target { address, contract, args, meta? }  (contract/args are reconstructed from chain if missing)
 * @param opts   { deployments, fromBlock, creation }
 */
async function buildVerificationPackage(hre, target, opts = {}) {
  let { address, contract, args, meta } = target;
  if (!contract || !args) {
    const r = await reconstructConstructorArgs(hre.ethers.provider, address, {
      deployments: opts.deployments,
      fromBlock: opts.fromBlock,
      creation: opts.creation,
    });
    contract = r.contract;
    args = r.args;
    meta = r.meta;
    address = r.address;
  }
  const { sourceName, contractName } = splitFqn(contract);
  const artifact = await hre.artifacts.readArtifact(contract);
  const buildInfo = await hre.artifacts.getBuildInfo(contract);
  if (!buildInfo) throw new Error(`build-info not found for ${contract}; run npx hardhat compile`);

  const iface = new hre.ethers.Interface(artifact.abi);
  const abiEncoded = iface.encodeDeploy(args);
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const chain = chainConfigFor(hre, chainId);
  const browserUrl = chain ? chain.urls.browserURL.replace(/\/$/, "") : null;
  const settings = buildInfo.input.settings || {};
  const compilerVersion = `v${buildInfo.solcLongVersion}`;

  const readme =
    `Blockscout manual verification: open ${browserUrl || "<explorer>"}/address/${address}/contract-verification, ` +
    `choose "Solidity (Standard JSON input)", compiler ${compilerVersion}, EVM version ${settings.evmVersion || "default"}, ` +
    `upload ${address}.input.json (the standardJsonInput field of this file), contract name "${contractName}" ` +
    `(fully qualified: ${contract}); if the form asks for ABI-encoded constructor arguments paste ` +
    `constructorArguments.abiEncodedNoPrefix.`;

  return {
    generatedAt: new Date().toISOString(),
    network: hre.network.name,
    chainId,
    address,
    contractName: contract,
    sourceName,
    contractShortName: contractName,
    compilerVersion,
    solcVersion: buildInfo.solcVersion,
    evmVersion: settings.evmVersion || null,
    optimizer: settings.optimizer || null,
    viaIR: settings.viaIR === true,
    constructorArguments: {
      decoded: toPlainArgs(args),
      abiEncoded,
      abiEncodedNoPrefix: abiEncoded.replace(/^0x/, ""),
    },
    explorer: browserUrl
      ? {
          browserUrl,
          contractUrl: `${browserUrl}/address/${address}`,
          verifyFormUrl: `${browserUrl}/address/${address}/contract-verification`,
          apiUrl: chain.urls.apiURL,
        }
      : null,
    reconstruction: meta
      ? { sources: meta.sources || null, warnings: meta.warnings || [], creation: meta.creation || null }
      : null,
    readme,
    standardJsonInput: pruneStandardJsonInput(buildInfo, sourceName),
  };
}

function ensureIgnoredDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n!.gitignore\n");
}

/** Writes the package under verify-out/<network>/; returns { packagePath, inputPath }. */
function writeVerificationPackage(hre, pkg, outDir = DEFAULT_OUT_DIR) {
  ensureIgnoredDir(outDir);
  const dir = path.join(outDir, pkg.network || hre.network.name);
  fs.mkdirSync(dir, { recursive: true });
  const packagePath = path.join(dir, `${pkg.address}.json`);
  const inputPath = path.join(dir, `${pkg.address}.input.json`);
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  fs.writeFileSync(inputPath, JSON.stringify(pkg.standardJsonInput, null, 2));

  const readmePath = path.join(dir, "README.md");
  const lines = [
    "# Manual verification packages",
    "",
    "Each `<address>.json` is a complete package: fully qualified contract name, compiler version,",
    "ABI encoded constructor arguments and the Standard JSON Input taken from the Hardhat build-info.",
    "`<address>.input.json` is the same Standard JSON Input as a standalone file for the upload form.",
    "",
    "Steps (Blockscout): Contract tab, `Verify & publish`, method `Solidity (Standard JSON input)`,",
    "pick the compiler version from the package, upload `<address>.input.json`, set the contract name,",
    "paste `constructorArguments.abiEncodedNoPrefix` if the form asks for constructor arguments, submit.",
    "",
    "See docs/VERIFY.md for the full pipeline.",
    "",
  ];
  fs.writeFileSync(readmePath, lines.join("\n"));
  return { packagePath, inputPath };
}

function loadDeploymentsOrNull(hre) {
  const file = process.env.DEPLOYMENTS_FILE || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const hre = require("hardhat");
  const deployments = loadDeploymentsOrNull(hre);
  let addresses = (process.env.ADDRESSES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (process.env.PLATFORM === "1") {
    if (!deployments) throw new Error(`deployments/${hre.network.name}.json not found`);
    const { DEPLOYMENT_KEYS } = require("./lib/constructorArgs");
    for (const key of Object.keys(DEPLOYMENT_KEYS)) if (deployments[key]) addresses.push(deployments[key]);
    const tf = await hre.ethers.getContractAt("TokenFactory", deployments.tokenFactory);
    addresses.push(await tf.standardDeployer(), await tf.taxDeployer(), await tf.rewardsDeployer());
  }
  if (addresses.length === 0) {
    console.log("Usage: ADDRESSES=0x..,0x.. [PLATFORM=1] npx hardhat run scripts/verify-standard-json.js --network <net>");
    return;
  }
  const outDir = process.env.VERIFY_OUT || DEFAULT_OUT_DIR;
  for (const address of addresses) {
    try {
      const pkg = await buildVerificationPackage(hre, { address }, { deployments, fromBlock: Number(process.env.FROM_BLOCK) || 0 });
      const { packagePath, inputPath } = writeVerificationPackage(hre, pkg, outDir);
      console.log(`${address}  ${pkg.contractName}\n  package: ${packagePath}\n  input:   ${inputPath}\n  ${pkg.readme}`);
      if (pkg.reconstruction && pkg.reconstruction.warnings.length > 0) {
        console.log(`  warnings: ${pkg.reconstruction.warnings.join(" | ")}`);
      }
    } catch (e) {
      console.error(`${address}  FAILED: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  main,
  buildVerificationPackage,
  writeVerificationPackage,
  pruneStandardJsonInput,
  chainConfigFor,
  apiKeyFor,
  ensureIgnoredDir,
  loadDeploymentsOrNull,
  DEFAULT_OUT_DIR,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
