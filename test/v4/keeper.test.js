const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { createKeeper } = require("../../scripts/launch-keeper");
const { deployPlatformV4, taxConfig, keyArray } = require("./helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const Lock = 0;
const Rewards = 2;

// A v4 launch keeps its fees in the pool's hook until someone sends them on. Nobody watches a
// custom sale, so the platform keeper does it; without this the platform's own share would sit in
// the hook forever and the HOODS buyback would never see it.
describe("V4 keeper", function () {
  async function launched() {
    const ctx = await deployPlatformV4();
    return launchRewards(ctx, ctx.weth.target);
  }

  /** Launches a Rewards token paying `rewardToken`, with 2% to marketing and 2% to holders. */
  async function launchRewards(ctx, rewardToken) {
    const { launcher, presaleFactory, alice, bob, carol, marketing } = ctx;
    const now = BigInt(await time.latest());
    const start = now + 1000n;

    await launcher.connect(alice).createToken(
      Rewards,
      { name: "Keeper", symbol: "KEEP", totalSupply: E("1000000"), rewardToken },
      taxConfig(marketing.address, {
        marketingBuyBps: 200,
        marketingSellBps: 200,
        rewardsBuyBps: 200,
        rewardsSellBps: 200,
      }),
      alice.address
    );
    const created = await launcher.tokensOfCreator(alice.address);
    const tokenAddr = created[created.length - 1];
    const token = await ethers.getContractAt("RewardsTokenV4", tokenAddr);

    const params = {
      token: tokenAddr,
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: E("2"),
      hardCap: E("4"),
      minContribution: E("0.1"),
      maxContribution: E("2"),
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction: Lock,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("2") });
    await presale.connect(carol).contribute({ value: E("2") });
    await presale.connect(alice).finalize(0, 0);
    await presale.connect(bob).claim();
    await presale.connect(carol).claim();

    const key = keyArray(await launcher.poolKeyOf(tokenAddr));
    const poolId = (await launcher.launchOf(tokenAddr)).poolId;
    return { ...ctx, token, tokenAddr, presale, key, poolId };
  }

  async function makeKeeper(ctx, extra = {}) {
    const lines = [];
    const keeper = await createKeeper(hre, {
      factoryAddress: ctx.presaleFactory.target,
      signer: ctx.keeper,
      log: (l) => lines.push(l),
      retrySeconds: 60,
      v4LauncherAddress: ctx.launcher.target,
      v4HookAddress: ctx.hook.target,
      ...extra,
    });
    return { keeper, lines };
  }

  it("sends the collected fees on and pays the Treasury", async function () {
    const ctx = await loadFixture(launched);
    const { swapper, hook, treasury, token, key, poolId, marketing, dave } = ctx;
    const spend = E("2");
    await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });
    expect(await hook.pendingPlatform()).to.be.greaterThan(0);

    const marketingBefore = await ethers.provider.getBalance(marketing.address);
    const reserveBefore = await treasury.buybackReserve();
    const { keeper, lines } = await makeKeeper(ctx);
    await keeper.poll();

    // The creator's share is paid, the holders' share goes all the way through to the reward
    // asset in the same pass, and the platform's share is booked in the Treasury.
    expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.be.greaterThan(0);
    expect(await token.totalRewardsDistributed()).to.be.greaterThan(0);
    expect(await treasury.buybackReserve()).to.be.greaterThan(reserveBefore);
    expect(await hook.pendingMarketing(poolId)).to.equal(0);
    expect(await hook.pendingPlatform()).to.equal(0);
    expect(lines.some((l) => l.startsWith("v4-flush "))).to.equal(true);
    expect(lines.some((l) => l.startsWith("v4-flush-platform "))).to.equal(true);
  });

  it("turns a rewards token's collected ETH into the reward asset", async function () {
    const ctx = await loadFixture(launched);
    const { swapper, token, key, weth, bob, dave } = ctx;
    const spend = E("2");
    await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });

    const { keeper, lines } = await makeKeeper(ctx);
    // One pass is enough: the flush funds the token and the same pass turns it into the reward.
    await keeper.poll();

    expect(await token.pendingRewardEth()).to.equal(0);
    expect(await token.totalRewardsDistributed()).to.be.greaterThan(0);
    expect(lines.some((l) => l.startsWith("v4-rewards "))).to.equal(true);

    const owed = await token.withdrawableRewardOf(bob.address);
    expect(owed).to.be.greaterThan(0);
    await token.connect(bob).claimRewards();
    expect(await weth.balanceOf(bob.address)).to.equal(owed);
  });

  it("leaves dust alone", async function () {
    const ctx = await loadFixture(launched);
    const { swapper, hook, key, poolId, dave } = ctx;
    // A tiny trade is not worth a transaction of its own.
    const spend = E("0.01");
    await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });
    const pending = await hook.pendingMarketing(poolId);
    expect(pending).to.be.greaterThan(0);

    const { keeper, lines } = await makeKeeper(ctx);
    await keeper.poll();
    expect(await hook.pendingMarketing(poolId)).to.equal(pending);
    expect(lines.some((l) => l.startsWith("v4-"))).to.equal(false);
  });

  // The review found the keeper walked the launcher's whole token list, which anyone can grow for
  // the price of a createToken call. It now finds v4 pools through finalized sales only.
  it("finds pools through finalized sales, not through every token anyone created", async function () {
    const ctx = await loadFixture(launched);
    const { launcher, dave, marketing, tokenAddr } = ctx;
    for (let i = 0; i < 3; i++) {
      await launcher.connect(dave).createToken(
        0,
        { name: `Spam ${i}`, symbol: "SPAM", totalSupply: E("1000"), rewardToken: ethers.ZeroAddress },
        taxConfig(marketing.address, { taxLocked: true, walletLocked: true }),
        dave.address
      );
    }
    const { keeper } = await makeKeeper(ctx);
    await keeper.poll();
    expect([...keeper.v4.launched.keys()]).to.deep.equal([tokenAddr]);
  });

  describe("paying holders along a thin route", function () {
    // A stock that trades against WETH on Uniswap V3, in a pool of `wethDepth` WETH at 6.9 TSLA each.
    async function stockLaunched(wethDepth) {
      const ctx = await deployPlatformV4();
      const { v3Factory, weth, quickLaunch } = ctx;
      const tsla = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E("1000000")]);
      await v3Factory.createPool(weth.target, tsla.target, 3000);
      const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, tsla.target, 3000));
      const deepen = async (amount) => {
        await weth.deposit({ value: amount });
        await weth.transfer(pool.target, amount);
        await tsla.transfer(pool.target, amount * 69n / 10n);
        await pool.sync();
      };
      await deepen(wethDepth);
      const path = ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, tsla.target]);
      await quickLaunch.setRewardTokenAllowed(tsla.target, true);
      await quickLaunch.setRewardRouteV3(tsla.target, path);
      return { ...(await launchRewards(ctx, tsla.target)), tsla, deepen };
    }

    it("pays out the part a thin route can take and keeps the rest for later", async function () {
      const ctx = await stockLaunched(E("0.1"));
      const { swapper, token, key, dave } = ctx;
      // 2% of a 2 ETH buy is 0.04 ETH for holders: a large bite out of a 0.1 WETH pool.
      await swapper.connect(dave).swapExactIn(key, true, E("2"), 0, dave.address, { value: E("2") });

      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();
      const left = await token.pendingRewardEth();
      expect(left).to.be.greaterThan(0);
      expect(await token.totalRewardsDistributed()).to.be.greaterThan(0);
      expect(lines.some((l) => l.startsWith("v4-rewards ") && l.includes(" of "))).to.equal(true);
    });

    it("holds a distribution the route cannot take at all, and sends it once the route deepens", async function () {
      const ctx = await stockLaunched(E("0.001"));
      const { swapper, token, key, deepen, dave } = ctx;
      await swapper.connect(dave).swapExactIn(key, true, E("2"), 0, dave.address, { value: E("2") });

      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();
      expect(await token.pendingRewardEth()).to.be.greaterThan(0);
      expect(await token.totalRewardsDistributed()).to.equal(0);
      expect(lines.some((l) => l.startsWith("v4-rewards ") && l.includes("price impact"))).to.equal(true);
      // The skip is logged once, not on every poll.
      await keeper.poll();
      expect(lines.filter((l) => l.includes("price impact")).length).to.equal(1);

      await deepen(E("50"));
      await keeper.poll();
      expect(await token.pendingRewardEth()).to.equal(0);
      expect(await token.totalRewardsDistributed()).to.be.greaterThan(0);
    });
  });

  it("does nothing at all when the platform has no v4 mode", async function () {
    const ctx = await loadFixture(launched);
    const { keeper } = await makeKeeper(ctx, { v4LauncherAddress: undefined, v4HookAddress: undefined });
    expect(keeper.v4).to.equal(null);
    await keeper.poll();
  });
});
