const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { deployPlatform } = require("./helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DAY = 86400n;

// Status enum
const Upcoming = 0n, Live = 1n, Ended = 2n, Failed = 3n, Cancelled = 4n, Finalized = 5n;
// LiquidityAction enum
const Lock = 0, Burn = 1;

/**
 * Base fixture: platform + a Standard token owned by alice + default presale params.
 * Defaults: rate 1000/ETH, listing 800/ETH, soft 5 / hard 10 ETH, min 0.1 / max 5 ETH,
 * 60% liquidity, Lock 30d. requiredTokensFor(defaults) = 14320 tokens.
 */
async function presaleFixture() {
  const ctx = await deployPlatform();
  const { tokenFactory, alice } = ctx;

  await tokenFactory.connect(alice).createStandardToken("Pump", "PUMP", E("1000000"));
  const tokenAddr = await tokenFactory.allTokens(0);
  const token = await ethers.getContractAt("StandardToken", tokenAddr);

  const now = BigInt(await time.latest());
  const start = now + 1000n;
  const params = {
    token: tokenAddr,
    presaleRate: E("1000"),
    listingRate: E("800"),
    softCap: E("5"),
    hardCap: E("10"),
    minContribution: E("0.1"),
    maxContribution: E("5"),
    startTime: start,
    endTime: start + DAY,
    liquidityBps: 6000,
    liquidityAction: Lock,
    lockDuration: 30n * DAY,
    launchTime: 0,
    whitelistEnabled: false,
  };

  return { ...ctx, token, params };
}

async function createPresale(ctx, overrides = {}) {
  const p = { ...ctx.params, ...overrides };
  const required = await ctx.presaleFactory.requiredTokensFor(p);
  await ctx.token.connect(ctx.alice).approve(ctx.presaleFactory.target, required);
  await ctx.presaleFactory.connect(ctx.alice).createPresale(p, { value: FEE });
  const n = await ctx.presaleFactory.allPresalesLength();
  const addr = await ctx.presaleFactory.allPresales(n - 1n);
  return ethers.getContractAt("Presale", addr);
}

/** Presale started; contribs = [["bob", "3"], ...] amounts in ETH strings. */
async function liveWith(ctx, contribs = [], overrides = {}) {
  const presale = await createPresale(ctx, overrides);
  await time.increaseTo(ctx.params.startTime);
  for (const [who, amt] of contribs) {
    await presale.connect(ctx[who]).contribute({ value: E(amt) });
  }
  return presale;
}

async function expectCreateRevert(ctx, overrides, reason) {
  const p = { ...ctx.params, ...overrides };
  await expect(
    ctx.presaleFactory.connect(ctx.alice).createPresale(p, { value: FEE })
  ).to.be.revertedWith(reason);
}

describe("Presale lifecycle", function () {
  // ------------------------------------------------------------ createPresale

  describe("createPresale", function () {
    it("creates a presale for exactly 0.1 ETH and forwards the fee to Treasury", async function () {
      const ctx = await loadFixture(presaleFixture);
      const { presaleFactory, token, treasury, alice, params } = ctx;
      const required = await presaleFactory.requiredTokensFor(params);
      await token.connect(alice).approve(presaleFactory.target, required);
      const tx = presaleFactory.connect(alice).createPresale(params, { value: FEE });
      await expect(tx).to.emit(presaleFactory, "PresaleCreated").withArgs(anyValue, token.target, alice.address);
      await expect(tx).to.changeEtherBalances([treasury], [FEE]);
      // Treasury earmarks 30% of incoming ETH for buyback
      expect(await treasury.buybackReserve()).to.equal((FEE * 3000n) / 10000n);
    });

    it("reverts when the creation fee is not exactly 0.1 ETH", async function () {
      const ctx = await loadFixture(presaleFixture);
      const { presaleFactory, token, alice, params } = ctx;
      await token.connect(alice).approve(presaleFactory.target, ethers.MaxUint256);
      await expect(
        presaleFactory.connect(alice).createPresale(params, { value: E("0.05") })
      ).to.be.revertedWith("wrong creation fee");
      await expect(
        presaleFactory.connect(alice).createPresale(params, { value: E("0.2") })
      ).to.be.revertedWith("wrong creation fee");
    });

    it("rejects tokens not created by the platform TokenFactory", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { token: ctx.weth.target }, "not a platform token");
    });

    it("rejects callers that do not own the token", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expect(
        ctx.presaleFactory.connect(ctx.bob).createPresale(ctx.params, { value: FEE })
      ).to.be.revertedWith("not token owner");
    });

    it("validates caps", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { softCap: 0n }, "bad caps");
      await expectCreateRevert(ctx, { softCap: E("10"), hardCap: E("9") }, "bad caps");
    });

    it("rejects softcap below 25% of hardcap", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { softCap: E("1"), hardCap: E("5"), maxContribution: E("5") }, "softcap < 25% of hardcap");
    });

    it("validates contribution limits", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { minContribution: 0n }, "bad limits");
      await expectCreateRevert(ctx, { minContribution: E("2"), maxContribution: E("1") }, "bad limits");
    });

    it("rejects maxContribution above hardcap", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { maxContribution: E("11") }, "max > hardcap");
    });

    it("validates rates", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { presaleRate: 0n, listingRate: 0n }, "bad rates");
      await expectCreateRevert(ctx, { listingRate: 0n }, "bad rates");
    });

    it("rejects listingRate above presaleRate", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { listingRate: E("1001") }, "listing > presale rate");
    });

    it("rejects startTime in the past", async function () {
      const ctx = await loadFixture(presaleFixture);
      const past = BigInt(await time.latest()) - 100n;
      await expectCreateRevert(ctx, { startTime: past }, "start in past");
    });

    it("rejects endTime not after startTime", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { endTime: ctx.params.startTime }, "bad times");
    });

    it("rejects sales longer than 90 days", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { endTime: ctx.params.startTime + 91n * DAY }, "sale too long");
    });

    it("rejects liquidityBps below 5100 or above 10000", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { liquidityBps: 5000 }, "bad liquidity bps");
      await expectCreateRevert(ctx, { liquidityBps: 10001 }, "bad liquidity bps");
    });

    it("rejects lock duration under 30 days when Lock is chosen, ignores it for Burn", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expectCreateRevert(ctx, { lockDuration: 29n * DAY }, "lock too short");
      // Burn ignores lockDuration entirely
      const presale = await createPresale(ctx, { liquidityAction: Burn, lockDuration: 0n });
      expect(await presale.status()).to.equal(Upcoming);
    });

    it("requires the creator to approve the factory for the required tokens first", async function () {
      const ctx = await loadFixture(presaleFixture);
      await expect(
        ctx.presaleFactory.connect(ctx.alice).createPresale(ctx.params, { value: FEE })
      ).to.be.revertedWithCustomError(ctx.token, "ERC20InsufficientAllowance");
    });

    it("pulls exactly requiredTokensFor tokens from the creator", async function () {
      const ctx = await loadFixture(presaleFixture);
      const required = await ctx.presaleFactory.requiredTokensFor(ctx.params);
      // sale tokens 10*1000 + liquidity tokens (10-1)*0.6*800 = 10000 + 4320
      expect(required).to.equal(E("14320"));
      const balBefore = await ctx.token.balanceOf(ctx.alice.address);
      const presale = await createPresale(ctx);
      expect(await ctx.token.balanceOf(presale.target)).to.equal(required);
      expect(await ctx.token.balanceOf(ctx.alice.address)).to.equal(balBefore - required);
    });

    it("registers the presale in allPresales, activePresaleOfToken and presalesOfCreator", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await createPresale(ctx);
      expect(await ctx.presaleFactory.allPresalesLength()).to.equal(1n);
      expect(await ctx.presaleFactory.allPresales(0)).to.equal(presale.target);
      expect(await ctx.presaleFactory.isPresale(presale.target)).to.equal(true);
      expect(await ctx.presaleFactory.activePresaleOfToken(ctx.token.target)).to.equal(presale.target);
      expect([...(await ctx.presaleFactory.presalesOfCreator(ctx.alice.address))]).to.deep.equal([presale.target]);
      expect(await presale.saleOwner()).to.equal(ctx.alice.address);
    });

    it("excludes the presale contract from token fees", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await createPresale(ctx);
      expect(await ctx.token.isExcludedFromFees(presale.target)).to.equal(true);
    });

    it("blocks a second presale for the same token while one is active", async function () {
      const ctx = await loadFixture(presaleFixture);
      await createPresale(ctx);
      await expect(
        ctx.presaleFactory.connect(ctx.alice).createPresale(ctx.params, { value: FEE })
      ).to.be.revertedWith("presale exists");
    });

    it("allows a new presale for the token after the previous one is cancelled", async function () {
      const ctx = await loadFixture(presaleFixture);
      const first = await createPresale(ctx);
      await first.connect(ctx.alice).cancel();
      expect(await ctx.presaleFactory.activePresaleOfToken(ctx.token.target)).to.equal(ethers.ZeroAddress);
      const second = await createPresale(ctx);
      expect(second.target).to.not.equal(first.target);
      expect(await ctx.presaleFactory.activePresaleOfToken(ctx.token.target)).to.equal(second.target);
    });
  });

  // --------------------------------------------------------------- contribute

  describe("contribute", function () {
    it("reverts before startTime", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await createPresale(ctx);
      await expect(presale.connect(ctx.bob).contribute({ value: E("1") })).to.be.revertedWith("not started");
    });

    it("reverts after endTime", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx);
      await time.increaseTo(ctx.params.endTime + 1n);
      await expect(presale.connect(ctx.bob).contribute({ value: E("1") })).to.be.revertedWith("ended");
    });

    it("reverts on zero value", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx);
      await expect(presale.connect(ctx.bob).contribute({ value: 0 })).to.be.revertedWith("zero value");
    });

    it("enforces the per-wallet minimum", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx);
      await expect(presale.connect(ctx.bob).contribute({ value: E("0.05") })).to.be.revertedWith("below min");
      // once above min, a small top-up is allowed (min applies to the cumulative amount)
      await presale.connect(ctx.bob).contribute({ value: E("0.1") });
      await presale.connect(ctx.bob).contribute({ value: E("0.05") });
      expect(await presale.contributionOf(ctx.bob.address)).to.equal(E("0.15"));
    });

    it("enforces the per-wallet maximum, including cumulatively", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx);
      await expect(presale.connect(ctx.bob).contribute({ value: E("5.5") })).to.be.revertedWith("above max");
      await presale.connect(ctx.bob).contribute({ value: E("3") });
      await expect(presale.connect(ctx.bob).contribute({ value: E("2.5") })).to.be.revertedWith("above max");
      await presale.connect(ctx.bob).contribute({ value: E("2") }); // exactly max
      expect(await presale.contributionOf(ctx.bob.address)).to.equal(E("5"));
    });

    it("caps total contributions at the hardcap", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"], ["carol", "4"]]);
      await expect(presale.connect(ctx.dave).contribute({ value: E("2") })).to.be.revertedWith("hardcap exceeded");
      await presale.connect(ctx.dave).contribute({ value: E("1") });
      expect(await presale.totalRaised()).to.equal(E("10"));
    });

    it("tracks totalRaised and counts unique contributors", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx);
      await presale.connect(ctx.bob).contribute({ value: E("1") });
      await presale.connect(ctx.bob).contribute({ value: E("1") });
      expect(await presale.contributorCount()).to.equal(1n);
      await presale.connect(ctx.carol).contribute({ value: E("0.5") });
      expect(await presale.contributorCount()).to.equal(2n);
      expect(await presale.totalRaised()).to.equal(E("2.5"));
    });

    it("status(): Upcoming -> Live -> Ended when effectively full", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await createPresale(ctx);
      expect(await presale.status()).to.equal(Upcoming);
      await time.increaseTo(ctx.params.startTime);
      expect(await presale.status()).to.equal(Live);
      await presale.connect(ctx.bob).contribute({ value: E("5") });
      await presale.connect(ctx.carol).contribute({ value: E("4.95") });
      // hardCap - raised = 0.05 < minContribution -> Ended even before endTime
      expect(await presale.status()).to.equal(Ended);
    });

    it("status(): Ended after end with softcap met, Failed otherwise", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      expect(await presale.status()).to.equal(Ended);

      const ctx2 = await loadFixture(presaleFixture);
      const presale2 = await liveWith(ctx2, [["bob", "1"]]);
      await time.increaseTo(ctx2.params.endTime + 1n);
      expect(await presale2.status()).to.equal(Failed);
    });
  });

  // ------------------------------------------------------- emergencyWithdraw

  describe("emergencyWithdraw", function () {
    it("refunds 90% to the contributor and sends 10% to the Treasury", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"], ["carol", "1"]]);
      const tx = presale.connect(ctx.bob).emergencyWithdraw();
      await expect(tx).to.changeEtherBalances(
        [ctx.bob, ctx.treasury, presale],
        [E("1.8"), E("0.2"), -E("2")]
      );
      await expect(tx).to.emit(presale, "EmergencyWithdrawn").withArgs(ctx.bob.address, E("1.8"), E("0.2"));
    });

    it("updates totalRaised, contributorCount and contributionOf", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"], ["carol", "1"]]);
      await presale.connect(ctx.bob).emergencyWithdraw();
      expect(await presale.totalRaised()).to.equal(E("1"));
      expect(await presale.contributorCount()).to.equal(1n);
      expect(await presale.contributionOf(ctx.bob.address)).to.equal(0n);
    });

    it("reverts after the sale has ended", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      await expect(presale.connect(ctx.bob).emergencyWithdraw()).to.be.revertedWith("sale ended");
    });

    it("reverts without a contribution", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx);
      await expect(presale.connect(ctx.bob).emergencyWithdraw()).to.be.revertedWith("no contribution");
    });
  });

  // ------------------------------------------------------------------ cancel

  describe("cancel", function () {
    it("only the sale owner can cancel", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await createPresale(ctx);
      await expect(presale.connect(ctx.bob).cancel()).to.be.revertedWith("not sale owner");
    });

    it("returns all tokens to the owner, sets Cancelled and frees activePresaleOfToken", async function () {
      const ctx = await loadFixture(presaleFixture);
      const required = await ctx.presaleFactory.requiredTokensFor(ctx.params);
      const presale = await createPresale(ctx);
      const balBefore = await ctx.token.balanceOf(ctx.alice.address);
      await expect(presale.connect(ctx.alice).cancel()).to.emit(presale, "Cancelled");
      expect(await ctx.token.balanceOf(ctx.alice.address)).to.equal(balBefore + required);
      expect(await ctx.token.balanceOf(presale.target)).to.equal(0n);
      expect(await presale.status()).to.equal(Cancelled);
      expect(await ctx.presaleFactory.activePresaleOfToken(ctx.token.target)).to.equal(ethers.ZeroAddress);
    });

    it("lets contributors claim a full refund after cancel", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"], ["carol", "3"]]);
      await presale.connect(ctx.alice).cancel();
      await expect(presale.connect(ctx.bob).claimRefund()).to.changeEtherBalances([ctx.bob], [E("2")]);
      await expect(presale.connect(ctx.carol).claimRefund()).to.changeEtherBalances([ctx.carol], [E("3")]);
      await expect(presale.connect(ctx.bob).claimRefund()).to.be.revertedWith("nothing to refund");
      expect(await ethers.provider.getBalance(presale.target)).to.equal(0n);
    });

    it("blocks contribute, claim and a second cancel after cancelling", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"]]);
      await presale.connect(ctx.alice).cancel();
      await expect(presale.connect(ctx.carol).contribute({ value: E("1") })).to.be.revertedWith("not active");
      await expect(presale.connect(ctx.bob).claim()).to.be.revertedWith("not finalized");
      await expect(presale.connect(ctx.alice).cancel()).to.be.revertedWith("not active");
    });

    it("cannot cancel after finalize", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"], ["carol", "5"]]);
      await presale.connect(ctx.alice).finalize(0, 0);
      await expect(presale.connect(ctx.alice).cancel()).to.be.revertedWith("not active");
    });
  });

  // --------------------------------------------------------------- fail path

  describe("failed sale (softcap not met)", function () {
    it("turns Failed after endTime and gives full refunds", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"], ["carol", "1"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      expect(await presale.status()).to.equal(Failed);
      await expect(presale.connect(ctx.bob).claimRefund()).to.changeEtherBalances([ctx.bob], [E("2")]);
      await expect(presale.connect(ctx.carol).claimRefund()).to.changeEtherBalances([ctx.carol], [E("1")]);
      await expect(presale.connect(ctx.bob).claimRefund()).to.be.revertedWith("nothing to refund");
    });

    it("blocks contribute and finalize on a failed sale", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      await expect(presale.connect(ctx.carol).contribute({ value: E("1") })).to.be.revertedWith("ended");
      await expect(presale.connect(ctx.alice).finalize(0, 0)).to.be.revertedWith("softcap not met");
    });

    it("refunds are not available while the sale is still live", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "2"]]);
      await expect(presale.connect(ctx.bob).claimRefund()).to.be.revertedWith("refund not available");
    });
  });

  // ---------------------------------------------------------------- finalize

  describe("finalize", function () {
    // Scenario A (Burn): bob 5 + carol 5 = 10 ETH (hardcap), finalize before end.
    //   fee 1, net 9, liqEth 5.4, liqTokens 4320, claims 10000, leftover tokens 0, leftover ETH 3.6
    // Scenario B (Lock): bob 3 + carol 3 = 6 ETH, finalize after end.
    //   fee 0.6, net 5.4, liqEth 3.24, liqTokens 2592, claims 6000, leftover tokens 5728, leftover ETH 2.16

    it("reverts before endTime when the sale is not effectively full", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"]]); // softcap met, room left
      await expect(presale.connect(ctx.alice).finalize(0, 0)).to.be.revertedWith("sale still running");
    });

    it("can finalize before endTime when hardCap - raised < minContribution", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"], ["carol", "4.95"]]);
      await presale.connect(ctx.alice).finalize(0, 0);
      expect(await presale.status()).to.equal(Finalized);
    });

    it("reverts below softcap", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "4.9"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      await expect(presale.connect(ctx.alice).finalize(0, 0)).to.be.revertedWith("softcap not met");
    });

    it("only the sale owner can finalize when no launch time is set", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"], ["carol", "5"]]);
      await expect(presale.connect(ctx.bob).finalize(0, 0)).to.be.revertedWith(
        "not authorized to launch"
      );
      expect(await presale.isLaunchDue()).to.equal(false);
    });

    it("sends exactly 10% of the raise to the Treasury and leftover ETH to the owner", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "3"], ["carol", "3"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      const tx = presale.connect(ctx.alice).finalize(0, 0);
      // treasury +0.6; alice gets net - liquidity = 6 - 0.6 - 3.24 = 2.16
      await expect(tx).to.changeEtherBalances([ctx.treasury, ctx.alice], [E("0.6"), E("2.16")]);
      expect(await ethers.provider.getBalance(presale.target)).to.equal(0n);
    });

    it("adds liquidity at the listing rate (pair reserves match) and emits Finalized", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "3"], ["carol", "3"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      await expect(presale.connect(ctx.alice).finalize(0, 0))
        .to.emit(presale, "Finalized")
        .withArgs(E("0.6"), E("3.24"), E("2592"), anyValue);
      const pair = await ctx.token.mainPair();
      expect(await ctx.weth.balanceOf(pair)).to.equal(E("3.24"));
      expect(await ctx.token.balanceOf(pair)).to.equal(E("2592"));
    });

    it("burns the LP to 0xdead when LiquidityAction is Burn", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"], ["carol", "5"]], { liquidityAction: Burn });
      await presale.connect(ctx.alice).finalize(0, 0);
      const pairAddr = await ctx.token.mainPair();
      const pair = await ethers.getContractAt("MockPair", pairAddr);
      const lpAmount = await presale.lpAmount();
      expect(lpAmount).to.be.gt(0n);
      expect(await pair.balanceOf(DEAD)).to.equal(lpAmount);
      expect(await ctx.weth.balanceOf(pairAddr)).to.equal(E("5.4"));
      expect(await ctx.token.balanceOf(pairAddr)).to.equal(E("4320"));
    });

    it("locks the LP in the LiquidityLocker for the sale owner with the right unlock time", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "3"], ["carol", "3"]]); // Lock by default
      await time.increaseTo(ctx.params.endTime + 1n);
      await presale.connect(ctx.alice).finalize(0, 0);

      const pairAddr = await ctx.token.mainPair();
      const pair = await ethers.getContractAt("MockPair", pairAddr);
      const lpAmount = await presale.lpAmount();
      const lockId = await presale.lpLockId();
      const info = await ctx.locker.locks(lockId);
      expect(info.token).to.equal(pairAddr);
      expect(info.owner).to.equal(ctx.alice.address);
      expect(info.amount).to.equal(lpAmount);
      expect(info.unlockTime).to.equal((await presale.finalizedAt()) + 30n * DAY);
      expect(info.withdrawn).to.equal(false);
      expect(await pair.balanceOf(ctx.locker.target)).to.equal(lpAmount);

      // cannot unlock early; can unlock after the lock expires
      await expect(ctx.locker.connect(ctx.alice).unlock(lockId)).to.be.revertedWith("still locked");
      await time.increaseTo(info.unlockTime);
      await ctx.locker.connect(ctx.alice).unlock(lockId);
      expect(await pair.balanceOf(ctx.alice.address)).to.equal(lpAmount);
    });

    it("returns leftover tokens to the sale owner", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "3"], ["carol", "3"]]);
      await time.increaseTo(ctx.params.endTime + 1n);
      const balBefore = await ctx.token.balanceOf(ctx.alice.address);
      await presale.connect(ctx.alice).finalize(0, 0);
      // 14320 deposited - 2592 liquidity - 6000 reserved for claims = 5728 back
      expect(await ctx.token.balanceOf(ctx.alice.address)).to.equal(balBefore + E("5728"));
      expect(await ctx.token.balanceOf(presale.target)).to.equal(E("6000"));
    });

    it("claim() pays contribution * presaleRate / 1e18 and cannot be repeated", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "3"], ["carol", "3"]]);
      await expect(presale.connect(ctx.bob).claim()).to.be.revertedWith("not finalized");
      await time.increaseTo(ctx.params.endTime + 1n);
      await presale.connect(ctx.alice).finalize(0, 0);

      await expect(presale.connect(ctx.bob).claim()).to.changeTokenBalance(ctx.token, ctx.bob, E("3000"));
      await expect(presale.connect(ctx.carol).claim()).to.changeTokenBalance(ctx.token, ctx.carol, E("3000"));
      await expect(presale.connect(ctx.bob).claim()).to.be.revertedWith("nothing to claim");
      await expect(presale.connect(ctx.dave).claim()).to.be.revertedWith("nothing to claim");
      expect(await ctx.token.balanceOf(presale.target)).to.equal(0n);
    });

    it("after finalize: no refunds, no contributions, no second finalize", async function () {
      const ctx = await loadFixture(presaleFixture);
      const presale = await liveWith(ctx, [["bob", "5"], ["carol", "5"]]);
      await presale.connect(ctx.alice).finalize(0, 0);
      expect(await presale.status()).to.equal(Finalized);
      await expect(presale.connect(ctx.bob).claimRefund()).to.be.revertedWith("refund not available");
      await expect(presale.connect(ctx.dave).contribute({ value: E("1") })).to.be.revertedWith("not active");
      await expect(presale.connect(ctx.alice).finalize(0, 0)).to.be.revertedWith("not active");
    });
  });

  // ------------------------------------------------- trading after finalize

  describe("post-finalize trading on the DEX", function () {
    async function finalized(ctx) {
      const presale = await liveWith(ctx, [["bob", "5"], ["carol", "5"]], { liquidityAction: Burn });
      await presale.connect(ctx.alice).finalize(0, 0);
      await presale.connect(ctx.bob).claim(); // bob holds 5000 tokens
      return presale;
    }

    it("lets a buyer sell claimed tokens into the real liquidity, with 0.25% platform tax", async function () {
      const ctx = await loadFixture(presaleFixture);
      const { token, router, weth, bob } = ctx;
      await finalized(ctx);

      const pairAddr = await token.mainPair();
      const sellAmount = E("1000");
      const taxed = (sellAmount * 25n) / 10000n; // 0.25% platform tax accrues in the token contract
      const effIn = sellAmount - taxed;
      const rToken = await token.balanceOf(pairAddr); // 4320
      const rWeth = await weth.balanceOf(pairAddr); // 5.4
      const expectedOut = (effIn * 997n * rWeth) / (rToken * 1000n + effIn * 997n);

      await token.connect(bob).approve(router.target, sellAmount);
      const tx = router.connect(bob).swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount, 0, [token.target, weth.target], bob.address,
        (await time.latest()) + 600
      );
      await expect(tx).to.changeEtherBalances([bob], [expectedOut]);
      expect(expectedOut).to.be.gt(0n);
      expect(await token.balanceOf(pairAddr)).to.equal(rToken + effIn);
      expect(await token.balanceOf(token.target)).to.equal(taxed);
      expect(await token.pendingPlatformTokens()).to.equal(taxed);
    });

    it("applies the 0.25% platform tax on buys too", async function () {
      const ctx = await loadFixture(presaleFixture);
      const { token, router, weth, dave } = ctx;
      await finalized(ctx);

      const pairAddr = await token.mainPair();
      const ethIn = E("0.5");
      const rToken = await token.balanceOf(pairAddr);
      const rWeth = await weth.balanceOf(pairAddr);
      const outPreTax = (ethIn * 997n * rToken) / (rWeth * 1000n + ethIn * 997n);
      const tax = (outPreTax * 25n) / 10000n;

      await router.connect(dave).swapExactETHForTokens(
        0, [weth.target, token.target], dave.address,
        (await time.latest()) + 600, { value: ethIn }
      );
      expect(await token.balanceOf(dave.address)).to.equal(outPreTax - tax);
      expect(await token.pendingPlatformTokens()).to.equal(tax);
    });
  });
});
