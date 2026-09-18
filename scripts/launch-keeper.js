// Launch keeper: the platform bot that performs the launches and token deliveries nobody
// should have to wait for.
//
//   KEEPER_KEY=0x... npx hardhat run scripts/launch-keeper.js --network robinhood
//   KEEPER_KEY=0x... npm run keeper -- --network robinhood
//
// Every POLL_SECONDS (default 15) it reads all presales from the factory in pages and
//   - sends finalize(0, 0) to quick sales that are Active and ready to finalize,
//   - sends finalize(0, 0) to normal sales whose launch time has arrived, when this wallet is
//     the factory's launchKeeper (the only address allowed to launch on the owner's behalf),
//   - sends distribute(100) to finalized sales whose token delivery is not complete,
//   - sends QuickLaunch.distributeRewards(token, amountOutMin) for the launched quick sales of a
//     Rewards token whenever the token's pendingRewardsTokens reaches its swapThreshold() (1/1000
//     of the supply) or REWARDS_MIN_BPS of the supply when that is set, at most once per
//     REWARDS_INTERVAL_SECONDS (default 300) per token. The QuickLaunch that launched the sale
//     (its sale owner) is the token's owner and forwards the call; only the QuickLaunch owner or
//     the factory's launchKeeper may send it (the caller sets the swap floor), so the keeper warns
//     at start when its wallet is neither and every distribution it sends would fail.
//     Before sending, the swap is quoted along the token's reward route (the V2 router along
//     rewardPath, or for a token with a Uniswap V3 path the V2 router for token -> WETH and then
//     the chain's QuoterV2 for the packed path, the way the swap runs; a token from before the V3
//     generation has no rewardRouteV3 getter, which is read from its code once and treated as an
//     empty path, so it stays on its V2 route): the output of the whole
//     pending amount against a thousandth of it scaled back up gives the price impact. Above
//     REWARDS_MAX_IMPACT_BPS the distribution is skipped (a pool of the route is down to dust;
//     the rewards wait until it recovers or the route is repaired), logged once per pending
//     amount. Otherwise amountOutMin is the quote minus REWARDS_SLIPPAGE_BPS. A route that cannot
//     be quoted at all (a pool gone) is skipped the same way and never sent.
// One log line per action. RPC errors are logged and the loop continues. A transaction is never
// re-sent while a previous one for the same sale (or token) and action is still pending; a
// failed send is retried after RETRY_SECONDS (default 60). Sales that need nothing more are not
// read again; the rewards tokens of launched quick sales are watched for as long as the keeper runs.
//
// The same process also runs the verification watcher (scripts/auto-verify.js): every token the
// TokenFactory creates is verified on Sourcify (Blockscout second), one log line per verified
// contract with its https://repo.sourcify.dev/<chainId>/<address> link. AUTO_VERIFY=0 turns it off.
//
// Environment:
//   KEEPER_KEY      private key of the keeper wallet (required on public networks; on the local
//                   network the first configured signer is used when it is not set)
//   POLL_SECONDS    seconds between polls (default 15)
//   RETRY_SECONDS   wait after a failed send before trying that action again (default 60)
//   REWARDS_INTERVAL_SECONDS  least time between two reward distributions of one token (default 300)
//   REWARDS_MIN_BPS pending rewards needed before a distribution, in bps of the token's supply
//                   (default: the token's own swapThreshold, 10 bps)
//   REWARDS_MAX_IMPACT_BPS  most price impact a reward swap may take, in bps of its fair output
//                   (default 2000 = 20%); a distribution above it is skipped and logged once
//   REWARDS_SLIPPAGE_BPS  the slack below the quoted output that amountOutMin allows the swap
//                   (default 300 = 3%)
//   KEEPER_ONCE=1   run a single poll (and a single verification round) and exit (for cron)
//   AUTO_VERIFY=0   do not run the verification watcher
//   VERIFY_PRESALES=1, CONFIRMATIONS, START_BLOCK, SOURCIFY_URL, ...: see scripts/auto-verify.js
// The RPC comes from the hardhat network configuration (--network).
const fs = require("fs");
const path = require("path");

const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
const PAGE = 50;
const DISTRIBUTE_BATCH = 100;
const REWARDS_INTERVAL_SECONDS = 300;
const REWARDS_MAX_IMPACT_BPS = 2000;
const REWARDS_SLIPPAGE_BPS = 300;
const BPS = 10_000n;
// The price-impact probe: a thousandth of the pending amount, scaled back up, is the output the
// route would give without the swap's own impact
const IMPACT_PROBE_DIVISOR = 1000n;
// RewardsToken refuses to distribute while the shares are below 1 token
const MIN_SHARES_FOR_DISTRIBUTION = 10n ** 18n;
// A Uniswap v4 launch collects its fees in the pool's hook and they sit there until someone sends
// them on. Below this they are not worth a transaction.
const V4_FLUSH_MIN_WEI = 5n * 10n ** 15n; // 0.005 ETH

const State = { Active: 0, Cancelled: 1, Finalized: 2 };
// Presale.Status: Failed means the sale ended below its soft cap or the finalize window passed
const Status = { Failed: 3 };
// QuickLaunch token types
const TokenType = { Rewards: 2 };

const short = (e) => {
  const m = (e && (e.shortMessage || e.reason || e.message)) || String(e);
  return m.replace(/\s+/g, " ").slice(0, 160);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (amounts) => amounts[amounts.length - 1];
// Bps as a percentage for the log: whole percentages without a decimal, the rest with one
const pct = (bps) => (Number(bps) / 100).toFixed(bps % 100n === 0n ? 0 : 1);

/** Whether the code deployed at `address` carries the 4-byte selector of `signature` ("name(type,...)") */
async function codeHasSelector(provider, address, signature) {
  const selector = new (require("ethers").Interface)([`function ${signature}`]).getFunction(signature.split("(")[0]).selector.slice(2).toLowerCase();
  return (await provider.getCode(address)).toLowerCase().includes(selector);
}

/**
 * Builds a keeper bound to one factory and one signer. `poll()` performs a single pass.
 * @param hre hardhat runtime (for ethers and contract ABIs)
 * @param options { factoryAddress, signer, log, retrySeconds, pendingTimeoutMs, now,
 *                  rewardsIntervalSeconds, rewardsMinBps, rewardsMaxImpactBps, rewardsSlippageBps,
 *                  quickLaunchAddress (the current QuickLaunch, for the distribution rights warning),
 *                  v4LauncherAddress and v4HookAddress (the Uniswap v4 launch mode, optional),
 *                  v4FlushMinWei }
 */
async function createKeeper(hre, options) {
  const { factoryAddress, signer, quickLaunchAddress, v4LauncherAddress, v4HookAddress } = options;
  const log = options.log || ((line) => console.log(`${new Date().toISOString()} ${line}`));
  const retryMs = (options.retrySeconds ?? 60) * 1000;
  const pendingTimeoutMs = options.pendingTimeoutMs ?? PENDING_TIMEOUT_MS;
  const rewardsIntervalMs = (options.rewardsIntervalSeconds ?? REWARDS_INTERVAL_SECONDS) * 1000;
  // undefined: the token's own swapThreshold decides
  const rewardsMinBps = options.rewardsMinBps === undefined || options.rewardsMinBps === null ? undefined : BigInt(options.rewardsMinBps);
  const rewardsMaxImpactBps = BigInt(options.rewardsMaxImpactBps ?? REWARDS_MAX_IMPACT_BPS);
  const rewardsSlippageBps = BigInt(options.rewardsSlippageBps ?? REWARDS_SLIPPAGE_BPS);
  const v4FlushMinWei = BigInt(options.v4FlushMinWei ?? V4_FLUSH_MIN_WEI);
  const now = options.now || (() => Date.now());
  const provider = signer.provider;

  const factory = await hre.ethers.getContractAt("PresaleFactory", factoryAddress, signer);
  const launchKeeper = await factory.launchKeeper();
  const isKeeper = launchKeeper.toLowerCase() === signer.address.toLowerCase();
  // QuickLaunch.distributeRewards takes the factory's launchKeeper or the QuickLaunch owner only:
  // the wallet is checked once against the current QuickLaunch and the warning goes out at start
  let quickLaunchOwner = null;
  if (quickLaunchAddress && quickLaunchAddress !== hre.ethers.ZeroAddress) {
    quickLaunchOwner = await (await hre.ethers.getContractAt("QuickLaunch", quickLaunchAddress, signer)).owner();
  }
  const isQuickLaunchOwner = quickLaunchOwner !== null && quickLaunchOwner.toLowerCase() === signer.address.toLowerCase();
  const canDistribute = isKeeper || isQuickLaunchOwner;
  if (quickLaunchOwner !== null && !canDistribute) {
    log(`warning: quick reward distributions will fail: this wallet is not the launch keeper (${launchKeeper}) or the QuickLaunch owner (${quickLaunchOwner})`);
  }

  const sales = new Map(); // address -> { sale, quick, rewards }
  const pending = new Map(); // key -> { hash, sentAt }
  const retryAfter = new Map(); // key -> timestamp ms
  const done = new Set(); // sales that need nothing more
  const actions = []; // history of sends, for tests and diagnostics
  // token address -> { token, quickLaunch, presale, launched, lastSentAt, router, quoter, weth,
  // reward, skippedPending }: the Rewards tokens of quick sales, distributed through the
  // QuickLaunch that owns them once their sale has launched. router, quoter (the QuoterV2 of a
  // token with a V3 path), weth and reward (the reward token's symbol and decimals, for the log)
  // are read on first use; skippedPending is the pending amount whose skip was already logged, so
  // a route that stays dead produces one line, not one per poll.
  const rewardsTokens = new Map();

  async function saleInfo(addr) {
    let info = sales.get(addr);
    if (!info) {
      const sale = await hre.ethers.getContractAt("Presale", addr, signer);
      const quick = await factory.isQuick(addr);
      const rewards = quick ? await rewardsTokenOf(addr, sale) : null;
      info = { sale, quick, rewards };
      sales.set(addr, info);
    }
    return info;
  }

  /**
   * Whether the code at `owner` carries the quickTokenOf selector, cached per address. The sale
   * owner of a quick sale is the QuickLaunch that launched it; a generation from before the token
   * types has no quickTokenOf and no Rewards launches. Reading the code instead of catching a
   * revert keeps the answer the same on every provider (the in-process network and JSON-RPC
   * nodes report a missing selector differently) and lets real RPC errors propagate.
   */
  const ownerHasQuickTokenOf = new Map();
  async function hasQuickTokenOf(owner) {
    let has = ownerHasQuickTokenOf.get(owner);
    if (has === undefined) {
      has = await codeHasSelector(provider, owner, "quickTokenOf(address)");
      ownerHasQuickTokenOf.set(owner, has);
    }
    return has;
  }

  /**
   * Whether a Rewards token carries rewardRouteV3(), read from its code once (like
   * hasQuickTokenOf). A token from the deployer generation before the Uniswap V3 leg has no such
   * getter: it swaps along its V2 rewardPath and is quoted that way.
   */
  async function hasRewardRouteV3(r) {
    if (r.hasRewardRouteV3 === undefined) r.hasRewardRouteV3 = await codeHasSelector(provider, r.token.target, "rewardRouteV3()");
    return r.hasRewardRouteV3;
  }

  /**
   * The Rewards token of a quick sale, or null: the sale owner must be a QuickLaunch with
   * quickTokenOf (see hasQuickTokenOf) and the record must say Rewards. RPC errors propagate, so
   * a sale that could not be read is looked at again on the next poll.
   */
  async function rewardsTokenOf(addr, sale) {
    const owner = await sale.saleOwner();
    if (!(await hasQuickTokenOf(owner))) return null;
    const quickLaunch = await hre.ethers.getContractAt("QuickLaunch", owner, signer);
    const record = await quickLaunch.quickTokenOf(addr);
    if (Number(record.tokenType) !== TokenType.Rewards) return null;
    const tokenAddr = (await sale.getParams()).token;
    let entry = rewardsTokens.get(tokenAddr);
    if (!entry) {
      const token = await hre.ethers.getContractAt("RewardsToken", tokenAddr, signer);
      entry = { token, quickLaunch, presale: addr, launched: false, lastSentAt: 0 };
      rewardsTokens.set(tokenAddr, entry);
    }
    return entry;
  }

  /** Checks every transaction sent earlier: logs the mined ones, forgets the ones stuck too long. */
  async function reconcilePending() {
    for (const [key, p] of [...pending.entries()]) {
      const [addr, kind] = key.split(":");
      let receipt;
      try {
        receipt = await provider.getTransactionReceipt(p.hash);
      } catch (e) {
        log(`${kind} ${addr} ${p.hash} receipt lookup failed: ${short(e)}`);
        continue;
      }
      if (!receipt) {
        if (now() - p.sentAt > pendingTimeoutMs) {
          log(`${kind} ${addr} ${p.hash} still pending after ${pendingTimeoutMs / 60000} min, will send again`);
          pending.delete(key);
        }
        continue;
      }
      pending.delete(key);
      log(`${kind} ${addr} ${p.hash} mined, ${receipt.status === 1 ? "success" : "reverted"}, gas ${receipt.gasUsed}`);
      if (receipt.status !== 1) retryAfter.set(key, now() + retryMs);
    }
  }

  /**
   * Sends one action for one sale (or token) unless the same action is already pending or backing
   * off. Returns true when a transaction went out.
   */
  async function send(kind, addr, fn, detail) {
    const key = `${addr}:${kind}`;
    if (pending.has(key)) return false;
    if ((retryAfter.get(key) || 0) > now()) return false;
    try {
      const tx = await fn();
      pending.set(key, { hash: tx.hash, sentAt: now() });
      actions.push({ kind, presale: addr, hash: tx.hash });
      log(`${kind} ${addr} sent ${tx.hash}${detail ? ` ${detail}` : ""}`);
      return true;
    } catch (e) {
      retryAfter.set(key, now() + retryMs);
      log(`${kind} ${addr} not sent: ${short(e)} (retry in ${retryMs / 1000}s)`);
      return false;
    }
  }

  async function inspect(addr) {
    const info = await saleInfo(addr);
    const { sale, quick, rewards } = info;
    const state = Number(await sale.state());
    if (state === State.Cancelled) {
      done.add(addr);
      return;
    }
    if (state === State.Finalized) {
      // The pool exists from the launch on: the token's rewards are worth watching now
      if (rewards) rewards.launched = true;
      // A failed read here must not hold up the sale's delivery; it is tried again next poll.
      if (v4) {
        try {
          await v4Register(info);
        } catch (e) {
          log(`read v4 ${addr} failed: ${short(e)}`);
        }
      }
      if (await sale.distributionComplete()) {
        done.add(addr);
        return;
      }
      await send("distribute", addr, () => sale.distribute(DISTRIBUTE_BATCH));
      return;
    }
    // Active. Failed (soft cap missed after the end, or the finalize window passed) means refunds
    // only; read from the chain each time, so a schedule changed before the start is never stale.
    if (Number(await sale.status()) === Status.Failed) {
      done.add(addr);
      return;
    }
    if (!(await sale.isReadyToFinalize())) return;
    if (quick) {
      await send("finalize", addr, () => sale.finalize(0, 0));
    } else if (isKeeper && (await sale.isLaunchDue())) {
      await send("finalize", addr, () => sale.finalize(0, 0));
    }
  }

  /**
   * Quotes the reward swap of `pendingTokens` along the token's current reward route: `expected`
   * is what the whole amount fetches right now, `fair` what a thousandth of it fetches scaled
   * back up (the route's price without the swap's own impact), `impactBps` the gap between the
   * two. A token with a Uniswap V3 path (rewardRouteV3) is quoted in two legs, like the swap
   * runs: token -> WETH on its own V2 pool (router.getAmountsOut), then the packed path on the
   * chain's QuoterV2 (the token's v3Quoter; quoteExactInput is not a view, so a static call). A
   * route that cannot be quoted (a pool gone or emptied) returns { error } instead; such a
   * distribution is never sent.
   */
  async function quoteRewards(r, pendingTokens) {
    if (!r.router) r.router = await hre.ethers.getContractAt("IUniswapV2Router02", await r.token.router(), signer);
    // A token without the getter (pre-V3 deployer generation) has an empty V3 path; the code read
    // stays outside the try, so an RPC failure there is a read error, not a dead route
    const v3Enabled = await hasRewardRouteV3(r);
    try {
      const v3Path = v3Enabled ? await r.token.rewardRouteV3() : "0x";
      let quoteVia;
      if (v3Path && v3Path !== "0x") {
        if (!r.quoter) r.quoter = await hre.ethers.getContractAt("IQuoterV2", await r.token.v3Quoter(), signer);
        if (!r.weth) r.weth = await r.router.WETH();
        const toWeth = [r.token.target, r.weth];
        quoteVia = async (amountIn) => {
          const wethOut = last(await r.router.getAmountsOut(amountIn, toWeth));
          const [amountOut] = await r.quoter.quoteExactInput.staticCall(v3Path, wethOut);
          return amountOut;
        };
      } else {
        const route = [...(await r.token.rewardPath())];
        quoteVia = async (amountIn) => last(await r.router.getAmountsOut(amountIn, route));
      }
      const expected = await quoteVia(pendingTokens);
      const probeIn = pendingTokens >= IMPACT_PROBE_DIVISOR ? pendingTokens / IMPACT_PROBE_DIVISOR : 1n;
      const fair = (await quoteVia(probeIn)) * IMPACT_PROBE_DIVISOR;
      const impactBps = fair > 0n ? ((fair - expected) * BPS) / fair : BPS;
      return { expected, fair, impactBps };
    } catch (e) {
      return { error: short(e) };
    }
  }

  /** The reward token's symbol and decimals for the log; a token without metadata logs raw units. */
  async function rewardMeta(r) {
    if (!r.reward) {
      try {
        const rewardToken = await hre.ethers.getContractAt("IERC20Metadata", await r.token.rewardToken(), signer);
        const [symbol, decimals] = await Promise.all([rewardToken.symbol(), rewardToken.decimals()]);
        r.reward = { symbol, decimals: Number(decimals) };
      } catch (e) {
        r.reward = { symbol: "reward units", decimals: 0 };
      }
    }
    return r.reward;
  }

  /**
   * One launched quick Rewards token: distributes when the pending rewards reach the threshold,
   * the token has holders to pay, the interval since the last send has passed and the swap's
   * price impact stays within rewardsMaxImpactBps. The quote sets amountOutMin.
   */
  async function inspectRewards(tokenAddr, r) {
    if (!r.launched) return;
    if (pending.has(`${tokenAddr}:rewards`)) return;
    if (now() - r.lastSentAt < rewardsIntervalMs) return;
    const pendingTokens = await r.token.pendingRewardsTokens();
    if (pendingTokens === 0n) return;
    const threshold =
      rewardsMinBps === undefined ? await r.token.swapThreshold() : ((await r.token.totalSupply()) * rewardsMinBps) / BPS;
    if (pendingTokens < threshold) return;
    if ((await r.token.totalShares()) < MIN_SHARES_FOR_DISTRIBUTION) return;

    const pendingText = `pending ${hre.ethers.formatEther(pendingTokens)} tokens`;
    // The route is quoted again on every poll (it may recover), but a skip for the same pending
    // amount is logged only once
    const skip = (reason) => {
      if (r.skippedPending !== pendingTokens) log(`rewards ${tokenAddr} skipped: ${reason}, ${pendingText}`);
      r.skippedPending = pendingTokens;
    };
    const quote = await quoteRewards(r, pendingTokens);
    if (quote.error) return skip(`route quote failed: ${quote.error}`);
    if (quote.impactBps > rewardsMaxImpactBps) {
      return skip(`price impact ${pct(quote.impactBps)}% over ${pct(rewardsMaxImpactBps)}%`);
    }
    const amountOutMin = (quote.expected * (BPS - rewardsSlippageBps)) / BPS;
    const { symbol, decimals } = await rewardMeta(r);
    const units = (v) => `${hre.ethers.formatUnits(v, decimals)} ${symbol}`;
    const sent = await send(
      "rewards",
      tokenAddr,
      () => r.quickLaunch.distributeRewards(tokenAddr, amountOutMin),
      `${pendingText}, quoted ${units(quote.expected)}, min ${units(amountOutMin)}`
    );
    if (sent) {
      r.lastSentAt = now();
      r.skippedPending = undefined;
    }
  }

  // ------------------------------------------------------------ Uniswap v4

  // A v4 launch keeps its fees in the pool's hook until someone sends them on, and the call is
  // open to anyone, so the keeper does it. Without this the platform's share never reaches the
  // Treasury and the buyback never sees it.
  // token address -> { poolId, lastSentAt, isRewards, token, skippedPending }
  const v4 = v4LauncherAddress && v4HookAddress ? { launched: new Map() } : null;

  async function v4Contracts() {
    if (!v4.launcher) {
      v4.launcher = await hre.ethers.getContractAt("V4Launcher", v4LauncherAddress, signer);
      v4.hook = await hre.ethers.getContractAt("HoodSaleV4Hook", v4HookAddress, signer);
    }
    return v4;
  }

  /**
   * Remembers the v4 pool of a finalized sale, read once per sale. Launches are found through the
   * platform's own sales rather than the launcher's token list: anyone can create a v4 token, but
   * only a sale that reached its soft cap and finalized opens a pool, so the keeper's work grows
   * with real launches and not with tokens created to fill its list. A sale from before the v4
   * mode has no isV4Launch and is a V2 launch.
   */
  async function v4Register(info) {
    if (info.v4Token !== undefined) return;
    const addr = info.sale.target;
    let tokenAddr = null;
    if ((await codeHasSelector(provider, addr, "isV4Launch()")) && (await info.sale.isV4Launch())) {
      // Only the platform's launcher counts; a sale is v4 through the launcher its token names.
      if ((await info.sale.v4Launcher()).toLowerCase() === v4LauncherAddress.toLowerCase()) {
        tokenAddr = (await info.sale.getParams()).token;
        if (!v4.launched.has(tokenAddr)) {
          const { launcher } = await v4Contracts();
          v4.launched.set(tokenAddr, { poolId: (await launcher.launchOf(tokenAddr)).poolId, lastSentAt: 0 });
        }
      }
    }
    info.v4Token = tokenAddr;
  }

  /**
   * Quotes turning `pendingEth` into the reward token along the token's stored Uniswap V3 path:
   * `expected` is what the whole amount fetches now, `impactBps` how far that falls short of a
   * thousandth of it scaled back up (the route's price without the swap's own impact), the same
   * guard the V2 rewards distribution uses. A reward token that is WETH needs no swap. A route
   * that cannot be quoted returns { error }, and the distribution is not sent.
   */
  // How many times a v4 distribution the route is too thin for is halved before it waits
  const V4_PARTIAL_HALVINGS = 6;

  async function quoteV4Rewards(token, pendingEth) {
    const [rewardToken, weth, path] = await Promise.all([token.rewardToken(), token.weth(), token.rewardRouteV3()]);
    if (rewardToken.toLowerCase() === weth.toLowerCase()) return { expected: pendingEth, impactBps: 0n };
    if (!path || path === "0x") return { error: "no reward route" };
    try {
      const quoter = await hre.ethers.getContractAt("IQuoterV2", await token.v3Quoter(), signer);
      const quoteVia = async (amountIn) => (await quoter.quoteExactInput.staticCall(path, amountIn))[0];
      const expected = await quoteVia(pendingEth);
      const probeIn = pendingEth >= IMPACT_PROBE_DIVISOR ? pendingEth / IMPACT_PROBE_DIVISOR : 1n;
      const fair = (await quoteVia(probeIn)) * IMPACT_PROBE_DIVISOR;
      if (expected === 0n || fair === 0n) return { error: "the route returns nothing" };
      return { expected, impactBps: fair > expected ? ((fair - expected) * BPS) / fair : 0n };
    } catch (e) {
      return { error: short(e) };
    }
  }

  async function inspectV4(tokenAddr, entry) {
    const { hook } = await v4Contracts();

    const [marketing, rewards] = await Promise.all([
      hook.pendingMarketing(entry.poolId),
      hook.pendingRewards(entry.poolId),
    ]);
    if (marketing + rewards >= v4FlushMinWei) {
      await send("v4-flush", tokenAddr, () => hook.flush(entry.poolId), `${hre.ethers.formatEther(marketing + rewards)} ETH`);
    }

    // Only a rewards token holds ETH of its own to turn into the reward asset.
    if (entry.isRewards === undefined) {
      entry.isRewards = await codeHasSelector(provider, tokenAddr, "pendingRewardEth()");
    }
    if (!entry.isRewards) return;
    if (!entry.token) entry.token = await hre.ethers.getContractAt("RewardsTokenV4", tokenAddr, signer);
    const pendingEth = await entry.token.pendingRewardEth();
    if (pendingEth < v4FlushMinWei) return;
    if (now() - entry.lastSentAt < rewardsIntervalMs) return;
    if ((await entry.token.totalShares()) < MIN_SHARES_FOR_DISTRIBUTION) return;

    // A route that stays dead or too thin is quoted again on every poll, but logged once per
    // pending amount
    const skip = (reason) => {
      if (entry.skippedPending !== pendingEth) {
        log(`v4-rewards ${tokenAddr} skipped: ${reason}, pending ${hre.ethers.formatEther(pendingEth)} ETH`);
      }
      entry.skippedPending = pendingEth;
    };
    let quote = await quoteV4Rewards(entry.token, pendingEth);
    if (quote.error) return skip(`route quote failed: ${quote.error}`);
    // A route too thin for everything that is pending can still take part of it: the amount is
    // halved until the impact fits, and the rest waits for the next interval. A token from before
    // distributeRewardsPartly has to wait for the route instead.
    let amount = pendingEth;
    if (quote.impactBps > rewardsMaxImpactBps) {
      if (entry.canSplit === undefined) {
        entry.canSplit = await codeHasSelector(provider, tokenAddr, "distributeRewardsPartly(uint256,uint256)");
      }
      for (let i = 0; entry.canSplit && i < V4_PARTIAL_HALVINGS && quote.impactBps > rewardsMaxImpactBps; i++) {
        amount /= 2n;
        if (amount < v4FlushMinWei) break;
        quote = await quoteV4Rewards(entry.token, amount);
        if (quote.error) return skip(`route quote failed: ${quote.error}`);
      }
      if (amount < v4FlushMinWei || quote.impactBps > rewardsMaxImpactBps) {
        return skip(`price impact ${pct(quote.impactBps)}% over ${pct(rewardsMaxImpactBps)}%`);
      }
    }
    const amountOutMin = (quote.expected * (BPS - rewardsSlippageBps)) / BPS;
    const partly = amount < pendingEth;
    const sent = await send(
      "v4-rewards",
      tokenAddr,
      () =>
        partly
          ? entry.token.distributeRewardsPartly(amount, amountOutMin)
          : entry.token.distributeRewards(amountOutMin),
      `${hre.ethers.formatEther(amount)}${partly ? ` of ${hre.ethers.formatEther(pendingEth)}` : ""} ETH, min out ${amountOutMin}`
    );
    if (sent) {
      entry.lastSentAt = now();
      entry.skippedPending = undefined;
    }
  }

  async function inspectV4Platform() {
    const { hook } = await v4Contracts();
    const pendingPlatform = await hook.pendingPlatform();
    if (pendingPlatform < v4FlushMinWei) return;
    await send(
      "v4-flush-platform",
      v4HookAddress,
      () => hook.flushPlatform(),
      `${hre.ethers.formatEther(pendingPlatform)} ETH to the Treasury`
    );
  }

  async function poll() {
    await reconcilePending();
    const total = Number(await factory.allPresalesLength());
    for (let start = 0; start < total; start += PAGE) {
      const page = await factory.getPresales(start, PAGE);
      for (const addr of page) {
        if (done.has(addr)) continue;
        try {
          await inspect(addr);
        } catch (e) {
          log(`read ${addr} failed: ${short(e)}`);
        }
      }
    }
    for (const [tokenAddr, r] of rewardsTokens) {
      try {
        await inspectRewards(tokenAddr, r);
      } catch (e) {
        log(`read rewards ${tokenAddr} failed: ${short(e)}`);
      }
    }
    if (v4) {
      try {
        for (const [tokenAddr, entry] of v4.launched) {
          try {
            await inspectV4(tokenAddr, entry);
          } catch (e) {
            log(`read v4 ${tokenAddr} failed: ${short(e)}`);
          }
        }
        await inspectV4Platform();
      } catch (e) {
        log(`read v4 failed: ${short(e)}`);
      }
    }
  }

  return { poll, isKeeper, launchKeeper, quickLaunchOwner, isQuickLaunchOwner, canDistribute, factory, actions, pending, done, rewardsTokens, v4 };
}

/**
 * The verification watcher that runs in the keeper process (scripts/auto-verify.js): every token
 * the TokenFactory creates is verified on Sourcify, Blockscout is the secondary target. Returns
 * { watcher: null, reason } when AUTO_VERIFY=0 or when no verifier covers the network's chain
 * (the local hardhat chain, for instance), so the keeper never fails because of verification.
 * @param options { deployments, log, env?, ...createWatcher options }
 */
async function createVerificationWatcher(hre, options = {}) {
  const { deployments, log = () => {}, env = process.env, ...watcherOptions } = options;
  if (env.AUTO_VERIFY === "0") return { watcher: null, reason: "AUTO_VERIFY=0" };
  if (!deployments || !deployments.tokenFactory || !deployments.presaleFactory) {
    return { watcher: null, reason: "deployments file has no tokenFactory / presaleFactory" };
  }
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const { sourcifyApplies } = require("./verify-contract");
  const { chainConfigFor } = require("./verify-standard-json");
  const s = sourcifyApplies(chainId, { sourcify: env.SOURCIFY !== "0", sourcifyOptions: watcherOptions.sourcifyOptions || {} });
  if (!s.applies && !chainConfigFor(hre, chainId)) {
    return { watcher: null, reason: `no verifier for chainId ${chainId} (${s.reason})` };
  }
  const { createWatcher } = require("./auto-verify");
  const watcher = createWatcher(hre, {
    deployments,
    sourcify: env.SOURCIFY !== "0",
    log: (...a) => log(`verify ${a.join(" ")}`),
    ...watcherOptions,
  });
  return { watcher, reason: null };
}

async function main() {
  const hre = require("hardhat");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.presaleFactory) throw new Error("deployments file has no presaleFactory");

  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const provider = hre.ethers.provider;
  let signer;
  if (process.env.KEEPER_KEY) {
    signer = new hre.ethers.Wallet(process.env.KEEPER_KEY, provider);
  } else {
    const signers = await hre.ethers.getSigners();
    if (signers.length === 0) throw new Error("set KEEPER_KEY (the keeper wallet's private key)");
    signer = signers[0];
    log(`KEEPER_KEY not set, using the first configured signer ${signer.address}`);
  }

  const pollSeconds = Number(process.env.POLL_SECONDS || 15);
  const keeper = await createKeeper(hre, {
    factoryAddress: d.presaleFactory,
    quickLaunchAddress: d.quickLaunch,
    v4LauncherAddress: d.v4Launcher,
    v4HookAddress: d.v4Hook,
    signer,
    log,
    retrySeconds: Number(process.env.RETRY_SECONDS || 60),
    rewardsIntervalSeconds: Number(process.env.REWARDS_INTERVAL_SECONDS || REWARDS_INTERVAL_SECONDS),
    rewardsMinBps: process.env.REWARDS_MIN_BPS ? Number(process.env.REWARDS_MIN_BPS) : undefined,
    rewardsMaxImpactBps: process.env.REWARDS_MAX_IMPACT_BPS ? Number(process.env.REWARDS_MAX_IMPACT_BPS) : undefined,
    rewardsSlippageBps: process.env.REWARDS_SLIPPAGE_BPS ? Number(process.env.REWARDS_SLIPPAGE_BPS) : undefined,
  });
  log(`keeper ${signer.address} on ${network}, factory ${d.presaleFactory}, balance ${hre.ethers.formatEther(await provider.getBalance(signer.address))} ETH`);
  if (!keeper.isKeeper) {
    log(`warning: this wallet is not the factory's launchKeeper (${keeper.launchKeeper}); scheduled launches of normal sales are skipped, quick sales and token delivery still run`);
  }
  if (keeper.quickLaunchOwner === null) log("warning: deployments file has no quickLaunch; quick reward distribution rights were not checked");

  const once = process.env.KEEPER_ONCE === "1";
  log(`polling every ${pollSeconds}s${once ? " (single poll)" : ""}`);

  // Verification runs in the same process (AUTO_VERIFY=0 turns it off); it never sends transactions.
  let watcher = null;
  try {
    const v = await createVerificationWatcher(hre, { deployments: d, log });
    watcher = v.watcher;
    if (!watcher) log(`verification off: ${v.reason}`);
  } catch (e) {
    log(`verification off: ${short(e)}`);
  }
  const onSignal = (sig) => {
    log(`${sig} received, saving verification state and exiting`);
    if (watcher) watcher.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const keeperLoop = async () => {
    for (;;) {
      try {
        await keeper.poll();
      } catch (e) {
        log(`poll failed: ${short(e)}`);
      }
      if (once) break;
      await sleep(pollSeconds * 1000);
    }
  };
  const verifyLoop = watcher
    ? watcher.run({ once: once || process.env.ONCE === "1" }).catch((e) => log(`verify loop failed: ${short(e)}`))
    : Promise.resolve();
  await Promise.all([keeperLoop(), verifyLoop]);
}

module.exports = { createKeeper, createVerificationWatcher, codeHasSelector };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
