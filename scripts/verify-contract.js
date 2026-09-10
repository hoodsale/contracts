// Verifies individual addresses (and is the shared core of the other verification scripts).
//
//   ADDRESSES=0xabc,0xdef npx hardhat run scripts/verify-contract.js --network robinhoodTestnet
//
// Environment variables:
//   DRY_RUN=1        prints everything that would be submitted without touching the API
//   FORCE_MANUAL=1   skips the APIs and writes the verify-out/<network>/ packages directly
//   SOURCIFY=0       skips Sourcify (Blockscout only)
//   SOURCIFY_URL, SOURCIFY_CHAINS, SOURCIFY_TIMEOUT_MS, SOURCIFY_JOB_TIMEOUT_MS: see lib/sourcify.js
//   VERIFY_OUT=dir   package directory (default verify-out)
//   FROM_BLOCK=n     starting block hint for log scans
//   BLOCKSCOUT_API_KEY  read by hardhat.config.js; the probe uses the same key
//
// Flow (verifyOne):
//   1. constructor arguments are reconstructed from chain (lib/constructorArgs)
//   2. Sourcify (primary, chains 4663 and 46630): Standard JSON input from build-info is
//      submitted through the v2 API and the job is polled; exact_match / match or an
//      "already verified" answer is a terminal success
//   3. Blockscout (secondary): the explorer API is probed once; when it answers JSON the
//      hardhat-verify plugin is used ("Already Verified" counts as success). A Cloudflare
//      challenge or HTTP 500 never blocks: after a Sourcify attempt the result is a retryable
//      failure, without Sourcify (unsupported chain, SOURCIFY=0) a manual package is written.

const fs = require("fs");
const path = require("path");
const { reconstructConstructorArgs, toPlainArgs } = require("./lib/constructorArgs");
const sourcify = require("./lib/sourcify");
const {
  buildVerificationPackage,
  writeVerificationPackage,
  chainConfigFor,
  apiKeyFor,
  DEFAULT_OUT_DIR,
} = require("./verify-standard-json");

const STATUS = {
  VERIFIED: "verified",
  ALREADY: "already-verified",
  MANUAL: "manual-package",
  DRY_RUN: "dry-run",
  FAILED: "failed",
  UNSUPPORTED: "unsupported-network",
};

const RETRYABLE = new Set(["not-indexed", "network", "failed"]);

function envFlag(name) {
  return /^(1|true|yes)$/i.test(process.env[name] || "");
}

function shortName(fqn) {
  return fqn ? fqn.slice(fqn.lastIndexOf(":") + 1) : "?";
}

/** deployments/<network>.json (DEPLOYMENTS_FILE can point to a different file). */
function loadDeployments(hre, { required = false } = {}) {
  const file = process.env.DEPLOYMENTS_FILE || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`${file} not found; run scripts/deploy.js first`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Sends a single GET to the explorer API and classifies the response:
 *   ok | cloudflare | http-error | unreachable
 */
async function probeExplorerApi(apiUrl, apiKey, { timeoutMs = 15000 } = {}) {
  const url = new URL(apiUrl);
  url.searchParams.set("module", "block");
  url.searchParams.set("action", "eth_block_number");
  if (apiKey) url.searchParams.set("apikey", apiKey);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    const text = await res.text();
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    const looksHtml = /^\s*</.test(text) || /text\/html/i.test(res.headers.get("content-type") || "");
    const cloudflare = looksHtml && (/just a moment|cf-chl|challenge-platform|cloudflare/i.test(text) || res.status === 403 || res.status === 503);
    if (cloudflare) return { status: "cloudflare", httpStatus: res.status, snippet };
    if (!res.ok) return { status: "http-error", httpStatus: res.status, snippet };
    try {
      JSON.parse(text);
      return { status: "ok", httpStatus: res.status, snippet };
    } catch (e) {
      return { status: looksHtml ? "cloudflare" : "http-error", httpStatus: res.status, snippet };
    }
  } catch (e) {
    return { status: "unreachable", httpStatus: null, snippet: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Reduces hardhat-verify / network errors to a single label. */
function classifyVerifyError(err) {
  const m = String((err && err.message) || err || "");
  if (/already verified|already been verified/i.test(m)) return "already-verified";
  if (/just a moment|cloudflare|cf-chl|<!doctype|<html|status code 403|status code 503|Unexpected token '?<|is not valid JSON|Unexpected end of JSON/i.test(m)) {
    return "blocked";
  }
  if (/does not have bytecode|Unable to locate ContractCode|has no bytecode/i.test(m)) return "not-indexed";
  if (/network request failed|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|aborted/i.test(m)) return "network";
  if (/selected network is hardhat|not supported by Etherscan|Chain config not found|chainId .* not supported/i.test(m)) {
    return "unsupported-network";
  }
  return "failed";
}

/**
 * Explorer API status; cached in options.apiProbe. Long-running processes can pass
 * options.probeTtlMs to have it probed again at regular intervals.
 */
async function getApiProbe(hre, options) {
  const cached = options.apiProbe;
  if (cached && (!options.probeTtlMs || Date.now() - cached.at < options.probeTtlMs)) return cached;
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const chain = chainConfigFor(hre, chainId);
  if (!chain) {
    options.apiProbe = { status: "unsupported", httpStatus: null, snippet: `no explorer configured for chainId ${chainId}`, chain: null, apiKey: null, at: Date.now() };
    return options.apiProbe;
  }
  const apiKey = apiKeyFor(hre, chain);
  const probe = await probeExplorerApi(chain.urls.apiURL, apiKey, { timeoutMs: options.probeTimeoutMs || 15000 });
  options.apiProbe = { ...probe, chain, apiKey, at: Date.now() };
  const log = options.log || console.log;
  log(`[verify] explorer API ${chain.urls.apiURL}: ${probe.status}${probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : ""}`);
  if (probe.status === "cloudflare") {
    log("[verify] API is behind a Cloudflare challenge; falling back to manual Standard JSON packages");
  }
  return options.apiProbe;
}

async function writeManualPackage(hre, target, options, reason) {
  const pkg = target.package || (await buildVerificationPackage(hre, target, { deployments: options.deployments }));
  const { packagePath, inputPath } = writeVerificationPackage(hre, pkg, options.outDir || DEFAULT_OUT_DIR);
  return {
    status: STATUS.MANUAL,
    message: `${reason}; package written`,
    packagePath,
    inputPath,
    encodedArgs: pkg.constructorArguments.abiEncoded,
    readme: pkg.readme,
  };
}

/** Sourcify is used unless SOURCIFY=0 / options.sourcify === false, and only for chains it supports. */
function sourcifyApplies(chainId, options) {
  const enabled = options.sourcify !== undefined ? options.sourcify !== false : process.env.SOURCIFY !== "0";
  if (!enabled) return { applies: false, reason: "disabled (SOURCIFY=0)" };
  if (!sourcify.supportsChain(chainId, options.sourcifyOptions || {})) {
    return { applies: false, reason: `Sourcify does not support chain ${chainId}` };
  }
  return { applies: true, reason: null };
}

/**
 * Primary target. Builds the Standard JSON package, checks the current Sourcify status, submits
 * and polls. Returns a partial result: status verified / already-verified (terminal) or failed
 * (with retryable + errorClass). Never throws.
 * @param target { address, contract, args, meta, creation, package? }
 */
async function verifyOnSourcify(hre, target, options, chainId) {
  const so = options.sourcifyOptions || {};
  const url = sourcify.repoUrl(chainId, target.address, so);
  let pkg = target.package;
  if (!pkg) {
    try {
      pkg = await buildVerificationPackage(hre, target, { deployments: options.deployments });
      target.package = pkg;
    } catch (e) {
      return { status: STATUS.FAILED, message: `package: ${e.message}`, retryable: false, errorClass: "package", sourcifyUrl: url };
    }
  }
  const creationTransactionHash =
    (target.creation && target.creation.transactionHash) || (target.meta && target.meta.creation && target.meta.creation.transactionHash) || undefined;
  try {
    const r = await sourcify.verifyStandardJson(
      {
        chainId,
        address: target.address,
        stdJsonInput: pkg.standardJsonInput,
        compilerVersion: pkg.compilerVersion,
        contractIdentifier: pkg.contractName,
        creationTransactionHash,
      },
      so
    );
    const status = r.status === "already-verified" ? STATUS.ALREADY : STATUS.VERIFIED;
    const detail = `${r.match}${r.creationMatch ? "" : ", creation match not available (factory creation)"}`;
    return {
      status,
      message: `${r.status === "already-verified" ? "already verified" : "verified"} on Sourcify (${detail})`,
      target: "sourcify",
      sourcifyUrl: url,
      match: r.match,
      creationMatch: r.creationMatch || null,
      runtimeMatch: r.runtimeMatch || null,
      verificationId: r.verificationId || null,
    };
  } catch (e) {
    const retryable = e instanceof sourcify.SourcifyError ? e.retryable : true;
    const cls = e instanceof sourcify.SourcifyError ? `sourcify-${e.code}` : "sourcify-error";
    return { status: STATUS.FAILED, message: `sourcify: ${String(e.message || e).split("\n")[0]}`, retryable, errorClass: cls, sourcifyUrl: url };
  }
}

/**
 * Verifies a single address.
 * @param target  { address, contract?, args?, meta?, creation? }
 * @param options { dryRun, forceManual, outDir, deployments, fromBlock, log, apiProbe }
 * @returns { address, contract, status, message, retryable, packagePath?, encodedArgs?, warnings }
 */
async function verifyOne(hre, target, options = {}) {
  const log = options.log || console.log;
  const address = target.address;
  const result = { address, contract: target.contract || null, status: STATUS.FAILED, message: "", retryable: false, warnings: [] };

  // 1. arguments
  let contract = target.contract;
  let args = target.args;
  let meta = target.meta || null;
  try {
    if (!contract || !args) {
      const r = await reconstructConstructorArgs(hre.ethers.provider, address, {
        deployments: options.deployments,
        fromBlock: options.fromBlock,
        creation: target.creation,
      });
      contract = r.contract;
      args = r.args;
      meta = r.meta;
    }
  } catch (e) {
    result.message = `constructor args: ${e.message}`;
    return result;
  }
  result.contract = contract;
  result.warnings = (meta && meta.warnings) || [];
  const plainArgs = toPlainArgs(args);
  const creation = target.creation || (meta && meta.creation) || null;
  const fullTarget = { address, contract, args, meta, creation };
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const sourcifyState = sourcifyApplies(chainId, options);

  // 2. dry run: print everything that would be submitted, do not touch the network
  if (options.dryRun) {
    let encoded = null;
    let compilerVersion = null;
    try {
      const pkg = await buildVerificationPackage(hre, fullTarget, { deployments: options.deployments });
      encoded = pkg.constructorArguments.abiEncoded;
      compilerVersion = pkg.compilerVersion;
      result.sourceCount = Object.keys(pkg.standardJsonInput.sources).length;
    } catch (e) {
      result.warnings.push(`package build failed: ${e.message}`);
    }
    log(`[dry-run] ${address}`);
    log(`  contract:  ${contract}`);
    log(`  compiler:  ${compilerVersion || "?"}`);
    log(`  args:      ${JSON.stringify(plainArgs)}`);
    log(`  encoded:   ${encoded || "?"}`);
    if (meta && meta.sources) log(`  sources:   ${JSON.stringify(meta.sources)}`);
    if (result.warnings.length > 0) log(`  warnings:  ${result.warnings.join(" | ")}`);
    if (sourcifyState.applies) {
      log(`  sourcify:  POST ${sourcify.serverUrl(options.sourcifyOptions || {})}/v2/verify/${chainId}/${address} { contractIdentifier: "${contract}", compilerVersion: "${sourcify.normalizeCompilerVersion(compilerVersion)}"${creation && creation.transactionHash ? `, creationTransactionHash: "${creation.transactionHash}"` : ""} }`);
    } else {
      log(`  sourcify:  skipped (${sourcifyState.reason})`);
    }
    log(`  blockscout: hre.run("verify:verify", { address, contract, constructorArguments }) when the API is reachable`);
    return { ...result, status: STATUS.DRY_RUN, message: "printed submission", encodedArgs: encoded, plainArgs };
  }

  if (options.forceManual) {
    try {
      return { ...result, ...(await writeManualPackage(hre, fullTarget, options, "FORCE_MANUAL")) };
    } catch (e) {
      return { ...result, message: `manual package: ${e.message}` };
    }
  }

  // 3. Sourcify (primary): a success here is terminal
  let sourcifyFailure = null;
  if (sourcifyState.applies) {
    const r = await verifyOnSourcify(hre, fullTarget, options, chainId);
    if (r.status === STATUS.VERIFIED || r.status === STATUS.ALREADY) return { ...result, ...r };
    sourcifyFailure = r;
    log(`[verify] ${address}: ${r.message}; trying Blockscout`);
  }

  // 4. Blockscout (secondary): explorer configuration / API status
  const probe = await getApiProbe(hre, options);
  const blockscoutUnavailable = (reason) => {
    if (sourcifyFailure) {
      // Sourcify was tried: keep the address in the retry queue instead of freezing it as a manual package
      return {
        ...result,
        status: STATUS.FAILED,
        message: `${sourcifyFailure.message}; blockscout: ${reason}`,
        retryable: sourcifyFailure.retryable !== false,
        errorClass: sourcifyFailure.errorClass,
        sourcifyUrl: sourcifyFailure.sourcifyUrl,
      };
    }
    return null;
  };
  if (probe.status === "unsupported") {
    return blockscoutUnavailable("unsupported network") || { ...result, status: STATUS.UNSUPPORTED, message: probe.snippet };
  }
  if (probe.status === "cloudflare" || probe.status === "http-error" || probe.status === "unreachable") {
    const reason = probe.status === "cloudflare" ? "explorer API blocked by Cloudflare" : `explorer API ${probe.status}${probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : ""}`;
    const kept = blockscoutUnavailable(reason);
    if (kept) return kept;
    if (probe.status === "cloudflare") {
      try {
        return { ...result, ...(await writeManualPackage(hre, fullTarget, options, reason)) };
      } catch (e) {
        return { ...result, message: `manual package: ${e.message}` };
      }
    }
    // http-error / unreachable without Sourcify: retry later
    return { ...result, status: STATUS.FAILED, message: reason, retryable: true, errorClass: "network" };
  }

  // 5. already verified on Blockscout?
  try {
    const { Etherscan } = require("@nomicfoundation/hardhat-verify/etherscan");
    const explorer = new Etherscan(probe.apiKey || "blockscout", probe.chain.urls.apiURL, probe.chain.urls.browserURL);
    if (await explorer.isVerified(address)) {
      return { ...result, status: STATUS.ALREADY, message: "already verified on the explorer", target: "blockscout" };
    }
  } catch (e) {
    const cls = classifyVerifyError(e);
    if (cls === "blocked") {
      const kept = blockscoutUnavailable("explorer API returned HTML/403");
      if (kept) return kept;
      try {
        return { ...result, ...(await writeManualPackage(hre, fullTarget, options, "explorer API returned HTML/403")) };
      } catch (e2) {
        return { ...result, message: `manual package: ${e2.message}` };
      }
    }
    // if isVerified fails, the verification is still attempted
    result.warnings.push(`isVerified check failed: ${e.message.split("\n")[0]}`);
  }

  // 6. the actual Blockscout verification
  try {
    await hre.run("verify:verify", { address, contract, constructorArguments: plainArgs });
    return { ...result, status: STATUS.VERIFIED, message: "verified on Blockscout", target: "blockscout" };
  } catch (e) {
    const cls = classifyVerifyError(e);
    const firstLine = String(e.message || e).split("\n")[0];
    if (cls === "already-verified") return { ...result, status: STATUS.ALREADY, message: "already verified (API response)", target: "blockscout" };
    if (cls === "blocked") {
      const kept = blockscoutUnavailable("explorer API returned HTML/403");
      if (kept) return kept;
      try {
        return { ...result, ...(await writeManualPackage(hre, fullTarget, options, "explorer API returned HTML/403")) };
      } catch (e2) {
        return { ...result, message: `manual package: ${e2.message}` };
      }
    }
    if (cls === "unsupported-network") {
      return blockscoutUnavailable("unsupported network") || { ...result, status: STATUS.UNSUPPORTED, message: firstLine };
    }
    const message = sourcifyFailure ? `${sourcifyFailure.message}; blockscout ${cls}: ${firstLine}` : `${cls}: ${firstLine}`;
    return { ...result, status: STATUS.FAILED, message, retryable: RETRYABLE.has(cls) || (sourcifyFailure && sourcifyFailure.retryable !== false), errorClass: cls };
  }
}

/** Sequential verification of several addresses; returns the result list and prints the summary table. */
async function verifyAddresses(hre, targets, options = {}) {
  const results = [];
  for (const t of targets) {
    const target = typeof t === "string" ? { address: t } : t;
    const log = options.log || console.log;
    log(`\n[verify] ${target.label ? target.label + " " : ""}${target.address}`);
    let r;
    try {
      r = await verifyOne(hre, target, options);
    } catch (e) {
      r = { address: target.address, contract: target.contract || null, status: STATUS.FAILED, message: e.message, retryable: true, warnings: [] };
    }
    if (target.label) r.label = target.label;
    log(`[verify] -> ${r.status}${r.message ? ": " + r.message : ""}`);
    results.push(r);
  }
  if (!options.quiet) printSummary(results, options.log, await explorerBaseUrl(hre));
  return results;
}

/** The explorer's browser URL for the current network, without a trailing slash, or null. */
async function explorerBaseUrl(hre) {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const chain = chainConfigFor(hre, chainId);
  return chain ? chain.urls.browserURL.replace(/\/$/, "") : null;
}

function printSummary(results, log = console.log, browserUrl = null) {
  const rows = results.map((r) => ({
    label: r.label || "",
    address: r.address,
    contract: shortName(r.contract),
    status: r.status,
    note: r.packagePath ? path.relative(process.cwd(), r.packagePath) : (r.message || "").slice(0, 70),
  }));
  const cols = ["label", "address", "contract", "status", "note"];
  const width = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join("  ");
  log("");
  log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  log(cols.map((c) => "-".repeat(width[c])).join("  "));
  for (const r of rows) log(line(r));
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  log("");
  log("summary: " + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", "));

  // Sourcify is a success the flow stops on, so the explorer is never asked. They are separate
  // indexes: a contract can read "unverified" on Blockscout while Sourcify holds an exact match.
  // Blockscout also fills itself in from its own bytecode database, which is why every sale used
  // to appear verified without anybody submitting it: they all shared one already-known bytecode.
  // A build with new bytecode has nothing to match until one instance of it is submitted by hand.
  const sourcifyOnly = results.filter(
    (r) => r.target === "sourcify" && (r.status === STATUS.VERIFIED || r.status === STATUS.ALREADY)
  );
  if (sourcifyOnly.length) {
    log("");
    log(`Sourcify holds ${sourcifyOnly.length === 1 ? "this contract" : `these ${sourcifyOnly.length} contracts`}, and the explorer was not asked.`);
    log("The explorer keeps its own index, so it can still show the address as unverified. It also");
    log("fills itself in from its bytecode database, so submitting one instance of a build by hand");
    log("is enough for every later contract with the same bytecode. To submit one, open");
    for (const r of sourcifyOnly) {
      log(`  ${browserUrl ? `${browserUrl}/address/${r.address}` : r.address}/contract-verification`);
    }
    log("choose Solidity (Standard JSON input), and upload the package that FORCE_MANUAL=1 writes.");
  }
}

function optionsFromEnv(hre) {
  return {
    dryRun: envFlag("DRY_RUN"),
    forceManual: envFlag("FORCE_MANUAL"),
    sourcify: process.env.SOURCIFY !== "0",
    outDir: process.env.VERIFY_OUT || DEFAULT_OUT_DIR,
    fromBlock: Number(process.env.FROM_BLOCK) || 0,
    deployments: loadDeployments(hre),
  };
}

async function main() {
  const hre = require("hardhat");
  const addresses = (process.env.ADDRESSES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (addresses.length === 0) {
    console.log("Usage: ADDRESSES=0x..,0x.. [DRY_RUN=1] [FORCE_MANUAL=1] npx hardhat run scripts/verify-contract.js --network <net>");
    process.exitCode = 2;
    return;
  }
  const results = await verifyAddresses(hre, addresses, optionsFromEnv(hre));
  if (results.some((r) => r.status === STATUS.FAILED)) process.exitCode = 1;
}

module.exports = {
  main,
  verifyOne,
  verifyOnSourcify,
  sourcifyApplies,
  verifyAddresses,
  printSummary,
  explorerBaseUrl,
  probeExplorerApi,
  classifyVerifyError,
  getApiProbe,
  loadDeployments,
  optionsFromEnv,
  envFlag,
  STATUS,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
