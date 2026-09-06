const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const BPS = 10_000n;

// Rules surfaced by the mainnet fork test, based on real Uniswap V2 behaviour:
// (A) pair.swap cannot send its output to its own tokens (INVALID_TO),
// (B) on a pool where LP has been minted, price deviation can shift the launch price,
// (C) the reward swap route must be configurable (for rewards without a WETH pool).
// MockDex now enforces the INVALID_TO rule as well.

function amountOut(amountIn, rIn, rOut) {
  const withFee = amountIn * 997n;
  return (withFee * rOut) / (rIn * 1000n + withFee);
}

async function addLiquidity(router, token, signer, tokens, eth) {
  await token.connect(signer).approve(router.target, tokens);
  await router
    .connect(signer)
    .addLiquidityETH(token.target, tokens, 0, 0, signer.address, (await time.latest()) + 600, { value: eth });
}

async function sell(router, weth, token, signer, amount) {
  await token.connect(signer).approve(router.target, amount);
  await router
    .connect(signer)
    .swapExactTokensForETHSupportingFeeOnTransferTokens(
      amount, 0, [token.target, weth.target], signer.address, (await time.latest()) + 600
    );
}

async function buy(router, weth, token, signer, eth) {
  await router
    .connect(signer)
    .swapExactETHForTokens(0, [weth.target, token.target], signer.address, (await time.latest()) + 600, { value: eth });
}

describe("Real DEX behaviour (INVALID_TO, pool price guard, reward routes)", function () {
  async function rewardsWethFixture() {
    const env = await deployPlatform();
    const { deployer, alice, bob, tokenFactory, router, weth } = env;
    await tokenFactory.createRewardsToken("Rew", "REW", E("1000000"), weth.target, deployer.address, [300, 300, 100, 100]);
    const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(0));
    await addLiquidity(router, token, deployer, E("200000"), E("100"));
    await token.transfer(alice.address, E("50000"));
    await token.transfer(bob.address, E("50000"));
    return { ...env, token };
  }

  describe("A. reward token = WETH", function () {
    it("distributes real WETH through the ETH path and holders claim it", async function () {
      const { token, router, weth, alice, bob } = await loadFixture(rewardsWethFixture);
      expect(await token.rewardPath()).to.deep.equal([token.target, weth.target]);

      await sell(router, weth, token, bob, E("20000")); // 3% rewards = 600
      expect(await token.pendingRewardsTokens()).to.equal(E("600"));

      const wethBefore = await weth.balanceOf(token.target);
      await expect(token.distributeRewards(0)).to.emit(token, "RewardsDistributed");
      const received = (await weth.balanceOf(token.target)) - wethBefore;
      expect(received).to.be.gt(0n);
      expect(await token.pendingRewardsTokens()).to.equal(0n);

      const claimable = await token.withdrawableRewardOf(alice.address);
      expect(claimable).to.be.gt(0n);
      const before = await weth.balanceOf(alice.address);
      await token.connect(alice).claimRewards();
      expect((await weth.balanceOf(alice.address)) - before).to.equal(claimable);
    });

    it("mock router now enforces INVALID_TO like the real pair", async function () {
      const { token, router, weth, bob } = await loadFixture(rewardsWethFixture);
      await token.connect(bob).approve(router.target, E("10"));
      await expect(
        router.connect(bob).swapExactTokensForTokensSupportingFeeOnTransferTokens(
          E("10"), 0, [token.target, weth.target], token.target, (await time.latest()) + 600
        )
      ).to.be.revertedWith("UniswapV2: INVALID_TO");
    });
  });

  describe("C. configurable reward route", function () {
    async function routeFixture() {
      const env = await deployPlatform();
      const { deployer, alice, tokenFactory, router, weth, dexFactory } = env;
      // A USDG-like intermediate token and a stock-like reward token without a WETH pool
      await tokenFactory.createStandardToken("Stable", "USDG", E("10000000"));
      await tokenFactory.createStandardToken("Stock", "TSLA", E("1000000"));
      const usdg = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
      const stock = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(1));
      await tokenFactory.createRewardsToken("Rew", "REW", E("1000000"), stock.target, deployer.address, [300, 300, 0, 0]);
      const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(2));

      await addLiquidity(router, token, deployer, E("200000"), E("100"));
      await addLiquidity(router, usdg, deployer, E("1000000"), E("100")); // 10000 USDG / ETH
      // STOCK/USDG pool (no WETH pool): create the pair, transfer both tokens, V2 mint
      await dexFactory.createPair(stock.target, usdg.target);
      const pairAddr = await dexFactory.getPair(stock.target, usdg.target);
      await stock.transfer(pairAddr, E("10000"));
      await usdg.transfer(pairAddr, E("1000000")); // 100 USDG / STOCK
      await (await ethers.getContractAt("MockPair", pairAddr)).mint(deployer.address);

      await token.transfer(alice.address, E("50000"));
      return { ...env, token, usdg, stock };
    }

    it("defaults to [token, WETH, rewardToken] and lets the owner set a longer route", async function () {
      const { token, weth, usdg, stock, alice } = await loadFixture(routeFixture);
      expect(await token.rewardPath()).to.deep.equal([token.target, weth.target, stock.target]);
      await expect(token.connect(alice).setRewardRoute([weth.target, usdg.target])).to.be.revertedWithCustomError(
        token, "OwnableUnauthorizedAccount"
      );
      await expect(token.setRewardRoute([weth.target, usdg.target])).to.emit(token, "RewardRouteUpdated");
      expect(await token.rewardPath()).to.deep.equal([token.target, weth.target, usdg.target, stock.target]);
      expect(await token.rewardRoute()).to.deep.equal([weth.target, usdg.target]);
    });

    it("validates routes", async function () {
      const { token, weth, usdg, stock, alice } = await loadFixture(routeFixture);
      await expect(token.setRewardRoute([])).to.be.revertedWith("route required");
      await expect(token.setRewardRoute([usdg.target])).to.be.revertedWith("route must start at WETH");
      await expect(token.setRewardRoute([weth.target, token.target])).to.be.revertedWith("bad hop");
      await expect(token.setRewardRoute([weth.target, stock.target])).to.be.revertedWith("bad hop");
      await expect(token.setRewardRoute([weth.target, ethers.ZeroAddress])).to.be.revertedWith("bad hop");
      await expect(
        token.setRewardRoute([weth.target, usdg.target, alice.address, weth.target])
      ).to.be.revertedWith("route too long");
    });

    it("distributes a stock-like reward through WETH and USDG when no WETH pool exists", async function () {
      const { token, router, weth, usdg, stock, alice } = await loadFixture(routeFixture);
      await sell(router, weth, token, alice, E("20000")); // rewards 600
      // Default route WETH -> STOCK: the platform token's WETH pair exists but is empty, so the swap fails
      await expect(token.distributeRewards(0)).to.be.revertedWith("router: no liquidity");

      await token.setRewardRoute([weth.target, usdg.target]);
      const before = await stock.balanceOf(token.target);
      await expect(token.distributeRewards(0)).to.emit(token, "RewardsDistributed");
      const received = (await stock.balanceOf(token.target)) - before;
      expect(received).to.be.gt(0n);

      const claimable = await token.withdrawableRewardOf(alice.address);
      expect(claimable).to.be.gt(0n);
      await token.connect(alice).claimRewards();
      expect(await stock.balanceOf(alice.address)).to.equal(claimable);
    });
  });

  describe("B. pool price guard on a pre-minted pair", function () {
    async function saleFixture() {
      const env = await deployPlatform();
      const { deployer, alice, bob, tokenFactory, presaleFactory } = env;
      await tokenFactory.createStandardToken("Pump", "PUMP", E("10000000"));
      const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
      const now = await time.latest();
      const params = {
        token: token.target,
        presaleRate: E("1000"),
        listingRate: E("800"),
        softCap: E("2"),
        hardCap: E("8"),
        minContribution: E("0.5"),
        maxContribution: E("4"),
        startTime: now + 100,
        endTime: now + 1000,
        liquidityBps: 6000,
        liquidityAction: 0,
        lockDuration: 30n * 24n * 3600n,
        launchTime: 0,
        whitelistEnabled: false,
      };
      await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
      await presaleFactory.createPresale(params, { value: E("0.1") });
      const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
      await time.increaseTo(params.startTime);
      await presale.connect(alice).contribute({ value: E("3") });
      await presale.connect(bob).contribute({ value: E("2") });
      await time.increaseTo(params.endTime + 10);
      return { ...env, token, presale, params };
    }

    it("reports zero deviation on an empty pool and finalizes normally", async function () {
      const { presale } = await loadFixture(saleFixture);
      expect(await presale.poolPriceDeviationBps()).to.equal(0n);
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
    });

    it("refuses to finalize into a pre-minted pool whose price is off the listing rate", async function () {
      const { presale, token, router, carol } = await loadFixture(saleFixture);
      await token.transfer(carol.address, E("100"));
      await addLiquidity(router, token, carol, E("100"), E("1")); // ~99 token / ETH, listing 800
      expect(await presale.poolPriceDeviationBps()).to.be.gt(500n);
      await expect(presale.finalize(0, 0)).to.be.revertedWith("pool price off listing");
    });

    it("finalizes once the owner realigns the pool, and the launch price lands on the listing rate", async function () {
      const { presale, token, router, weth, dexFactory, carol, deployer } = await loadFixture(saleFixture);
      await token.transfer(carol.address, E("100"));
      await addLiquidity(router, token, carol, E("100"), E("1"));
      const pair = await ethers.getContractAt("MockPair", await dexFactory.getPair(token.target, weth.target));

      // The owner sells tokens to pull the price to 800 token/ETH; the input is found by binary search over the V2 formula
      const LISTING = E("800");
      const rT = await token.balanceOf(pair.target);
      const rW = await weth.balanceOf(pair.target);
      let lo = 0n, hi = E("100000");
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2n;
        const out = amountOut(mid, rT, rW);
        const ratio = ((rT + mid) * E("1")) / (rW - out);
        if (ratio < LISTING) lo = mid; else hi = mid;
      }
      const ethBefore = await ethers.provider.getBalance(deployer.address);
      await sell(router, weth, token, deployer, hi);
      // Realigning 99 -> 800 token/ETH moves ~0.65 of the pool's 1 ETH to the owner (the attacker's capital)
      expect(await ethers.provider.getBalance(deployer.address)).to.be.gt(ethBefore + E("0.6"));
      expect(await presale.poolPriceDeviationBps()).to.be.lte(500n);

      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
      const tokensPerEth = ((await token.balanceOf(pair.target)) * E("1")) / (await weth.balanceOf(pair.target));
      expect(tokensPerEth).to.be.gte((LISTING * 9500n) / BPS);
      expect(tokensPerEth).to.be.lte((LISTING * 10500n) / BPS);
    });

    it("accepts a pre-minted pool that already sits at the listing price", async function () {
      const { presale, token, router, carol } = await loadFixture(saleFixture);
      await token.transfer(carol.address, E("1000"));
      // 800 tokens (792 after tax) + 1 ETH: 1% deviation
      await addLiquidity(router, token, carol, E("800"), E("1"));
      expect(await presale.poolPriceDeviationBps()).to.be.lte(500n);
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
    });

    it("still tolerates donation-only griefing (no LP minted)", async function () {
      const { presale, token, weth, dexFactory, carol } = await loadFixture(saleFixture);
      const pair = await ethers.getContractAt("MockPair", await dexFactory.getPair(token.target, weth.target));
      await token.transfer(carol.address, E("100"));
      await token.connect(carol).transfer(pair.target, E("100"));
      await weth.connect(carol).deposit({ value: E("1") });
      await weth.connect(carol).transfer(pair.target, E("1"));
      await pair.sync();
      expect(await pair.totalSupply()).to.equal(0n);
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
    });
  });
});
