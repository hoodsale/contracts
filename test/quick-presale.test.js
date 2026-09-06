const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const DEAD = "0x000000000000000000000000000000000000dEaD";
const TOTAL_SUPPLY = E(1_000_000_000);
const SALE_SUPPLY = TOTAL_SUPPLY / 2n;
const QUICK_FEE = E(0.03);
const BPS = 10_000n;

// Status enum
const Live = 1n, Ended = 2n, Failed = 3n, Finalized = 5n;
// State enum
const Active = 0n, FinalizedState = 2n;
// QuickLaunch token types
const TYPE = { Standard: 0, Tax: 1, Rewards: 2 };
const TOKEN_CONTRACT = ["StandardToken", "TaxToken", "RewardsToken"];
const PLATFORM_TAX = 25n; // TokenFactory.platformTaxBps

// Quick presale: one transaction creates the token and a sale with locked rules; the sale
// launches itself when the hard cap fills or, after the end with the soft cap met, on the
// first claim() (anyone may also finalize then); tokens are delivered without a claim.
describe("Quick presale", function () {
  /** Creates n fresh wallets funded with `eth` ETH each. */
  async function fundedWallets(env, n, eth) {
    const wallets = [];
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await env.deployer.sendTransaction({ to: w.address, value: E(eth) });
      wallets.push(w);
    }
    return wallets;
  }

  /** The QuickParams struct of a launch: a Standard token, 1 ETH, 30 minutes, 5% share by default. */
  function quickParams(overrides = {}) {
    const o = {
      name: "Hood Flash",
      symbol: "HFLASH",
      hardCap: E(1),
      duration: 0, // 30 minutes
      share: 5,
      tokenType: TYPE.Standard,
      rewardToken: ethers.ZeroAddress, // Rewards only
      taxWallet: ethers.ZeroAddress, // Tax and Rewards; zero = the creator
      buyTax: 0, // Tax: creator tax in bps; Rewards: marketing tax
      sellTax: 0,
      rewardsBuy: 0, // Rewards only
      rewardsSell: 0,
      logoURI: "ipfs://flash-logo",
      description: "A quick sale.",
      ...overrides,
    };
    return {
      name: o.name,
      symbol: o.symbol,
      hardCap: o.hardCap,
      durationOption: o.duration,
      creatorSharePercent: o.share,
      tokenType: o.tokenType,
      rewardToken: o.rewardToken,
      taxWallet: o.taxWallet,
      buyTaxBps: o.buyTax,
      sellTaxBps: o.sellTax,
      rewardsBuyBps: o.rewardsBuy,
      rewardsSellBps: o.rewardsSell,
      logoURI: o.logoURI,
      description: o.description,
    };
  }

  /** Runs QuickLaunch.launch and returns the token and presale handles. */
  async function launchQuick(env, overrides = {}) {
    const creator = overrides.creator || env.carol;
    const q = quickParams(overrides);
    const tx = await env.quickLaunch.connect(creator).launch(q, { value: QUICK_FEE });
    const receipt = await tx.wait();
    const parsed = receipt.logs
      .map((l) => {
        try {
          return env.quickLaunch.interface.parseLog(l);
        } catch (e) {
          return null;
        }
      })
      .find((e) => e && e.name === "QuickLaunched");
    const token = await ethers.getContractAt(TOKEN_CONTRACT[q.tokenType], parsed.args.token);
    const presale = await ethers.getContractAt("Presale", parsed.args.presale);
    return { token, presale, receipt, launched: parsed.args, tx, params: q };
  }

  /** Expects QuickLaunch.launch with these overrides to revert with `reason`. */
  async function expectLaunchRevert(env, overrides, reason, value = QUICK_FEE) {
    const creator = overrides.creator || env.carol;
    await expect(env.quickLaunch.connect(creator).launch(quickParams(overrides), { value })).to.be.revertedWith(reason);
  }

  async function swapDeadline() {
    return (await time.latest()) + 600;
  }

  async function buy(env, token, buyer, ethIn) {
    return env.router
      .connect(buyer)
      .swapExactETHForTokens(0, [env.weth.target, token.target], buyer.address, await swapDeadline(), { value: ethIn });
  }

  async function sell(env, token, seller, amount) {
    await token.connect(seller).approve(env.router.target, amount);
    return env.router
      .connect(seller)
      .swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0, [token.target, env.weth.target], seller.address, await swapDeadline());
  }

  function findEvent(receipt, iface, name) {
    return receipt.logs
      .map((l) => {
        try {
          return iface.parseLog(l);
        } catch (e) {
          return null;
        }
      })
      .find((e) => e && e.name === name);
  }

  async function contributeAll(presale, wallets, amount) {
    for (const w of wallets) await presale.connect(w).contribute({ value: amount });
  }

  // Hard cap 1 ETH, share 5%: max 0.02 ETH per wallet, so 50 wallets fill the cap
  async function quickFixture() {
    const env = await deployPlatform();
    const sale = await launchQuick(env);
    const wallets = await fundedWallets(env, 50, 0.05);
    return { ...env, ...sale, wallets };
  }

  // 49 wallets at the maximum plus one just below it: 0.9995 ETH raised, 0.0005 left (< min)
  async function fullFixture() {
    const f = await loadFixture(quickFixture);
    await contributeAll(f.presale, f.wallets.slice(0, 49), E(0.02));
    return f;
  }

  // Soft cap met (0.26 of 0.25 ETH), cap not filled
  async function softCapFixture() {
    const f = await loadFixture(quickFixture);
    await contributeAll(f.presale, f.wallets.slice(0, 13), E(0.02));
    return f;
  }

  // ------------------------------------------------------------ QuickLaunch flow

  describe("QuickLaunch.launch", function () {
    it("creates the token, the sale and records the creator and the share", async function () {
      const { quickLaunch, presaleFactory, tokenFactory, token, presale, carol, launched } =
        await loadFixture(quickFixture);

      expect(await tokenFactory.isPlatformToken(token.target)).to.equal(true);
      expect(await token.name()).to.equal("Hood Flash");
      expect(await token.symbol()).to.equal("HFLASH");
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);

      expect(await presaleFactory.isPresale(presale.target)).to.equal(true);
      expect(await presaleFactory.isQuick(presale.target)).to.equal(true);
      expect(await presaleFactory.quickCreatorOf(presale.target)).to.equal(carol.address);
      expect(await quickLaunch.creatorOf(presale.target)).to.equal(carol.address);
      expect(await quickLaunch.presaleOfToken(token.target)).to.equal(presale.target);
      expect(await quickLaunch.allLaunchesLength()).to.equal(1);
      expect([...(await presaleFactory.presalesOfCreator(carol.address))]).to.deep.equal([presale.target]);

      expect(await presale.saleOwner()).to.equal(quickLaunch.target);
      expect(await presale.autoLaunch()).to.equal(true);
      expect(await presale.payoutRecipient()).to.equal(carol.address);
      expect(await presale.creatorShareBps()).to.equal(500);

      expect(launched.creator).to.equal(carol.address);
      expect(launched.hardCap).to.equal(E(1));
      expect(launched.creatorShareBps).to.equal(500);
      expect(launched.endTime).to.equal((await presale.getParams()).endTime);
      // A Standard token: no tax of its own, only the platform tax on DEX trades
      expect(launched.tokenType).to.equal(TYPE.Standard);
      expect(launched.rewardToken).to.equal(ethers.ZeroAddress);
      expect(launched.buyTaxBps).to.equal(0);
      expect(launched.sellTaxBps).to.equal(0);
      expect(launched.rewardsBuyBps).to.equal(0);
      expect(launched.rewardsSellBps).to.equal(0);
      expect((await tokenFactory.infoOf(token.target)).tokenType).to.equal(0);
      const rec = await quickLaunch.quickTokenOf(presale.target);
      expect(rec.tokenType).to.equal(TYPE.Standard);
      expect(rec.rewardToken).to.equal(ethers.ZeroAddress);
      expect(rec.taxWallet).to.equal(ethers.ZeroAddress);
      expect([rec.buyTaxBps, rec.sellTaxBps, rec.rewardsBuyBps, rec.rewardsSellBps]).to.deep.equal([0n, 0n, 0n, 0n]);
      // Unknown presales read as all zero
      expect((await quickLaunch.quickTokenOf(carol.address)).tokenType).to.equal(0);
    });

    it("writes the locked sale rules", async function () {
      const { presale } = await loadFixture(quickFixture);
      const p = await presale.getParams();
      const rate = (SALE_SUPPLY * E(1)) / E(1);
      expect(p.presaleRate).to.equal(rate);
      expect(p.listingRate).to.equal(rate);
      expect(p.hardCap).to.equal(E(1));
      expect(p.softCap).to.equal(E(0.25));
      expect(p.minContribution).to.equal(E(0.001));
      expect(p.maxContribution).to.equal(E(0.02));
      expect(p.endTime - p.startTime).to.equal(1800);
      expect(p.launchTime).to.equal(p.endTime);
      expect(p.liquidityBps).to.equal(9445);
      expect(p.liquidityAction).to.equal(1); // Burn
      expect(p.lockDuration).to.equal(0);
      expect(p.whitelistEnabled).to.equal(false);
      expect(await presale.status()).to.equal(Live);
    });

    it("burns the supply down to exactly the sale plus liquidity tokens and renounces ownership", async function () {
      const { presaleFactory, quickLaunch, token, presale } = await loadFixture(quickFixture);
      const p = (await presale.getParams()).toObject();
      const required = await presaleFactory.requiredTokensFor(p);
      const tokensForSale = (p.hardCap * p.presaleRate) / E(1);
      const liquidityEth = ((p.hardCap - p.hardCap / 10n) * BigInt(p.liquidityBps)) / BPS;
      const liquidityTokens = (liquidityEth * p.listingRate) / E(1);
      expect(tokensForSale).to.equal(SALE_SUPPLY);
      expect(required).to.equal(tokensForSale + liquidityTokens);

      expect(await token.balanceOf(presale.target)).to.equal(required);
      expect(await token.balanceOf(DEAD)).to.equal(TOTAL_SUPPLY - required);
      expect(await token.balanceOf(quickLaunch.target)).to.equal(0);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
    });

    it("writes the profile and the tokenomics on chain", async function () {
      const { metadataRegistry, token } = await loadFixture(quickFixture);
      const m = await metadataRegistry.metadataOf(token.target);
      expect(m.logoURI).to.equal("ipfs://flash-logo");
      expect(m.description).to.equal("A quick sale.");
      expect(await metadataRegistry.hasMetadata(token.target)).to.equal(true);

      const slices = await metadataRegistry.tokenomicsOf(token.target);
      expect(slices.map((s) => [s.label, Number(s.bps)])).to.deep.equal([
        ["Presale", 5000],
        ["Liquidity", 4250], // 42.5025% rounded half up
        ["Burned", 750],
      ]);
    });

    it("skips the profile when logo and description are empty", async function () {
      const env = await loadFixture(deployPlatform);
      const { token } = await launchQuick(env, { logoURI: "", description: "" });
      expect(await env.metadataRegistry.hasMetadata(token.target)).to.equal(false);
      expect(await env.metadataRegistry.hasTokenomics(token.target)).to.equal(true);
    });

    it("sends the 0.03 ETH fee to the Treasury and keeps no ETH", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, treasury, carol } = env;
      const tx = quickLaunch
        .connect(carol)
        .launch(quickParams({ name: "Fee", symbol: "FEE", hardCap: E(2), duration: 1, share: 0, logoURI: "", description: "" }), {
          value: QUICK_FEE,
        });
      await expect(tx).to.changeEtherBalances([treasury, quickLaunch], [QUICK_FEE, 0n]);
      await expect(tx).to.emit(quickLaunch, "QuickLaunched");
    });

    it("maps the creator share to the liquidity share of the net raise", async function () {
      const { presaleFactory } = await loadFixture(deployPlatform);
      expect(await presaleFactory.quickLiquidityBps(0)).to.equal(10000);
      expect(await presaleFactory.quickLiquidityBps(500)).to.equal(9445);
      expect(await presaleFactory.quickLiquidityBps(1000)).to.equal(8889);
    });

    it("validates the inputs", async function () {
      const env = await loadFixture(deployPlatform);
      await expectLaunchRevert(env, {}, "wrong creation fee", E(0.1));
      await expectLaunchRevert(env, { hardCap: E(0.4) }, "hard cap out of range");
      await expectLaunchRevert(env, { hardCap: E(101) }, "hard cap out of range");
      await expectLaunchRevert(env, { hardCap: E(1) + 1n }, "hard cap not divisible by 4");
      await expectLaunchRevert(env, { duration: 4 }, "bad duration option");
      await expectLaunchRevert(env, { share: 11 }, "share too high");
      await expectLaunchRevert(env, { tokenType: 3 }, "bad token type");
      // A Standard token carries no tax and no reward token
      await expectLaunchRevert(env, { buyTax: 100 }, "standard token has no tax");
      await expectLaunchRevert(env, { sellTax: 1 }, "standard token has no tax");
      await expectLaunchRevert(env, { rewardsBuy: 100 }, "standard token has no tax");
      await expectLaunchRevert(env, { rewardsSell: 100 }, "standard token has no tax");
      await expectLaunchRevert(env, { rewardToken: env.weth.target }, "no reward token for this type");
      // A Tax token: creator tax up to 5% per side, at least one side, no rewards fields
      await expectLaunchRevert(env, { tokenType: TYPE.Tax, buyTax: 501 }, "creator tax too high");
      await expectLaunchRevert(env, { tokenType: TYPE.Tax, sellTax: 501 }, "creator tax too high");
      await expectLaunchRevert(env, { tokenType: TYPE.Tax }, "tax token without tax");
      await expectLaunchRevert(env, { tokenType: TYPE.Tax, buyTax: 100, rewardsBuy: 100 }, "rewards tax on a tax token");
      await expectLaunchRevert(env, { tokenType: TYPE.Tax, buyTax: 100, rewardToken: env.weth.target }, "no reward token for this type");
      expect(await env.quickLaunch.MAX_CREATOR_TAX_BPS()).to.equal(500);
      expect(await env.quickLaunch.MIN_REWARDS_TAX_BPS()).to.equal(100);
      expect(await env.quickLaunch.durationOf(1)).to.equal(3600);
      expect(await env.quickLaunch.durationOf(2)).to.equal(7200);
      expect(await env.quickLaunch.durationOf(3)).to.equal(21600);
    });

    it("burnLeftovers sends stray tokens to the dead address", async function () {
      const { quickLaunch, tokenFactory, alice } = await loadFixture(deployPlatform);
      await tokenFactory.connect(alice).createStandardToken("Stray", "STRAY", E(1000));
      const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
      await expect(quickLaunch.burnLeftovers(token.target)).to.be.revertedWith("nothing to burn");
      await token.connect(alice).transfer(quickLaunch.target, E(10));
      await expect(quickLaunch.burnLeftovers(token.target))
        .to.emit(quickLaunch, "LeftoversBurned")
        .withArgs(token.target, E(10));
      expect(await token.balanceOf(DEAD)).to.equal(E(10));
    });
  });

  // ------------------------------------------------------------ factory validation

  describe("PresaleFactory.createQuickPresale", function () {
    async function directFixture() {
      const env = await deployPlatform();
      const { tokenFactory, presaleFactory, alice } = env;
      // The factory only accepts quick sales from its QuickLaunch; alice plays that role here
      await presaleFactory.setQuickLaunch(alice.address);
      await tokenFactory.connect(alice).createStandardToken("Direct", "DRCT", TOTAL_SUPPLY);
      const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
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
        liquidityBps: 9445,
        liquidityAction: 1,
        lockDuration: 0,
        launchTime: start + 3600,
        whitelistEnabled: false,
      };
      return { ...env, token, params };
    }

    async function expectQuickRevert(ctx, overrides, reason, share = 500, value = QUICK_FEE) {
      const p = { ...ctx.params, ...overrides };
      await expect(
        ctx.presaleFactory.connect(ctx.alice).createQuickPresale(p, ctx.alice.address, share, { value })
      ).to.be.revertedWith(reason);
    }

    it("only the configured QuickLaunch can create quick presales", async function () {
      const ctx = await loadFixture(directFixture);
      const { presaleFactory, quickLaunch, alice, bob, token, params } = ctx;
      expect(await presaleFactory.quickLaunch()).to.equal(alice.address);
      // bob is not the quick launcher, even with his own token
      await ctx.tokenFactory.connect(bob).createStandardToken("Other", "OTHR", TOTAL_SUPPLY);
      const other = await ethers.getContractAt("StandardToken", await ctx.tokenFactory.allTokens(1));
      await other.connect(bob).approve(presaleFactory.target, ethers.MaxUint256);
      await expect(
        presaleFactory.connect(bob).createQuickPresale({ ...params, token: other.target }, bob.address, 500, { value: QUICK_FEE })
      ).to.be.revertedWith("not quick launch");
      // Only the platform owner can change the quick launcher
      await expect(presaleFactory.connect(alice).setQuickLaunch(bob.address))
        .to.be.revertedWithCustomError(presaleFactory, "OwnableUnauthorizedAccount");
      await expect(presaleFactory.setQuickLaunch(ethers.ZeroAddress)).to.be.revertedWith("zero addr");
      await expect(presaleFactory.setQuickLaunch(quickLaunch.target))
        .to.emit(presaleFactory, "QuickLaunchSet")
        .withArgs(quickLaunch.target);
      // alice lost the role: the token owner alone cannot create a quick sale
      await expect(
        presaleFactory.connect(alice).createQuickPresale(params, alice.address, 500, { value: QUICK_FEE })
      ).to.be.revertedWith("not quick launch");
      expect(token.target).to.not.equal(other.target);
    });

    it("accepts valid quick params from the quick launcher that owns the token", async function () {
      const ctx = await loadFixture(directFixture);
      const tx = ctx.presaleFactory.connect(ctx.alice).createQuickPresale(ctx.params, ctx.alice.address, 500, { value: QUICK_FEE });
      await expect(tx).to.emit(ctx.presaleFactory, "QuickPresaleCreated").withArgs(anyValue, ctx.token.target, ctx.alice.address, 500);
      await expect(tx).to.changeEtherBalances([ctx.treasury], [QUICK_FEE]);
      const presale = await ethers.getContractAt("Presale", await ctx.presaleFactory.allPresales(0));
      await expect(tx).to.emit(presale, "QuickModeSet").withArgs(ctx.alice.address, 500);
      expect(await presale.autoLaunch()).to.equal(true);
      expect(await ctx.presaleFactory.isQuick(presale.target)).to.equal(true);
    });

    it("rejects the wrong fee", async function () {
      const ctx = await loadFixture(directFixture);
      await expectQuickRevert(ctx, {}, "wrong creation fee", 500, E(0.1));
      await expectQuickRevert(ctx, {}, "wrong creation fee", 500, 0n);
    });

    it("rejects a liquidity share that does not match the creator share", async function () {
      const ctx = await loadFixture(directFixture);
      await expectQuickRevert(ctx, { liquidityBps: 9000 }, "liquidity bps mismatch");
      await expectQuickRevert(ctx, { liquidityBps: 9445 }, "liquidity bps mismatch", 0);
    });

    it("rejects a creator share above 10%", async function () {
      const ctx = await loadFixture(directFixture);
      await expectQuickRevert(ctx, { liquidityBps: 8778 }, "share too high", 1100);
    });

    it("rejects a soft cap that is not 25% of the hard cap", async function () {
      const ctx = await loadFixture(directFixture);
      await expectQuickRevert(ctx, { softCap: E(0.3) }, "softcap must be 25% of hardcap");
      await expectQuickRevert(ctx, { softCap: E(0.2) }, "softcap must be 25% of hardcap");
    });

    it("rejects durations outside 30 minutes to 6 hours", async function () {
      const ctx = await loadFixture(directFixture);
      const s = ctx.params.startTime;
      await expectQuickRevert(ctx, { endTime: s + 600, launchTime: s + 600 }, "bad quick duration");
      await expectQuickRevert(ctx, { endTime: s + 7 * 3600, launchTime: s + 7 * 3600 }, "bad quick duration");
    });

    it("rejects a launch time that differs from the end time", async function () {
      const ctx = await loadFixture(directFixture);
      await expectQuickRevert(ctx, { launchTime: ctx.params.endTime + 100 }, "launch time must equal end time");
      await expectQuickRevert(ctx, { launchTime: 0 }, "launch time must equal end time");
    });

    it("rejects locked LP, a listing rate that differs and the whitelist", async function () {
      const ctx = await loadFixture(directFixture);
      await expectQuickRevert(ctx, { liquidityAction: 0, lockDuration: 30 * 24 * 3600 }, "quick sale must burn lp");
      await expectQuickRevert(ctx, { listingRate: ctx.params.presaleRate - 1n }, "listing rate must equal presale rate");
      await expectQuickRevert(ctx, { whitelistEnabled: true }, "quick sale has no whitelist");
    });

    it("quick sales cannot be cancelled", async function () {
      const ctx = await loadFixture(directFixture);
      await ctx.presaleFactory.connect(ctx.alice).createQuickPresale(ctx.params, ctx.alice.address, 500, { value: QUICK_FEE });
      const presale = await ethers.getContractAt("Presale", await ctx.presaleFactory.allPresales(0));
      await expect(presale.connect(ctx.alice).cancel()).to.be.revertedWith("quick sale cannot be cancelled");
      await expect(presale.connect(ctx.bob).cancel()).to.be.revertedWith("not sale owner");
    });

    it("only the factory can switch a sale to quick mode, and only before contributions", async function () {
      const ctx = await loadFixture(directFixture);
      await expect(ctx.presaleFactory.connect(ctx.alice).setQuickCreationFee(E(0.05)))
        .to.be.revertedWithCustomError(ctx.presaleFactory, "OwnableUnauthorizedAccount");
      await expect(ctx.presaleFactory.setQuickCreationFee(E(0.05)))
        .to.emit(ctx.presaleFactory, "QuickCreationFeeUpdated")
        .withArgs(E(0.05));
      await expectQuickRevert(ctx, {}, "wrong creation fee");
      await ctx.presaleFactory.setQuickCreationFee(QUICK_FEE);
      await ctx.presaleFactory.connect(ctx.alice).createQuickPresale(ctx.params, ctx.alice.address, 500, { value: QUICK_FEE });
      const presale = await ethers.getContractAt("Presale", await ctx.presaleFactory.allPresales(0));
      await expect(presale.connect(ctx.alice).setQuickMode(ctx.alice.address, 100)).to.be.revertedWith("not factory");
    });
  });

  // ------------------------------------------------------------ automatic launch

  describe("automatic launch at the hard cap", function () {
    it("finalizes inside the filling contribution and splits the raise", async function () {
      const { presale, token, treasury, carol, wallets, weth } = await loadFixture(fullFixture);
      const last = wallets[49];
      const dead = await ethers.getContractAt("MockPair", await token.mainPair());
      const treasuryBefore = await ethers.provider.getBalance(treasury.target);
      const creatorBefore = await ethers.provider.getBalance(carol.address);
      const deadTokensBefore = await token.balanceOf(DEAD);

      const tx = presale.connect(last).contribute({ value: E(0.0195) });
      await expect(tx).to.emit(presale, "Contributed").withArgs(last.address, E(0.0195), E(0.9995));
      await expect(tx).to.emit(presale, "Finalized");
      await expect(tx).to.emit(presale, "AutoLaunched").withArgs(E(0.9995));
      await expect(tx).to.emit(presale, "Distributed").withArgs(20);
      expect(await presale.state()).to.equal(FinalizedState);
      expect(await presale.status()).to.equal(Finalized);
      expect(await ethers.provider.getBalance(presale.target)).to.equal(0);

      const gross = E(0.9995);
      const platformFee = gross / 10n;
      const net = gross - platformFee;
      const liquidityEth = (net * 9445n) / BPS;
      const creatorEth = net - liquidityEth;
      expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.equal(platformFee);
      // The creator gets the chosen 5% of the gross raise, within the rounding of liquidityBps
      const creatorGot = (await ethers.provider.getBalance(carol.address)) - creatorBefore;
      expect(creatorGot).to.equal(creatorEth);
      expect(creatorGot).to.be.lte((gross * 500n) / BPS);
      expect(creatorGot).to.be.gte((gross * 500n) / BPS - gross / BPS);
      // Liquidity got the rest, at the presale price, and the LP is burned
      expect(await weth.balanceOf(dead.target)).to.equal(liquidityEth);
      expect(await token.balanceOf(dead.target)).to.equal((liquidityEth * (await presale.getParams()).listingRate) / E(1));
      expect(await dead.balanceOf(DEAD)).to.equal(await presale.lpAmount());
      expect(await presale.lpAmount()).to.be.gt(0);
      // Unsold tokens are burned (the cap was filled just below the hard cap)
      const tokensForClaims = (gross * (await presale.getParams()).presaleRate) / E(1);
      expect(await token.balanceOf(DEAD)).to.be.gt(deadTokensBefore);
      expect(await token.balanceOf(presale.target)).to.equal(tokensForClaims - 20n * E(0.02) * 500_000_000n);
    });

    it("delivers tokens to the first 20 participants inline, distribute() finishes the rest", async function () {
      const { presale, token, wallets, deployer } = await loadFixture(fullFixture);
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });

      const perWallet = E(0.02) * 500_000_000n; // 0.02 ETH * 500M tokens per ETH
      for (let i = 0; i < 20; i++) expect(await token.balanceOf(wallets[i].address)).to.equal(perWallet);
      expect(await token.balanceOf(wallets[20].address)).to.equal(0);
      let [sent, total] = await presale.distributionProgress();
      expect(sent).to.equal(20);
      expect(total).to.equal(50);
      expect(await presale.distributionCursor()).to.equal(20);
      expect(await presale.distributionComplete()).to.equal(false);

      // Anyone can push the rest
      await expect(presale.connect(deployer).distribute(100)).to.emit(presale, "Distributed").withArgs(30);
      [sent, total] = await presale.distributionProgress();
      expect(sent).to.equal(50);
      expect(await presale.distributionComplete()).to.equal(true);
      for (let i = 20; i < 49; i++) expect(await token.balanceOf(wallets[i].address)).to.equal(perWallet);
      expect(await token.balanceOf(wallets[49].address)).to.equal(E(0.0195) * 500_000_000n);
      expect(await token.balanceOf(presale.target)).to.equal(0);
      // Nothing left to claim or distribute
      await expect(presale.connect(wallets[0]).claim()).to.be.revertedWith("nothing to claim");
      expect(await presale.distribute.staticCall(100)).to.equal(0);
      await expect(presale.distribute(100)).to.not.emit(presale, "Distributed");

      // The activity feed shows the deliveries as claims
      const acts = await presale.getActivities(50, 60);
      expect(acts.length).to.equal(50);
      expect(acts.every((a) => Number(a.kind) === 3)).to.equal(true);
    });

    it("keeps distribute() in batches from the cursor", async function () {
      const { presale, wallets } = await loadFixture(fullFixture);
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      expect(await presale.distribute.staticCall(7)).to.equal(7);
      await presale.distribute(7);
      expect(await presale.distributionCursor()).to.equal(27);
      // A wallet that claims itself is skipped by the walk
      await presale.connect(wallets[30]).claim();
      await expect(presale.distribute(100)).to.emit(presale, "Distributed").withArgs(22);
      const [sent, total] = await presale.distributionProgress();
      expect(sent).to.equal(50);
      expect(total).to.equal(50);
    });

    it("asks for the gas of the launch plus the inline delivery", async function () {
      const { presale, wallets } = await loadFixture(fullFixture);
      expect(await presale.autoLaunchGas()).to.equal(600_000 + 20 * 150_000);
      // Too little gas reverts instead of silently deferring the launch
      await expect(presale.connect(wallets[49]).contribute({ value: E(0.0195), gasLimit: 1_500_000 }))
        .to.be.revertedWithCustomError(presale, "InsufficientGasForLaunch");
      expect(await presale.state()).to.equal(Active);
      // The wallet's own estimate is enough for the launch and all 20 inline deliveries
      const estimate = await presale.connect(wallets[49]).contribute.estimateGas({ value: E(0.0195) });
      expect(estimate).to.be.lt(5_000_000n);
      await expect(presale.connect(wallets[49]).contribute({ value: E(0.0195), gasLimit: estimate }))
        .to.emit(presale, "Distributed")
        .withArgs(20);
    });

    it("does not launch while the cap has room and refuses outside launchers", async function () {
      const { presale, wallets, dave } = await loadFixture(fullFixture);
      // 0.9995 is needed for "full"; 0.98 leaves 0.02 (>= min 0.001)
      expect(await presale.status()).to.equal(Live);
      expect(await presale.isReadyToFinalize()).to.equal(false);
      await expect(presale.connect(dave).finalize(0, 0)).to.be.revertedWith("not authorized to launch");
      await expect(presale.connect(wallets[49]).contribute({ value: E(0.01) })).to.not.emit(presale, "Finalized");
      expect(await presale.state()).to.equal(Active);
    });
  });

  describe("deferred launch", function () {
    async function skewedFixture() {
      const f = await loadFixture(fullFixture);
      const { token, router, carol, weth } = f;
      // Nobody holds quick tokens before the launch, so a skewed pool can only be built in a test:
      // the burned supply is borrowed from the dead address.
      await ethers.provider.send("hardhat_impersonateAccount", [DEAD]);
      await ethers.provider.send("hardhat_setBalance", [DEAD, "0x" + E(1).toString(16)]);
      const dead = await ethers.getSigner(DEAD);
      await token.connect(dead).transfer(carol.address, E(1_000_000));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [DEAD]);
      // LP minted at a price far below the listing (1000 tokens for 0.0001 ETH)
      await token.connect(carol).approve(router.target, E(1000));
      await router
        .connect(carol)
        .addLiquidityETH(token.target, E(1000), 0, 0, carol.address, (await time.latest()) + 600, { value: E(0.0001) });
      const pair = await ethers.getContractAt("MockPair", await token.mainPair());
      expect(await pair.totalSupply()).to.be.gt(0);
      expect(await f.presale.poolPriceDeviationBps()).to.be.gt(500);
      return { ...f, pair, weth };
    }

    it("keeps the contribution when the pool price guard trips and leaves the sale launchable", async function () {
      const { presale, wallets, dave } = await loadFixture(skewedFixture);
      const tx = presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await expect(tx).to.emit(presale, "Contributed");
      await expect(tx).to.emit(presale, "AutoLaunchDeferred");
      await expect(tx).to.not.emit(presale, "Finalized");
      const receipt = await (await tx).wait();
      const deferred = receipt.logs
        .map((l) => {
          try {
            return presale.interface.parseLog(l);
          } catch (e) {
            return null;
          }
        })
        .find((e) => e && e.name === "AutoLaunchDeferred");
      const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], ethers.dataSlice(deferred.args.reason, 4))[0];
      expect(reason).to.equal("pool price off listing");

      expect(await presale.state()).to.equal(Active);
      expect(await presale.status()).to.equal(Ended);
      expect(await presale.totalRaised()).to.equal(E(0.9995));
      expect(await presale.contributionOf(wallets[49].address)).to.equal(E(0.0195));
      expect(await presale.isReadyToFinalize()).to.equal(true);
      // Still blocked while the pool is off the listing price
      await expect(presale.connect(dave).finalize(0, 0)).to.be.revertedWith("pool price off listing");
    });

    it("lets anyone finalize once the pool is back at the listing price", async function () {
      const { presale, token, wallets, carol, dave, pair } = await loadFixture(skewedFixture);
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });

      // Move the pool back to the listing price: 0.0001 ETH needs 50,000 tokens at 500M per ETH
      await token.connect(carol).transfer(pair.target, E(49_100));
      await pair.sync();
      expect(await presale.poolPriceDeviationBps()).to.be.lte(500);

      await expect(presale.connect(dave).finalize(0, 0)).to.emit(presale, "Finalized");
      expect(await presale.status()).to.equal(Finalized);
      expect(await pair.balanceOf(DEAD)).to.equal(await presale.lpAmount());
      const [sent] = await presale.distributionProgress();
      expect(sent).to.equal(20);
      await presale.distribute(100);
      expect(await presale.distributionComplete()).to.equal(true);
    });
  });

  describe("launch at the end of the sale", function () {
    it("lets the keeper finalize right after the end and burns the unsold tokens", async function () {
      const { presale, token, keeper, wallets, carol } = await loadFixture(softCapFixture);
      const params = await presale.getParams();
      expect(await presale.status()).to.equal(Live);

      await time.increaseTo(params.endTime + 1n);
      expect(await presale.status()).to.equal(Ended);
      expect(await presale.isLaunchDue()).to.equal(true);
      expect(await presale.isReadyToFinalize()).to.equal(true);

      const deadBefore = await token.balanceOf(DEAD);
      const saleBalance = await token.balanceOf(presale.target);
      const creatorBefore = await ethers.provider.getBalance(carol.address);
      const tx = presale.connect(keeper).finalize(0, 0);
      await expect(tx).to.emit(presale, "Finalized");
      await expect(tx).to.emit(presale, "Distributed").withArgs(13);
      const receipt = await (await tx).wait();
      const finalized = receipt.logs
        .map((l) => {
          try {
            return presale.interface.parseLog(l);
          } catch (e) {
            return null;
          }
        })
        .find((e) => e && e.name === "Finalized");

      const gross = E(0.26);
      const tokensForClaims = (gross * params.presaleRate) / E(1);
      const leftover = saleBalance - finalized.args.liquidityTokens - tokensForClaims;
      expect(leftover).to.be.gt(0);
      expect((await token.balanceOf(DEAD)) - deadBefore).to.equal(leftover);
      expect(finalized.args.platformFee).to.equal(gross / 10n);
      expect((await ethers.provider.getBalance(carol.address)) - creatorBefore).to.equal(
        gross - gross / 10n - finalized.args.liquidityEth
      );

      // Everyone was paid inline (13 participants)
      const [sent, total] = await presale.distributionProgress();
      expect(sent).to.equal(13);
      expect(total).to.equal(13);
      expect(await presale.distributionComplete()).to.equal(true);
      expect(await token.balanceOf(wallets[12].address)).to.equal(E(0.02) * 500_000_000n);
      expect(await token.balanceOf(presale.target)).to.equal(0);
    });

    // A Tax or Rewards sale that met the soft cap (13 wallets, 0.26 of 0.25 ETH) and ended
    async function endedTaxFixture() {
      const env = await deployPlatform();
      const sale = await launchQuick(env, {
        name: "Hood Tax", symbol: "HTAX", tokenType: TYPE.Tax, buyTax: 200, sellTax: 300, taxWallet: env.dave.address,
      });
      const wallets = await fundedWallets(env, 13, 0.05);
      await contributeAll(sale.presale, wallets, E(0.02));
      await time.increaseTo((await sale.presale.getParams()).endTime + 1n);
      return { ...env, ...sale, wallets };
    }

    async function endedRewardsFixture() {
      const env = await deployPlatform();
      const sale = await launchQuick(env, {
        name: "Hood Yield", symbol: "HYLD", tokenType: TYPE.Rewards, rewardToken: env.weth.target,
        taxWallet: env.dave.address, buyTax: 100, sellTax: 100, rewardsBuy: 300, rewardsSell: 300,
      });
      const wallets = await fundedWallets(env, 13, 0.05);
      await contributeAll(sale.presale, wallets, E(0.02));
      await time.increaseTo((await sale.presale.getParams()).endTime + 1n);
      return { ...env, ...sale, wallets };
    }

    /**
     * The keeper launches an ended taxed sale: unsold tokens burned, liquidity at the presale
     * rate with the LP burned, platform fee and creator share paid, every participant delivered
     * untaxed. Returns what the type-specific checks need.
     */
    async function expectKeeperLaunch(f) {
      const { presale, token, keeper, wallets, carol, treasury, weth } = f;
      const params = await presale.getParams();
      expect(await presale.status()).to.equal(Ended);
      expect(await presale.isReadyToFinalize()).to.equal(true);
      const deadBefore = await token.balanceOf(DEAD);
      const saleBalance = await token.balanceOf(presale.target);
      const creatorBefore = await ethers.provider.getBalance(carol.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.target);

      const tx = presale.connect(keeper).finalize(0, 0);
      await expect(tx).to.emit(presale, "Finalized");
      await expect(tx).to.emit(presale, "Distributed").withArgs(13);
      const finalized = findEvent(await (await tx).wait(), presale.interface, "Finalized");
      expect(await presale.status()).to.equal(Finalized);

      // The raise split: platform 10% of the gross, liquidity its share of the net, creator the rest
      const gross = E(0.26);
      const platformFee = gross / 10n;
      const liquidityEth = ((gross - platformFee) * BigInt(params.liquidityBps)) / BPS;
      expect(finalized.args.platformFee).to.equal(platformFee);
      expect(finalized.args.liquidityEth).to.equal(liquidityEth);
      expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.equal(platformFee);
      expect((await ethers.provider.getBalance(carol.address)) - creatorBefore).to.equal(gross - platformFee - liquidityEth);

      // Liquidity at the presale rate reached the pool in full (the sale is fee exempt), LP burned
      const pair = await ethers.getContractAt("MockPair", await token.mainPair());
      const liquidityTokens = (liquidityEth * params.listingRate) / E(1);
      expect(params.listingRate).to.equal(params.presaleRate);
      expect(finalized.args.liquidityTokens).to.equal(liquidityTokens);
      expect(await weth.balanceOf(pair.target)).to.equal(liquidityEth);
      expect(await token.balanceOf(pair.target)).to.equal(liquidityTokens);
      expect(await pair.balanceOf(DEAD)).to.equal(await presale.lpAmount());
      expect(await presale.lpAmount()).to.be.gt(0);

      // The unsold tokens are burned
      const tokensForClaims = (gross * params.presaleRate) / E(1);
      const leftover = saleBalance - liquidityTokens - tokensForClaims;
      expect(leftover).to.be.gt(0);
      expect((await token.balanceOf(DEAD)) - deadBefore).to.equal(leftover);

      // Everyone was delivered inline and untaxed; no tax accumulated on the way
      const perWallet = E(0.02) * 500_000_000n;
      for (const w of wallets) expect(await token.balanceOf(w.address)).to.equal(perWallet);
      expect(await presale.distributionComplete()).to.equal(true);
      expect(await token.balanceOf(presale.target)).to.equal(0);
      expect(await token.pendingPlatformTokens()).to.equal(0);
      expect(await token.pendingMarketingTokens()).to.equal(0);
      return { pair, perWallet, gross };
    }

    it("launches a Tax token at the end: burn, liquidity at the presale rate, split and untaxed delivery", async function () {
      const f = await loadFixture(endedTaxFixture);
      await expectKeeperLaunch(f);
      expect(await f.token.owner()).to.equal(ethers.ZeroAddress);
      expect(await f.token.marketingWallet()).to.equal(f.dave.address);
      expect(await f.token.buyTaxBps()).to.equal(200);
      expect(await f.token.sellTaxBps()).to.equal(300);
    });

    it("launches a Rewards token at the end and gives the delivered holders their reward shares", async function () {
      const f = await loadFixture(endedRewardsFixture);
      const { token, presale, wallets, quickLaunch } = f;
      const { pair, perWallet, gross } = await expectKeeperLaunch(f);
      expect(await token.pendingRewardsTokens()).to.equal(0);
      for (const w of wallets) expect(await token.sharesOf(w.address)).to.equal(perWallet);
      expect(await token.totalShares()).to.equal(gross * 500_000_000n);
      // The sale, the pool and the dead address hold tokens but earn nothing
      expect(await token.sharesOf(presale.target)).to.equal(0);
      expect(await token.sharesOf(pair.target)).to.equal(0);
      expect(await token.sharesOf(DEAD)).to.equal(0);
      expect(await token.isExcludedFromRewards(pair.target)).to.equal(true);
      expect(await token.owner()).to.equal(quickLaunch.target);
    });

    it("lets anyone press launch after the end", async function () {
      const { presale, dave } = await loadFixture(softCapFixture);
      const params = await presale.getParams();
      await expect(presale.connect(dave).finalize(0, 0)).to.be.revertedWith("not authorized to launch");
      await time.increaseTo(params.endTime + 1n);
      await expect(presale.connect(dave).finalize(0, 0)).to.emit(presale, "Finalized");
    });

    it("launches on the first claim() after the end", async function () {
      const { presale, token, wallets } = await loadFixture(softCapFixture);
      const params = await presale.getParams();
      await expect(presale.connect(wallets[0]).claim()).to.be.revertedWith("not finalized");
      await time.increaseTo(params.endTime + 1n);

      const tx = presale.connect(wallets[0]).claim();
      await expect(tx).to.emit(presale, "AutoLaunched").withArgs(E(0.26));
      await expect(tx).to.emit(presale, "Finalized");
      await expect(tx).to.emit(presale, "Claimed").withArgs(wallets[0].address, E(0.02) * 500_000_000n);
      expect(await presale.status()).to.equal(Finalized);
      expect(await token.balanceOf(wallets[0].address)).to.equal(E(0.02) * 500_000_000n);
      await expect(presale.connect(wallets[0]).claim()).to.be.revertedWith("nothing to claim");
    });

    it("claim() after the end does not revert when the launch is deferred", async function () {
      const { presale, token, router, carol, wallets } = await loadFixture(softCapFixture);
      const params = await presale.getParams();
      await ethers.provider.send("hardhat_impersonateAccount", [DEAD]);
      await ethers.provider.send("hardhat_setBalance", [DEAD, "0x" + E(1).toString(16)]);
      const dead = await ethers.getSigner(DEAD);
      await token.connect(dead).transfer(carol.address, E(1000));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [DEAD]);
      await token.connect(carol).approve(router.target, E(1000));
      await router
        .connect(carol)
        .addLiquidityETH(token.target, E(1000), 0, 0, carol.address, (await time.latest()) + 600, { value: E(0.0001) });

      await time.increaseTo(params.endTime + 1n);
      const tx = presale.connect(wallets[0]).claim();
      await expect(tx).to.emit(presale, "AutoLaunchDeferred");
      await expect(tx).to.not.emit(presale, "Claimed");
      expect(await presale.state()).to.equal(Active);
      expect(await presale.contributionOf(wallets[0].address)).to.equal(E(0.02));
    });

    it("reports the schedule through the lens", async function () {
      const { lens, presale, carol } = await loadFixture(softCapFixture);
      const params = await presale.getParams();
      let v = await lens.presaleView(presale.target);
      expect(v.quick).to.equal(true);
      expect(v.creator).to.equal(carol.address);
      expect(v.creatorShareBps).to.equal(500);
      expect(v.buyTaxBps).to.equal(0);
      expect(v.sellTaxBps).to.equal(0);
      expect(v.launchTime).to.equal(params.endTime);
      expect(v.readyToFinalize).to.equal(false);
      expect(v.distributed).to.equal(0);
      expect(v.participantsTotal).to.equal(13);

      await time.increaseTo(params.endTime + 1n);
      v = await lens.presaleView(presale.target);
      expect(v.launchDue).to.equal(true);
      expect(v.readyToFinalize).to.equal(true);
      await presale.finalize(0, 0);
      v = await lens.presaleView(presale.target);
      expect(v.distributed).to.equal(13);
      expect(v.status).to.equal(5);
      expect((await lens.launchView(presale.target)).quick).to.equal(true);
      expect((await lens.presaleMomentum(presale.target, 0)).quick).to.equal(true);
    });
  });

  describe("soft cap missed", function () {
    it("refunds everyone in full and never launches", async function () {
      const { presale, wallets, keeper, dave } = await loadFixture(quickFixture);
      await contributeAll(presale, wallets.slice(0, 5), E(0.02)); // 0.1 of 0.25 ETH
      const params = await presale.getParams();
      await time.increaseTo(params.endTime + 1n);

      expect(await presale.status()).to.equal(Failed);
      expect(await presale.isReadyToFinalize()).to.equal(false);
      await expect(presale.connect(dave).finalize(0, 0)).to.be.revertedWith("not authorized to launch");
      await expect(presale.connect(keeper).finalize(0, 0)).to.be.revertedWith("softcap not met");
      await expect(presale.connect(wallets[0]).claim()).to.be.revertedWith("not finalized");
      await expect(presale.distribute(100)).to.be.revertedWith("not finalized");

      for (const w of wallets.slice(0, 5)) {
        await expect(presale.connect(w).claimRefund()).to.changeEtherBalances([w, presale], [E(0.02), -E(0.02)]);
      }
      expect(await ethers.provider.getBalance(presale.target)).to.equal(0);
    });
  });

  // ------------------------------------------------------------ creator tax

  // The Tax type: a creator tax on DEX buys and sells (0 to 5% per side) on top of the platform
  // tax. The token is a TaxToken whose marketing wallet is the tax wallet (the creator by
  // default); the ownership is renounced at launch, so the taxes and the wallet are fixed forever.
  describe("creator tax", function () {
    const BUY_TAX = 200n;
    const SELL_TAX = 300n;

    async function taxedFixture() {
      const env = await deployPlatform();
      const sale = await launchQuick(env, { name: "Hood Tax", symbol: "HTAX", tokenType: TYPE.Tax, buyTax: 200, sellTax: 300 });
      const wallets = await fundedWallets(env, 50, 0.05);
      return { ...env, ...sale, wallets };
    }

    // 49 wallets at the maximum, the 50th fills the cap and launches the sale
    async function taxedLaunchedFixture() {
      const f = await loadFixture(taxedFixture);
      await contributeAll(f.presale, f.wallets.slice(0, 49), E(0.02));
      await f.presale.connect(f.wallets[49]).contribute({ value: E(0.0195) });
      await f.presale.distribute(100);
      return f;
    }

    it("creates a TaxToken paid to the creator, with the taxes fixed and no owner", async function () {
      const { quickLaunch, tokenFactory, lens, presaleFactory, token, presale, carol, launched } =
        await loadFixture(taxedFixture);

      expect((await tokenFactory.infoOf(token.target)).tokenType).to.equal(1); // Tax
      expect(await token.marketingWallet()).to.equal(carol.address);
      expect(await token.buyTaxBps()).to.equal(BUY_TAX);
      expect(await token.sellTaxBps()).to.equal(SELL_TAX);
      expect(await token.platformTaxBps()).to.equal(PLATFORM_TAX);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      // Nobody can change the taxes or the wallet, the creator included
      await expect(token.connect(carol).setTaxes(0, 0)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
      await expect(token.connect(carol).setMarketingWallet(carol.address)).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );

      // Recorded on QuickLaunch, in the event and through the lens
      const rec = await quickLaunch.quickTokenOf(presale.target);
      expect(rec.tokenType).to.equal(TYPE.Tax);
      expect(rec.rewardToken).to.equal(ethers.ZeroAddress);
      expect(rec.taxWallet).to.equal(carol.address);
      expect([rec.buyTaxBps, rec.sellTaxBps, rec.rewardsBuyBps, rec.rewardsSellBps]).to.deep.equal([BUY_TAX, SELL_TAX, 0n, 0n]);
      expect(launched.tokenType).to.equal(TYPE.Tax);
      expect(launched.rewardToken).to.equal(ethers.ZeroAddress);
      expect(launched.buyTaxBps).to.equal(BUY_TAX);
      expect(launched.sellTaxBps).to.equal(SELL_TAX);
      const v = await lens.presaleView(presale.target);
      expect(v.quick).to.equal(true);
      expect(v.tokenType).to.equal(1);
      expect(v.rewardToken).to.equal(ethers.ZeroAddress);
      expect(v.buyTaxBps).to.equal(BUY_TAX);
      expect(v.sellTaxBps).to.equal(SELL_TAX);
      const [views] = await lens.presaleViews(0, 10, 255);
      expect(views[0].buyTaxBps).to.equal(BUY_TAX);
      expect((await lens.presaleMomentum(presale.target, 0)).sellTaxBps).to.equal(SELL_TAX);

      // Everything else is the quick sale as usual
      expect(await presaleFactory.isQuick(presale.target)).to.equal(true);
      expect(await presale.creatorShareBps()).to.equal(500);
      expect(await token.isExcludedFromFees(presale.target)).to.equal(true);
    });

    it("burns the surplus and writes the profile and the tokenomics like a standard quick token", async function () {
      const { presaleFactory, quickLaunch, metadataRegistry, token, presale } = await loadFixture(taxedFixture);
      const required = await presaleFactory.requiredTokensFor((await presale.getParams()).toObject());
      expect(await token.balanceOf(presale.target)).to.equal(required);
      expect(await token.balanceOf(DEAD)).to.equal(TOTAL_SUPPLY - required);
      expect(await token.balanceOf(quickLaunch.target)).to.equal(0);
      expect((await metadataRegistry.metadataOf(token.target)).logoURI).to.equal("ipfs://flash-logo");
      expect(await metadataRegistry.hasTokenomics(token.target)).to.equal(true);
    });

    it("accepts the 5% cap per side and rejects 5.01%", async function () {
      const env = await loadFixture(deployPlatform);
      await expectLaunchRevert(env, { tokenType: TYPE.Tax, buyTax: 501, sellTax: 500 }, "creator tax too high");
      await expectLaunchRevert(env, { tokenType: TYPE.Tax, buyTax: 500, sellTax: 501 }, "creator tax too high");
      const { token } = await launchQuick(env, { tokenType: TYPE.Tax, buyTax: 500, sellTax: 500 });
      expect(await token.buyTaxBps()).to.equal(500);
      expect(await token.sellTaxBps()).to.equal(500);
      // Only one side taxed is fine
      const other = await launchQuick(env, { creator: env.dave, name: "One", symbol: "ONE", tokenType: TYPE.Tax, buyTax: 0, sellTax: 100 });
      expect((await env.tokenFactory.infoOf(other.token.target)).tokenType).to.equal(1);
      expect(await other.token.buyTaxBps()).to.equal(0);
    });

    it("launches automatically and delivers the tokens untaxed", async function () {
      const { presale, token, wallets, weth } = await loadFixture(taxedFixture);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      const tx = presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await expect(tx).to.emit(presale, "Finalized");
      await expect(tx).to.emit(presale, "AutoLaunched").withArgs(E(0.9995));
      await expect(tx).to.emit(presale, "Distributed").withArgs(20);
      expect(await presale.status()).to.equal(Finalized);

      // The liquidity reached the pool in full: the sale contract is fee exempt
      const p = await presale.getParams();
      const gross = E(0.9995);
      const liquidityEth = ((gross - gross / 10n) * BigInt(p.liquidityBps)) / BPS;
      const pair = await ethers.getContractAt("MockPair", await token.mainPair());
      expect(await weth.balanceOf(pair.target)).to.equal(liquidityEth);
      expect(await token.balanceOf(pair.target)).to.equal((liquidityEth * p.listingRate) / E(1));
      expect(await pair.balanceOf(DEAD)).to.equal(await presale.lpAmount());
      expect(await token.pendingMarketingTokens()).to.equal(0);
      expect(await token.pendingPlatformTokens()).to.equal(0);

      // Delivery: every participant gets the full amount, inline and in batches
      const perWallet = E(0.02) * 500_000_000n;
      expect(await token.balanceOf(wallets[0].address)).to.equal(perWallet);
      await expect(presale.distribute(100)).to.emit(presale, "Distributed").withArgs(30);
      expect(await token.balanceOf(wallets[48].address)).to.equal(perWallet);
      expect(await token.balanceOf(wallets[49].address)).to.equal(E(0.0195) * 500_000_000n);
      expect(await presale.distributionComplete()).to.equal(true);
      expect(await token.balanceOf(presale.target)).to.equal(0);
    });

    it("takes the platform and the creator tax on DEX buys and sells and pays the creator after the swap-back", async function () {
      const { token, router, weth, treasury, carol, dave, wallets } = await loadFixture(taxedLaunchedFixture);

      // Buy: 2% creator + 0.25% platform stay in the token contract, the rest reaches the buyer
      const ethIn = E(0.2);
      const [, out] = await router.getAmountsOut(ethIn, [weth.target, token.target]);
      await router
        .connect(dave)
        .swapExactETHForTokens(0, [weth.target, token.target], dave.address, await swapDeadline(), { value: ethIn });
      const platformFee = (out * PLATFORM_TAX) / BPS;
      const creatorFee = (out * BUY_TAX) / BPS;
      expect(await token.balanceOf(dave.address)).to.equal(out - platformFee - creatorFee);
      expect(await token.pendingPlatformTokens()).to.equal(platformFee);
      expect(await token.pendingMarketingTokens()).to.equal(creatorFee);
      // Enough accumulated for the next sell to trigger the swap-back
      expect(platformFee + creatorFee).to.be.gte(await token.swapThreshold());

      // Sell: the swap-back runs first (ETH to the creator and the Treasury), then 3% + 0.25% is taken
      const seller = wallets[0];
      const amount = await token.balanceOf(seller.address);
      const pendingP = await token.pendingPlatformTokens();
      const pendingM = await token.pendingMarketingTokens();
      const creatorBefore = await ethers.provider.getBalance(carol.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.target);
      const pairTokensBefore = await token.balanceOf(await token.mainPair());
      await token.connect(seller).approve(router.target, amount);
      const tx = router
        .connect(seller)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          amount,
          0,
          [token.target, weth.target],
          seller.address,
          await swapDeadline()
        );
      await expect(tx).to.emit(token, "SwapBack");
      const receipt = await (await tx).wait();
      const swapBack = receipt.logs
        .map((l) => {
          try {
            return token.interface.parseLog(l);
          } catch (e) {
            return null;
          }
        })
        .find((e) => e && e.name === "SwapBack");
      expect(swapBack.args.tokensSwapped).to.equal(pendingP + pendingM);
      const ethGained = swapBack.args.ethReceived;
      expect(ethGained).to.be.gt(0);
      const creatorEth = (ethGained * pendingM) / (pendingP + pendingM);
      expect((await ethers.provider.getBalance(carol.address)) - creatorBefore).to.equal(creatorEth);
      expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.equal(ethGained - creatorEth);

      // The sell itself: 3% creator + 0.25% platform kept, the rest went to the pool
      const sellPlatform = (amount * PLATFORM_TAX) / BPS;
      const sellCreator = (amount * SELL_TAX) / BPS;
      expect(await token.pendingPlatformTokens()).to.equal(sellPlatform);
      expect(await token.pendingMarketingTokens()).to.equal(sellCreator);
      expect(await token.balanceOf(seller.address)).to.equal(0);
      // Pool tokens: the swap-back sold pendingP + pendingM into it, the seller added the net amount
      expect((await token.balanceOf(await token.mainPair())) - pairTokensBefore).to.equal(
        pendingP + pendingM + amount - sellPlatform - sellCreator
      );
      // Wallet to wallet stays untaxed
      await expect(token.connect(dave).transfer(wallets[1].address, E(1000))).to.changeTokenBalances(
        token,
        [dave, wallets[1]],
        [-E(1000), E(1000)]
      );
    });

    it("refunds everyone in full when the soft cap is missed", async function () {
      const { presale, wallets } = await loadFixture(taxedFixture);
      await contributeAll(presale, wallets.slice(0, 5), E(0.02));
      await time.increaseTo((await presale.getParams()).endTime + 1n);
      expect(await presale.status()).to.equal(Failed);
      for (const w of wallets.slice(0, 5)) {
        await expect(presale.connect(w).claimRefund()).to.changeEtherBalances([w, presale], [E(0.02), -E(0.02)]);
      }
      expect(await ethers.provider.getBalance(presale.target)).to.equal(0);
    });
  });

  // ------------------------------------------------------------ tax wallet

  // The creator names the wallet the tax is paid to; zero means the creator. It is the token's
  // marketing wallet and, like the taxes, it never changes.
  describe("tax wallet", function () {
    it("pays a Tax token's creator tax to the chosen wallet after the swap-back", async function () {
      const env = await loadFixture(deployPlatform);
      const { dave, carol, bob, treasury, quickLaunch } = env;
      const { token, presale, launched } = await launchQuick(env, {
        name: "Hood Wallet", symbol: "HWAL", tokenType: TYPE.Tax, buyTax: 300, sellTax: 300, taxWallet: dave.address,
      });
      expect(await token.marketingWallet()).to.equal(dave.address);
      expect((await quickLaunch.quickTokenOf(presale.target)).taxWallet).to.equal(dave.address);
      expect(launched.creator).to.equal(carol.address);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);

      // Launch, deliver, then a buy accumulates the taxes and a sell pays dave
      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await presale.distribute(100);
      await buy(env, token, bob, E(0.2));
      const pendingM = await token.pendingMarketingTokens();
      const pendingP = await token.pendingPlatformTokens();
      expect(pendingM).to.be.gt(0);
      expect(pendingM + pendingP).to.be.gte(await token.swapThreshold());
      const daveBefore = await ethers.provider.getBalance(dave.address);
      const carolBefore = await ethers.provider.getBalance(carol.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.target);
      const receipt = await (await sell(env, token, wallets[0], await token.balanceOf(wallets[0].address))).wait();
      const swapBack = findEvent(receipt, token.interface, "SwapBack");
      const marketingEth = (swapBack.args.ethReceived * pendingM) / (pendingP + pendingM);
      expect(marketingEth).to.be.gt(0);
      expect((await ethers.provider.getBalance(dave.address)) - daveBefore).to.equal(marketingEth);
      expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.equal(swapBack.args.ethReceived - marketingEth);
      // The creator is not the tax wallet here and gets nothing from the tax
      expect(await ethers.provider.getBalance(carol.address)).to.equal(carolBefore);
    });

    it("defaults to the creator when the wallet is zero", async function () {
      const env = await loadFixture(deployPlatform);
      const { token, presale } = await launchQuick(env, {
        creator: env.dave, tokenType: TYPE.Tax, buyTax: 100, sellTax: 100, taxWallet: ethers.ZeroAddress,
      });
      expect(await token.marketingWallet()).to.equal(env.dave.address);
      expect((await env.quickLaunch.quickTokenOf(presale.target)).taxWallet).to.equal(env.dave.address);
    });
  });

  // ------------------------------------------------------------ rewards type

  // The Rewards type: holders earn rewards in an allowlisted token (WETH here), 1% to 5% per side,
  // plus an optional marketing tax to the tax wallet. The token stays owned by QuickLaunch, which
  // only forwards distributeRewards; nothing about the token can change.
  describe("rewards type", function () {
    const REWARDS_BUY = 300n;
    const REWARDS_SELL = 300n;
    const MARKETING_BUY = 100n;
    const MARKETING_SELL = 100n;

    async function rewardsFixture() {
      const env = await deployPlatform();
      const sale = await launchQuick(env, {
        name: "Hood Yield", symbol: "HYLD", tokenType: TYPE.Rewards, rewardToken: env.weth.target,
        taxWallet: env.dave.address, buyTax: 100, sellTax: 100, rewardsBuy: 300, rewardsSell: 300,
      });
      const wallets = await fundedWallets(env, 50, 0.05);
      return { ...env, ...sale, wallets };
    }

    // 49 wallets at the maximum, the 50th fills the cap and launches the sale; delivery complete
    async function rewardsLaunchedFixture() {
      const f = await loadFixture(rewardsFixture);
      await contributeAll(f.presale, f.wallets.slice(0, 49), E(0.02));
      await f.presale.connect(f.wallets[49]).contribute({ value: E(0.0195) });
      await f.presale.distribute(100);
      return f;
    }

    it("creates a RewardsToken with the chosen taxes, wallet and reward token, owned by QuickLaunch", async function () {
      const { quickLaunch, tokenFactory, lens, token, presale, carol, dave, weth, launched } = await loadFixture(rewardsFixture);
      const info = await tokenFactory.infoOf(token.target);
      expect(info.tokenType).to.equal(2); // Rewards
      expect(info.rewardToken).to.equal(weth.target);
      expect(await token.rewardToken()).to.equal(weth.target);
      expect(await token.marketingWallet()).to.equal(dave.address);
      expect(await token.rewardsBuyTaxBps()).to.equal(REWARDS_BUY);
      expect(await token.rewardsSellTaxBps()).to.equal(REWARDS_SELL);
      expect(await token.marketingBuyTaxBps()).to.equal(MARKETING_BUY);
      expect(await token.marketingSellTaxBps()).to.equal(MARKETING_SELL);
      expect(await token.platformTaxBps()).to.equal(PLATFORM_TAX);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      // The owner is QuickLaunch (distributeRewards is owner-or-platform), not renounced
      expect(await token.owner()).to.equal(quickLaunch.target);
      // Default route: token -> WETH, the reward token itself
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target]);
      expect((await token.rewardRoute()).length).to.equal(0);

      // Recorded on QuickLaunch, in the event and through the lens
      const rec = await quickLaunch.quickTokenOf(presale.target);
      expect(rec.tokenType).to.equal(TYPE.Rewards);
      expect(rec.rewardToken).to.equal(weth.target);
      expect(rec.taxWallet).to.equal(dave.address);
      expect([rec.buyTaxBps, rec.sellTaxBps, rec.rewardsBuyBps, rec.rewardsSellBps]).to.deep.equal([
        MARKETING_BUY, MARKETING_SELL, REWARDS_BUY, REWARDS_SELL,
      ]);
      expect(launched.tokenType).to.equal(TYPE.Rewards);
      expect(launched.rewardToken).to.equal(weth.target);
      expect(launched.buyTaxBps).to.equal(MARKETING_BUY);
      expect(launched.sellTaxBps).to.equal(MARKETING_SELL);
      expect(launched.rewardsBuyBps).to.equal(REWARDS_BUY);
      expect(launched.rewardsSellBps).to.equal(REWARDS_SELL);
      expect(launched.creator).to.equal(carol.address);
      const v = await lens.presaleView(presale.target);
      expect(v.quick).to.equal(true);
      expect(v.tokenType).to.equal(2);
      expect(v.rewardToken).to.equal(weth.target);
      expect(v.buyTaxBps).to.equal(REWARDS_BUY + MARKETING_BUY);
      expect(v.sellTaxBps).to.equal(REWARDS_SELL + MARKETING_SELL);
      expect(v.creator).to.equal(carol.address);
      expect((await lens.launchView(presale.target)).buyTaxBps).to.equal(REWARDS_BUY + MARKETING_BUY);
    });

    it("burns the surplus, writes the profile and excludes the sale from fees and rewards", async function () {
      const { presaleFactory, quickLaunch, metadataRegistry, token, presale } = await loadFixture(rewardsFixture);
      const required = await presaleFactory.requiredTokensFor((await presale.getParams()).toObject());
      expect(await token.balanceOf(presale.target)).to.equal(required);
      expect(await token.balanceOf(DEAD)).to.equal(TOTAL_SUPPLY - required);
      expect(await token.balanceOf(quickLaunch.target)).to.equal(0);
      expect((await metadataRegistry.metadataOf(token.target)).logoURI).to.equal("ipfs://flash-logo");
      expect(await metadataRegistry.hasTokenomics(token.target)).to.equal(true);
      expect(await token.isExcludedFromFees(presale.target)).to.equal(true);
      expect(await token.isExcludedFromRewards(presale.target)).to.equal(true);
      expect(await token.isExcludedFromRewards(DEAD)).to.equal(true);
      // Nobody holds shares before the launch: the sale and the dead address are excluded
      expect(await token.totalShares()).to.equal(0);
      expect(await token.sharesOf(quickLaunch.target)).to.equal(0);
    });

    it("launches automatically, delivers untaxed tokens and gives every holder a share", async function () {
      const { presale, token, wallets, weth } = await loadFixture(rewardsFixture);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      const tx = presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await expect(tx).to.emit(presale, "Finalized");
      await expect(tx).to.emit(presale, "Distributed").withArgs(20);
      expect(await presale.status()).to.equal(Finalized);

      // The liquidity reached the pool in full
      const p = await presale.getParams();
      const gross = E(0.9995);
      const liquidityEth = ((gross - gross / 10n) * BigInt(p.liquidityBps)) / BPS;
      const pair = await ethers.getContractAt("MockPair", await token.mainPair());
      expect(await weth.balanceOf(pair.target)).to.equal(liquidityEth);
      expect(await token.balanceOf(pair.target)).to.equal((liquidityEth * p.listingRate) / E(1));
      expect(await pair.balanceOf(DEAD)).to.equal(await presale.lpAmount());
      expect(await token.pendingRewardsTokens()).to.equal(0);
      expect(await token.pendingMarketingTokens()).to.equal(0);
      expect(await token.pendingPlatformTokens()).to.equal(0);
      expect(await token.isExcludedFromRewards(pair.target)).to.equal(true);

      const perWallet = E(0.02) * 500_000_000n;
      expect(await token.balanceOf(wallets[0].address)).to.equal(perWallet);
      expect(await token.sharesOf(wallets[0].address)).to.equal(perWallet);
      await expect(presale.distribute(100)).to.emit(presale, "Distributed").withArgs(30);
      expect(await presale.distributionComplete()).to.equal(true);
      expect(await token.balanceOf(wallets[49].address)).to.equal(E(0.0195) * 500_000_000n);
      expect(await token.totalShares()).to.equal(gross * 500_000_000n);
    });

    it("accrues the rewards and marketing taxes on DEX trades and pays the tax wallet on the swap-back", async function () {
      const { token, weth, router, dave, bob, wallets, treasury } = await loadFixture(rewardsLaunchedFixture);
      const ethIn = E(0.3);
      const [, out] = await router.getAmountsOut(ethIn, [weth.target, token.target]);
      await buy({ router, weth }, token, bob, ethIn);
      const platformFee = (out * PLATFORM_TAX) / BPS;
      const rewardsFee = (out * REWARDS_BUY) / BPS;
      const marketingFee = (out * MARKETING_BUY) / BPS;
      expect(await token.balanceOf(bob.address)).to.equal(out - platformFee - rewardsFee - marketingFee);
      expect(await token.pendingRewardsTokens()).to.equal(rewardsFee);
      expect(await token.pendingMarketingTokens()).to.equal(marketingFee);
      expect(await token.pendingPlatformTokens()).to.equal(platformFee);
      expect(rewardsFee).to.be.gte(await token.swapThreshold());
      expect(platformFee + marketingFee).to.be.gte(await token.swapThreshold()); // the next sell swaps back

      // A sell swaps platform + marketing to ETH (dave gets the marketing part); the rewards stay pending
      const seller = wallets[0];
      const amount = await token.balanceOf(seller.address);
      const daveBefore = await ethers.provider.getBalance(dave.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.target);
      const receipt = await (await sell({ router, weth }, token, seller, amount)).wait();
      const swapBack = findEvent(receipt, token.interface, "SwapBack");
      expect(swapBack.args.tokensSwapped).to.equal(platformFee + marketingFee);
      const marketingEth = (swapBack.args.ethReceived * marketingFee) / (platformFee + marketingFee);
      expect((await ethers.provider.getBalance(dave.address)) - daveBefore).to.equal(marketingEth);
      expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.equal(swapBack.args.ethReceived - marketingEth);
      expect(await token.pendingRewardsTokens()).to.equal(rewardsFee + (amount * REWARDS_SELL) / BPS);
      expect(await token.pendingMarketingTokens()).to.equal((amount * MARKETING_SELL) / BPS);
      // Wallet to wallet stays untaxed and moves the shares
      await expect(token.connect(bob).transfer(wallets[1].address, E(1000))).to.changeTokenBalances(token, [bob, wallets[1]], [-E(1000), E(1000)]);
      expect(await token.sharesOf(wallets[1].address)).to.equal(await token.balanceOf(wallets[1].address));
    });

    it("lets the keeper distribute the rewards through QuickLaunch and the holders claim WETH", async function () {
      const { quickLaunch, token, weth, router, bob, dave, keeper, wallets } = await loadFixture(rewardsLaunchedFixture);
      await buy({ router, weth }, token, bob, E(0.2));
      const pendingRewards = await token.pendingRewardsTokens();
      expect(pendingRewards).to.be.gt(0);
      // The token itself refuses everyone but its owner (QuickLaunch) and the platform
      await expect(token.connect(dave).distributeRewards(0)).to.be.revertedWithCustomError(token, "NotAuthorized");
      await expect(token.connect(wallets[0]).distributeRewards(0)).to.be.revertedWithCustomError(token, "NotAuthorized");
      await expect(token.connect(keeper).distributeRewards(0)).to.be.revertedWithCustomError(token, "NotAuthorized");
      // Only quick rewards tokens go through QuickLaunch
      await expect(quickLaunch.connect(keeper).distributeRewards(weth.target, 0)).to.be.revertedWith("not a quick rewards token");

      const wethBefore = await weth.balanceOf(token.target);
      const tx = quickLaunch.connect(keeper).distributeRewards(token.target, 0);
      await expect(tx).to.emit(token, "RewardsDistributed");
      const receipt = await (await tx).wait();
      const ev = findEvent(receipt, token.interface, "RewardsDistributed");
      expect(ev.args.tokensSwapped).to.equal(pendingRewards);
      const received = ev.args.rewardsReceived;
      expect(received).to.be.gt(0);
      expect(await weth.balanceOf(token.target)).to.equal(wethBefore + received);
      expect(await token.pendingRewardsTokens()).to.equal(0);
      expect(await token.totalRewardsDistributed()).to.equal(received);
      // amountOutMin guards the swap
      await buy({ router, weth }, token, bob, E(0.01));
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, ethers.MaxUint256)).to.be.revertedWith(
        "router: insufficient output"
      );
      await expect(quickLaunch.distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      await expect(quickLaunch.distributeRewards(token.target, 0)).to.be.revertedWith("nothing to distribute");

      // Pro rata: each participant holds 0.02 ETH worth of tokens and gets the same share
      const holder = wallets[0];
      const claimable = await token.withdrawableRewardOf(holder.address);
      expect(claimable).to.be.gt(0);
      expect(await token.withdrawableRewardOf(wallets[1].address)).to.equal(claimable);
      const perShare = await token.magnifiedRewardPerShare();
      expect(claimable).to.equal((perShare * (await token.sharesOf(holder.address))) / (1n << 128n));
      await expect(token.connect(holder).claimRewards()).to.emit(token, "RewardsClaimed").withArgs(holder.address, claimable);
      expect(await weth.balanceOf(holder.address)).to.equal(claimable);
      await expect(token.connect(holder).claimRewards()).to.be.revertedWith("nothing to claim");
      // The buyer holds a share as well; the pool, the sale and the dead address do not
      expect(await token.withdrawableRewardOf(bob.address)).to.be.gt(0);
      expect(await token.sharesOf(await token.mainPair())).to.equal(0);
      expect(await token.sharesOf(DEAD)).to.equal(0);
    });

    // The caller sets the swap floor, so an open call would let anyone sandwich the reward swap
    // with a zero floor: only the owner of QuickLaunch and the platform keeper may distribute
    it("distributeRewards is for QuickLaunch's owner and the platform keeper only", async function () {
      const { quickLaunch, presaleFactory, token, weth, router, deployer, keeper, carol, dave, alice, bob, wallets } =
        await loadFixture(rewardsLaunchedFixture);
      expect(await quickLaunch.owner()).to.equal(deployer.address);
      expect(await presaleFactory.launchKeeper()).to.equal(keeper.address);
      await buy({ router, weth }, token, bob, E(0.2));
      const pending = await token.pendingRewardsTokens();
      expect(pending).to.be.gt(0);
      // A stranger, the creator, the tax wallet and a holder are refused before anything else is
      // looked at, whatever the token argument
      for (const who of [dave, carol, wallets[0], bob]) {
        await expect(quickLaunch.connect(who).distributeRewards(token.target, 0)).to.be.revertedWith("not keeper");
        await expect(quickLaunch.connect(who).distributeRewards(weth.target, 0)).to.be.revertedWith("not keeper");
      }
      expect(await token.marketingWallet()).to.equal(dave.address);
      expect(await quickLaunch.creatorOf(await quickLaunch.presaleOfToken(token.target))).to.equal(carol.address);
      expect(await token.pendingRewardsTokens()).to.equal(pending);
      // The keeper distributes, and so does the owner
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      await buy({ router, weth }, token, bob, E(0.01));
      await expect(quickLaunch.connect(deployer).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      // A new keeper takes over: the old one is a stranger from then on, the owner stays
      await presaleFactory.setLaunchKeeper(alice.address);
      await buy({ router, weth }, token, bob, E(0.01));
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.be.revertedWith("not keeper");
      await expect(quickLaunch.connect(alice).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      await buy({ router, weth }, token, bob, E(0.01));
      await expect(quickLaunch.connect(deployer).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      // No keeper at all: the owner alone
      await presaleFactory.setLaunchKeeper(ethers.ZeroAddress);
      await buy({ router, weth }, token, bob, E(0.01));
      await expect(quickLaunch.connect(alice).distributeRewards(token.target, 0)).to.be.revertedWith("not keeper");
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.be.revertedWith("not keeper");
      await expect(quickLaunch.connect(deployer).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      // The registration of pairs and the route repair stay open: they take no floor
      await expect(quickLaunch.connect(dave).registerAmmPair(token.target, ethers.ZeroAddress)).to.be.revertedWith("zero addr");
      await expect(quickLaunch.connect(dave).repairRewardRoute(token.target)).to.be.revertedWith("route still live");
    });

    it("keeps every parameter fixed: nobody, QuickLaunch's owner included, can change the token", async function () {
      const { quickLaunch, token, deployer, carol, dave, alice } = await loadFixture(rewardsFixture);
      expect(await quickLaunch.owner()).to.equal(deployer.address);
      // QuickLaunch has no function that reaches the token's owner-only setters (its own
      // transferOwnership concerns the allowlist owner, not the tokens; its own setRewardRoute
      // stores the route of future launches per reward token and never touches a launched token)
      for (const name of ["setTaxes", "setMarketingWallet", "setExcludedFromRewards", "excludeFromFees", "setAmmPair", "manualSwapBack"]) {
        expect(quickLaunch.interface.hasFunction(name), name).to.equal(false);
      }
      expect(quickLaunch.interface.getFunction("distributeRewards").inputs.map((i) => i.type)).to.deep.equal(["address", "uint256"]);
      expect(quickLaunch.interface.getFunction("setRewardRoute").inputs.map((i) => i.type)).to.deep.equal(["address", "address[]"]);
      const pathBefore = [...(await token.rewardPath())];
      await quickLaunch.setRewardRoute(await token.rewardToken(), []);
      expect([...(await token.rewardPath())]).to.deep.equal(pathBefore);
      // The token's setters reject everyone else: the creator, the tax wallet, the platform owner
      for (const who of [deployer, carol, dave, alice]) {
        await expect(token.connect(who).setTaxes(0, 0, 0, 0)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
        await expect(token.connect(who).setMarketingWallet(who.address)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
        await expect(token.connect(who).setRewardRoute([])).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
        await expect(token.connect(who).transferOwnership(who.address)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
        await expect(token.connect(who).renounceOwnership()).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
        await expect(token.connect(who).excludeFromFees(who.address, true)).to.be.revertedWithCustomError(token, "NotAuthorized");
        await expect(token.connect(who).setExcludedFromRewards(who.address, true)).to.be.revertedWithCustomError(token, "NotAuthorized");
        await expect(token.connect(who).setAmmPair(who.address, true)).to.be.revertedWithCustomError(token, "NotAuthorized");
        await expect(token.connect(who).manualSwapBack()).to.be.revertedWithCustomError(token, "NotAuthorized");
      }
      expect(await token.owner()).to.equal(quickLaunch.target);
      expect(await token.rewardsBuyTaxBps()).to.equal(REWARDS_BUY);
      expect(await token.marketingWallet()).to.equal(dave.address);
    });

    it("distributes a stock reward through the default token -> WETH -> stock route", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, tokenFactory, router, weth, alice, bob, keeper } = env;
      // A "tokenized stock": any token with its own WETH pool
      await tokenFactory.connect(alice).createStandardToken("tApple", "tAAPL", E(1_000_000));
      const stock = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
      await stock.connect(alice).approve(router.target, E(200_000));
      await router.connect(alice).addLiquidityETH(stock.target, E(200_000), 0, 0, alice.address, await swapDeadline(), { value: E(50) });
      await quickLaunch.setRewardTokenAllowed(stock.target, true);

      const { token, presale } = await launchQuick(env, {
        name: "Hood Stock", symbol: "HSTK", tokenType: TYPE.Rewards, rewardToken: stock.target, rewardsBuy: 200, rewardsSell: 200,
      });
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, stock.target]);
      expect(await token.marketingWallet()).to.equal(env.carol.address); // zero wallet: the creator
      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await presale.distribute(100);
      await buy(env, token, bob, E(0.2));
      expect(await token.pendingRewardsTokens()).to.be.gt(0);

      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      const claimable = await token.withdrawableRewardOf(wallets[0].address);
      expect(claimable).to.be.gt(0);
      await token.connect(wallets[0]).claimRewards();
      expect(await stock.balanceOf(wallets[0].address)).to.equal(claimable);
    });

    it("enforces the rewards caps: 1% to 5% per side including the marketing tax", async function () {
      const env = await loadFixture(deployPlatform);
      const base = { tokenType: TYPE.Rewards, rewardToken: env.weth.target };
      await expectLaunchRevert(env, { ...base, rewardsBuy: 99, rewardsSell: 100 }, "rewards tax too low");
      await expectLaunchRevert(env, { ...base, rewardsBuy: 100, rewardsSell: 0 }, "rewards tax too low");
      await expectLaunchRevert(env, { ...base, rewardsBuy: 501, rewardsSell: 100 }, "creator tax too high");
      await expectLaunchRevert(env, { ...base, rewardsBuy: 100, rewardsSell: 400, sellTax: 101 }, "creator tax too high");
      await expectLaunchRevert(env, { ...base, rewardsBuy: 400, rewardsSell: 100, buyTax: 101 }, "creator tax too high");
      // Reward token missing or not on the allowlist
      await expectLaunchRevert(env, { tokenType: TYPE.Rewards, rewardsBuy: 100, rewardsSell: 100 }, "reward token not allowed");
      await expectLaunchRevert(env, { ...base, rewardToken: env.hoodsale.target, rewardsBuy: 100, rewardsSell: 100 }, "reward token not allowed");
      // The edges are accepted: 5% rewards alone, or 4% rewards + 1% marketing
      const a = await launchQuick(env, { ...base, name: "Max", symbol: "MAX", rewardsBuy: 500, rewardsSell: 500 });
      expect(await a.token.rewardsBuyTaxBps()).to.equal(500);
      expect(await a.token.marketingBuyTaxBps()).to.equal(0);
      const b = await launchQuick(env, { ...base, creator: env.dave, name: "Mix", symbol: "MIX", rewardsBuy: 400, rewardsSell: 100, buyTax: 100, sellTax: 400 });
      expect(await b.token.rewardsSellTaxBps()).to.equal(100);
      expect(await b.token.marketingSellTaxBps()).to.equal(400);
    });

    it("refunds everyone in full when the soft cap is missed", async function () {
      const { presale, wallets } = await loadFixture(rewardsFixture);
      await contributeAll(presale, wallets.slice(0, 5), E(0.02));
      await time.increaseTo((await presale.getParams()).endTime + 1n);
      expect(await presale.status()).to.equal(Failed);
      for (const w of wallets.slice(0, 5)) {
        await expect(presale.connect(w).claimRefund()).to.changeEtherBalances([w, presale], [E(0.02), -E(0.02)]);
      }
    });
  });

  // ------------------------------------------------------------ reward allowlist

  describe("reward token allowlist", function () {
    it("starts with the constructor list and is managed by the owner only", async function () {
      const { quickLaunch, weth, hoodsale, deployer, alice } = await loadFixture(deployPlatform);
      expect(await quickLaunch.owner()).to.equal(deployer.address);
      expect(await quickLaunch.isRewardTokenAllowed(weth.target)).to.equal(true);
      expect(await quickLaunch.isRewardTokenAllowed(hoodsale.target)).to.equal(false);
      expect([...(await quickLaunch.rewardTokens())]).to.deep.equal([weth.target]);
      expect([...(await quickLaunch.initialRewardTokens())]).to.deep.equal([weth.target]);
      expect(await quickLaunch.initialRewardTokenCount()).to.equal(1);

      await expect(quickLaunch.connect(alice).setRewardTokenAllowed(hoodsale.target, true))
        .to.be.revertedWithCustomError(quickLaunch, "OwnableUnauthorizedAccount");
      await expect(quickLaunch.setRewardTokenAllowed(ethers.ZeroAddress, true)).to.be.revertedWith("zero addr");
      await expect(quickLaunch.setRewardTokenAllowed(hoodsale.target, true))
        .to.emit(quickLaunch, "RewardTokenAllowed")
        .withArgs(hoodsale.target, true);
      expect([...(await quickLaunch.rewardTokens())]).to.deep.equal([weth.target, hoodsale.target]);
      // Unchanged values are a no-op, removal keeps the list order for a later re-add
      await expect(quickLaunch.setRewardTokenAllowed(hoodsale.target, true)).to.not.emit(quickLaunch, "RewardTokenAllowed");
      await expect(quickLaunch.setRewardTokenAllowed(weth.target, false)).to.emit(quickLaunch, "RewardTokenAllowed").withArgs(weth.target, false);
      expect([...(await quickLaunch.rewardTokens())]).to.deep.equal([hoodsale.target]);
      await quickLaunch.setRewardTokenAllowed(weth.target, true);
      expect([...(await quickLaunch.rewardTokens())]).to.deep.equal([weth.target, hoodsale.target]);
      expect([...(await quickLaunch.initialRewardTokens())]).to.deep.equal([weth.target]);
    });

    it("removing a reward token blocks new launches but not the tokens already launched", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, weth, bob } = env;
      const { token, presale } = await launchQuick(env, {
        tokenType: TYPE.Rewards, rewardToken: weth.target, rewardsBuy: 300, rewardsSell: 300,
      });
      await quickLaunch.setRewardTokenAllowed(weth.target, false);
      await expectLaunchRevert(env, { creator: env.dave, tokenType: TYPE.Rewards, rewardToken: weth.target, rewardsBuy: 300, rewardsSell: 300 }, "reward token not allowed");
      expect((await quickLaunch.quickTokenOf(presale.target)).rewardToken).to.equal(weth.target);
      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await presale.distribute(100);
      await buy(env, token, bob, E(0.2));
      await expect(quickLaunch.distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
    });

    it("refuses a reward token whose swap route has no pool with reserves", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, weth, hoodsale, router, deployer } = env;
      expect(await quickLaunch.isRewardRouteLive(weth.target)).to.equal(true);
      expect([...(await quickLaunch.rewardPathOf(weth.target))]).to.deep.equal([weth.target]);
      // HOODSALE opened its WETH pair at deployment, but the pool is empty
      await quickLaunch.setRewardTokenAllowed(hoodsale.target, true);
      expect([...(await quickLaunch.rewardPathOf(hoodsale.target))]).to.deep.equal([weth.target, hoodsale.target]);
      expect(await quickLaunch.isRewardRouteLive(hoodsale.target)).to.equal(false);
      await expectLaunchRevert(env, { tokenType: TYPE.Rewards, rewardToken: hoodsale.target, rewardsBuy: 100, rewardsSell: 100 }, "reward route has no pool");
      // A token without any pair
      const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 10_000_000n * 10n ** 6n]);
      await quickLaunch.setRewardTokenAllowed(usdg.target, true);
      expect(await quickLaunch.isRewardRouteLive(usdg.target)).to.equal(false);
      await expectLaunchRevert(env, { tokenType: TYPE.Rewards, rewardToken: usdg.target, rewardsBuy: 100, rewardsSell: 100 }, "reward route has no pool");
      // Liquidity makes it live and the launch goes through with the default route
      const dex = await ethers.getContractAt("MockFactory", await router.factory());
      await dex.createPair(usdg.target, weth.target);
      await usdg.approve(router.target, 1_000_000n * 10n ** 6n);
      await router.addLiquidityETH(usdg.target, 1_000_000n * 10n ** 6n, 0, 0, deployer.address, await swapDeadline(), { value: E(500) });
      expect(await quickLaunch.isRewardRouteLive(usdg.target)).to.equal(true);
      const { token } = await launchQuick(env, { tokenType: TYPE.Rewards, rewardToken: usdg.target, rewardsBuy: 100, rewardsSell: 100 });
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, usdg.target]);
    });

    it("lets the owner route a stock through USDG: launch sets the route once and the rewards arrive through four hops", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, tokenFactory, router, weth, deployer, alice, bob, keeper } = env;
      const dex = await ethers.getContractAt("MockFactory", await router.factory());
      // A mock USDG with a deep WETH pool
      const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 10_000_000n * 10n ** 6n]);
      await dex.createPair(usdg.target, weth.target);
      await usdg.approve(router.target, 1_000_000n * 10n ** 6n);
      await router.addLiquidityETH(usdg.target, 1_000_000n * 10n ** 6n, 0, 0, deployer.address, await swapDeadline(), { value: E(500) });
      // A "tokenized stock" whose only pool is against USDG (its WETH pair exists and stays empty)
      await tokenFactory.connect(alice).createStandardToken("tTesla", "tTSLA", E(1_000_000));
      const stock = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
      await dex.createPair(stock.target, usdg.target);
      const pair = await ethers.getContractAt("MockPair", await dex.getPair(stock.target, usdg.target));
      await stock.connect(alice).transfer(pair.target, E(100_000));
      await usdg.transfer(pair.target, 500_000n * 10n ** 6n);
      await pair.mint(deployer.address);
      await quickLaunch.setRewardTokenAllowed(stock.target, true);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false); // the WETH pool is empty
      await expectLaunchRevert(env, { tokenType: TYPE.Rewards, rewardToken: stock.target, rewardsBuy: 200, rewardsSell: 200 }, "reward route has no pool");

      // The route is owner-managed and validated like RewardsToken.setRewardRoute
      await expect(quickLaunch.connect(alice).setRewardRoute(stock.target, [weth.target, usdg.target]))
        .to.be.revertedWithCustomError(quickLaunch, "OwnableUnauthorizedAccount");
      await expect(quickLaunch.setRewardRoute(ethers.ZeroAddress, [weth.target])).to.be.revertedWith("zero addr");
      await expect(quickLaunch.setRewardRoute(stock.target, [usdg.target])).to.be.revertedWith("route must start at WETH");
      await expect(quickLaunch.setRewardRoute(stock.target, [weth.target, stock.target])).to.be.revertedWith("bad hop");
      await expect(quickLaunch.setRewardRoute(stock.target, [weth.target, ethers.ZeroAddress])).to.be.revertedWith("bad hop");
      await expect(quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target, usdg.target, usdg.target])).to.be.revertedWith("route too long");
      await expect(quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target]))
        .to.emit(quickLaunch, "RewardRouteSet")
        .withArgs(stock.target, [weth.target, usdg.target]);
      expect([...(await quickLaunch.rewardRouteOf(stock.target))]).to.deep.equal([weth.target, usdg.target]);
      expect([...(await quickLaunch.rewardPathOf(stock.target))]).to.deep.equal([weth.target, usdg.target, stock.target]);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);

      const { token, presale } = await launchQuick(env, {
        name: "Hood Stock", symbol: "HSTK", tokenType: TYPE.Rewards, rewardToken: stock.target, rewardsBuy: 200, rewardsSell: 200,
      });
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, usdg.target, stock.target]);
      expect(await token.owner()).to.equal(quickLaunch.target);
      // A later route change only concerns future launches
      await quickLaunch.setRewardRoute(stock.target, []);
      expect((await quickLaunch.rewardRouteOf(stock.target)).length).to.equal(0);
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, usdg.target, stock.target]);

      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await presale.distribute(100);
      await buy(env, token, bob, E(0.2));
      const stockBefore = await stock.balanceOf(token.target);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      expect(await stock.balanceOf(token.target)).to.be.gt(stockBefore);
      const claimable = await token.withdrawableRewardOf(wallets[0].address);
      expect(claimable).to.be.gt(0);
      await token.connect(wallets[0]).claimRewards();
      expect(await stock.balanceOf(wallets[0].address)).to.equal(claimable);
    });

    it("rejects a zero address and duplicates in the constructor list", async function () {
      const { tokenFactory, presaleFactory, metadataRegistry, weth } = await loadFixture(deployPlatform);
      const args = [tokenFactory.target, presaleFactory.target, metadataRegistry.target];
      await expect(ethers.deployContract("QuickLaunch", [...args, [ethers.ZeroAddress], ethers.ZeroAddress])).to.be.revertedWith("zero addr");
      await expect(ethers.deployContract("QuickLaunch", [...args, [weth.target, weth.target], ethers.ZeroAddress])).to.be.revertedWith("duplicate reward token");
      const empty = await ethers.deployContract("QuickLaunch", [...args, [], ethers.ZeroAddress]);
      expect((await empty.rewardTokens()).length).to.equal(0);
      expect(await empty.initialRewardTokenCount()).to.equal(0);
    });
  });

  // ------------------------------------------------------------ route depth

  // isRewardRouteLive needs more than an existing pool: a swap of ten probes (ROUTE_PROBE_WETH)
  // along the route must keep at least half the per-probe rate, which a pool holding dust cannot.
  describe("route depth", function () {
    const REWARDS = { tokenType: TYPE.Rewards, rewardsBuy: 100, rewardsSell: 100 };

    async function quotes(router, path) {
      const probe = E(0.01);
      const one = (await router.getAmountsOut(probe, path))[path.length - 1];
      const ten = (await router.getAmountsOut(probe * 10n, path))[path.length - 1];
      return { one, ten };
    }

    it("refuses a reward token whose WETH pool only holds dust and accepts it once the pool is deep", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, router, weth, deployer } = env;
      expect(await quickLaunch.ROUTE_PROBE_WETH()).to.equal(E(0.01));
      expect(await quickLaunch.isRewardRouteLive(weth.target)).to.equal(true);

      const dex = await ethers.getContractAt("MockFactory", await router.factory());
      const dusty = await ethers.deployContract("MockERC20", ["Dusty", "DUST", 18, E(100_000_000)]);
      await dex.createPair(dusty.target, weth.target);
      await dusty.approve(router.target, ethers.MaxUint256);
      // 0.001 ETH against 1000 tokens: reserves on both sides, but one 0.01 ETH probe already
      // takes most of the pool, so ten probes get nowhere near five times the output of one
      await router.addLiquidityETH(dusty.target, E(1000), 0, 0, deployer.address, await swapDeadline(), { value: E(0.001) });
      await quickLaunch.setRewardTokenAllowed(dusty.target, true);
      const pair = await ethers.getContractAt("MockPair", await dex.getPair(dusty.target, weth.target));
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.be.gt(0);
      expect(r1).to.be.gt(0);
      const path = [weth.target, dusty.target];
      const dust = await quotes(router, path);
      expect(dust.one).to.be.gt(0);
      expect(dust.ten).to.be.lt(dust.one * 5n);
      expect(await quickLaunch.isRewardRouteLive(dusty.target)).to.equal(false);
      await expectLaunchRevert(env, { ...REWARDS, rewardToken: dusty.target }, "reward route has no pool");

      // Real depth at the same price: 50 ETH against 50,000,000 tokens
      await router.addLiquidityETH(dusty.target, E(50_000_000), 0, 0, deployer.address, await swapDeadline(), { value: E(50) });
      const deep = await quotes(router, path);
      expect(deep.ten).to.be.gte(deep.one * 5n);
      expect(await quickLaunch.isRewardRouteLive(dusty.target)).to.equal(true);
      const { token } = await launchQuick(env, { ...REWARDS, name: "Dust Yield", symbol: "DYLD", rewardToken: dusty.target });
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, dusty.target]);
    });

    it("checks every pool of a stored route, not only the first", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, router, weth, deployer } = env;
      const dex = await ethers.getContractAt("MockFactory", await router.factory());
      // A deep USDG pool, then a stock whose USDG pool holds dust
      const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 10_000_000n * 10n ** 6n]);
      await dex.createPair(usdg.target, weth.target);
      await usdg.approve(router.target, ethers.MaxUint256);
      await router.addLiquidityETH(usdg.target, 1_000_000n * 10n ** 6n, 0, 0, deployer.address, await swapDeadline(), { value: E(500) });
      const stock = await ethers.deployContract("MockERC20", ["tNvidia", "tNVDA", 18, E(1_000_000)]);
      await dex.createPair(stock.target, usdg.target);
      const pair = await ethers.getContractAt("MockPair", await dex.getPair(stock.target, usdg.target));
      await stock.transfer(pair.target, E(0.001));
      await usdg.transfer(pair.target, 5n * 10n ** 6n);
      await pair.mint(deployer.address);
      await quickLaunch.setRewardTokenAllowed(stock.target, true);
      await quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target]);
      expect(await quickLaunch.isRewardRouteLive(usdg.target)).to.equal(true);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await expectLaunchRevert(env, { ...REWARDS, rewardToken: stock.target }, "reward route has no pool");
      // Depth in the second pool makes the whole route live
      await stock.transfer(pair.target, E(100_000));
      await usdg.transfer(pair.target, 500_000n * 10n ** 6n);
      await pair.mint(deployer.address);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);
    });
  });

  // ------------------------------------------------------------ V3 reward routes

  // On Robinhood Chain the tokenized stocks trade on Uniswap V3. The owner stores a packed V3
  // path (WETH first, the reward token last) per reward token; a launch applies it to the token,
  // whose reward swap then leaves through its own V2 pool and continues on SwapRouter02.
  describe("V3 reward routes", function () {
    const REWARDS = { tokenType: TYPE.Rewards, rewardsBuy: 200, rewardsSell: 200 };
    const USDG_UNIT = 10n ** 6n;

    /** A packed Uniswap V3 path: token, fee, token, fee, token ... */
    function packPath(...route) {
      return ethers.solidityPacked(route.map((_, i) => (i % 2 === 0 ? "address" : "uint24")), route);
    }

    async function v3Pool(env, tokenA, tokenB, fee) {
      await env.v3Factory.createPool(tokenA.target, tokenB.target, fee);
      return ethers.getContractAt("MockV3Pool", await env.v3Factory.getPool(tokenA.target, tokenB.target, fee));
    }

    /** Adds liquidity to a mock V3 pool from the deployer: both tokens transferred, then sync(). */
    async function fillV3(env, pool, tokenA, amountA, tokenB, amountB) {
      for (const [t, amount] of [[tokenA, amountA], [tokenB, amountB]]) {
        if (t.target === env.weth.target) await env.weth.deposit({ value: amount });
        await t.transfer(pool.target, amount);
      }
      await pool.sync();
    }

    async function quotesV3(quoter, path) {
      const probe = E(0.01);
      const one = (await quoter.quoteExactInput.staticCall(path, probe))[0];
      const ten = (await quoter.quoteExactInput.staticCall(path, probe * 10n))[0];
      return { one, ten };
    }

    async function fillSale(env, presale) {
      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await presale.distribute(100);
      return wallets;
    }

    /** The ETH the token's rewards accrual swaps to on V2, then the V3 quote for it. */
    async function rewardQuote(env, token, path) {
      const pending = await token.pendingRewardsTokens();
      const [, ethOut] = await env.router.getAmountsOut(pending, [token.target, env.weth.target]);
      const quote = (await env.v3Quoter.quoteExactInput.staticCall(path, ethOut))[0];
      return { pending, ethOut, quote };
    }

    // A mock stock and USDG, an empty WETH/stock V3 pool at 0.3%, the stock allowlisted
    async function v3StockFixture() {
      const env = await deployPlatform();
      const stock = await ethers.deployContract("MockERC20", ["tTesla", "tTSLA", 18, E(100_000_000)]);
      const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 100_000_000n * USDG_UNIT]);
      const pool = await v3Pool(env, env.weth, stock, 3000);
      await env.quickLaunch.setRewardTokenAllowed(stock.target, true);
      const path = packPath(env.weth.target, 3000, stock.target);
      return { ...env, stock, usdg, pool, path };
    }

    // The pool holds 50 WETH against 200,000 stock and the path is stored
    async function v3DeepFixture() {
      const f = await loadFixture(v3StockFixture);
      await fillV3(f, f.pool, f.weth, E(50), f.stock, E(200_000));
      await f.quickLaunch.setRewardRouteV3(f.stock.target, f.path);
      return f;
    }

    // A quick Rewards launch on the stock, the sale filled and delivered
    async function v3LaunchedFixture() {
      const f = await loadFixture(v3DeepFixture);
      const sale = await launchQuick(f, {
        ...REWARDS, name: "Hood Stock", symbol: "HSTK", rewardToken: f.stock.target,
        taxWallet: f.dave.address, buyTax: 100, sellTax: 100,
      });
      const wallets = await fillSale(f, sale.presale);
      return { ...f, ...sale, wallets };
    }

    it("setRewardRouteV3 is owner-only, validated and replaces the V2 hops (and the reverse)", async function () {
      const { quickLaunch, weth, stock, usdg, path, alice } = await loadFixture(v3StockFixture);
      await expect(quickLaunch.connect(alice).setRewardRouteV3(stock.target, path))
        .to.be.revertedWithCustomError(quickLaunch, "OwnableUnauthorizedAccount");
      await expect(quickLaunch.setRewardRouteV3(ethers.ZeroAddress, path)).to.be.revertedWith("zero addr");
      await expect(quickLaunch.setRewardRouteV3(weth.target, path)).to.be.revertedWith("no V3 route for WETH");
      await expect(quickLaunch.setRewardRouteV3(stock.target, "0x01")).to.be.revertedWith("bad V3 path");
      await expect(quickLaunch.setRewardRouteV3(stock.target, path + "00")).to.be.revertedWith("bad V3 path");
      await expect(quickLaunch.setRewardRouteV3(stock.target, packPath(weth.target, 3000, usdg.target, 500))).to.be.revertedWith("bad V3 path");
      const fivePools = packPath(
        weth.target, 3000, usdg.target, 3000, weth.target, 3000, usdg.target, 3000, weth.target, 3000, stock.target
      );
      await expect(quickLaunch.setRewardRouteV3(stock.target, fivePools)).to.be.revertedWith("route too long");
      await expect(quickLaunch.setRewardRouteV3(stock.target, packPath(stock.target, 3000, weth.target))).to.be.revertedWith("route must start at WETH");
      await expect(quickLaunch.setRewardRouteV3(stock.target, packPath(weth.target, 3000, usdg.target))).to.be.revertedWith("route must end at reward");
      await expect(quickLaunch.setRewardRouteV3(stock.target, packPath(weth.target, 10000, stock.target))).to.be.revertedWith("no V3 pool");
      await expect(quickLaunch.setRewardRouteV3(stock.target, packPath(weth.target, 3000, weth.target, 3000, stock.target))).to.be.revertedWith("bad hop");
      await expect(quickLaunch.setRewardRouteV3(stock.target, packPath(weth.target, 3000, ethers.ZeroAddress, 3000, stock.target))).to.be.revertedWith("bad hop");
      expect(await quickLaunch.rewardRouteV3Of(stock.target)).to.equal("0x");

      // A stored V3 path replaces the V2 hops
      await quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target]);
      const tx = quickLaunch.setRewardRouteV3(stock.target, path);
      await expect(tx).to.emit(quickLaunch, "RewardRouteV3Set").withArgs(stock.target, path);
      await expect(tx).to.emit(quickLaunch, "RewardRouteSet").withArgs(stock.target, []);
      expect(await quickLaunch.rewardRouteV3Of(stock.target)).to.equal(path);
      expect((await quickLaunch.rewardRouteOf(stock.target)).length).to.equal(0);
      expect([...(await quickLaunch.rewardPathOf(stock.target))]).to.deep.equal([weth.target, stock.target]);
      // Storing V2 hops clears the V3 path
      const back = quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target]);
      await expect(back).to.emit(quickLaunch, "RewardRouteV3Set").withArgs(stock.target, "0x");
      await expect(back).to.emit(quickLaunch, "RewardRouteSet").withArgs(stock.target, [weth.target, usdg.target]);
      expect(await quickLaunch.rewardRouteV3Of(stock.target)).to.equal("0x");
      expect([...(await quickLaunch.rewardRouteOf(stock.target))]).to.deep.equal([weth.target, usdg.target]);
      // An empty path removes a stored one; the same path stored twice is fine
      await quickLaunch.setRewardRouteV3(stock.target, path);
      await quickLaunch.setRewardRouteV3(stock.target, path);
      await expect(quickLaunch.setRewardRouteV3(stock.target, "0x")).to.emit(quickLaunch, "RewardRouteV3Set").withArgs(stock.target, "0x");
      expect(await quickLaunch.rewardRouteV3Of(stock.target)).to.equal("0x");
      expect((await quickLaunch.rewardRouteOf(stock.target)).length).to.equal(0);
      await expect(quickLaunch.setRewardRouteV3(stock.target, "0x")).to.emit(quickLaunch, "RewardRouteV3Set").withArgs(stock.target, "0x");
    });

    it("needs real depth in every V3 pool of the path and agrees with the quoter", async function () {
      const env = await loadFixture(v3StockFixture);
      const { quickLaunch, v3Quoter, weth, stock, usdg, pool, path } = env;
      await quickLaunch.setRewardRouteV3(stock.target, path);
      // An empty pool: the path is stored, nothing can pay
      expect(await pool.liquidity()).to.equal(0);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await expectLaunchRevert(env, { ...REWARDS, rewardToken: stock.target }, "reward route has no pool");

      // Dust: 0.001 WETH against 4 stock, so one 0.01 WETH probe already empties the range
      await fillV3(env, pool, weth, E(0.001), stock, E(4));
      expect(await pool.liquidity()).to.be.gt(0);
      const dust = await quotesV3(v3Quoter, path);
      expect(dust.one).to.be.gt(0);
      expect(dust.ten).to.be.lt(dust.one * 5n);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await expectLaunchRevert(env, { ...REWARDS, rewardToken: stock.target }, "reward route has no pool");

      // Depth at the same price: 50 WETH against 200,000 stock
      await fillV3(env, pool, weth, E(50), stock, E(200_000));
      const deep = await quotesV3(v3Quoter, path);
      expect(deep.ten).to.be.gte(deep.one * 5n);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);

      // Two pools: WETH -0.05%-> USDG -0.3%-> stock, the first deep and the second dust
      const wethUsdg = await v3Pool(env, weth, usdg, 500);
      await fillV3(env, wethUsdg, weth, E(500), usdg, 1_000_000n * USDG_UNIT);
      const usdgStock = await v3Pool(env, usdg, stock, 3000);
      await fillV3(env, usdgStock, usdg, 5n * USDG_UNIT, stock, E(0.02));
      const twoPools = packPath(weth.target, 500, usdg.target, 3000, stock.target);
      await expect(quickLaunch.setRewardRouteV3(stock.target, twoPools)).to.emit(quickLaunch, "RewardRouteV3Set").withArgs(stock.target, twoPools);
      const dust2 = await quotesV3(v3Quoter, twoPools);
      expect(dust2.ten).to.be.lt(dust2.one * 5n);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await expectLaunchRevert(env, { ...REWARDS, rewardToken: stock.target }, "reward route has no pool");
      // Depth in the second pool makes the whole route live and the launch goes through
      await fillV3(env, usdgStock, usdg, 500_000n * USDG_UNIT, stock, E(2_000));
      const deep2 = await quotesV3(v3Quoter, twoPools);
      expect(deep2.ten).to.be.gte(deep2.one * 5n);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);
      const { token } = await launchQuick(env, { ...REWARDS, name: "Two Hop", symbol: "TWO", rewardToken: stock.target });
      expect(await token.rewardRouteV3()).to.equal(twoPools);
      // The 0.3% WETH/stock pool being deep does not count while the stored path avoids it:
      // the USDG/stock pool down to 0.01% (50 USDG) cannot hold eight probes of 20 USDG
      await usdgStock.withdraw(env.deployer.address, 9999);
      expect(await usdgStock.liquidity()).to.be.gt(0);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(false);
    });

    it("launches a stock reward on the stored V3 path and pays the stock through SwapRouter02", async function () {
      const f = await loadFixture(v3LaunchedFixture);
      const { quickLaunch, v3Router, v3Quoter, token, presale, stock, path, weth, router, receipt, bob, dave, keeper, wallets } = f;
      expect(await token.rewardToken()).to.equal(stock.target);
      expect(await token.owner()).to.equal(quickLaunch.target);
      expect(await token.v3Router()).to.equal(v3Router.target);
      expect(await token.v3Quoter()).to.equal(v3Quoter.target);
      expect(await token.rewardRouteV3()).to.equal(path);
      // The V2 hops stay at the default; rewardPath describes the V2 route only
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, stock.target]);
      expect([...(await token.rewardRoute())]).to.deep.equal([weth.target]);
      // The path was set twice in the launch: by the deployer (platformRouteV3For) and by launch
      const routeEvents = receipt.logs
        .filter((l) => l.address === token.target)
        .map((l) => token.interface.parseLog(l))
        .filter((e) => e && e.name === "RewardRouteV3Updated");
      expect(routeEvents.length).to.equal(2);
      for (const e of routeEvents) expect(e.args.path).to.equal(path);
      expect(await presale.distributionComplete()).to.equal(true);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(true);
      expect((await quickLaunch.quickTokenOf(presale.target)).rewardToken).to.equal(stock.target);

      // Buys and sells accrue the rewards tax; the sell also swaps the marketing tax to ETH for dave
      await buy(f, token, bob, E(0.3));
      const afterBuy = await token.pendingRewardsTokens();
      expect(afterBuy).to.be.gt(0);
      const platformPending = await token.pendingPlatformTokens();
      const marketingPending = await token.pendingMarketingTokens();
      expect(platformPending + marketingPending).to.be.gte(await token.swapThreshold());
      const seller = wallets[0];
      const amount = (await token.balanceOf(seller.address)) / 2n;
      const daveBefore = await ethers.provider.getBalance(dave.address);
      const sellReceipt = await (await sell(f, token, seller, amount)).wait();
      const swapBack = findEvent(sellReceipt, token.interface, "SwapBack");
      expect(swapBack.args.tokensSwapped).to.equal(platformPending + marketingPending);
      const marketingEth = (swapBack.args.ethReceived * marketingPending) / (platformPending + marketingPending);
      expect(marketingEth).to.be.gt(0);
      expect((await ethers.provider.getBalance(dave.address)) - daveBefore).to.equal(marketingEth);
      expect(await token.pendingRewardsTokens()).to.equal(afterBuy + (amount * 200n) / BPS);

      // The keeper distributes: token -> ETH on V2, wrapped, then WETH -> stock on SwapRouter02
      const { pending, quote } = await rewardQuote(f, token, path);
      expect(quote).to.be.gt(0);
      await expect(quickLaunch.connect(dave).distributeRewards(token.target, quote)).to.be.revertedWith("not keeper");
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, quote + 1n)).to.be.revertedWith("Too little received");
      const stockBefore = await stock.balanceOf(token.target);
      const wethBefore = await weth.balanceOf(token.target);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, quote))
        .to.emit(token, "RewardsDistributed")
        .withArgs(pending, quote);
      expect(await stock.balanceOf(token.target)).to.equal(stockBefore + quote);
      expect(await weth.balanceOf(token.target)).to.equal(wethBefore); // no WETH left behind
      expect(await ethers.provider.getBalance(token.target)).to.equal(0);
      expect(await token.pendingRewardsTokens()).to.equal(0);
      expect(await token.totalRewardsDistributed()).to.equal(quote);
      // The holders claim the stock
      const holder = wallets[1];
      const claimable = await token.withdrawableRewardOf(holder.address);
      expect(claimable).to.be.gt(0);
      expect(await token.withdrawableRewardOf(wallets[2].address)).to.equal(claimable);
      await expect(token.connect(holder).claimRewards()).to.emit(token, "RewardsClaimed").withArgs(holder.address, claimable);
      expect(await stock.balanceOf(holder.address)).to.equal(claimable);
      const bobClaim = await token.withdrawableRewardOf(bob.address);
      expect(bobClaim).to.be.gt(0);
      await token.connect(bob).claimRewards();
      expect(await stock.balanceOf(bob.address)).to.equal(bobClaim);
      expect(await token.sharesOf(await token.mainPair())).to.equal(0);
      // Nothing to distribute until the next trade
      await expect(quickLaunch.distributeRewards(token.target, 0)).to.be.revertedWith("nothing to distribute");
      await buy(f, token, bob, E(0.01));
      await expect(quickLaunch.distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
    });

    it("needs the pool to hold the output of ten probes, whatever its virtual reserves claim", async function () {
      const env = await loadFixture(v3DeepFixture);
      const { quickLaunch, weth, stock, pool, deployer } = env;
      const probe = await quickLaunch.ROUTE_PROBE_WETH();
      // The liquidity and price a 50 WETH pool reports
      const liquidity = await pool.liquidity();
      const [sqrtPriceX96] = await pool.slot0();
      expect(liquidity).to.be.gt(0);
      expect(sqrtPriceX96).to.be.gt(0);
      // The same pool down to dust at the same price: 0.0001 WETH against 0.4 stock
      await pool.withdraw(deployer.address, 10_000);
      expect(await weth.balanceOf(pool.target)).to.equal(0);
      expect(await stock.balanceOf(pool.target)).to.equal(0);
      await fillV3(env, pool, weth, E(0.0001), stock, E(0.4));
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);

      // A narrow concentrated position: the pool claims the deep pool's virtual reserves while it
      // holds the dust. The virtual reserve rule alone would pass ...
      await pool.setVirtualState(liquidity, sqrtPriceX96);
      expect(await pool.liquidity()).to.equal(liquidity);
      expect((await pool.slot0())[0]).to.equal(sqrtPriceX96);
      const Q96 = 1n << 96n;
      const x = (liquidity * Q96) / sqrtPriceX96;
      const y = (liquidity * sqrtPriceX96) / Q96;
      const zeroForOne = BigInt(weth.target) < BigInt(stock.target);
      expect(zeroForOne ? x : y).to.be.gte(8n * probe);
      const spotOut = zeroForOne ? (probe * y) / x : (probe * x) / y;
      expect(spotOut).to.be.gt(E(0.4));
      // ... but the pool cannot pay ten probes, so the route is dead and no launch goes through
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await expectLaunchRevert(env, { ...REWARDS, rewardToken: stock.target }, "reward route has no pool");

      // The boundary: the output of ten probes held exactly passes, one wei less fails
      await stock.transfer(pool.target, 10n * spotOut - 1n - (await stock.balanceOf(pool.target)));
      await pool.sync();
      expect(await stock.balanceOf(pool.target)).to.equal(10n * spotOut - 1n);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await stock.transfer(pool.target, 1n);
      await pool.sync();
      expect(await stock.balanceOf(pool.target)).to.equal(10n * spotOut);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);
      await stock.transfer(pool.target, spotOut);
      await pool.sync();
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);

      // Without the claim the dust is dust again; real balances make the route live and the
      // launch goes through
      await pool.setVirtualState(0, 0);
      expect(await pool.liquidity()).to.be.lt(liquidity);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await fillV3(env, pool, weth, E(50), stock, E(200_000));
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);
      const { token } = await launchQuick(env, { ...REWARDS, name: "Held", symbol: "HELD", rewardToken: stock.target });
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(true);
    });

    it("refuses a partial fill of the V3 leg and recovers WETH left on the token", async function () {
      const f = await loadFixture(v3LaunchedFixture);
      const { quickLaunch, token, stock, pool, path, weth, bob, keeper, wallets } = f;
      await buy(f, token, bob, E(0.3));
      const { pending, ethOut, quote } = await rewardQuote(f, token, path);
      expect(quote).to.be.gt(0);
      expect(await weth.balanceOf(token.target)).to.equal(0);

      // The pool's range runs out below the leg's output: SwapRouter02 fills as far as it can
      // and leaves the rest of the WETH on the token, which the token refuses
      await pool.setMaxOut(quote / 2n);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.be.revertedWith("partial fill");
      // The floor catches it first when the keeper sets one
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, quote)).to.be.revertedWith("Too little received");
      expect(await token.pendingRewardsTokens()).to.equal(pending);
      expect(await weth.balanceOf(token.target)).to.equal(0);
      expect(await stock.balanceOf(token.target)).to.equal(0);
      // A cap the leg fits under is no partial fill
      await pool.setMaxOut(quote);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(true);
      await pool.setMaxOut(0);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, quote))
        .to.emit(token, "RewardsDistributed")
        .withArgs(pending, quote);
      expect(await stock.balanceOf(token.target)).to.equal(quote);
      expect(await weth.balanceOf(token.target)).to.equal(0);

      // WETH sent to the token goes into the next distribution with the swapped rewards
      const stray = E(0.05);
      await weth.connect(bob).deposit({ value: stray });
      await weth.connect(bob).transfer(token.target, stray);
      expect(await weth.balanceOf(token.target)).to.equal(stray);
      await buy(f, token, bob, E(0.1));
      const next = await rewardQuote(f, token, path);
      const withStray = (await f.v3Quoter.quoteExactInput.staticCall(path, next.ethOut + stray))[0];
      expect(withStray).to.be.gt(next.quote);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, withStray))
        .to.emit(token, "RewardsDistributed")
        .withArgs(next.pending, withStray);
      expect(await stock.balanceOf(token.target)).to.equal(quote + withStray);
      expect(await weth.balanceOf(token.target)).to.equal(0);
      expect(await ethers.provider.getBalance(token.target)).to.equal(0);
      expect(await token.totalRewardsDistributed()).to.equal(quote + withStray);
      expect(ethOut).to.be.gt(0);
      // The holders claim everything that was distributed
      const claimable = await token.withdrawableRewardOf(wallets[0].address);
      expect(claimable).to.be.gt(0);
      await token.connect(wallets[0]).claimRewards();
      expect(await stock.balanceOf(wallets[0].address)).to.equal(claimable);
    });

    it("repairs a token whose V3 pool died to a new V3 path, then to V2 hops", async function () {
      const f = await loadFixture(v3LaunchedFixture);
      const { quickLaunch, token, stock, usdg, pool, path, weth, router, deployer, bob, dave, keeper, wallets } = f;
      const repair = () => quickLaunch.connect(dave).repairRewardRoute(token.target);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(true);
      await expect(repair()).to.be.revertedWith("route still live");

      // A second WETH/stock pool at 0.05% with depth; storing its path changes nothing while the
      // token's route pays
      const pool500 = await v3Pool(f, weth, stock, 500);
      await fillV3(f, pool500, weth, E(50), stock, E(200_000));
      const path500 = packPath(weth.target, 500, stock.target);
      await quickLaunch.setRewardRouteV3(stock.target, path500);
      await expect(repair()).to.be.revertedWith("route still live");
      expect(await token.rewardRouteV3()).to.equal(path);
      await quickLaunch.setRewardRouteV3(stock.target, path);

      // The 0.3% pool loses 99.9% of its liquidity: dust stays, the route is dead
      await pool.withdraw(deployer.address, 9990);
      expect(await pool.liquidity()).to.be.gt(0);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(false);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      // The stored path points at the same dead pool: nothing to repair with
      await expect(repair()).to.be.revertedWith("stored route has no pool");

      // The owner stores the 0.05% pool path, a stranger repairs
      await quickLaunch.setRewardRouteV3(stock.target, path500);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);
      const tx = repair();
      await expect(tx).to.emit(quickLaunch, "RewardRouteV3Repaired").withArgs(token.target, path500);
      await expect(tx).to.emit(token, "RewardRouteV3Updated").withArgs(path500);
      expect(await token.rewardRouteV3()).to.equal(path500);
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, stock.target]);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(true);
      await expect(repair()).to.be.revertedWith("route still live");
      // Rewards flow through the new pool
      await buy(f, token, bob, E(0.2));
      const { pending, quote } = await rewardQuote(f, token, path500);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, quote)).to.emit(token, "RewardsDistributed").withArgs(pending, quote);
      const claimable = await token.withdrawableRewardOf(wallets[0].address);
      expect(claimable).to.be.gt(0);
      await token.connect(wallets[0]).claimRewards();
      expect(await stock.balanceOf(wallets[0].address)).to.equal(claimable);

      // The 0.05% pool dies as well; the owner stores V2 hops through USDG before the V2 pools
      // exist, so the stored route cannot pay either
      await pool500.withdraw(deployer.address, 9990);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(false);
      await quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target]);
      expect(await quickLaunch.rewardRouteV3Of(stock.target)).to.equal("0x");
      expect([...(await quickLaunch.rewardPathOf(stock.target))]).to.deep.equal([weth.target, usdg.target, stock.target]);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      await expect(repair()).to.be.revertedWith("stored route has no pool");
      // Deep V2 pools WETH/USDG and USDG/stock
      const dex = await ethers.getContractAt("MockFactory", await router.factory());
      await dex.createPair(usdg.target, weth.target);
      await usdg.approve(router.target, ethers.MaxUint256);
      await router.addLiquidityETH(usdg.target, 1_000_000n * USDG_UNIT, 0, 0, deployer.address, await swapDeadline(), { value: E(500) });
      await dex.createPair(stock.target, usdg.target);
      const stockUsdg = await ethers.getContractAt("MockPair", await dex.getPair(stock.target, usdg.target));
      await stock.transfer(stockUsdg.target, E(100_000));
      await usdg.transfer(stockUsdg.target, 500_000n * USDG_UNIT);
      await stockUsdg.mint(deployer.address);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);
      // The repair switches the token to V2: the V3 path is cleared, the hops are set
      const toV2 = repair();
      await expect(toV2).to.emit(quickLaunch, "RewardRouteRepaired").withArgs(token.target, [weth.target, usdg.target, stock.target]);
      await expect(toV2).to.emit(token, "RewardRouteUpdated").withArgs([weth.target, usdg.target]);
      await expect(toV2).to.emit(token, "RewardRouteV3Updated").withArgs("0x");
      expect(await token.rewardRouteV3()).to.equal("0x");
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, usdg.target, stock.target]);
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(true);
      await expect(repair()).to.be.revertedWith("route still live");
      // Rewards flow through the four V2 hops
      await buy(f, token, bob, E(0.1));
      const stockBefore = await stock.balanceOf(token.target);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      expect(await stock.balanceOf(token.target)).to.be.gt(stockBefore);
      // The repairs touched nothing else
      expect(await token.owner()).to.equal(quickLaunch.target);
      expect(await token.rewardsBuyTaxBps()).to.equal(200);
      expect(await token.marketingWallet()).to.equal(dave.address);
      expect(await token.rewardToken()).to.equal(stock.target);
    });

    it("gives a token created through the factory the platform's V3 path, managed by its owner", async function () {
      const f = await loadFixture(v3DeepFixture);
      const { tokenFactory, rewardsDeployer, quickLaunch, v3Router, v3Quoter, stock, usdg, path, weth, router, treasury, deployer, alice, bob } = f;
      expect(await tokenFactory.rewardsDeployer()).to.equal(rewardsDeployer.target);
      expect(await rewardsDeployer.v3Router()).to.equal(v3Router.target);
      expect(await rewardsDeployer.v3Quoter()).to.equal(v3Quoter.target);
      expect(await rewardsDeployer.platformRouteV3For(stock.target)).to.equal(path);
      expect(await rewardsDeployer.platformRouteV3For(usdg.target)).to.equal("0x");
      expect(await rewardsDeployer.platformRouteV3For(weth.target)).to.equal("0x");

      await tokenFactory.connect(alice).createRewardsToken("Direct", "DRCT", E(1_000_000), stock.target, alice.address, [300, 300, 0, 0]);
      const direct = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n));
      expect(await direct.owner()).to.equal(alice.address);
      expect(await direct.rewardRouteV3()).to.equal(path);
      expect(await direct.v3Router()).to.equal(v3Router.target);
      expect([...(await direct.rewardPath())]).to.deep.equal([direct.target, weth.target, stock.target]);
      // A reward token without a stored path starts on the V2 route
      await tokenFactory.connect(alice).createRewardsToken("Plain", "PLN", E(1_000_000), usdg.target, alice.address, [300, 300, 0, 0]);
      const plain = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n));
      expect(await plain.rewardRouteV3()).to.equal("0x");
      expect([...(await plain.rewardPath())]).to.deep.equal([plain.target, weth.target, usdg.target]);
      // The token's owner manages its route; QuickLaunch has no way into a token it does not own
      await expect(direct.connect(bob).setRewardRouteV3("0x")).to.be.revertedWithCustomError(direct, "OwnableUnauthorizedAccount");
      await expect(quickLaunch.repairRewardRoute(direct.target)).to.be.revertedWith("not a quick rewards token");
      await expect(direct.connect(alice).setRewardRouteV3("0x")).to.emit(direct, "RewardRouteV3Updated").withArgs("0x");
      expect(await direct.rewardRouteV3()).to.equal("0x");
      await expect(direct.connect(alice).setRewardRouteV3(path)).to.emit(direct, "RewardRouteV3Updated").withArgs(path);
      expect(await direct.rewardRouteV3()).to.equal(path);
      // A later change of the stored path only concerns tokens created from then on
      await quickLaunch.setRewardRouteV3(stock.target, "0x");
      expect(await rewardsDeployer.platformRouteV3For(stock.target)).to.equal("0x");
      expect(await direct.rewardRouteV3()).to.equal(path);

      // A deployer behind a factory without a presale factory, or without a V3 router, hands out no path
      const bareFactory = await ethers.deployContract("TokenFactory", [deployer.address, treasury.target, router.target]);
      const bareDeployer = await ethers.deployContract("RewardsTokenDeployer", [bareFactory.target, v3Router.target, v3Quoter.target]);
      expect(await bareDeployer.platformRouteV3For(stock.target)).to.equal("0x");
      const noV3 = await ethers.deployContract("RewardsTokenDeployer", [tokenFactory.target, ethers.ZeroAddress, ethers.ZeroAddress]);
      expect(await noV3.platformRouteV3For(stock.target)).to.equal("0x");
    });
  });

  // ------------------------------------------------------------ registerAmmPair

  // A second pool of a quick Rewards token on the platform DEX is a plain holder until someone
  // registers it: then its trades are taxed like the main pool and it earns no rewards.
  describe("registerAmmPair", function () {
    const REWARDS_BUY = 300n;
    const MARKETING_BUY = 100n;

    // A launched and delivered Rewards token (WETH rewards); bob opens a second pool of it
    // against another ERC20 on the platform DEX
    async function secondPoolFixture() {
      const env = await deployPlatform();
      const { router, bob, alice, dave } = env;
      const sale = await launchQuick(env, {
        name: "Hood Yield", symbol: "HYLD", tokenType: TYPE.Rewards, rewardToken: env.weth.target,
        taxWallet: dave.address, buyTax: 100, sellTax: 100, rewardsBuy: 300, rewardsSell: 300,
      });
      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(sale.presale, wallets.slice(0, 49), E(0.02));
      await sale.presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await sale.presale.distribute(100);

      const dex = await ethers.getContractAt("MockFactory", await router.factory());
      const other = await ethers.deployContract("MockERC20", ["Other", "OTHR", 18, E(1_000_000)]);
      await other.transfer(bob.address, E(500_000));
      await other.transfer(alice.address, E(100_000));
      await buy(env, sale.token, bob, E(0.2));
      await dex.createPair(sale.token.target, other.target);
      const pair = await ethers.getContractAt("MockPair", await dex.getPair(sale.token.target, other.target));
      await sale.token.connect(bob).transfer(pair.target, E(1_000_000));
      await other.connect(bob).transfer(pair.target, E(100_000));
      await pair.mint(bob.address);
      await other.connect(alice).approve(router.target, ethers.MaxUint256);
      return { ...env, ...sale, wallets, dex, other, pair };
    }

    /** alice buys the token through the second pool with `other`; returns the quoted output. */
    async function buyThroughSecondPool(f, amountIn) {
      const path = [f.other.target, f.token.target];
      const out = (await f.router.getAmountsOut(amountIn, path))[1];
      await f.router
        .connect(f.alice)
        .swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, 0, path, f.alice.address, await swapDeadline());
      return out;
    }

    it("turns a plain holder pool into a taxed, reward-free AMM pair, open to anyone", async function () {
      const f = await loadFixture(secondPoolFixture);
      const { quickLaunch, token, pair, alice, dave } = f;
      // Before: the pool is an ordinary holder with a reward share, and its trades are untaxed
      expect(await token.isAmmPair(pair.target)).to.equal(false);
      expect(await token.isExcludedFromRewards(pair.target)).to.equal(false);
      const poolShares = await token.sharesOf(pair.target);
      expect(poolShares).to.equal(await token.balanceOf(pair.target));
      expect(poolShares).to.be.gt(0);
      const pendingBefore = await token.pendingRewardsTokens();
      const quoted = await buyThroughSecondPool(f, E(1000));
      expect(await token.balanceOf(alice.address)).to.equal(quoted);
      expect(await token.pendingRewardsTokens()).to.equal(pendingBefore);

      // A stranger registers the pool: its share (synced by the buy above) leaves the total
      const totalBefore = await token.totalShares();
      const poolSharesNow = await token.sharesOf(pair.target);
      expect(poolSharesNow).to.equal(await token.balanceOf(pair.target));
      const tx = quickLaunch.connect(dave).registerAmmPair(token.target, pair.target);
      await expect(tx).to.emit(quickLaunch, "AmmPairRegistered").withArgs(token.target, pair.target);
      await expect(tx).to.emit(token, "AmmPairSet").withArgs(pair.target, true);
      await expect(tx).to.emit(token, "ExcludedFromRewards").withArgs(pair.target, true);
      expect(await token.isAmmPair(pair.target)).to.equal(true);
      expect(await token.isExcludedFromRewards(pair.target)).to.equal(true);
      expect(await token.sharesOf(pair.target)).to.equal(0);
      expect(await token.totalShares()).to.equal(totalBefore - poolSharesNow);

      // After: a buy through the pool pays the platform, rewards and marketing taxes
      const aliceBefore = await token.balanceOf(alice.address);
      const pending = await token.pendingRewardsTokens();
      const out = await buyThroughSecondPool(f, E(1000));
      const platformFee = (out * PLATFORM_TAX) / BPS;
      const rewardsFee = (out * REWARDS_BUY) / BPS;
      const marketingFee = (out * MARKETING_BUY) / BPS;
      expect((await token.balanceOf(alice.address)) - aliceBefore).to.equal(out - platformFee - rewardsFee - marketingFee);
      expect(await token.pendingRewardsTokens()).to.equal(pending + rewardsFee);

      // Nothing else about the token moved
      expect(await token.owner()).to.equal(quickLaunch.target);
      expect(await token.marketingWallet()).to.equal(dave.address);
      expect(await token.rewardsBuyTaxBps()).to.equal(300);
      expect(await token.rewardsSellTaxBps()).to.equal(300);
      expect(await token.marketingBuyTaxBps()).to.equal(100);
      expect(await token.marketingSellTaxBps()).to.equal(100);
      expect(await token.isAmmPair(await token.mainPair())).to.equal(true);
      expect((await token.rewardRoute()).length).to.equal(0);
    });

    it("rejects pools without the token, pools outside the platform DEX, double registration and other tokens", async function () {
      const f = await loadFixture(secondPoolFixture);
      const { quickLaunch, tokenFactory, token, pair, dex, other, weth, alice, dave } = f;
      await expect(quickLaunch.registerAmmPair(token.target, ethers.ZeroAddress)).to.be.revertedWith("zero addr");
      // The main pool is registered at creation
      await expect(quickLaunch.registerAmmPair(token.target, await token.mainPair())).to.be.revertedWith("already registered");
      // A pool of two other tokens
      await dex.createPair(other.target, weth.target);
      const foreign = await dex.getPair(other.target, weth.target);
      await expect(quickLaunch.registerAmmPair(token.target, foreign)).to.be.revertedWith("pair without the token");
      // A contract that answers token0/token1 like a pair but is not the DEX's pair for them
      const [t0, t1] = token.target.toLowerCase() < other.target.toLowerCase() ? [token.target, other.target] : [other.target, token.target];
      const fake = await ethers.deployContract("MockPair", [t0, t1]);
      await expect(quickLaunch.registerAmmPair(token.target, fake.target)).to.be.revertedWith("not a pair of the platform DEX");
      const unopened = await ethers.deployContract("MockPair", [token.target, weth.target]);
      await expect(quickLaunch.registerAmmPair(token.target, unopened.target)).to.be.revertedWith("not a pair of the platform DEX");
      // A wallet is no pair at all
      await expect(quickLaunch.registerAmmPair(token.target, alice.address)).to.be.reverted;
      // Twice
      await quickLaunch.connect(dave).registerAmmPair(token.target, pair.target);
      await expect(quickLaunch.connect(alice).registerAmmPair(token.target, pair.target)).to.be.revertedWith("already registered");
      // Only quick Rewards tokens of this generation: Standard and Tax quick tokens, a random
      // address and a Rewards token created directly through the factory are refused
      const standard = await launchQuick(f, { creator: alice, name: "Std", symbol: "STD" });
      const taxed = await launchQuick(f, { creator: dave, name: "Txd", symbol: "TXD", tokenType: TYPE.Tax, buyTax: 100, sellTax: 100 });
      await tokenFactory.connect(alice).createRewardsToken("Own", "OWN", E(1000), weth.target, alice.address, [100, 100, 0, 0]);
      const own = await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n);
      for (const t of [standard.token.target, taxed.token.target, weth.target, own, pair.target]) {
        await expect(quickLaunch.registerAmmPair(t, pair.target)).to.be.revertedWith("not a quick rewards token");
      }
      expect(await token.isAmmPair(pair.target)).to.equal(true);
    });
  });

  // ------------------------------------------------------------ repairRewardRoute

  // A launched token keeps the route it was launched with as long as that route can pay. Only
  // when a pool of it is gone or down to dust may anyone point the token at the route stored on
  // QuickLaunch for its reward token, and only if that one can pay.
  describe("repairRewardRoute", function () {
    it("repairs a dead stock route to the stored one and refuses while either side cannot pay", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, tokenFactory, router, weth, deployer, alice, bob, dave, keeper } = env;
      const dex = await ethers.getContractAt("MockFactory", await router.factory());
      // Mock USDG with a deep WETH pool, a stock whose only pool is against USDG (its WETH pair
      // exists and stays empty), the stock routed through USDG: as in the allowlist tests
      const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 10_000_000n * 10n ** 6n]);
      await dex.createPair(usdg.target, weth.target);
      await usdg.approve(router.target, ethers.MaxUint256);
      await router.addLiquidityETH(usdg.target, 1_000_000n * 10n ** 6n, 0, 0, deployer.address, await swapDeadline(), { value: E(500) });
      await tokenFactory.connect(alice).createStandardToken("tTesla", "tTSLA", E(1_000_000));
      const stock = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
      await dex.createPair(stock.target, usdg.target);
      const stockUsdg = await ethers.getContractAt("MockPair", await dex.getPair(stock.target, usdg.target));
      await stock.connect(alice).transfer(stockUsdg.target, E(100_000));
      await usdg.transfer(stockUsdg.target, 500_000n * 10n ** 6n);
      await stockUsdg.mint(deployer.address);
      await quickLaunch.setRewardTokenAllowed(stock.target, true);
      await quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target]);

      const { token, presale } = await launchQuick(env, {
        name: "Hood Stock", symbol: "HSTK", tokenType: TYPE.Rewards, rewardToken: stock.target, rewardsBuy: 200, rewardsSell: 200,
      });
      const launchedPath = [token.target, weth.target, usdg.target, stock.target];
      expect([...(await token.rewardPath())]).to.deep.equal(launchedPath);
      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(presale, wallets.slice(0, 49), E(0.02));
      await presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await presale.distribute(100);

      // While the route pays, nobody can move it, whatever the stored route says
      await expect(quickLaunch.connect(dave).repairRewardRoute(token.target)).to.be.revertedWith("route still live");
      await quickLaunch.setRewardRoute(stock.target, []);
      await expect(quickLaunch.connect(dave).repairRewardRoute(token.target)).to.be.revertedWith("route still live");
      await quickLaunch.setRewardRoute(stock.target, [weth.target, usdg.target]);
      expect([...(await token.rewardPath())]).to.deep.equal(launchedPath);

      // The LP holder pulls the USDG/stock liquidity: the pool keeps only the locked dust
      await stockUsdg.transfer(stockUsdg.target, await stockUsdg.balanceOf(deployer.address));
      await stockUsdg.burn(deployer.address);
      const [r0, r1] = await stockUsdg.getReserves();
      expect(r0).to.be.gt(0);
      expect(r1).to.be.gt(0);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(false);
      // The token's route is dead, but so is the stored one: nothing to repair with
      await expect(quickLaunch.connect(dave).repairRewardRoute(token.target)).to.be.revertedWith("stored route has no pool");

      // The owner opens a real stock/WETH pool and stores the default route for the stock
      await stock.connect(alice).approve(router.target, E(200_000));
      await router.connect(alice).addLiquidityETH(stock.target, E(200_000), 0, 0, alice.address, await swapDeadline(), { value: E(50) });
      await expect(quickLaunch.connect(dave).repairRewardRoute(token.target)).to.be.revertedWith("stored route has no pool");
      await quickLaunch.setRewardRoute(stock.target, []);
      expect([...(await quickLaunch.rewardPathOf(stock.target))]).to.deep.equal([weth.target, stock.target]);
      expect(await quickLaunch.isRewardRouteLive(stock.target)).to.equal(true);

      // A stranger repairs the token: it now swaps token -> WETH -> stock
      const tx = quickLaunch.connect(dave).repairRewardRoute(token.target);
      await expect(tx).to.emit(quickLaunch, "RewardRouteRepaired").withArgs(token.target, [weth.target, stock.target]);
      await expect(tx).to.emit(token, "RewardRouteUpdated").withArgs([weth.target]);
      expect([...(await token.rewardRoute())]).to.deep.equal([weth.target]);
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, stock.target]);
      await expect(quickLaunch.connect(dave).repairRewardRoute(token.target)).to.be.revertedWith("route still live");

      // Rewards flow again through the new route
      await buy(env, token, bob, E(0.2));
      const stockBefore = await stock.balanceOf(token.target);
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
      expect(await stock.balanceOf(token.target)).to.be.gt(stockBefore);
      const claimable = await token.withdrawableRewardOf(wallets[0].address);
      expect(claimable).to.be.gt(0);
      await token.connect(wallets[0]).claimRewards();
      expect(await stock.balanceOf(wallets[0].address)).to.equal(claimable);
      // The repair touched nothing else
      expect(await token.owner()).to.equal(quickLaunch.target);
      expect(await token.rewardsBuyTaxBps()).to.equal(200);
      expect(await token.rewardToken()).to.equal(stock.target);
    });

    it("only concerns quick Rewards tokens of this generation", async function () {
      const env = await loadFixture(deployPlatform);
      const { quickLaunch, weth, dave } = env;
      const standard = await launchQuick(env, { name: "Std", symbol: "STD" });
      const taxed = await launchQuick(env, { creator: dave, name: "Txd", symbol: "TXD", tokenType: TYPE.Tax, buyTax: 100, sellTax: 100 });
      for (const t of [standard.token.target, taxed.token.target, weth.target, standard.presale.target, dave.address]) {
        await expect(quickLaunch.repairRewardRoute(t)).to.be.revertedWith("not a quick rewards token");
      }
      // A WETH rewards token's route is WETH alone, which is always live
      const { token } = await launchQuick(env, {
        creator: env.alice, name: "Yld", symbol: "YLD", tokenType: TYPE.Rewards, rewardToken: weth.target, rewardsBuy: 100, rewardsSell: 100,
      });
      await expect(quickLaunch.repairRewardRoute(token.target)).to.be.revertedWith("route still live");
    });
  });

  // ------------------------------------------------------------ previous generation

  // A replacement QuickLaunch names the one before it and answers creatorOf / presaleOfToken for
  // its sales, so the registry keeps every quick creator as an editor. It does not own the
  // tokens of the old generation and has no call into them.
  describe("previous generation", function () {
    // One Rewards sale on the old generation, filled and delivered, then the factory switches
    // to a new generation that names the old one
    async function generationsFixture() {
      const env = await deployPlatform();
      const { quickLaunch, tokenFactory, presaleFactory, metadataRegistry, weth } = env;
      const old = await launchQuick(env, {
        name: "Old Yield", symbol: "OLD", tokenType: TYPE.Rewards, rewardToken: weth.target, rewardsBuy: 300, rewardsSell: 300,
      });
      const wallets = await fundedWallets(env, 50, 0.05);
      await contributeAll(old.presale, wallets.slice(0, 49), E(0.02));
      await old.presale.connect(wallets[49]).contribute({ value: E(0.0195) });
      await old.presale.distribute(100);
      const next = await ethers.deployContract("QuickLaunch", [
        tokenFactory.target, presaleFactory.target, metadataRegistry.target, [weth.target], quickLaunch.target,
      ]);
      await presaleFactory.setQuickLaunch(next.target);
      return { ...env, old, next, wallets };
    }

    it("answers for the sales of the generation it replaced and records its own", async function () {
      const f = await loadFixture(generationsFixture);
      const { quickLaunch, presaleFactory, old, next, carol, dave, alice } = f;
      expect(await next.previousQuickLaunch()).to.equal(quickLaunch.target);
      expect(await quickLaunch.previousQuickLaunch()).to.equal(ethers.ZeroAddress);
      expect(await presaleFactory.quickLaunch()).to.equal(next.target);
      expect(await next.creatorOf(old.presale.target)).to.equal(carol.address);
      expect(await next.presaleOfToken(old.token.target)).to.equal(old.presale.target);
      expect(await next.allLaunchesLength()).to.equal(0);
      // The fixed token record is per generation; the lens falls back to the token itself
      expect((await next.quickTokenOf(old.presale.target)).tokenType).to.equal(0);
      // Unknown addresses read as zero through both generations
      expect(await next.creatorOf(alice.address)).to.equal(ethers.ZeroAddress);
      expect(await next.presaleOfToken(alice.address)).to.equal(ethers.ZeroAddress);
      expect(await next.creatorOf(old.token.target)).to.equal(ethers.ZeroAddress);

      // A launch on the new generation is recorded there and the old one never learns of it
      const fresh = await launchQuick({ ...f, quickLaunch: next }, { creator: dave, name: "New", symbol: "NEW" });
      expect(await next.creatorOf(fresh.presale.target)).to.equal(dave.address);
      expect(await next.presaleOfToken(fresh.token.target)).to.equal(fresh.presale.target);
      expect(await next.allLaunchesLength()).to.equal(1);
      expect(await quickLaunch.creatorOf(fresh.presale.target)).to.equal(ethers.ZeroAddress);
      expect(await quickLaunch.presaleOfToken(fresh.token.target)).to.equal(ethers.ZeroAddress);
      expect(await presaleFactory.quickCreatorOf(fresh.presale.target)).to.equal(dave.address);
      // The old generation can no longer create sales
      await expect(quickLaunch.connect(dave).launch(quickParams({ name: "Late", symbol: "LATE" }), { value: QUICK_FEE })).to.be.revertedWith("not quick launch");
    });

    it("keeps the old creator as the profile editor through the registry", async function () {
      const { metadataRegistry, old, carol, deployer, dave } = await loadFixture(generationsFixture);
      expect(await metadataRegistry.canEdit(old.token.target, carol.address)).to.equal(true);
      expect(await metadataRegistry.canEdit(old.token.target, deployer.address)).to.equal(false);
      expect(await metadataRegistry.canEdit(old.token.target, dave.address)).to.equal(false);
      const m = { ...(await metadataRegistry.metadataOf(old.token.target)).toObject(), website: "https://old.example" };
      await expect(metadataRegistry.connect(carol).setMetadata(old.token.target, m))
        .to.emit(metadataRegistry, "MetadataUpdated")
        .withArgs(old.token.target, carol.address);
      expect((await metadataRegistry.metadataOf(old.token.target)).website).to.equal("https://old.example");
      await expect(metadataRegistry.connect(dave).setMetadata(old.token.target, m)).to.be.revertedWithCustomError(metadataRegistry, "NotEditor");
    });

    it("has no call into the tokens of the old generation, which stay with their owner", async function () {
      const f = await loadFixture(generationsFixture);
      const { quickLaunch, old, next, bob, dave, keeper } = f;
      const token = old.token;
      expect(await token.owner()).to.equal(quickLaunch.target);
      await expect(next.distributeRewards(token.target, 0)).to.be.revertedWith("not a quick rewards token");
      await expect(next.connect(keeper).distributeRewards(token.target, 0)).to.be.revertedWith("not a quick rewards token");
      await expect(next.connect(dave).distributeRewards(token.target, 0)).to.be.revertedWith("not keeper");
      await expect(next.registerAmmPair(token.target, await token.mainPair())).to.be.revertedWith("not a quick rewards token");
      await expect(next.repairRewardRoute(token.target)).to.be.revertedWith("not a quick rewards token");
      // The old generation still distributes its token's rewards after the switch, for the same keeper
      await buy(f, token, bob, E(0.2));
      expect(await token.pendingRewardsTokens()).to.be.gt(0);
      await expect(quickLaunch.connect(dave).distributeRewards(token.target, 0)).to.be.revertedWith("not keeper");
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, 0)).to.emit(token, "RewardsDistributed");
    });

    it("accepts zero or any address as the previous generation", async function () {
      const { tokenFactory, presaleFactory, metadataRegistry, weth, alice } = await loadFixture(deployPlatform);
      const args = [tokenFactory.target, presaleFactory.target, metadataRegistry.target, [weth.target]];
      const first = await ethers.deployContract("QuickLaunch", [...args, ethers.ZeroAddress]);
      expect(await first.previousQuickLaunch()).to.equal(ethers.ZeroAddress);
      expect(await first.creatorOf(alice.address)).to.equal(ethers.ZeroAddress);
      const named = await ethers.deployContract("QuickLaunch", [...args, alice.address]);
      expect(await named.previousQuickLaunch()).to.equal(alice.address);
    });
  });

  // ------------------------------------------------------------ normal sales

  describe("normal presales", function () {
    async function normalFixture() {
      const env = await deployPlatform();
      const { tokenFactory, presaleFactory } = env;
      await tokenFactory.createStandardToken("Norm", "NORM", E(1_000_000));
      const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
      const now = await time.latest();
      const params = {
        token: token.target, presaleRate: E(1000), listingRate: E(800),
        softCap: E(2), hardCap: E(8), minContribution: E(0.5), maxContribution: E(4),
        startTime: now + 100, endTime: now + 1000, liquidityBps: 6000, liquidityAction: 1,
        lockDuration: 0, launchTime: 0, whitelistEnabled: false,
      };
      await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
      await presaleFactory.createPresale(params, { value: E(0.1) });
      const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
      await time.increaseTo(params.startTime);
      await presale.connect(env.alice).contribute({ value: E(1) });
      await presale.connect(env.bob).contribute({ value: E(2) });
      await presale.connect(env.carol).contribute({ value: E(1) });
      return { ...env, token, presale, params };
    }

    it("are not quick: no auto launch, payout to the owner, cancel still allowed", async function () {
      const { presale, presaleFactory, lens, deployer, alice } = await loadFixture(normalFixture);
      expect(await presale.autoLaunch()).to.equal(false);
      expect(await presale.payoutRecipient()).to.equal(deployer.address);
      expect(await presale.creatorShareBps()).to.equal(0);
      expect(await presaleFactory.isQuick(presale.target)).to.equal(false);
      expect(await presaleFactory.quickCreatorOf(presale.target)).to.equal(ethers.ZeroAddress);
      await expect(presale.connect(alice).setQuickMode(alice.address, 100)).to.be.revertedWith("not factory");
      const v = await lens.presaleView(presale.target);
      expect(v.quick).to.equal(false);
      expect(v.creator).to.equal(deployer.address);
      expect(v.participantsTotal).to.equal(3);
      expect((await lens.launchView(presale.target)).quick).to.equal(false);
      await expect(presale.cancel()).to.emit(presale, "Cancelled");
    });

    it("distribute() works on a finalized normal sale and claim() still works", async function () {
      const { presale, token, params, alice, bob, carol, dave } = await loadFixture(normalFixture);
      await expect(presale.distribute(10)).to.be.revertedWith("not finalized");
      await time.increaseTo(params.endTime + 1);
      const tx = presale.finalize(0, 0);
      await expect(tx).to.emit(presale, "Finalized");
      await expect(tx).to.not.emit(presale, "Distributed"); // no inline delivery on normal sales
      expect(await presale.distributionComplete()).to.equal(false);

      const d = presale.connect(dave).distribute(2);
      await expect(d).to.emit(presale, "Distributed").withArgs(2);
      await expect(d).to.emit(presale, "Claimed").withArgs(alice.address, E(1000));
      await expect(d).to.emit(presale, "Claimed").withArgs(bob.address, E(2000));
      expect(await token.balanceOf(alice.address)).to.equal(E(1000));
      expect(await token.balanceOf(bob.address)).to.equal(E(2000));
      let [sent, total] = await presale.distributionProgress();
      expect(sent).to.equal(2);
      expect(total).to.equal(3);
      await expect(presale.connect(alice).claim()).to.be.revertedWith("nothing to claim");

      await expect(presale.connect(carol).claim()).to.changeTokenBalance(token, carol, E(1000));
      [sent, total] = await presale.distributionProgress();
      expect(sent).to.equal(3);
      expect(await presale.distributionComplete()).to.equal(true);
      await expect(presale.distribute(10)).to.not.emit(presale, "Distributed");
      expect(await presale.distributionCursor()).to.equal(3);
      expect((await presale.statsOf(alice.address)).claimedTokens).to.equal(E(1000));
    });

    it("skips wallets that exited early", async function () {
      const { presale, params, carol } = await loadFixture(normalFixture);
      await presale.connect(carol).emergencyWithdraw();
      await time.increaseTo(params.endTime + 1);
      await presale.finalize(0, 0);
      await expect(presale.distribute(10)).to.emit(presale, "Distributed").withArgs(2);
      const [sent, total] = await presale.distributionProgress();
      expect(sent).to.equal(2);
      expect(total).to.equal(2);
      expect(await presale.distributionComplete()).to.equal(true);
    });
  });
});
