// Minimal Sourcify v2 client (global fetch, no dependencies).
//
//   const sourcify = require("./lib/sourcify");
//   const { verificationId } = await sourcify.submitStandardJson({ chainId, address, stdJsonInput, compilerVersion, contractIdentifier, creationTransactionHash });
//   const job = await sourcify.pollJob(verificationId, { timeoutMs: 300000 });
//   const status = await sourcify.getContractStatus(chainId, address);
//
// Endpoints (https://sourcify.dev/server, override with SOURCIFY_URL):
//   POST /v2/verify/{chainId}/{address}   -> 202 { verificationId }, 409 already verified
//   GET  /v2/verify/{verificationId}      -> { isJobCompleted, error?, contract? }
//   GET  /v2/contract/{chainId}/{address} -> { match, creationMatch, runtimeMatch }, 404 when unknown
//
// Every failure is a SourcifyError with `code` (network | timeout | http | rejected | job-failed |
// no-match | unsupported-chain), `httpStatus`, `customCode` (Sourcify's own error code) and
// `retryable`. "Already verified" answers are reported as success, never as an error.
//
// Environment:
//   SOURCIFY_URL          server base URL (default https://sourcify.dev/server)
//   SOURCIFY_REPO_URL     repository base URL used for links (default https://repo.sourcify.dev)
//   SOURCIFY_CHAINS       comma separated chain ids to accept (default 4663,46630); any chain is
//                         accepted when SOURCIFY_URL points at a custom server
//   SOURCIFY_TIMEOUT_MS   per request timeout (default 60000)
//   SOURCIFY_JOB_TIMEOUT_MS  how long to wait for a submitted job (default 300000)
//   SOURCIFY_POLL_MS      job polling interval (default 2000)

const DEFAULT_URL = "https://sourcify.dev/server";
const DEFAULT_REPO_URL = "https://repo.sourcify.dev";
const DEFAULT_CHAINS = [4663, 46630];
const MATCH_ORDER = { exact_match: 2, match: 1 };

class SourcifyError extends Error {
  constructor(message, { code = "http", httpStatus = null, customCode = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = "SourcifyError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.customCode = customCode;
    this.retryable = retryable;
    this.body = body;
  }
}

function envInt(name, def) {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(v) ? v : def;
}

function envList(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const list = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  return list.length > 0 ? list : null;
}

function serverUrl(opts = {}) {
  return String(opts.url || process.env.SOURCIFY_URL || DEFAULT_URL).replace(/\/+$/, "");
}

function isCustomServer(opts = {}) {
  return serverUrl(opts) !== DEFAULT_URL;
}

/** Link to the verified sources in the Sourcify repository. */
function repoUrl(chainId, address, opts = {}) {
  const base = String(opts.repoUrl || process.env.SOURCIFY_REPO_URL || DEFAULT_REPO_URL).replace(/\/+$/, "");
  return `${base}/${Number(chainId)}/${address}`;
}

/** True when Sourcify should be tried for this chain (custom servers accept every chain). */
function supportsChain(chainId, opts = {}) {
  if (isCustomServer(opts)) return true;
  const chains = (Array.isArray(opts.chains) && opts.chains.length > 0 ? opts.chains : null) || envList("SOURCIFY_CHAINS") || DEFAULT_CHAINS;
  return chains.map(Number).includes(Number(chainId));
}

/** Sourcify wants "0.8.26+commit.8a97fa7a" (hardhat's build-info solcLongVersion without the "v"). */
function normalizeCompilerVersion(version) {
  return String(version || "").replace(/^v/, "");
}

/** The best of match / runtimeMatch / creationMatch: exact_match, match or null. */
function bestMatch(contract) {
  if (!contract) return null;
  let best = null;
  for (const m of [contract.match, contract.runtimeMatch, contract.creationMatch]) {
    if (m && MATCH_ORDER[m] && (!best || MATCH_ORDER[m] > MATCH_ORDER[best])) best = m;
  }
  return best;
}

async function request(method, urlPath, { body, timeoutMs, opts = {} } = {}) {
  const url = `${serverUrl(opts)}${urlPath}`;
  const ctrl = new AbortController();
  const ms = timeoutMs ?? opts.timeoutMs ?? envInt("SOURCIFY_TIMEOUT_MS", 60000);
  const timer = setTimeout(() => ctrl.abort(), ms);
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(e.message || ""));
    throw new SourcifyError(
      aborted ? `Sourcify ${method} ${urlPath}: timeout after ${ms} ms` : `Sourcify ${method} ${urlPath}: ${e.message}`,
      { code: aborted ? "timeout" : "network", retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

function httpError(method, urlPath, r) {
  const customCode = (r.json && r.json.customCode) || null;
  const detail = (r.json && r.json.message) || r.text.slice(0, 200).replace(/\s+/g, " ");
  const retryable = r.status === 429 || r.status >= 500 || r.status === 408;
  return new SourcifyError(`Sourcify ${method} ${urlPath}: HTTP ${r.status}${customCode ? ` ${customCode}` : ""}${detail ? ` (${detail})` : ""}`, {
    code: retryable ? "http" : "rejected",
    httpStatus: r.status,
    customCode,
    retryable,
    body: r.json || r.text,
  });
}

/**
 * Submits a Standard JSON verification job.
 * @returns { verificationId, alreadyVerified } (alreadyVerified: the server answered 409 already verified)
 */
async function submitStandardJson({ chainId, address, stdJsonInput, compilerVersion, contractIdentifier, creationTransactionHash }, opts = {}) {
  if (!stdJsonInput || !compilerVersion || !contractIdentifier) {
    throw new SourcifyError("submitStandardJson needs stdJsonInput, compilerVersion and contractIdentifier", { code: "rejected" });
  }
  if (!supportsChain(chainId, opts)) {
    throw new SourcifyError(`Sourcify does not support chain ${chainId}`, { code: "unsupported-chain" });
  }
  const urlPath = `/v2/verify/${Number(chainId)}/${address}`;
  const body = {
    stdJsonInput,
    compilerVersion: normalizeCompilerVersion(compilerVersion),
    contractIdentifier,
    ...(creationTransactionHash ? { creationTransactionHash } : {}),
  };
  const r = await request("POST", urlPath, { body, opts });
  if (r.status === 202 || (r.ok && r.json && r.json.verificationId)) {
    return { verificationId: r.json && r.json.verificationId, alreadyVerified: false, httpStatus: r.status };
  }
  if (r.status === 409 || (r.json && /already.?verified/i.test(String(r.json.customCode || r.json.message || "")))) {
    return { verificationId: null, alreadyVerified: true, httpStatus: r.status, customCode: r.json && r.json.customCode };
  }
  throw httpError("POST", urlPath, r);
}

/**
 * Waits for a verification job. Resolves with { verificationId, match, creationMatch, runtimeMatch, contract, job }
 * when the job completed with a match; throws SourcifyError otherwise (retryable for internal errors and timeouts).
 */
async function pollJob(verificationId, { timeoutMs, intervalMs } = {}, opts = {}) {
  const urlPath = `/v2/verify/${verificationId}`;
  const deadline = Date.now() + (timeoutMs ?? opts.jobTimeoutMs ?? envInt("SOURCIFY_JOB_TIMEOUT_MS", 300000));
  const every = intervalMs ?? opts.pollIntervalMs ?? envInt("SOURCIFY_POLL_MS", 2000);
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    const r = await request("GET", urlPath, { opts, timeoutMs: opts.timeoutMs ?? envInt("SOURCIFY_TIMEOUT_MS", 60000) });
    if (!r.ok || !r.json) throw httpError("GET", urlPath, r);
    const job = r.json;
    if (job.isJobCompleted) {
      if (job.error) {
        const customCode = job.error.customCode || null;
        const retryable = /internal|timeout|unavailable|rate/i.test(String(customCode || job.error.message || ""));
        throw new SourcifyError(`Sourcify job ${verificationId} failed: ${customCode || ""} ${job.error.message || ""}`.trim(), {
          code: "job-failed",
          customCode,
          retryable,
          body: job.error,
        });
      }
      const match = bestMatch(job.contract);
      if (!match) {
        throw new SourcifyError(`Sourcify job ${verificationId} completed without a match`, { code: "no-match", body: job });
      }
      return {
        verificationId,
        match,
        creationMatch: (job.contract && job.contract.creationMatch) || null,
        runtimeMatch: (job.contract && job.contract.runtimeMatch) || null,
        contract: job.contract,
        job,
      };
    }
    if (Date.now() >= deadline) {
      throw new SourcifyError(`Sourcify job ${verificationId} still running after the timeout`, { code: "timeout", retryable: true });
    }
    await sleep(every);
  }
}

/**
 * Current verification status of an address: { verified, match, creationMatch, runtimeMatch, contract }.
 * An unknown contract is not an error (verified: false, match: null).
 */
async function getContractStatus(chainId, address, opts = {}) {
  const urlPath = `/v2/contract/${Number(chainId)}/${address}`;
  const r = await request("GET", urlPath, { opts, timeoutMs: opts.timeoutMs ?? envInt("SOURCIFY_TIMEOUT_MS", 15000) });
  if (r.status === 404) return { verified: false, match: null, creationMatch: null, runtimeMatch: null, contract: null };
  if (!r.ok || !r.json) throw httpError("GET", urlPath, r);
  const match = bestMatch(r.json);
  return {
    verified: match !== null,
    match,
    creationMatch: r.json.creationMatch || null,
    runtimeMatch: r.json.runtimeMatch || null,
    contract: r.json,
  };
}

/**
 * Status check, submission and polling in one call.
 * @returns { status: "verified" | "already-verified", match, creationMatch, runtimeMatch, url, verificationId }
 */
async function verifyStandardJson(params, opts = {}) {
  const { chainId, address } = params;
  const url = repoUrl(chainId, address, opts);
  let before = null;
  try {
    before = await getContractStatus(chainId, address, opts);
  } catch (e) {
    // a failed status check is not fatal: the submission decides
  }
  if (before && before.match === "exact_match") {
    return { status: "already-verified", match: before.match, creationMatch: before.creationMatch, runtimeMatch: before.runtimeMatch, url, verificationId: null };
  }
  const sub = await submitStandardJson(params, opts);
  if (sub.alreadyVerified) {
    return { status: "already-verified", match: (before && before.match) || "match", creationMatch: before && before.creationMatch, runtimeMatch: before && before.runtimeMatch, url, verificationId: null };
  }
  const job = await pollJob(sub.verificationId, {}, opts);
  return { status: "verified", match: job.match, creationMatch: job.creationMatch, runtimeMatch: job.runtimeMatch, url, verificationId: sub.verificationId };
}

module.exports = {
  SourcifyError,
  DEFAULT_URL,
  DEFAULT_REPO_URL,
  DEFAULT_CHAINS,
  serverUrl,
  repoUrl,
  supportsChain,
  normalizeCompilerVersion,
  bestMatch,
  submitStandardJson,
  pollJob,
  getContractStatus,
  verifyStandardJson,
};
