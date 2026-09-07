const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const hre = require("hardhat");
const { ethers } = hre;
const { deployPlatform } = require("./helpers");
const { createKeeper, codeHasSelector } = require("../scripts/launch-keeper");
const { v3CandidatesFor, quoteV3Candidates, deadRewardRoutes, requireQuotableRoutes, isCallRevert } = require("../scripts/lib/reward-tokens");

const E = (n) => ethers.parseEther(String(n));
const QUICK_FEE = E(0.03);
const DEAD = "0x000000000000000000000000000000000000dEaD";

// The keeper bot: launches quick sales that are ready, launches scheduled normal sales on the
// owner's behalf, delivers tokens after a launch, distributes the rewards of launched quick
// Rewards tokens, and never sends the same action twice while a transaction is pending.
describe("Launch keeper", function () {
  const WAD = 10n ** 18n;

  /** The QuickParams struct: a Standard token unless overridden, 1 ETH, 30 minutes, no creator share. */
  function quickParams(name, symbol, overrides = {}) {
    return {
      name, symbol, hardCap: E(1), durationOption: 0, creatorSharePercent: 0,
      tokenType: 0, rewardToken: ethers.ZeroAddress, taxWallet: ethers.ZeroAddress,
      buyTaxBps: 0, sellTaxBps: 0, rewardsBuyBps: 0, rewardsSellBps: 0, logoURI: "", description: "",
      ...overrides,
    };
  }

  async function fundedWallets(env, n) {
    const wallets = [];
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await env.deployer.sendTransaction({ to: w.address, value: E(0.05) });
      wallets.push(w);
    }
    return wallets;
  }

  async function launchQuick(env, creator, name, symbol, overrides = {}) {
    const tx = await env.quickLaunch.connect(creator).launch(quickParams(name, symbol, overrides), { value: QUICK_FEE });
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return env.quickLaunch.interface.parseLog(l);
        } catch (e) {
          return null;
        }
      })
      .find((e) => e && e.name === "QuickLaunched");
    return {
      presale: await ethers.getContractAt("Presale", ev.args.presale),
      token: await ethers.getContractAt(overrides.tokenType === 2 ? "RewardsToken" : "StandardToken", ev.args.token),
    };
  }

  async function buy(env, token, buyer, ethIn) {
    const deadline = (await time.latest()) + 600;
    return env.router
      .connect(buyer)
      .swapExactETHForTokens(0, [env.weth.target, token.target], buyer.address, deadline, { value: ethIn });
  }

  async function createNormal(env, overrides) {
    const { tokenFactory, presaleFactory } = env;
    const idx = Number(await tokenFactory.allTokensLength());
    await tokenFactory.createStandardToken(`Norm${idx}`, `NRM${idx}`, E(1_000_000));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(idx));
    const now = await time.latest();
    const params = {
      token: token.target, presaleRate: E(1000), listingRate: E(800),
      softCap: E(2), hardCap: E(8), minContribution: E(0.5), maxContribution: E(4),
      startTime: now + 10, endTime: now + 1000, liquidityBps: 6000, liquidityAction: 1,
      lockDuration: 0, launchTime: 0, whitelistEnabled: false, ...overrides,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.createPresale(params, { value: E(0.1) });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n));
    return { presale, params, token };
  }

  // Timeline (seconds after the quick sale's creation): normal sales end at about +1000,
  // the quick sale ends at +1800, the scheduled launch time is +3000.
  async function keeperFixture() {
    const env = await deployPlatform();
    const wallets = await fundedWallets(env, 13);
    // 1) quick sale, soft cap met (13 x 0.02 of 0.25 ETH), ends at +30 min
    const quick = await launchQuick(env, env.carol, "Quick", "QCK");
    for (const w of wallets) await quick.presale.connect(w).contribute({ value: E(0.02) });
    // 2) normal sale with a launch time: the keeper may launch it from +3000 on
    const now = await time.latest();
    const scheduled = await createNormal(env, { launchTime: now + 3000 });
    await time.increaseTo(scheduled.params.startTime);
    await scheduled.presale.connect(env.alice).contribute({ value: E(3) });
    // 3) normal sale without a launch time: the keeper must leave it alone
    const unscheduled = await createNormal(env, {});
    await time.increaseTo(unscheduled.params.startTime);
    await unscheduled.presale.connect(env.bob).contribute({ value: E(3) });
    // 4) normal sale that the owner will finalize, with undelivered tokens
    const finished = await createNormal(env, {});
    await time.increaseTo(finished.params.startTime);
    await finished.presale.connect(env.alice).contribute({ value: E(2) });
    await finished.presale.connect(env.bob).contribute({ value: E(1) });
    // 5) cancelled sale
    const cancelled = await createNormal(env, {});
    await cancelled.presale.cancel();
    return { ...env, wallets, quick, scheduled, unscheduled, finished, cancelled };
  }

  /** A fresh keeper per test: loadFixture would otherwise share its action history between tests. */
  async function makeKeeper(env, signer, extra = {}) {
    const lines = [];
    const keeper = await createKeeper(hre, {
      factoryAddress: env.presaleFactory.target,
      signer: signer || env.keeper,
      log: (l) => lines.push(l),
      retrySeconds: 60,
      ...extra,
    });
    return { keeper, lines };
  }

  it("is bound to the factory's keeper wallet", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper } = await makeKeeper(env);
    expect(keeper.isKeeper).to.equal(true);
    expect(keeper.launchKeeper).to.equal(await env.presaleFactory.launchKeeper());
    const { keeper: other } = await makeKeeper(env, env.dave);
    expect(other.isKeeper).to.equal(false);
  });

  it("warns at start when the wallet may not send quick reward distributions (neither launch keeper nor QuickLaunch owner)", async function () {
    const env = await loadFixture(keeperFixture);
    const quickLaunchAddress = env.quickLaunch.target;
    const launchKeeper = await env.presaleFactory.launchKeeper();
    const owner = await env.quickLaunch.owner();
    expect(owner).to.equal(env.deployer.address);
    // A stranger: one warning line, naming both wallets that may distribute
    const { keeper: stranger, lines } = await makeKeeper(env, env.dave, { quickLaunchAddress });
    expect(stranger.canDistribute).to.equal(false);
    expect(stranger.isQuickLaunchOwner).to.equal(false);
    expect(stranger.quickLaunchOwner).to.equal(owner);
    expect(lines).to.deep.equal([
      `warning: quick reward distributions will fail: this wallet is not the launch keeper (${launchKeeper}) or the QuickLaunch owner (${owner})`,
    ]);
    // The launch keeper and the QuickLaunch owner: no warning
    const { keeper, lines: keeperLines } = await makeKeeper(env, env.keeper, { quickLaunchAddress });
    expect(keeper.canDistribute).to.equal(true);
    expect(keeperLines).to.deep.equal([]);
    const { keeper: asOwner, lines: ownerLines } = await makeKeeper(env, env.deployer, { quickLaunchAddress });
    expect(asOwner.canDistribute).to.equal(true);
    expect(asOwner.isQuickLaunchOwner).to.equal(true);
    expect(ownerLines).to.deep.equal([]);
    // Without a QuickLaunch address nothing is checked and nothing is logged
    const { keeper: unchecked, lines: uncheckedLines } = await makeKeeper(env, env.dave);
    expect(unchecked.quickLaunchOwner).to.equal(null);
    expect(uncheckedLines).to.deep.equal([]);
  });

  it("does nothing while no sale is ready and drops cancelled sales", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper, lines } = await makeKeeper(env);
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
    expect(lines).to.deep.equal([]);
    expect([...keeper.done]).to.deep.equal([env.cancelled.presale.target]);
  });

  it("launches a ready quick sale, reports the mined transaction and stops watching it", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper, lines } = await makeKeeper(env);
    const { presale, token } = env.quick;
    await time.increaseTo((await presale.getParams()).endTime + 1n);

    await keeper.poll();
    expect(keeper.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["finalize", presale.target]]);
    expect(await presale.status()).to.equal(5); // Finalized (automine)
    expect(lines[0]).to.match(/^finalize 0x[0-9a-fA-F]{40} sent 0x/);
    // 13 participants were paid inline by the launch
    expect(await token.balanceOf(env.wallets[12].address)).to.equal(E(0.02) * 500_000_000n);

    await keeper.poll();
    expect(lines[1]).to.match(/^finalize .* mined, success, gas \d+$/);
    expect(keeper.actions.length).to.equal(1); // nothing left to distribute
    await keeper.poll();
    expect(keeper.done.has(presale.target)).to.equal(true);
  });

  it("launches a scheduled normal sale only from its launch time on and leaves unscheduled sales alone", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper } = await makeKeeper(env);
    const { scheduled, unscheduled } = env;
    await time.increaseTo(scheduled.params.endTime + 1);
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]); // ended with the soft cap met, launch time not reached

    await time.increaseTo(scheduled.params.launchTime);
    await keeper.poll();
    const forScheduled = keeper.actions.filter((a) => a.presale === scheduled.presale.target);
    expect(forScheduled.map((a) => a.kind)).to.deep.equal(["finalize"]);
    expect(await scheduled.presale.status()).to.equal(5);
    expect(keeper.actions.some((a) => a.presale === unscheduled.presale.target)).to.equal(false);
    expect(await unscheduled.presale.status()).to.equal(2); // Ended, waiting for its owner
  });

  it("skips scheduled launches when the wallet is not the factory's keeper, but still launches quick sales", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper: other } = await makeKeeper(env, env.dave);
    await time.increaseTo(env.scheduled.params.launchTime); // the quick sale has ended by now as well
    await other.poll();
    expect(other.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["finalize", env.quick.presale.target]]);
    expect(await env.scheduled.presale.status()).to.equal(2); // still waiting
  });

  it("delivers the tokens of a finalized sale and then forgets it", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper, lines } = await makeKeeper(env);
    const { finished, alice, bob } = env;
    await time.increaseTo(finished.params.endTime + 1);
    await finished.presale.finalize(0, 0);
    expect(await finished.presale.distributionComplete()).to.equal(false);

    await keeper.poll();
    expect(keeper.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["distribute", finished.presale.target]]);
    expect(await finished.token.balanceOf(alice.address)).to.equal(E(2000));
    expect(await finished.token.balanceOf(bob.address)).to.equal(E(1000));
    await keeper.poll(); // reports the receipt
    expect(lines.some((l) => /^distribute .* mined, success/.test(l))).to.equal(true);
    await keeper.poll(); // sees the delivery complete
    expect(keeper.done.has(finished.presale.target)).to.equal(true);
    expect(keeper.actions.length).to.equal(1);
  });

  it("never re-sends an action while its transaction is pending", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper } = await makeKeeper(env);
    const { presale } = env.quick;
    await time.increaseTo((await presale.getParams()).endTime + 1n);
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await keeper.poll();
      await keeper.poll();
      await keeper.poll();
      expect(keeper.actions.length).to.equal(1);
      expect(keeper.pending.size).to.equal(1);
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    await keeper.poll();
    expect(keeper.pending.size).to.equal(0);
    expect(await presale.status()).to.equal(5);
  });

  it("logs a send that fails, backs off and retries after the wait", async function () {
    const env = await loadFixture(keeperFixture);
    let clock = Date.now();
    const { keeper, lines } = await makeKeeper(env, env.keeper, { now: () => clock });
    const { presale, token } = env.quick;
    // A pool skewed by borrowed burned tokens makes finalize revert with the price guard
    await ethers.provider.send("hardhat_impersonateAccount", [DEAD]);
    await ethers.provider.send("hardhat_setBalance", [DEAD, "0x" + E(1).toString(16)]);
    await token.connect(await ethers.getSigner(DEAD)).transfer(env.carol.address, E(1000));
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [DEAD]);
    await token.connect(env.carol).approve(env.router.target, E(1000));
    await env.router
      .connect(env.carol)
      .addLiquidityETH(token.target, E(1000), 0, 0, env.carol.address, (await time.latest()) + 600, { value: E(0.0001) });
    await time.increaseTo((await presale.getParams()).endTime + 1n);

    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
    expect(lines.length).to.equal(1);
    expect(lines[0]).to.match(/^finalize .* not sent: .*pool price off listing.*\(retry in 60s\)$/);
    await keeper.poll(); // inside the back-off window: no new attempt
    expect(lines.length).to.equal(1);
    clock += 61_000;
    await keeper.poll();
    expect(lines.length).to.equal(2);
    expect(await presale.status()).to.equal(2); // still Ended, launchable once the pool is fixed
  });

  // ------------------------------------------------------------ rewards distribution

  /** The (token, amountOutMin) a keeper transaction passed to QuickLaunch.distributeRewards. */
  async function sentDistribution(env, hash) {
    const tx = await ethers.provider.getTransaction(hash);
    const parsed = env.quickLaunch.interface.parseTransaction({ data: tx.data });
    expect(parsed.name).to.equal("distributeRewards");
    return { token: parsed.args.token, amountOutMin: parsed.args.amountOutMin };
  }

  /** The RewardsDistributed event a mined transaction emitted on `token`. */
  async function findRewardsDistributed(token, hash) {
    const receipt = await ethers.provider.getTransactionReceipt(hash);
    const ev = receipt.logs
      .map((l) => {
        try {
          return token.interface.parseLog(l);
        } catch (e) {
          return null;
        }
      })
      .find((e) => e && e.name === "RewardsDistributed");
    expect(ev, "RewardsDistributed event").to.not.equal(undefined);
    return ev.args;
  }

  /** Fills a quick sale with 50 wallets (soft cap met, one contribution short of the hard cap) and delivers it. */
  async function fillAndDeliver(env, presale) {
    const wallets = await fundedWallets(env, 50);
    for (const w of wallets.slice(0, 49)) await presale.connect(w).contribute({ value: E(0.02) });
    await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
    await presale.distribute(100);
    expect(await presale.distributionComplete()).to.equal(true);
    return wallets;
  }

  // A quick Rewards sale (WETH rewards 3%/3%, marketing 1%/1%) filled by 50 wallets and delivered,
  // plus a live one that never launches during the test.
  async function rewardsFixture() {
    const env = await deployPlatform();
    const rewards = { tokenType: 2, rewardToken: env.weth.target, rewardsBuyBps: 300, rewardsSellBps: 300, buyTaxBps: 100, sellTaxBps: 100 };
    const launched = await launchQuick(env, env.carol, "Yield", "YLD", rewards);
    const live = await launchQuick(env, env.dave, "Later", "LTR", rewards);
    const wallets = await fillAndDeliver(env, launched.presale);
    return { ...env, wallets, launched, live };
  }

  // A quick Rewards sale paying in a mock USDG (6 decimals) that trades against WETH in a deep
  // pool, delivered, with a buy that leaves rewards above the threshold. That pool is the second
  // hop of the reward route (token -> WETH -> USDG); the tests drain it to see the keeper hold back.
  async function usdgRewardsFixture() {
    const env = await deployPlatform();
    const { deployer, dexFactory, router, weth, quickLaunch } = env;
    const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 10_000_000n * 10n ** 6n]);
    await dexFactory.createPair(usdg.target, weth.target);
    await usdg.approve(router.target, 1_000_000n * 10n ** 6n);
    await router.addLiquidityETH(usdg.target, 1_000_000n * 10n ** 6n, 0, 0, deployer.address, (await time.latest()) + 600, { value: E(500) });
    await quickLaunch.setRewardTokenAllowed(usdg.target, true);
    const rewards = { tokenType: 2, rewardToken: usdg.target, rewardsBuyBps: 300, rewardsSellBps: 300, buyTaxBps: 100, sellTaxBps: 100 };
    const launched = await launchQuick(env, env.carol, "Dollar Yield", "DYL", rewards);
    const wallets = await fillAndDeliver(env, launched.presale);
    await buy(env, launched.token, env.bob, E(0.2));
    expect(await launched.token.pendingRewardsTokens()).to.be.gte(await launched.token.swapThreshold());
    const pool = await ethers.getContractAt("MockPair", await dexFactory.getPair(usdg.target, weth.target));
    return { ...env, wallets, usdg, launched, pool };
  }

  /**
   * Leaves only `keepWeth` and `keepUsdg` in the WETH/USDG pool. Only the router may move a
   * pool's tokens, so it is impersonated; the pool syncs its reserves on every move.
   */
  async function drainPool(env, keepWeth, keepUsdg) {
    const routerAddr = env.router.target;
    await ethers.provider.send("hardhat_impersonateAccount", [routerAddr]);
    await ethers.provider.send("hardhat_setBalance", [routerAddr, "0x" + E(1).toString(16)]);
    const asRouter = env.pool.connect(await ethers.getSigner(routerAddr));
    const wethHeld = await env.weth.balanceOf(env.pool.target);
    const usdgHeld = await env.usdg.balanceOf(env.pool.target);
    if (wethHeld > keepWeth) await asRouter.transferOut(env.weth.target, env.deployer.address, wethHeld - keepWeth);
    if (usdgHeld > keepUsdg) await asRouter.transferOut(env.usdg.target, env.deployer.address, usdgHeld - keepUsdg);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [routerAddr]);
  }

  it("distributes the rewards of a launched quick Rewards token once the threshold is met, then waits out the interval", async function () {
    const env = await loadFixture(rewardsFixture);
    let clock = Date.now();
    const { keeper, lines } = await makeKeeper(env, env.keeper, { now: () => clock, rewardsIntervalSeconds: 300 });
    const { token, presale } = env.launched;

    // Nothing pending yet: the token is known and watched, no action
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
    const watched = keeper.rewardsTokens.get(token.target);
    expect(watched.presale).to.equal(presale.target);
    expect(watched.launched).to.equal(true);
    expect(watched.quickLaunch.target).to.equal(env.quickLaunch.target);
    // The live sale's token is watched too but not launched
    expect(keeper.rewardsTokens.get(env.live.token.target).launched).to.equal(false);
    expect(keeper.done.has(presale.target)).to.equal(true);

    // A buy pushes the pending rewards past the swap threshold (0.1% of the supply)
    await buy(env, token, env.bob, E(0.2));
    const pendingBefore = await token.pendingRewardsTokens();
    expect(pendingBefore).to.be.gte(await token.swapThreshold());
    await keeper.poll();
    expect(keeper.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["rewards", token.target]]);
    expect(lines[0]).to.match(
      /^rewards 0x[0-9a-fA-F]{40} sent 0x[0-9a-fA-F]{64} pending [\d.]+ tokens, quoted [\d.]+ WETH, min [\d.]+ WETH$/
    );
    // The call carried a real floor (the quote minus 3%) and the swap cleared it
    const { amountOutMin } = await sentDistribution(env, keeper.actions[0].hash);
    expect(amountOutMin).to.be.gt(0);
    const distributed = await findRewardsDistributed(token, keeper.actions[0].hash);
    expect(distributed.tokensSwapped).to.equal(pendingBefore);
    expect(distributed.rewardsReceived).to.be.gte(amountOutMin);
    expect(await token.pendingRewardsTokens()).to.equal(0);
    expect(await token.totalRewardsDistributed()).to.equal(distributed.rewardsReceived);
    expect(await token.withdrawableRewardOf(env.wallets[0].address)).to.be.gt(0);
    const claimable = await token.withdrawableRewardOf(env.wallets[0].address);
    await token.connect(env.wallets[0]).claimRewards();
    expect(await env.weth.balanceOf(env.wallets[0].address)).to.equal(claimable);

    // Another buy right away: above the threshold again, but inside the interval
    await buy(env, token, env.bob, E(0.2));
    expect(await token.pendingRewardsTokens()).to.be.gte(await token.swapThreshold());
    await keeper.poll(); // reports the mined receipt, sends nothing new
    expect(lines[1]).to.match(/^rewards .* mined, success, gas \d+$/);
    await keeper.poll();
    expect(keeper.actions.length).to.equal(1);
    clock += 301_000;
    await keeper.poll();
    expect(keeper.actions.length).to.equal(2);
    expect(await token.pendingRewardsTokens()).to.equal(0);
  });

  it("cannot distribute from a stranger wallet (QuickLaunch answers not keeper), the QuickLaunch owner can", async function () {
    const env = await loadFixture(rewardsFixture);
    const { token } = env.launched;
    await buy(env, token, env.bob, E(0.2));
    const pendingBefore = await token.pendingRewardsTokens();
    expect(pendingBefore).to.be.gte(await token.swapThreshold());

    // dave is neither the launch keeper nor the QuickLaunch owner: the send is refused on chain
    // (the caller sets the swap floor, so the call is not open) and the keeper backs off
    let clock = Date.now();
    const { keeper: stranger, lines } = await makeKeeper(env, env.dave, { quickLaunchAddress: env.quickLaunch.target, now: () => clock });
    await stranger.poll();
    expect(stranger.actions).to.deep.equal([]);
    expect(lines.length).to.equal(2);
    expect(lines[0]).to.match(/^warning: quick reward distributions will fail: /);
    expect(lines[1]).to.match(/^rewards 0x[0-9a-fA-F]{40} not sent: .*not keeper.*\(retry in 60s\)$/);
    expect(await token.pendingRewardsTokens()).to.equal(pendingBefore);
    await stranger.poll(); // inside the back-off window: no new attempt
    expect(lines.length).to.equal(2);
    clock += 61_000;
    await stranger.poll();
    expect(lines.length).to.equal(3);
    expect(lines[2]).to.match(/not keeper/);

    // The QuickLaunch owner (the deployer) distributes with the same quote and floor
    const { keeper: asOwner, lines: ownerLines } = await makeKeeper(env, env.deployer, { quickLaunchAddress: env.quickLaunch.target });
    await asOwner.poll();
    expect(asOwner.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["rewards", token.target]]);
    expect(ownerLines[0]).to.match(/^rewards .* sent .* quoted [\d.]+ WETH, min [\d.]+ WETH$/);
    const { amountOutMin } = await sentDistribution(env, asOwner.actions[0].hash);
    expect(amountOutMin).to.be.gt(0);
    const distributed = await findRewardsDistributed(token, asOwner.actions[0].hash);
    expect(distributed.tokensSwapped).to.equal(pendingBefore);
    expect(await token.pendingRewardsTokens()).to.equal(0);
  });

  it("leaves the rewards alone below the threshold, unless REWARDS_MIN_BPS lowers it", async function () {
    const env = await loadFixture(rewardsFixture);
    const { keeper } = await makeKeeper(env);
    const { token } = env.launched;
    await buy(env, token, env.bob, E(0.02)); // about 0.03% of the supply in rewards
    const pending = await token.pendingRewardsTokens();
    expect(pending).to.be.gt(0);
    expect(pending).to.be.lt(await token.swapThreshold());
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);

    // 1 bps of the supply is enough for a keeper configured that way
    const { keeper: eager } = await makeKeeper(env, env.keeper, { rewardsMinBps: 1 });
    expect(pending).to.be.gte(((await token.totalSupply()) * 1n) / 10_000n);
    await eager.poll();
    expect(eager.actions.map((a) => a.kind)).to.deep.equal(["rewards"]);
    expect(await token.pendingRewardsTokens()).to.equal(0);
  });

  it("never re-sends a rewards distribution while its transaction is pending", async function () {
    const env = await loadFixture(rewardsFixture);
    const { keeper } = await makeKeeper(env, env.keeper, { rewardsIntervalSeconds: 0 });
    const { token } = env.launched;
    await buy(env, token, env.bob, E(0.2));
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await keeper.poll();
      await keeper.poll();
      expect(keeper.actions.length).to.equal(1);
      expect(keeper.pending.has(`${token.target}:rewards`)).to.equal(true);
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    await keeper.poll();
    expect(keeper.pending.size).to.equal(0);
    expect(await token.pendingRewardsTokens()).to.equal(0);
    // Nothing pending: no further send even with a zero interval
    await keeper.poll();
    expect(keeper.actions.length).to.equal(1);
    expect(await token.totalShares()).to.be.gte(WAD);
  });

  it("distributes through a two-hop route into a 6-decimal reward token with a floor from the quote", async function () {
    const env = await loadFixture(usdgRewardsFixture);
    const { keeper, lines } = await makeKeeper(env);
    const { token } = env.launched;
    const pendingBefore = await token.pendingRewardsTokens();
    await keeper.poll();
    expect(keeper.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["rewards", token.target]]);
    expect(lines[0]).to.match(/^rewards .* sent .* pending [\d.]+ tokens, quoted [\d.]+ USDG, min [\d.]+ USDG$/);
    const { amountOutMin } = await sentDistribution(env, keeper.actions[0].hash);
    expect(amountOutMin).to.be.gt(0);
    const distributed = await findRewardsDistributed(token, keeper.actions[0].hash);
    expect(distributed.tokensSwapped).to.equal(pendingBefore);
    expect(distributed.rewardsReceived).to.be.gte(amountOutMin);
    expect(await token.pendingRewardsTokens()).to.equal(0);
    expect(await env.usdg.balanceOf(token.target)).to.equal(distributed.rewardsReceived);
  });

  it("skips a distribution whose route is down to dust, logs it once, and sends it with a wide enough impact limit", async function () {
    const env = await loadFixture(usdgRewardsFixture);
    const { token } = env.launched;
    const pendingBefore = await token.pendingRewardsTokens();
    // The WETH/USDG pool keeps 0.001 ETH and 2 USDG: the pending rewards would take most of it
    await drainPool(env, E(0.001), 2n * 10n ** 6n);
    expect(await env.quickLaunch.isRewardRouteLive(env.usdg.target)).to.equal(false);

    const { keeper, lines } = await makeKeeper(env);
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
    expect(lines.length).to.equal(1);
    expect(lines[0]).to.match(/^rewards 0x[0-9a-fA-F]{40} skipped: price impact \d+(\.\d)?% over 20%, pending [\d.]+ tokens$/);
    const impact = Number(lines[0].match(/price impact ([\d.]+)%/)[1]);
    expect(impact).to.be.gt(20);
    // The same pending amount on the next polls: no repeat of the line, still no transaction
    await keeper.poll();
    await keeper.poll();
    expect(lines.length).to.equal(1);
    expect(keeper.actions).to.deep.equal([]);
    expect(await token.pendingRewardsTokens()).to.equal(pendingBefore);
    // More rewards accumulate: the new pending amount is logged once more
    await buy(env, token, env.bob, E(0.05));
    await keeper.poll();
    expect(lines.length).to.equal(2);
    expect(lines[1]).to.match(/^rewards .* skipped: price impact /);

    // A keeper that accepts any impact sends it with the floor taken from the same quote
    const { keeper: lenient, lines: lenientLines } = await makeKeeper(env, env.keeper, { rewardsMaxImpactBps: 10_000 });
    await lenient.poll();
    expect(lenient.actions.map((a) => a.kind)).to.deep.equal(["rewards"]);
    expect(lenientLines[0]).to.match(/^rewards .* sent .* quoted [\d.]+ USDG, min [\d.]+ USDG$/);
    const { amountOutMin } = await sentDistribution(env, lenient.actions[0].hash);
    expect(amountOutMin).to.be.gt(0);
    const distributed = await findRewardsDistributed(token, lenient.actions[0].hash);
    expect(distributed.rewardsReceived).to.be.gte(amountOutMin);
    expect(await token.pendingRewardsTokens()).to.equal(0);
  });

  it("skips a distribution whose route cannot be quoted at all and never crashes the poll", async function () {
    const env = await loadFixture(usdgRewardsFixture);
    const { token } = env.launched;
    const pendingBefore = await token.pendingRewardsTokens();
    // An emptied pool: the router refuses to quote it
    await drainPool(env, 0n, 0n);
    await expect(env.router.getAmountsOut(pendingBefore, [...(await token.rewardPath())])).to.be.revertedWith("router: no liquidity");

    const { keeper, lines } = await makeKeeper(env);
    await keeper.poll();
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
    expect(lines).to.have.lengthOf(1);
    expect(lines[0]).to.match(/^rewards 0x[0-9a-fA-F]{40} skipped: route quote failed: .*no liquidity.*, pending [\d.]+ tokens$/);
    expect(await token.pendingRewardsTokens()).to.equal(pendingBefore);
    // Even a keeper without an impact limit never sends on a route it cannot quote
    const { keeper: lenient } = await makeKeeper(env, env.keeper, { rewardsMaxImpactBps: 10_000 });
    await lenient.poll();
    expect(lenient.actions).to.deep.equal([]);
  });

  // ------------------------------------------------------------ V3 stock rewards

  // A quick Rewards sale paying a mock tokenized stock (TSLA, 18 decimals) that trades against
  // WETH in a deep mock Uniswap V3 pool at 0.3%: QuickLaunch stores the packed path WETH -> TSLA,
  // the launch applies it to the token, the sale is delivered and a buy leaves rewards above the
  // threshold. The keeper quotes the two legs (V2 for token -> WETH, QuoterV2 for the path).
  async function v3RewardsFixture() {
    const env = await deployPlatform();
    const { deployer, v3Factory, weth, quickLaunch } = env;
    const tsla = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E(1_000_000)]);
    await v3Factory.createPool(weth.target, tsla.target, 3000);
    const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, tsla.target, 3000));
    // 50 WETH against 345 TSLA (about 6.9 TSLA per ETH, the mainnet rate)
    await weth.deposit({ value: E(50) });
    await weth.transfer(pool.target, E(50));
    await tsla.transfer(pool.target, E(345));
    await pool.sync();
    const path = ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, tsla.target]);
    await quickLaunch.setRewardTokenAllowed(tsla.target, true);
    await quickLaunch.setRewardRouteV3(tsla.target, path);
    expect(await quickLaunch.rewardRouteV3Of(tsla.target)).to.equal(path);
    expect(await quickLaunch.isRewardRouteLive(tsla.target)).to.equal(true);
    const rewards = { tokenType: 2, rewardToken: tsla.target, rewardsBuyBps: 300, rewardsSellBps: 300, buyTaxBps: 100, sellTaxBps: 100 };
    const launched = await launchQuick(env, env.carol, "Stock Yield", "SYLD", rewards);
    expect(await launched.token.rewardRouteV3()).to.equal(path);
    expect(await launched.token.v3Quoter()).to.equal(env.v3Quoter.target);
    const wallets = await fillAndDeliver(env, launched.presale);
    await buy(env, launched.token, env.bob, E(0.2));
    expect(await launched.token.pendingRewardsTokens()).to.be.gte(await launched.token.swapThreshold());
    return { ...env, wallets, tsla, launched, pool, path, deployer };
  }

  it("distributes a V3 stock reward with a floor from the two-leg quote and the token receives the stock", async function () {
    const env = await loadFixture(v3RewardsFixture);
    const { keeper, lines } = await makeKeeper(env);
    const { token } = env.launched;
    const pendingBefore = await token.pendingRewardsTokens();
    // The keeper's floor is the two-leg quote minus 3%: leg 1 on the V2 router, leg 2 on the quoter
    const wethOut = (await env.router.getAmountsOut(pendingBefore, [token.target, env.weth.target]))[1];
    const [quoted] = await env.v3Quoter.quoteExactInput.staticCall(env.path, wethOut);
    expect(quoted).to.be.gt(0);

    await keeper.poll();
    expect(keeper.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["rewards", token.target]]);
    expect(lines[0]).to.match(/^rewards .* sent .* pending [\d.]+ tokens, quoted [\d.]+ TSLA, min [\d.]+ TSLA$/);
    const { amountOutMin } = await sentDistribution(env, keeper.actions[0].hash);
    expect(amountOutMin).to.equal((quoted * 9700n) / 10_000n);
    expect(amountOutMin).to.be.gt(0);
    const distributed = await findRewardsDistributed(token, keeper.actions[0].hash);
    expect(distributed.tokensSwapped).to.equal(pendingBefore);
    expect(distributed.rewardsReceived).to.equal(quoted);
    expect(distributed.rewardsReceived).to.be.gte(amountOutMin);
    expect(await token.pendingRewardsTokens()).to.equal(0);
    expect(await env.tsla.balanceOf(token.target)).to.equal(distributed.rewardsReceived);
    expect(await env.weth.balanceOf(token.target)).to.equal(0);
    // A holder claims the stock
    const claimable = await token.withdrawableRewardOf(env.wallets[0].address);
    expect(claimable).to.be.gt(0);
    await token.connect(env.wallets[0]).claimRewards();
    expect(await env.tsla.balanceOf(env.wallets[0].address)).to.equal(claimable);
  });

  it("skips a V3 distribution whose pool is drained to dust with the impact line, sends it with a wide enough limit", async function () {
    const env = await loadFixture(v3RewardsFixture);
    const { token } = env.launched;
    const pendingBefore = await token.pendingRewardsTokens();
    // 99.99% of both sides leave the pool: 0.005 WETH and 0.0345 TSLA remain
    await env.pool.withdraw(env.deployer.address, 9999);
    expect(await env.weth.balanceOf(env.pool.target)).to.equal(E(0.005));
    expect(await env.quickLaunch.isRewardRouteLive(env.tsla.target)).to.equal(false);
    expect(await env.quickLaunch.isTokenRouteLive(token.target)).to.equal(false);

    const { keeper, lines } = await makeKeeper(env);
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
    expect(lines.length).to.equal(1);
    expect(lines[0]).to.match(/^rewards 0x[0-9a-fA-F]{40} skipped: price impact \d+(\.\d)?% over 20%, pending [\d.]+ tokens$/);
    expect(Number(lines[0].match(/price impact ([\d.]+)%/)[1])).to.be.gt(20);
    await keeper.poll();
    expect(lines.length).to.equal(1);
    expect(await token.pendingRewardsTokens()).to.equal(pendingBefore);

    const { keeper: lenient, lines: lenientLines } = await makeKeeper(env, env.keeper, { rewardsMaxImpactBps: 10_000 });
    await lenient.poll();
    expect(lenient.actions.map((a) => a.kind)).to.deep.equal(["rewards"]);
    expect(lenientLines[0]).to.match(/^rewards .* sent .* quoted [\d.]+ TSLA, min [\d.]+ TSLA$/);
    const { amountOutMin } = await sentDistribution(env, lenient.actions[0].hash);
    expect(amountOutMin).to.be.gt(0);
    const distributed = await findRewardsDistributed(token, lenient.actions[0].hash);
    expect(distributed.rewardsReceived).to.be.gte(amountOutMin);
    expect(await token.pendingRewardsTokens()).to.equal(0);
  });

  it("skips a V3 distribution whose pool is emptied with a quote failure line and never sends", async function () {
    const env = await loadFixture(v3RewardsFixture);
    const { token } = env.launched;
    const pendingBefore = await token.pendingRewardsTokens();
    await env.pool.withdraw(env.deployer.address, 10_000);
    expect(await env.weth.balanceOf(env.pool.target)).to.equal(0);
    await expect(env.v3Quoter.quoteExactInput.staticCall(env.path, E(0.001))).to.be.revertedWith("quoter: insufficient liquidity");

    const { keeper, lines } = await makeKeeper(env);
    await keeper.poll();
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
    expect(lines).to.have.lengthOf(1);
    expect(lines[0]).to.match(/^rewards 0x[0-9a-fA-F]{40} skipped: route quote failed: .*insufficient liquidity.*, pending [\d.]+ tokens$/);
    expect(await token.pendingRewardsTokens()).to.equal(pendingBefore);
    const { keeper: lenient } = await makeKeeper(env, env.keeper, { rewardsMaxImpactBps: 10_000 });
    await lenient.poll();
    expect(lenient.actions).to.deep.equal([]);
  });

  it("reads a selector from the code once: RewardsToken carries rewardRouteV3, a plain ERC20 and an EOA do not", async function () {
    const env = await loadFixture(rewardsFixture);
    const { token } = env.launched;
    const plain = await ethers.deployContract("MockERC20", ["Plain", "PLN", 18, E(1)]);
    expect(await codeHasSelector(ethers.provider, token.target, "rewardRouteV3()")).to.equal(true);
    expect(await codeHasSelector(ethers.provider, token.target, "rewardPath()")).to.equal(true);
    expect(await codeHasSelector(ethers.provider, plain.target, "rewardRouteV3()")).to.equal(false);
    expect(await codeHasSelector(ethers.provider, plain.target, "balanceOf(address)")).to.equal(true);
    expect(await codeHasSelector(ethers.provider, env.dave.address, "rewardRouteV3()")).to.equal(false);
    expect(await codeHasSelector(ethers.provider, env.quickLaunch.target, "quickTokenOf(address)")).to.equal(true);
    expect(await codeHasSelector(ethers.provider, env.presaleFactory.target, "quickTokenOf(address)")).to.equal(false);
    // A caller of the function carries the selector as well (QuickLaunch calls rewardRouteV3 on
    // its tokens): the check answers for the code that is called, never for the caller
    expect(await codeHasSelector(ethers.provider, env.quickLaunch.target, "rewardRouteV3()")).to.equal(true);
    expect(await codeHasSelector(ethers.provider, env.presaleFactory.target, "rewardRouteV3()")).to.equal(false);
  });

  it("quotes and distributes a token from the pre-V3 deployer generation (no rewardRouteV3 getter) on its V2 route", async function () {
    const env = await loadFixture(rewardsFixture);
    const { token } = env.launched;
    await buy(env, token, env.bob, E(0.2));
    const pendingBefore = await token.pendingRewardsTokens();
    expect(pendingBefore).to.be.gte(await token.swapThreshold());
    // The fixture cannot deploy the earlier RewardsToken (its source is gone), so the earlier
    // generation is emulated at the point the keeper looks: the token's code as the provider
    // reports it has the rewardRouteV3 selector blanked out. Every other read and the
    // distribution itself run against the real token, whose V3 path is empty (WETH rewards).
    const selector = token.interface.getFunction("rewardRouteV3").selector.slice(2).toLowerCase();
    const provider = ethers.provider;
    const originalGetCode = provider.getCode;
    provider.getCode = async function (address, ...rest) {
      const code = await originalGetCode.call(this, address, ...rest);
      if (String(address).toLowerCase() !== token.target.toLowerCase()) return code;
      expect(code.toLowerCase()).to.include(selector);
      return code.toLowerCase().replace(selector, "00000000");
    };
    let codeReads = 0;
    provider.getCode = async function (address, ...rest) {
      const code = await originalGetCode.call(this, address, ...rest);
      if (String(address).toLowerCase() !== token.target.toLowerCase()) return code;
      codeReads++;
      expect(code.toLowerCase()).to.include(selector);
      return code.toLowerCase().replace(selector, "00000000");
    };
    // The floor must come from the V2 route quote (token -> WETH), the way the old token swaps
    const expected = (await env.router.getAmountsOut(pendingBefore, [...(await token.rewardPath())]))[1];
    try {
      const { keeper, lines } = await makeKeeper(env, env.keeper, { rewardsIntervalSeconds: 0 });
      await keeper.poll();
      const watched = keeper.rewardsTokens.get(token.target);
      expect(watched.hasRewardRouteV3).to.equal(false);
      expect(codeReads).to.equal(1);
      expect(keeper.actions.map((a) => [a.kind, a.presale])).to.deep.equal([["rewards", token.target]]);
      expect(lines[0]).to.match(/^rewards .* sent .* quoted [\d.]+ WETH, min [\d.]+ WETH$/);
      const { amountOutMin } = await sentDistribution(env, keeper.actions[0].hash);
      expect(amountOutMin).to.equal((expected * 9700n) / 10_000n);
      const distributed = await findRewardsDistributed(token, keeper.actions[0].hash);
      expect(distributed.tokensSwapped).to.equal(pendingBefore);
      expect(distributed.rewardsReceived).to.be.gte(amountOutMin);
      // The next distribution neither reads the code again nor calls the getter the token lacks
      let getterCalls = 0;
      watched.token.rewardRouteV3 = async () => {
        getterCalls++;
        throw new Error("rewardRouteV3 called on a token without it");
      };
      await buy(env, token, env.bob, E(0.2));
      await keeper.poll(); // reports the receipt
      await keeper.poll();
      expect(keeper.actions.length).to.equal(2);
      expect(codeReads).to.equal(1);
      expect(getterCalls).to.equal(0);
      expect(await token.pendingRewardsTokens()).to.equal(0);
    } finally {
      provider.getCode = originalGetCode;
    }
  });

  it("serves a quick sale whose owner has no quickTokenOf, as an earlier QuickLaunch generation", async function () {
    const env = await loadFixture(rewardsFixture);
    const { tokenFactory, presaleFactory, alice } = env;
    // The factory takes quick sales only from its QuickLaunch; alice plays an earlier generation
    // here: no code at all, so no quickTokenOf selector, and the keeper must not ask her for one.
    await presaleFactory.setQuickLaunch(alice.address);
    const TOTAL_SUPPLY = E(1_000_000_000);
    const SALE_SUPPLY = TOTAL_SUPPLY / 2n;
    await tokenFactory.connect(alice).createStandardToken("Direct", "DRCT", TOTAL_SUPPLY);
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n));
    await token.connect(alice).approve(presaleFactory.target, ethers.MaxUint256);
    const start = (await time.latest()) + 60;
    const rate = (SALE_SUPPLY * E(1)) / E(1);
    const params = {
      token: token.target,
      presaleRate: rate,
      listingRate: rate,
      softCap: E(0.25),
      hardCap: E(1),
      minContribution: E(0.001),
      maxContribution: E(0.02),
      startTime: start,
      endTime: start + 3600,
      liquidityBps: 10000,
      liquidityAction: 1,
      lockDuration: 0,
      launchTime: start + 3600,
      whitelistEnabled: false,
    };
    const fee = await presaleFactory.quickCreationFee();
    const tx = await presaleFactory.connect(alice).createQuickPresale(params, alice.address, 0, { value: fee });
    const receipt = await tx.wait();
    const created = receipt.logs.map((l) => {
      try {
        return presaleFactory.interface.parseLog(l);
      } catch (e) {
        return null;
      }
    }).find((e) => e && e.name === "PresaleCreated");
    const presale = await ethers.getContractAt("Presale", created.args.presale);
    expect(await presale.saleOwner()).to.equal(alice.address);

    const wallets = await fundedWallets(env, 13);
    await time.increaseTo(start);
    for (const w of wallets) await presale.connect(w).contribute({ value: E(0.02) });
    await time.increaseTo(start + 3601);

    const { keeper, lines } = await makeKeeper(env);
    await keeper.poll();
    expect(lines.filter((l) => /failed/.test(l))).to.deep.equal([]);
    expect(keeper.actions.map((a) => [a.kind, a.presale])).to.include.deep.members([["finalize", presale.target]]);
    expect(await presale.status()).to.equal(5); // Finalized
    expect(keeper.rewardsTokens.has(token.target)).to.equal(false);
  });

  it("logs and survives a sale that cannot be read", async function () {
    const env = await loadFixture(keeperFixture);
    const { keeper, lines } = await makeKeeper(env);
    const original = keeper.factory.getPresales;
    keeper.factory.getPresales = async () => [ethers.ZeroAddress]; // not a Presale
    try {
      await keeper.poll();
    } finally {
      keeper.factory.getPresales = original;
    }
    expect(lines.length).to.equal(1);
    expect(lines[0]).to.match(/^read 0x0{40} failed: /);
    // The next poll works normally
    await keeper.poll();
    expect(keeper.actions).to.deep.equal([]);
  });
});

// The quoting round the deploy scripts run before deploying QuickLaunch (scripts/lib/reward-tokens.js):
// a candidate whose quote reverts is a failed candidate, an RPC that cannot answer stops the round.
describe("Reward route quoting", function () {
  const E = (n) => ethers.parseEther(String(n));

  /** A mock stock with a live WETH pool at 0.3%, an empty one at 0.05% and none at 1% */
  async function stockFixture() {
    const env = await deployPlatform();
    const { v3Factory, v3Quoter, weth } = env;
    const stock = await ethers.deployContract("MockERC20", ["Mock Stock", "STK", 18, E(1_000_000)]);
    await v3Factory.createPool(weth.target, stock.target, 3000);
    const live = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, stock.target, 3000));
    await weth.deposit({ value: E(50) });
    await weth.transfer(live.target, E(50));
    await stock.transfer(live.target, E(345));
    await live.sync();
    await v3Factory.createPool(weth.target, stock.target, 500); // exists, holds nothing
    const v3 = { factory: v3Factory.target, router: env.v3Router.target, quoter: v3Quoter.target };
    return { ...env, stock, live, v3 };
  }

  it("marks a reverting quote as a failed candidate and a missing pool as no pool, keeps the live one", async function () {
    const env = await loadFixture(stockFixture);
    const candidates = v3CandidatesFor(hre, env.weth.target, null, env.stock.target);
    expect(candidates.map((c) => c.fees)).to.deep.equal([[500], [3000], [10000]]);
    const quoted = await quoteV3Candidates(hre, env.v3, candidates);
    const byFee = Object.fromEntries(quoted.map((c) => [c.fees[0], c]));
    expect(byFee[500].pools).to.equal(true);
    expect(byFee[500].amountOut).to.equal(null);
    expect(byFee[500].error).to.match(/^quote failed: .*insufficient liquidity/);
    expect(byFee[3000].pools).to.equal(true);
    expect(byFee[3000].amountOut).to.be.gt(0n);
    expect(byFee[3000].error).to.equal(null);
    expect(byFee[10000].pools).to.equal(false);
    expect(byFee[10000].error).to.match(/^no pool .* at 1%$/);
  });

  it("rethrows a quote error that is not a call revert (the RPC unreachable, a quoter without code)", async function () {
    const env = await loadFixture(stockFixture);
    const candidates = v3CandidatesFor(hre, env.weth.target, null, env.stock.target);
    // A quoter address without code answers with empty data: not a revert, the round stops
    let thrown = null;
    try {
      await quoteV3Candidates(hre, { ...env.v3, quoter: env.dave.address }, candidates);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "quoting a quoter without code must throw").to.not.equal(null);
    expect(isCallRevert(thrown)).to.equal(false);
    // A transport failure on the quote call (the pool reads before it still answer) is rethrown as it is
    const provider = ethers.provider;
    const originalCall = provider.call;
    const quoterSelector = env.v3Quoter.interface.getFunction("quoteExactInput").selector;
    provider.call = async function (tx, ...rest) {
      if (tx && tx.data && String(tx.data).startsWith(quoterSelector)) {
        const err = new Error("fetch failed");
        err.code = "NETWORK_ERROR";
        throw err;
      }
      return originalCall.call(this, tx, ...rest);
    };
    try {
      thrown = null;
      try {
        await quoteV3Candidates(hre, env.v3, candidates);
      } catch (e) {
        thrown = e;
      }
      expect(thrown && thrown.code).to.equal("NETWORK_ERROR");
    } finally {
      provider.call = originalCall;
    }
    // Back to normal: the live candidate quotes again
    const quoted = await quoteV3Candidates(hre, env.v3, candidates);
    expect(quoted.find((c) => c.fees[0] === 3000).amountOut).to.be.gt(0n);
  });

  it("stops a deployment on a stock whose pools exist but cannot be quoted, unless ALLOW_DEAD_ROUTES=1; a stock without pools only warns", function () {
    const dead = { symbol: "NVDA", token: "0x1", v3Path: null, quote: null, reason: "no candidate with pools and a quote",
      candidates: [{ pools: true, amountOut: null, error: "quote failed: insufficient liquidity" }, { pools: false, error: "no pool" }] };
    const waiting = { symbol: "QCOM", token: "0x2", v3Path: null, quote: null, reason: "no candidate with pools and a quote",
      candidates: [{ pools: false, error: "no pool" }, { pools: false, error: "no pool" }] };
    const stored = { symbol: "TSLA", token: "0x3", v3Path: "0xabc", quote: 1n, candidates: [{ pools: true, amountOut: 1n, error: null }] };
    const v2 = { symbol: "USDG", token: "0x4", intermediates: ["0x5"] };
    expect(deadRewardRoutes([dead, waiting, stored, v2]).map((r) => r.symbol)).to.deep.equal(["NVDA"]);

    const lines = [];
    const log = (l) => lines.push(l);
    // Only a waiting stock: a warning, no stop
    expect(requireQuotableRoutes([waiting, stored, v2], { log, env: {} })).to.deep.equal([]);
    expect(lines).to.deep.equal(["WARNING: QCOM has no Uniswap V3 pool yet; no route is stored and it cannot be picked until one exists"]);
    // A dead stock stops the script with the failing candidates named
    expect(() => requireQuotableRoutes([dead, waiting, stored, v2], { log, env: {} })).to.throw(
      /no quotable route for NVDA although their pools exist; nothing was deployed.*insufficient liquidity.*ALLOW_DEAD_ROUTES=1/
    );
    // Allowed explicitly: a warning per dead stock and the route is skipped
    lines.length = 0;
    const allowed = requireQuotableRoutes([dead, waiting, stored, v2], { log, env: { ALLOW_DEAD_ROUTES: "1" } });
    expect(allowed.map((r) => r.symbol)).to.deep.equal(["NVDA"]);
    expect(lines).to.deep.equal([
      "WARNING: QCOM has no Uniswap V3 pool yet; no route is stored and it cannot be picked until one exists",
      "WARNING: dead route allowed (ALLOW_DEAD_ROUTES=1): NVDA: quote failed: insufficient liquidity",
    ]);
  });
});
