// The reward tokens a quick Rewards launch may pick: the initial allowlist QuickLaunch receives in
// its constructor, plus the swap routes the owner stores for the reward tokens that have no WETH
// pool on the chain's Uniswap V2. On Robinhood Chain mainnet (4663) the allowlist is WETH, USDG and
// the tokenized stocks the frontend offers (frontend/src/config/addresses.js, STOCK_REWARD_PRESETS;
// the lists must match). On the local network it is the MockWETH of the mock DEX plus the mock USDG
// and the mock TSLA deploy.js creates; a local network that forks mainnet (FORK_URL) gets the
// mainnet list.
//
//   const { rewardAllowlistFor, rewardRoutesFor, applyRewardRoutes, describeRewardRoutes } = require("./lib/reward-tokens");
//   const list = await rewardAllowlistFor(hre, deployments);   // addresses for the QuickLaunch constructor
//   await applyRewardRoutes(hre, quickLaunch, await rewardRoutesFor(hre, deployments), console.log);
//   for (const line of await describeRewardRoutes(hre, quickLaunch)) console.log(line);
//
// Routes. A token launched with a reward asset swaps token -> WETH on its own Uniswap V2 pool and
// from WETH on either through V2 hops (QuickLaunch.setRewardRoute) or, for the tokenized stocks,
// through a packed Uniswap V3 path (QuickLaunch.setRewardRouteV3): on Robinhood Chain the stocks
// trade on Uniswap V3 (TSLA/USDG, TSLA/WETH, NVDA/USDG, SPY/WETH, ...) and their V2 pools hold
// dust. rewardRoutesFor quotes, for every stock, the candidates WETH -fee-> STOCK (fees 0.05%,
// 0.3%, 1%) and WETH -0.05%-> USDG -fee-> STOCK (fees 0.05%, 0.3%) with the chain's QuoterV2 for
// 0.1 WETH, skips the candidates whose pools are missing or whose quote fails, and picks the one
// with the highest output. QuickLaunch refuses a launch whose route is not live
// (isRewardRouteLive): every pool of the route must exist with depth (V3: the liquidity of the
// current tick range holds at least eight probes of ROUTE_PROBE_WETH, 0.01 ETH each). A stock
// without such a pool stays on the allowlist but cannot be picked until one exists.

const MAINNET_REWARD_TOKENS = [
  { symbol: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
  { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", stock: true },
  { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", stock: true },
  { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", stock: true },
  { symbol: "AMZN", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", stock: true },
  { symbol: "MSFT", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", stock: true },
  { symbol: "GOOGL", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", stock: true },
  { symbol: "META", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", stock: true },
  { symbol: "MSTR", address: "0xec262a75e413fAfD0dF80480274532C79D42da09", stock: true },
  { symbol: "SPY", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", stock: true },
  { symbol: "QCOM", address: "0x0f17206447090e464C277571124dD2688E48AEA9", stock: true },
];

const REWARD_TOKENS_BY_CHAIN = {
  4663: MAINNET_REWARD_TOKENS,
};

// The official Uniswap V3 contracts per chain (verified on chain): the factory, SwapRouter02 (the
// reward swap's V3 leg, no deadline of its own) and QuoterV2 (off-chain quotes).
const V3_ADDRESSES_BY_CHAIN = {
  4663: {
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    router: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  },
};

/** The V3 fee tiers tried for a stock: straight from WETH, and through the WETH/USDG 0.05% pool */
const DIRECT_FEES = [500, 3000, 10000];
const VIA_USDG_FEE = 500;
const VIA_USDG_FEES = [500, 3000];
/** The WETH amount every candidate is quoted with */
const CANDIDATE_QUOTE_WETH = 10n ** 17n;

const isLocal = (network) => network === "hardhat" || network === "localhost";
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sameHex = (a, b) => String(a || "0x").toLowerCase() === String(b || "0x").toLowerCase();

// ------------------------------------------------------------- V3 paths

/** The packed Uniswap V3 path token (20 bytes), fee (3 bytes), token, ... for [t0, t1, ...] and [fee01, fee12, ...] */
function encodeV3Path(hre, tokens, fees) {
  if (tokens.length !== fees.length + 1 || fees.length === 0) throw new Error("a V3 path needs n tokens and n - 1 fees");
  const types = ["address"];
  const values = [tokens[0]];
  for (let i = 0; i < fees.length; i++) {
    types.push("uint24", "address");
    values.push(fees[i], tokens[i + 1]);
  }
  return hre.ethers.solidityPacked(types, values);
}

/** The tokens and fees of a packed V3 path: { tokens: [checksummed], fees: [number] } (null for an empty or malformed path) */
function decodeV3Path(hre, path) {
  const hex = String(path || "0x").replace(/^0x/, "");
  if (hex.length < 86 || (hex.length - 40) % 46 !== 0) return null;
  const tokens = [hre.ethers.getAddress("0x" + hex.slice(0, 40))];
  const fees = [];
  for (let o = 40; o < hex.length; o += 46) {
    fees.push(parseInt(hex.slice(o, o + 6), 16));
    tokens.push(hre.ethers.getAddress("0x" + hex.slice(o + 6, o + 46)));
  }
  return { tokens, fees };
}

/** A fee tier as a percentage: 500 -> "0.05%", 3000 -> "0.3%", 10000 -> "1%" */
function feePercent(fee) {
  return `${Number(fee) / 10_000}%`;
}

/** "WETH -0.3%-> TSLA" for a decoded path and a symbol lookup */
function describeV3Hops(symbols, fees) {
  let s = symbols[0];
  for (let i = 0; i < fees.length; i++) s += ` -${feePercent(fees[i])}-> ${symbols[i + 1]}`;
  return s;
}

// ------------------------------------------------------------- chain lookups

/** The chain id a hardhat network forks (hardhat_metadata.forkedNetwork), null when it is not a fork. */
async function forkedChainId(hre) {
  try {
    const meta = await hre.network.provider.send("hardhat_metadata", []);
    return meta && meta.forkedNetwork ? Number(meta.forkedNetwork.chainId) : null;
  } catch (e) {
    return null;
  }
}

function listOrThrow(chainId) {
  const list = REWARD_TOKENS_BY_CHAIN[chainId];
  if (!list) throw new Error(`no reward token allowlist for chainId ${chainId}; add it to scripts/lib/reward-tokens.js`);
  return list;
}

/** The chain hardhat runs against: the forked chain on a fork, null on a plain local network, else the chain itself */
async function effectiveChainId(hre) {
  if (isLocal(hre.network.name)) return forkedChainId(hre);
  return Number((await hre.ethers.provider.getNetwork()).chainId);
}

/**
 * The reward token list of the chain hardhat runs against: the forked chain's on a fork, null on a
 * plain local network (the mocks apply), the chain's own list on a public network (unknown: throws).
 */
async function chainListFor(hre) {
  const chainId = await effectiveChainId(hre);
  return chainId === null ? null : listOrThrow(chainId);
}

/** The Uniswap V3 addresses of a chain, checksummed: { factory, router, quoter }, or null when the chain has none */
function v3AddressesFor(chainId) {
  const v3 = V3_ADDRESSES_BY_CHAIN[Number(chainId)];
  if (!v3) return null;
  const { getAddress } = require("ethers");
  return { factory: getAddress(v3.factory), router: getAddress(v3.router), quoter: getAddress(v3.quoter) };
}

/**
 * The Uniswap V3 addresses for the network hardhat runs against: the chain's (also on a fork of
 * it), or the mocks recorded in the deployments file on a plain local network; null when there
 * are none.
 */
async function v3For(hre, deployments = {}) {
  const chainId = await effectiveChainId(hre);
  if (chainId !== null) return v3AddressesFor(chainId);
  if (deployments.v3Router && deployments.v3Quoter) {
    return {
      factory: deployments.v3Factory || null,
      router: hre.ethers.getAddress(deployments.v3Router),
      quoter: hre.ethers.getAddress(deployments.v3Quoter),
    };
  }
  return null;
}

/**
 * The V3 leg of the token factory's current RewardsTokenDeployer: { address, v3Router, v3Quoter },
 * or null when the deployer is an earlier generation without v3Router() or carries a zero router.
 */
async function rewardsDeployerV3(hre, tokenFactoryAddress) {
  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", tokenFactoryAddress);
  const address = await tokenFactory.rewardsDeployer();
  if (!address || address === hre.ethers.ZeroAddress) return null;
  const selector = hre.ethers.id("v3Router()").slice(2, 10).toLowerCase();
  const code = (await hre.ethers.provider.getCode(address)).toLowerCase();
  if (!code.includes(selector)) return null;
  const deployer = await hre.ethers.getContractAt("RewardsTokenDeployer", address);
  const v3Router = await deployer.v3Router();
  if (v3Router === hre.ethers.ZeroAddress) return null;
  return { address, v3Router, v3Quoter: await deployer.v3Quoter() };
}

/**
 * Stops a script that would store V3 routes on a chain with Uniswap V3 while the token factory's
 * rewards deployer has no V3 leg (QuickLaunch.setRewardRouteV3 reverts without it, and the tokens
 * would swap on V2). Returns the deployer's V3 leg, or null on a network without V3 addresses.
 */
async function requireV3Deployer(hre, deployments) {
  const v3 = await v3For(hre, deployments);
  if (!v3) return null;
  const dep = await rewardsDeployerV3(hre, deployments.tokenFactory);
  if (!dep) {
    throw new Error(
      "tokenFactory.rewardsDeployer() has no v3Router(): the reward swap's Uniswap V3 leg is missing; run scripts/deploy-rewards-deployer.js first"
    );
  }
  if (!same(dep.v3Router, v3.router)) {
    throw new Error(`the rewards deployer's v3Router is ${dep.v3Router}, the chain's SwapRouter02 is ${v3.router}; run scripts/deploy-rewards-deployer.js`);
  }
  return dep;
}

// ------------------------------------------------------------- allowlist

/**
 * The reward allowlist for the network hardhat runs against, checksummed. Local networks need the
 * deployments (or at least the router) to find the MockWETH; `usdg` and `tsla` are the mocks when
 * deploy.js created them.
 */
async function rewardAllowlistFor(hre, deployments = {}) {
  const list = await chainListFor(hre);
  if (list) return list.map((t) => hre.ethers.getAddress(t.address));
  const router = deployments.router;
  if (!router) throw new Error("local reward allowlist needs the router address (deployments.router)");
  const weth = await (await hre.ethers.getContractAt("MockRouter", router)).WETH();
  const out = [weth];
  if (deployments.usdg) out.push(hre.ethers.getAddress(deployments.usdg));
  if (deployments.tsla) out.push(hre.ethers.getAddress(deployments.tsla));
  return out;
}

// ------------------------------------------------------------- routes

/** The V3 candidates of a stock: straight from WETH at three fee tiers, and through the USDG pool at two */
function v3CandidatesFor(hre, weth, usdg, stock) {
  const candidates = DIRECT_FEES.map((fee) => ({ tokens: [weth, stock], fees: [fee] }));
  if (usdg) for (const fee of VIA_USDG_FEES) candidates.push({ tokens: [weth, usdg, stock], fees: [VIA_USDG_FEE, fee] });
  return candidates.map((c) => ({ ...c, path: encodeV3Path(hre, c.tokens, c.fees) }));
}

/**
 * True for an error that is the call itself reverting (the pool cannot fill the quote): ethers
 * reports it as CALL_EXCEPTION on a JSON-RPC node; the in-process Hardhat network throws a plain
 * error carrying the revert data and no code. Anything else (NETWORK_ERROR, SERVER_ERROR,
 * TIMEOUT, BAD_DATA, an HTTP status) is not a revert.
 */
function isCallRevert(e) {
  if (!e) return false;
  if (e.code === "CALL_EXCEPTION") return true;
  // Hardhat's HttpProvider hands an eth_call revert over as a ProviderError with the node's
  // numeric JSON-RPC code (3 on Robinhood Chain) and "execution reverted: <reason>" (QuoterV2
  // reverts with "Unexpected error" when a pool of the path cannot quote); the in-process network
  // throws a SolidityError with hex data and "revert" in the message.
  if (typeof e.code === "number" && /execution reverted/i.test(String(e.message))) return true;
  if (e.name === "ProviderError" && /execution reverted/i.test(String(e.message))) return true;
  return e.code === undefined && typeof e.data === "string" && e.data.startsWith("0x") && /revert/i.test(String(e.message));
}

/**
 * Quotes every candidate on the chain's QuoterV2 and returns them with `pools` (every pool exists),
 * `amountOut` (null when the quote failed) and `error`; the best is the highest amountOut. Only a
 * revert of the quote call marks a candidate as failed (its pools cannot fill 0.1 WETH); any other
 * error (the RPC unreachable, a timeout, an HTTP status, a malformed answer) is thrown, so a
 * quoting round that could not read the chain never passes for a round with dead routes.
 */
async function quoteV3Candidates(hre, v3, candidates, amountIn = CANDIDATE_QUOTE_WETH) {
  const factory = await hre.ethers.getContractAt("IUniswapV3Factory", v3.factory);
  const quoter = await hre.ethers.getContractAt("IQuoterV2", v3.quoter);
  const out = [];
  for (const c of candidates) {
    const r = { ...c, pools: true, amountOut: null, error: null };
    for (let i = 0; i < c.fees.length && r.pools; i++) {
      const pool = await factory.getPool(c.tokens[i], c.tokens[i + 1], c.fees[i]);
      if (pool === hre.ethers.ZeroAddress) {
        r.pools = false;
        r.error = `no pool ${c.tokens[i]}/${c.tokens[i + 1]} at ${feePercent(c.fees[i])}`;
      }
    }
    if (r.pools) {
      try {
        const [amountOut] = await quoter.quoteExactInput.staticCall(c.path, amountIn);
        r.amountOut = amountOut;
        if (amountOut === 0n) r.error = "quote is zero";
      } catch (e) {
        if (!isCallRevert(e)) throw e;
        r.error = `quote failed: ${((e && (e.shortMessage || e.message)) || String(e)).replace(/\s+/g, " ").slice(0, 120)}`;
      }
    }
    out.push(r);
  }
  return out;
}

/**
 * The stocks of a quoting round whose pools exist but none of which could be quoted (the route
 * table would store nothing for them, the pools are dead or too shallow for 0.1 WETH). A stock
 * without any pool at all is not in this list: it only waits for a pool.
 */
function deadRewardRoutes(routes) {
  return routes.filter((r) => !Array.isArray(r.intermediates) && !r.v3Path && r.candidates.some((c) => c.pools));
}

/**
 * Stops a deployment whose quoting round found dead routes (see deadRewardRoutes) unless
 * ALLOW_DEAD_ROUTES=1; stocks without a pool only warn. Call it before anything is deployed, so a
 * round that must be repeated costs no gas. Returns the dead routes.
 */
function requireQuotableRoutes(routes, { log = console.log, env = process.env } = {}) {
  for (const r of routes) {
    if (Array.isArray(r.intermediates) || r.v3Path) continue;
    if (r.candidates.length > 0 && !r.candidates.some((c) => c.pools)) {
      log(`WARNING: ${r.symbol} has no Uniswap V3 pool yet; no route is stored and it cannot be picked until one exists`);
    }
  }
  const dead = deadRewardRoutes(routes);
  if (dead.length === 0) return dead;
  const lines = dead.map((r) => `${r.symbol}: ${r.candidates.filter((c) => c.pools).map((c) => c.error).join("; ")}`);
  if (env.ALLOW_DEAD_ROUTES === "1") {
    for (const l of lines) log(`WARNING: dead route allowed (ALLOW_DEAD_ROUTES=1): ${l}`);
    return dead;
  }
  throw new Error(
    `no quotable route for ${dead.map((r) => r.symbol).join(", ")} although their pools exist; nothing was deployed. ` +
      `Details: ${lines.join(" | ")}. Re-run once the pools hold depth, or set ALLOW_DEAD_ROUTES=1 to deploy without those routes`
  );
}

/**
 * The routes QuickLaunch must hold for this network, one record per reward token that needs one:
 *   { symbol, token, v3Path, quote, candidates }  a V3 route (the best quoted candidate; v3Path
 *                                                 null when no candidate has pools and a quote,
 *                                                 with `reason`)
 *   { symbol, token, intermediates }              V2 hops after the launched token, WETH first
 * On mainnet (and on a fork of it) every stock gets a V3 route quoted on the chain's QuoterV2;
 * WETH and USDG need none (they trade against WETH on V2). On a plain local network the mock
 * USDG stays on V2 and the mock TSLA gets WETH -0.3%-> TSLA on the mock V3 (deploy.js creates
 * that pool). `options.symbols` limits the quoting to those stocks; `options.log` reports each
 * candidate.
 */
async function rewardRoutesFor(hre, deployments = {}, options = {}) {
  const log = options.log || (() => {});
  const list = await chainListFor(hre);
  if (!list) {
    if (!deployments.tsla || !deployments.router) return [];
    const weth = await (await hre.ethers.getContractAt("MockRouter", deployments.router)).WETH();
    const tsla = hre.ethers.getAddress(deployments.tsla);
    return [{ symbol: "TSLA", token: tsla, v3Path: encodeV3Path(hre, [weth, tsla], [3000]), quote: null, candidates: [], hops: "WETH -0.3%-> TSLA" }];
  }
  const bySymbol = Object.fromEntries(list.map((t) => [t.symbol, hre.ethers.getAddress(t.address)]));
  const weth = bySymbol.WETH;
  if (!weth) throw new Error("the reward token list has no WETH entry");
  const chainId = await effectiveChainId(hre);
  const v3 = v3AddressesFor(chainId);
  const stocks = list.filter((t) => t.stock && (!options.symbols || options.symbols.includes(t.symbol)));
  const routes = [];
  for (const t of stocks) {
    const token = bySymbol[t.symbol];
    if (!v3) {
      routes.push({ symbol: t.symbol, token, v3Path: null, quote: null, candidates: [], reason: `chainId ${chainId} has no Uniswap V3 addresses` });
      continue;
    }
    const symbolOf = (a) => Object.keys(bySymbol).find((s) => same(bySymbol[s], a)) || a;
    const candidates = await quoteV3Candidates(hre, v3, v3CandidatesFor(hre, weth, bySymbol.USDG, token));
    for (const c of candidates) {
      const hops = describeV3Hops(c.tokens.map(symbolOf), c.fees);
      log(`reward route ${t.symbol}: candidate ${hops}: ${c.amountOut !== null && c.amountOut > 0n ? `${c.amountOut} out for 0.1 WETH` : c.error}`);
    }
    const best = candidates
      .filter((c) => c.amountOut !== null && c.amountOut > 0n)
      .reduce((a, c) => (a === null || c.amountOut > a.amountOut ? c : a), null);
    if (best) {
      routes.push({ symbol: t.symbol, token, v3Path: best.path, quote: best.amountOut, candidates, hops: describeV3Hops(best.tokens.map(symbolOf), best.fees) });
    } else {
      routes.push({ symbol: t.symbol, token, v3Path: null, quote: null, candidates, reason: "no candidate with pools and a quote" });
    }
  }
  return routes;
}

/**
 * Stores every route whose on-chain value differs (QuickLaunch owner): setRewardRouteV3 for a V3
 * path, setRewardRoute for V2 hops (which also clears a stored V3 path). A stock without a usable
 * candidate is logged and left as it is. Returns the number of sends.
 */
async function applyRewardRoutes(hre, quickLaunch, routes, log = () => {}) {
  let sent = 0;
  for (const r of routes) {
    if (Array.isArray(r.intermediates)) {
      const current = [...(await quickLaunch.rewardRouteOf(r.token))];
      const currentV3 = await quickLaunch.rewardRouteV3Of(r.token);
      const equal =
        current.length === r.intermediates.length && current.every((a, i) => same(a, r.intermediates[i])) && sameHex(currentV3, "0x");
      if (equal) {
        log(`reward route ${r.symbol}: already ${r.intermediates.join(" -> ")}`);
        continue;
      }
      await (await quickLaunch.setRewardRoute(r.token, r.intermediates)).wait();
      sent++;
      log(`reward route ${r.symbol}: set V2 hops ${r.intermediates.join(" -> ")}`);
      continue;
    }
    if (!r.v3Path) {
      log(`reward route ${r.symbol}: no V3 route stored (${r.reason || "no candidate"}), the stored value is left as it is`);
      continue;
    }
    const currentV3 = await quickLaunch.rewardRouteV3Of(r.token);
    if (sameHex(currentV3, r.v3Path)) {
      log(`reward route ${r.symbol}: already ${r.hops || r.v3Path} (V3)`);
      continue;
    }
    await (await quickLaunch.setRewardRouteV3(r.token, r.v3Path)).wait();
    sent++;
    log(`reward route ${r.symbol}: set V3 path ${r.hops || r.v3Path}${r.quote ? ` (${r.quote} out for 0.1 WETH)` : ""}`);
  }
  return sent;
}

/**
 * One record per allowed reward token: { token, symbol, path, fees, v3, live, line } with `path`
 * the swap hops after the launched token (symbols where known), `fees` the V3 fee tiers of a V3
 * route (null on V2), `live` the depth verdict of QuickLaunch.isRewardRouteLive right now and
 * `line` the printable form describeRewardRoutes returns.
 */
async function rewardRouteStatus(hre, quickLaunch) {
  const list = (await chainListFor(hre).catch(() => null)) || [];
  // Symbols come from the chain's list first, then from the token itself (the local mocks), else
  // the address is shown; each address is read once
  const symbols = new Map();
  const symbolOf = async (a) => {
    const key = String(a).toLowerCase();
    if (!symbols.has(key)) {
      let symbol = (list.find((t) => same(t.address, a)) || {}).symbol;
      if (!symbol) {
        try {
          symbol = await (await hre.ethers.getContractAt("IERC20Metadata", a)).symbol();
        } catch (e) {
          symbol = a;
        }
      }
      symbols.set(key, symbol);
    }
    return symbols.get(key);
  };
  const records = [];
  for (const token of await quickLaunch.rewardTokens()) {
    const symbol = await symbolOf(token);
    const live = await quickLaunch.isRewardRouteLive(token);
    const v3Path = await quickLaunch.rewardRouteV3Of(token);
    const decoded = decodeV3Path(hre, v3Path);
    if (decoded) {
      const path = [];
      for (const hop of decoded.tokens) path.push(await symbolOf(hop));
      const line = `${symbol}: token -> ${describeV3Hops(path, decoded.fees)} (V3, ${live ? "pools live" : "NO POOL OR NO DEPTH"})`;
      records.push({ token, symbol, path, fees: decoded.fees, v3: true, live, line });
      continue;
    }
    const path = [];
    for (const hop of await quickLaunch.rewardPathOf(token)) path.push(await symbolOf(hop));
    const line = `${symbol}: token -> ${path.join(" -> ")} ${live ? "(pools live)" : "(NO POOL OR NO DEPTH)"}`;
    records.push({ token, symbol, path, fees: null, v3: false, live, line });
  }
  return records;
}

/**
 * One line per allowed reward token: symbol, the swap path after the launched token (with the V3
 * fee tiers when the route runs on V3) and the depth verdict, "(pools live)" or
 * "(NO POOL OR NO DEPTH)" (see rewardRouteStatus).
 */
async function describeRewardRoutes(hre, quickLaunch) {
  return (await rewardRouteStatus(hre, quickLaunch)).map((r) => r.line);
}

module.exports = {
  MAINNET_REWARD_TOKENS,
  REWARD_TOKENS_BY_CHAIN,
  V3_ADDRESSES_BY_CHAIN,
  CANDIDATE_QUOTE_WETH,
  v3AddressesFor,
  v3For,
  rewardsDeployerV3,
  requireV3Deployer,
  encodeV3Path,
  decodeV3Path,
  feePercent,
  describeV3Hops,
  v3CandidatesFor,
  isCallRevert,
  quoteV3Candidates,
  deadRewardRoutes,
  requireQuotableRoutes,
  rewardAllowlistFor,
  rewardRoutesFor,
  applyRewardRoutes,
  rewardRouteStatus,
  describeRewardRoutes,
};
