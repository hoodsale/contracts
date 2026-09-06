const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatform } = require("./helpers");

const E = ethers.parseEther;
const BPS = 10_000n;
const MAGNITUDE = 1n << 128n;

async function deadline() {
  return (await time.latest()) + 600;
}

async function addLiq(router, token, signer, tokenAmt, ethAmt) {
  await token.connect(signer).approve(router.target, tokenAmt);
  await router
    .connect(signer)
    .addLiquidityETH(token.target, tokenAmt, 0, 0, signer.address, await deadline(), { value: ethAmt });
}

async function buy(router, weth, token, signer, ethAmt) {
  return router
    .connect(signer)
    .swapExactETHForTokens(0, [weth.target, token.target], signer.address, await deadline(), { value: ethAmt });
}

async function sell(router, weth, token, signer, amount) {
  await token.connect(signer).approve(router.target, amount);
  return router
    .connect(signer)
    .swapExactTokensForETHSupportingFeeOnTransferTokens(
      amount,
      0,
      [token.target, weth.target],
      signer.address,
      await deadline()
    );
}

function findEvent(receipt, iface, name) {
  for (const log of receipt.logs) {
    let parsed = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch (e) {
      parsed = null;
    }
    if (parsed && parsed.name === name) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------- fixtures

async function standardFixture() {
  const ctx = await deployPlatform();
  const { tokenFactory, router, alice, bob, carol } = ctx;
  await tokenFactory.connect(alice).createStandardToken("Alpha", "ALPHA", E("1000000"));
  const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("300000"));
  await token.connect(alice).transfer(carol.address, E("50000"));
  return { ...ctx, token };
}

async function taxFixture() {
  const ctx = await deployPlatform();
  const { tokenFactory, router, alice, bob, dave } = ctx;
  // dave = marketing wallet of the tax token (passive EOA in these tests)
  await tokenFactory
    .connect(alice)
    .createTaxToken("Taxed", "TAXD", E("1000000"), dave.address, 400, 500);
  const token = await ethers.getContractAt("TaxToken", await tokenFactory.allTokens(0));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("300000"));
  return { ...ctx, token };
}

async function rewardsFixture() {
  const ctx = await deployPlatform();
  const { tokenFactory, router, weth, alice, bob, carol, dave } = ctx;
  // reward token = WETH, taxes: rewards 3%/3%, marketing 1%/1% (+0.25% platform = 4.25% per side)
  await tokenFactory
    .connect(alice)
    .createRewardsToken("Divi", "DIVI", E("1000000"), weth.target, dave.address, [300, 300, 100, 100]);
  const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(0));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("200000"));
  await token.connect(alice).transfer(carol.address, E("100000"));
  return { ...ctx, token };
}

async function stockRewardsFixture() {
  const ctx = await deployPlatform();
  const { tokenFactory, router, alice, bob, dave } = ctx;
  // "tokenized stock" mock: a platform standard token with its own WETH pair
  await tokenFactory.connect(alice).createStandardToken("tApple", "tAAPL", E("1000000"));
  const stock = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
  await addLiq(router, stock, alice, E("200000"), E("50"));

  await tokenFactory
    .connect(alice)
    .createRewardsToken("StockRew", "SREW", E("1000000"), stock.target, dave.address, [300, 300, 0, 0]);
  const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(1));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("200000"));
  return { ...ctx, token, stock };
}

/** A packed Uniswap V3 path: token, fee, token, fee, token ... */
function packPath(...route) {
  return ethers.solidityPacked(route.map((_, i) => (i % 2 === 0 ? "address" : "uint24")), route);
}

async function v3StockRewardsFixture() {
  const ctx = await deployPlatform();
  const { tokenFactory, router, weth, v3Factory, alice, bob, dave } = ctx;
  // "tokenized stock" mock whose only pool is a Uniswap V3 pool against WETH (0.3%):
  // 50 WETH against 200,000 stock, filled by the deployer
  const stock = await ethers.deployContract("MockERC20", ["tApple", "tAAPL", 18, E("1000000")]);
  await v3Factory.createPool(weth.target, stock.target, 3000);
  const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, stock.target, 3000));
  await weth.deposit({ value: E("50") });
  await weth.transfer(pool.target, E("50"));
  await stock.transfer(pool.target, E("200000"));
  await pool.sync();
  const path = packPath(weth.target, 3000, stock.target);

  await tokenFactory
    .connect(alice)
    .createRewardsToken("StockRew", "SREW", E("1000000"), stock.target, dave.address, [300, 300, 0, 0]);
  const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(0));
  await token.connect(alice).setRewardRouteV3(path);
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("200000"));
  return { ...ctx, token, stock, pool, path };
}

async function hoodFixture() {
  const ctx = await deployPlatform();
  const { hoodsale, router, deployer, alice } = ctx;
  await addLiq(router, hoodsale, deployer, E("10000000"), E("100"));
  await hoodsale.connect(deployer).transfer(alice.address, E("10000000"));
  return ctx;
}

// ================================================================ tests

describe("TokenFactory", function () {
  it("creates all 3 token types for free (full supply to creator, no fee)", async function () {
    const { tokenFactory, weth, alice, bob, dave } = await loadFixture(deployPlatform);

    const tx1 = await tokenFactory.connect(alice).createStandardToken("Alpha", "ALPHA", E("1000"));
    const std = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    await expect(tx1)
      .to.emit(tokenFactory, "TokenCreated")
      .withArgs(std.target, alice.address, 0, "Alpha", "ALPHA");
    expect(await std.balanceOf(alice.address)).to.equal(E("1000"));
    expect(await std.totalSupply()).to.equal(E("1000"));
    expect(await std.owner()).to.equal(alice.address);

    await tokenFactory.connect(bob).createTaxToken("Taxed", "TAXD", E("2000"), dave.address, 400, 500);
    const tax = await ethers.getContractAt("TaxToken", await tokenFactory.allTokens(1));
    expect(await tax.balanceOf(bob.address)).to.equal(E("2000"));
    expect(await tax.buyTaxBps()).to.equal(400);
    expect(await tax.sellTaxBps()).to.equal(500);

    await tokenFactory
      .connect(alice)
      .createRewardsToken("Divi", "DIVI", E("3000"), weth.target, dave.address, [300, 300, 100, 100]);
    const rew = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(2));
    expect(await rew.balanceOf(alice.address)).to.equal(E("3000"));
    expect(await rew.rewardToken()).to.equal(weth.target);
  });

  it("registry: isPlatformToken, infoOf, allTokensLength, tokensOfCreator, getTokens", async function () {
    const { tokenFactory, weth, alice, bob, dave } = await loadFixture(deployPlatform);
    await tokenFactory.connect(alice).createStandardToken("Alpha", "ALPHA", E("1000"));
    await tokenFactory.connect(bob).createTaxToken("Taxed", "TAXD", E("2000"), dave.address, 100, 100);
    await tokenFactory
      .connect(alice)
      .createRewardsToken("Divi", "DIVI", E("3000"), weth.target, dave.address, [100, 100, 0, 0]);

    const std = await tokenFactory.allTokens(0);
    const tax = await tokenFactory.allTokens(1);
    const rew = await tokenFactory.allTokens(2);

    expect(await tokenFactory.allTokensLength()).to.equal(3);
    expect(await tokenFactory.isPlatformToken(std)).to.equal(true);
    expect(await tokenFactory.isPlatformToken(rew)).to.equal(true);
    expect(await tokenFactory.isPlatformToken(bob.address)).to.equal(false);

    const stdInfo = await tokenFactory.infoOf(std);
    expect(stdInfo.token).to.equal(std);
    expect(stdInfo.creator).to.equal(alice.address);
    expect(stdInfo.tokenType).to.equal(0);
    expect(stdInfo.rewardToken).to.equal(ethers.ZeroAddress);
    expect(stdInfo.name).to.equal("Alpha");
    expect(stdInfo.symbol).to.equal("ALPHA");

    const rewInfo = await tokenFactory.infoOf(rew);
    expect(rewInfo.tokenType).to.equal(2);
    expect(rewInfo.rewardToken).to.equal(weth.target);

    expect(await tokenFactory.tokensOfCreator(alice.address)).to.deep.equal([std, rew]);
    expect(await tokenFactory.tokensOfCreator(bob.address)).to.deep.equal([tax]);

    const page = await tokenFactory.getTokens(0, 2);
    expect(page.length).to.equal(2);
    expect(page[0].symbol).to.equal("ALPHA");
    expect(page[1].symbol).to.equal("TAXD");
    expect((await tokenFactory.getTokens(2, 10)).length).to.equal(1);
    expect((await tokenFactory.getTokens(3, 1)).length).to.equal(0);
  });

  it("auto-creates the token/WETH pair and registers it as AMM pair", async function () {
    const { tokenFactory, dexFactory, weth, alice } = await loadFixture(deployPlatform);
    await tokenFactory.connect(alice).createStandardToken("Alpha", "ALPHA", E("1000"));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    const pair = await token.mainPair();
    expect(pair).to.not.equal(ethers.ZeroAddress);
    expect(await dexFactory.getPair(token.target, weth.target)).to.equal(pair);
    expect(await token.isAmmPair(pair)).to.equal(true);
  });

  it("snapshots platformTaxBps into the token at creation time", async function () {
    const { tokenFactory, alice } = await loadFixture(deployPlatform);
    await tokenFactory.connect(alice).createStandardToken("A", "A", E("1000"));
    const tokenA = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    expect(await tokenA.platformTaxBps()).to.equal(25); // default 0.25%

    await tokenFactory.setPlatformTaxBps(50);
    await tokenFactory.connect(alice).createStandardToken("B", "B", E("1000"));
    const tokenB = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(1));
    expect(await tokenB.platformTaxBps()).to.equal(50);
    // earlier token keeps its snapshot
    expect(await tokenA.platformTaxBps()).to.equal(25);
  });

  it("setPlatformTaxBps enforces the 0.5% cap", async function () {
    const { tokenFactory } = await loadFixture(deployPlatform);
    await expect(tokenFactory.setPlatformTaxBps(51)).to.be.revertedWith("tax too high");
    await expect(tokenFactory.setPlatformTaxBps(50)).to.emit(tokenFactory, "PlatformTaxUpdated").withArgs(50);
    expect(await tokenFactory.platformTaxBps()).to.equal(50);
  });

  it("setters are owner-only", async function () {
    const { tokenFactory, alice, treasury, router } = await loadFixture(deployPlatform);
    const f = tokenFactory.connect(alice);
    await expect(f.setPlatformTaxBps(50)).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
    await expect(f.setTreasury(treasury.target)).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
    await expect(f.setRouter(router.target)).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
    await expect(f.setPresaleFactory(alice.address)).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
    await expect(
      f.setDeployers(alice.address, alice.address, alice.address)
    ).to.be.revertedWithCustomError(tokenFactory, "OwnableUnauthorizedAccount");
  });
});

describe("StandardToken", function () {
  it("wallet-to-wallet transfers carry zero tax", async function () {
    const { token, bob, carol } = await loadFixture(standardFixture);
    const before = await token.balanceOf(carol.address);
    await token.connect(bob).transfer(carol.address, E("10000")); // bob is NOT fee-excluded
    expect(await token.balanceOf(carol.address)).to.equal(before + E("10000"));
    expect(await token.balanceOf(token.target)).to.equal(0);
    expect(await token.pendingPlatformTokens()).to.equal(0);
  });

  it("AMM buy takes exactly 0.25% platform tax, accrued in the token contract", async function () {
    const { token, router, weth, bob } = await loadFixture(standardFixture);
    const raw = (await router.getAmountsOut(E("1"), [weth.target, token.target]))[1];
    const fee = (raw * 25n) / BPS;

    const before = await token.balanceOf(bob.address);
    await buy(router, weth, token, bob, E("1"));
    expect(await token.balanceOf(bob.address)).to.equal(before + raw - fee);
    expect(await token.balanceOf(token.target)).to.equal(fee);
    expect(await token.pendingPlatformTokens()).to.equal(fee);
  });

  it("AMM sell takes exactly 0.25% platform tax and pendingPlatformTokens grows", async function () {
    const { token, router, weth, bob } = await loadFixture(standardFixture);
    const pair = await token.mainPair();
    const amount = E("10000");
    const fee = (amount * 25n) / BPS;

    const pairBefore = await token.balanceOf(pair);
    await sell(router, weth, token, bob, amount);
    expect(await token.balanceOf(pair)).to.equal(pairBefore + amount - fee);
    expect(await token.pendingPlatformTokens()).to.equal(fee);
    expect(await token.balanceOf(token.target)).to.equal(fee);
  });

  it("sell past swapThreshold triggers swap-back: Treasury receives ETH, accrual resets", async function () {
    const { token, router, weth, treasury, alice, bob } = await loadFixture(standardFixture);
    expect(await token.swapThreshold()).to.equal(E("1000")); // 1M supply / 1000
    await token.connect(alice).transfer(bob.address, E("101000")); // bob 401k: 400k sells accrue 1000, 1k left to trigger

    await sell(router, weth, token, bob, E("200000")); // +500 pending
    await sell(router, weth, token, bob, E("200000")); // +500 pending => 1000 = threshold
    expect(await token.pendingPlatformTokens()).to.equal(E("1000"));

    const treBefore = await ethers.provider.getBalance(treasury.target);
    await token.connect(bob).approve(router.target, E("1000"));
    const tx = router
      .connect(bob)
      .swapExactTokensForETHSupportingFeeOnTransferTokens(
        E("1000"),
        0,
        [token.target, weth.target],
        bob.address,
        await deadline()
      );
    await expect(tx).to.emit(token, "SwapBack");
    await expect(tx).to.emit(treasury, "RevenueReceived");

    const receipt = await (await tx).wait();
    const evt = findEvent(receipt, token.interface, "SwapBack");
    expect(evt.args.tokensSwapped).to.equal(E("1000"));
    const ethGained = evt.args.ethReceived;
    expect(ethGained).to.be.gt(0);

    expect(await ethers.provider.getBalance(treasury.target)).to.equal(treBefore + ethGained);
    expect(await treasury.buybackReserve()).to.equal((ethGained * 3000n) / BPS); // 30% earmarked
    // only the fee of the triggering sell remains accrued
    expect(await token.pendingPlatformTokens()).to.equal(E("2.5"));
    expect(await token.balanceOf(token.target)).to.equal(E("2.5"));
  });

  it("fee-excluded creator buys and sells tax-free", async function () {
    const { token, router, weth, alice } = await loadFixture(standardFixture);
    expect(await token.isExcludedFromFees(alice.address)).to.equal(true);

    const raw = (await router.getAmountsOut(E("1"), [weth.target, token.target]))[1];
    const before = await token.balanceOf(alice.address);
    await buy(router, weth, token, alice, E("1"));
    expect(await token.balanceOf(alice.address)).to.equal(before + raw); // full amount, no tax
    expect(await token.pendingPlatformTokens()).to.equal(0);

    const pair = await token.mainPair();
    const pairBefore = await token.balanceOf(pair);
    await sell(router, weth, token, alice, E("10000"));
    expect(await token.balanceOf(pair)).to.equal(pairBefore + E("10000")); // full amount reaches pair
    expect(await token.pendingPlatformTokens()).to.equal(0);
  });
});

describe("TaxToken", function () {
  it("takes creator taxes on top of the platform tax on buys and sells", async function () {
    const { token, router, weth, bob } = await loadFixture(taxFixture);

    // buy: 0.25% platform + 4% creator
    const raw = (await router.getAmountsOut(E("1"), [weth.target, token.target]))[1];
    const platformFee = (raw * 25n) / BPS;
    const creatorFee = (raw * 400n) / BPS;
    const before = await token.balanceOf(bob.address);
    await buy(router, weth, token, bob, E("1"));
    expect(await token.balanceOf(bob.address)).to.equal(before + raw - platformFee - creatorFee);
    expect(await token.pendingPlatformTokens()).to.equal(platformFee);
    expect(await token.pendingMarketingTokens()).to.equal(creatorFee);

    // sell: 0.25% platform + 5% creator
    const pair = await token.mainPair();
    const amount = E("10000");
    const pairBefore = await token.balanceOf(pair);
    await sell(router, weth, token, bob, amount);
    expect(await token.balanceOf(pair)).to.equal(pairBefore + amount - (amount * 525n) / BPS);
    expect(await token.pendingPlatformTokens()).to.equal(platformFee + (amount * 25n) / BPS);
    expect(await token.pendingMarketingTokens()).to.equal(creatorFee + (amount * 500n) / BPS);
  });

  it("enforces the 10% total tax cap at construction (incl. platform share)", async function () {
    const { tokenFactory, alice, dave } = await loadFixture(deployPlatform);
    const TaxToken = await ethers.getContractFactory("TaxToken");
    // 976 + 25 platform > 1000
    await expect(
      tokenFactory.connect(alice).createTaxToken("T", "T", E("1000"), dave.address, 976, 0)
    ).to.be.revertedWithCustomError(TaxToken, "TaxTooHigh");
    await expect(
      tokenFactory.connect(alice).createTaxToken("T", "T", E("1000"), dave.address, 0, 976)
    ).to.be.revertedWithCustomError(TaxToken, "TaxTooHigh");
    // boundary: 975 + 25 = exactly 10% is allowed
    await tokenFactory.connect(alice).createTaxToken("T", "T", E("1000"), dave.address, 975, 975);
    const token = await ethers.getContractAt("TaxToken", await tokenFactory.allTokens(0));
    expect(await token.buyTaxBps()).to.equal(975);
  });

  it("setTaxes enforces the cap and is owner-only", async function () {
    const { token, alice, bob } = await loadFixture(taxFixture);
    await expect(token.connect(alice).setTaxes(976, 0)).to.be.revertedWithCustomError(token, "TaxTooHigh");
    await expect(token.connect(alice).setTaxes(0, 976)).to.be.revertedWithCustomError(token, "TaxTooHigh");
    await expect(token.connect(alice).setTaxes(975, 975)).to.emit(token, "TaxesUpdated").withArgs(975, 975);
    expect(await token.buyTaxBps()).to.equal(975);
    expect(await token.sellTaxBps()).to.equal(975);
    await expect(token.connect(bob).setTaxes(100, 100)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );
  });

  it("swap-back splits ETH pro-rata between Treasury and marketing wallet", async function () {
    const { token, router, weth, treasury, bob, dave } = await loadFixture(taxFixture);

    // two sells of 10k: platform 25+25, marketing 500+500 => total pending 1050 >= threshold 1000
    await sell(router, weth, token, bob, E("10000"));
    await sell(router, weth, token, bob, E("10000"));
    const pendingP = await token.pendingPlatformTokens();
    const pendingM = await token.pendingMarketingTokens();
    expect(pendingP).to.equal(E("50"));
    expect(pendingM).to.equal(E("1000"));

    const treBefore = await ethers.provider.getBalance(treasury.target);
    const mktBefore = await ethers.provider.getBalance(dave.address);

    const receipt = await (await sell(router, weth, token, bob, E("1000"))).wait();
    const evt = findEvent(receipt, token.interface, "SwapBack");
    expect(evt).to.not.equal(null);
    expect(evt.args.tokensSwapped).to.equal(pendingP + pendingM);
    const ethGained = evt.args.ethReceived;

    const marketingEth = (ethGained * pendingM) / (pendingP + pendingM);
    const platformEth = ethGained - marketingEth;
    expect(await ethers.provider.getBalance(dave.address)).to.equal(mktBefore + marketingEth);
    expect(await ethers.provider.getBalance(treasury.target)).to.equal(treBefore + platformEth);

    // pendings reset; only the triggering sell's fees remain
    expect(await token.pendingPlatformTokens()).to.equal(E("2.5"));
    expect(await token.pendingMarketingTokens()).to.equal(E("50"));
  });

  it("setMarketingWallet validates and is owner-only", async function () {
    const { token, alice, bob, carol } = await loadFixture(taxFixture);
    await expect(token.connect(bob).setMarketingWallet(carol.address)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );
    await expect(token.connect(alice).setMarketingWallet(ethers.ZeroAddress)).to.be.revertedWith("zero marketing");
    await expect(token.connect(alice).setMarketingWallet(carol.address))
      .to.emit(token, "MarketingWalletUpdated")
      .withArgs(carol.address);
    expect(await token.marketingWallet()).to.equal(carol.address);
  });
});

describe("RewardsToken", function () {
  it("rewards tax accrues to pendingRewardsTokens separately from platform/marketing", async function () {
    const { token, router, weth, bob } = await loadFixture(rewardsFixture);

    const raw = (await router.getAmountsOut(E("1"), [weth.target, token.target]))[1];
    await buy(router, weth, token, bob, E("1"));
    expect(await token.pendingRewardsTokens()).to.equal((raw * 300n) / BPS);
    expect(await token.pendingMarketingTokens()).to.equal((raw * 100n) / BPS);
    expect(await token.pendingPlatformTokens()).to.equal((raw * 25n) / BPS);

    const pendingRewBefore = await token.pendingRewardsTokens();
    await sell(router, weth, token, bob, E("10000"));
    expect(await token.pendingRewardsTokens()).to.equal(pendingRewBefore + E("300"));
  });

  it("distributeRewards is owner/platform-only and requires pending rewards", async function () {
    const { token, alice, bob } = await loadFixture(rewardsFixture);
    await expect(token.connect(bob).distributeRewards(0)).to.be.revertedWithCustomError(token, "NotAuthorized");
    await expect(token.connect(alice).distributeRewards(0)).to.be.revertedWith("nothing to distribute");
  });

  it("distributeRewards converts accrual to WETH and grows magnifiedRewardPerShare; holders get exact pro-rata", async function () {
    const { token, router, weth, alice, bob, carol } = await loadFixture(rewardsFixture);

    await sell(router, weth, token, bob, E("20000")); // rewards fee = 600
    expect(await token.pendingRewardsTokens()).to.equal(E("600"));

    const wethBefore = await weth.balanceOf(token.target);
    const receipt = await (await token.connect(alice).distributeRewards(0)).wait();
    const evt = findEvent(receipt, token.interface, "RewardsDistributed");
    expect(evt.args.tokensSwapped).to.equal(E("600"));
    const received = evt.args.rewardsReceived;
    expect(received).to.be.gt(0);

    expect(await weth.balanceOf(token.target)).to.equal(wethBefore + received);
    expect(await token.pendingRewardsTokens()).to.equal(0);
    expect(await token.totalRewardsDistributed()).to.equal(received);

    const perShare = await token.magnifiedRewardPerShare();
    const totalShares = await token.totalShares();
    expect(perShare).to.equal((received * MAGNITUDE) / totalShares);

    // exact pro-rata (first distribution, corrections are zero)
    for (const holder of [alice, bob, carol]) {
      const shares = await token.sharesOf(holder.address);
      expect(await token.withdrawableRewardOf(holder.address)).to.equal((perShare * shares) / MAGNITUDE);
    }
    const sum =
      (await token.withdrawableRewardOf(alice.address)) +
      (await token.withdrawableRewardOf(bob.address)) +
      (await token.withdrawableRewardOf(carol.address));
    expect(sum).to.be.lte(received);
    expect(received - sum).to.be.lt(10n); // dust only
  });

  it("distributeRewards respects amountOutMin (sandwich guard)", async function () {
    const { token, router, weth, alice, bob } = await loadFixture(rewardsFixture);
    await sell(router, weth, token, bob, E("20000"));
    await expect(token.connect(alice).distributeRewards(E("1000000"))).to.be.revertedWith(
      "router: insufficient output"
    );
  });

  it("claimRewards pays the reward token and cannot double-claim", async function () {
    const { token, router, weth, alice, bob } = await loadFixture(rewardsFixture);
    await sell(router, weth, token, bob, E("20000"));
    await token.connect(alice).distributeRewards(0);

    const claimable = await token.withdrawableRewardOf(bob.address);
    expect(claimable).to.be.gt(0);
    const wethBefore = await weth.balanceOf(bob.address);
    await expect(token.connect(bob).claimRewards())
      .to.emit(token, "RewardsClaimed")
      .withArgs(bob.address, claimable);
    expect(await weth.balanceOf(bob.address)).to.equal(wethBefore + claimable);
    expect(await token.withdrawableRewardOf(bob.address)).to.equal(0);
    await expect(token.connect(bob).claimRewards()).to.be.revertedWith("nothing to claim");
  });

  it("pair, contract, dead and treasury are excluded from shares", async function () {
    const { token, treasury, alice, bob, carol } = await loadFixture(rewardsFixture);
    const pair = await token.mainPair();
    const DEAD = "0x000000000000000000000000000000000000dEaD";

    expect(await token.balanceOf(pair)).to.be.gt(0);
    for (const a of [pair, token.target, DEAD, treasury.target]) {
      expect(await token.isExcludedFromRewards(a)).to.equal(true);
      expect(await token.sharesOf(a)).to.equal(0);
    }
    // totalShares == sum of the (non-excluded) holders' balances
    const expected =
      (await token.balanceOf(alice.address)) +
      (await token.balanceOf(bob.address)) +
      (await token.balanceOf(carol.address));
    expect(await token.totalShares()).to.equal(expected);
  });

  it("shares stay in sync with balances on transfers", async function () {
    const { token, bob, carol } = await loadFixture(rewardsFixture);
    const totalBefore = await token.totalShares();
    await token.connect(bob).transfer(carol.address, E("50000"));
    expect(await token.sharesOf(bob.address)).to.equal(await token.balanceOf(bob.address));
    expect(await token.sharesOf(carol.address)).to.equal(await token.balanceOf(carol.address));
    expect(await token.sharesOf(bob.address)).to.equal(E("150000"));
    expect(await token.sharesOf(carol.address)).to.equal(E("150000"));
    expect(await token.totalShares()).to.equal(totalBefore);
  });

  it("setExcludedFromRewards adjusts shares and protects pair/contract", async function () {
    const { token, alice, bob } = await loadFixture(rewardsFixture);
    const bal = await token.balanceOf(bob.address);
    const totalBefore = await token.totalShares();

    // Callers other than the owner or the platform are rejected (the platform may call
    // this function so it can exclude presales from the reward share).
    await expect(token.connect(bob).setExcludedFromRewards(bob.address, true)).to.be.revertedWithCustomError(
      token,
      "NotAuthorized"
    );
    await expect(token.connect(alice).setExcludedFromRewards(await token.mainPair(), false)).to.be.revertedWith(
      "always excluded"
    );

    await token.connect(alice).setExcludedFromRewards(bob.address, true);
    expect(await token.sharesOf(bob.address)).to.equal(0);
    expect(await token.totalShares()).to.equal(totalBefore - bal);

    await token.connect(alice).setExcludedFromRewards(bob.address, false);
    expect(await token.sharesOf(bob.address)).to.equal(bal);
    expect(await token.totalShares()).to.equal(totalBefore);
  });

  it("distributeRewards reverts when total shares are below the MIN guard", async function () {
    const { token, router, weth, alice, bob, carol } = await loadFixture(rewardsFixture);
    await sell(router, weth, token, bob, E("20000")); // accrue rewards
    await token.connect(alice).setExcludedFromRewards(alice.address, true);
    await token.connect(alice).setExcludedFromRewards(bob.address, true);
    await token.connect(alice).setExcludedFromRewards(carol.address, true);
    expect(await token.totalShares()).to.equal(0);
    await expect(token.connect(alice).distributeRewards(0)).to.be.revertedWith("shares too low");
  });

  it("stock-rewards: distributes a non-WETH reward token via the 3-hop path and pays claims", async function () {
    const { token, stock, router, weth, alice, bob } = await loadFixture(stockRewardsFixture);
    expect(await token.rewardToken()).to.equal(stock.target);

    await sell(router, weth, token, bob, E("20000")); // rewards fee = 600
    expect(await token.pendingRewardsTokens()).to.equal(E("600"));

    const receipt = await (await token.connect(alice).distributeRewards(0)).wait();
    const evt = findEvent(receipt, token.interface, "RewardsDistributed");
    const received = evt.args.rewardsReceived;
    expect(received).to.be.gt(0);
    expect(await stock.balanceOf(token.target)).to.equal(received);

    const claimable = await token.withdrawableRewardOf(bob.address);
    expect(claimable).to.be.gt(0);
    const stockBefore = await stock.balanceOf(bob.address);
    await token.connect(bob).claimRewards();
    // wallet transfer of the stock token is tax-free: full claim arrives
    expect(await stock.balanceOf(bob.address)).to.equal(stockBefore + claimable);
  });
});

// The reward swap's V3 leg: token -> ETH on the token's own V2 pool, wrapped, then the packed
// path on SwapRouter02 (tokenized stocks trade on Uniswap V3 on Robinhood Chain)
describe("RewardsToken V3 route", function () {
  it("carries the chain's V3 router and quoter and keeps the V2 hops beside the V3 path", async function () {
    const { token, stock, weth, v3Router, v3Quoter, rewardsDeployer, path } = await loadFixture(v3StockRewardsFixture);
    expect(await token.v3Router()).to.equal(v3Router.target);
    expect(await token.v3Quoter()).to.equal(v3Quoter.target);
    expect(await token.rewardRouteV3()).to.equal(path);
    expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, stock.target]);
    expect([...(await token.rewardRoute())]).to.deep.equal([weth.target]);
    // Nothing is stored on QuickLaunch for the stock: the path came from the owner, not the deployer
    expect(await rewardsDeployer.platformRouteV3For(stock.target)).to.equal("0x");
    expect(await token.MAX_ROUTE_HOPS()).to.equal(3);
  });

  it("setRewardRouteV3 is owner-only and validates the path against the V3 factory", async function () {
    const { token, stock, weth, v3Factory, alice, bob, path } = await loadFixture(v3StockRewardsFixture);
    await expect(token.connect(bob).setRewardRouteV3(path)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    await expect(token.connect(bob).setRewardRouteV3("0x")).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    const owner = token.connect(alice);
    await expect(owner.setRewardRouteV3("0x01")).to.be.revertedWith("bad V3 path");
    await expect(owner.setRewardRouteV3(path + "00")).to.be.revertedWith("bad V3 path");
    const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 1_000_000n * 10n ** 6n]);
    const fivePools = packPath(
      weth.target, 3000, usdg.target, 3000, weth.target, 3000, usdg.target, 3000, weth.target, 3000, stock.target
    );
    await expect(owner.setRewardRouteV3(fivePools)).to.be.revertedWith("route too long");
    await expect(owner.setRewardRouteV3(packPath(stock.target, 3000, weth.target))).to.be.revertedWith("route must start at WETH");
    await expect(owner.setRewardRouteV3(packPath(weth.target, 3000, usdg.target))).to.be.revertedWith("route must end at reward");
    await expect(owner.setRewardRouteV3(packPath(weth.target, 3000, weth.target, 3000, stock.target))).to.be.revertedWith("bad hop");
    // The token itself is never a hop
    await expect(owner.setRewardRouteV3(packPath(weth.target, 3000, token.target, 3000, stock.target))).to.be.revertedWith("bad hop");
    await expect(owner.setRewardRouteV3(packPath(weth.target, 500, stock.target))).to.be.revertedWith("no V3 pool");
    await expect(owner.setRewardRouteV3(packPath(weth.target, 3000, usdg.target, 3000, stock.target))).to.be.revertedWith("no V3 pool");
    expect(await token.rewardRouteV3()).to.equal(path);
    // A pool that exists (even empty) passes; the owner can clear the path
    await v3Factory.createPool(weth.target, stock.target, 500);
    const path500 = packPath(weth.target, 500, stock.target);
    await expect(owner.setRewardRouteV3(path500)).to.emit(token, "RewardRouteV3Updated").withArgs(path500);
    expect(await token.rewardRouteV3()).to.equal(path500);
    await expect(owner.setRewardRouteV3("0x")).to.emit(token, "RewardRouteV3Updated").withArgs("0x");
    expect(await token.rewardRouteV3()).to.equal("0x");
    expect([...(await token.rewardPath())]).to.deep.equal([token.target, weth.target, stock.target]);
  });

  it("setRewardRoute clears the V3 path", async function () {
    const { token, weth, alice, path } = await loadFixture(v3StockRewardsFixture);
    const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 1_000_000n * 10n ** 6n]);
    const tx = token.connect(alice).setRewardRoute([weth.target, usdg.target]);
    await expect(tx).to.emit(token, "RewardRouteV3Updated").withArgs("0x");
    await expect(tx).to.emit(token, "RewardRouteUpdated").withArgs([weth.target, usdg.target]);
    expect(await token.rewardRouteV3()).to.equal("0x");
    expect([...(await token.rewardRoute())]).to.deep.equal([weth.target, usdg.target]);
    // Without a V3 path, setRewardRoute emits no V3 event
    await expect(token.connect(alice).setRewardRoute([weth.target])).to.not.emit(token, "RewardRouteV3Updated");
    // The V3 path can come back
    await token.connect(alice).setRewardRouteV3(path);
    expect(await token.rewardRouteV3()).to.equal(path);
    expect([...(await token.rewardRoute())]).to.deep.equal([weth.target]);
  });

  it("distributes through the V3 path at the quoted floor and refuses above it", async function () {
    const { token, stock, weth, router, v3Quoter, alice, bob, path } = await loadFixture(v3StockRewardsFixture);
    await sell(router, weth, token, bob, E("20000")); // rewards fee = 600
    expect(await token.pendingRewardsTokens()).to.equal(E("600"));
    // Leg 1 on V2: 600 tokens -> ETH; leg 2 on V3: that WETH -> stock, quoted by QuoterV2
    const [, ethOut] = await router.getAmountsOut(E("600"), [token.target, weth.target]);
    const [quote] = await v3Quoter.quoteExactInput.staticCall(path, ethOut);
    expect(quote).to.be.gt(0);
    await expect(token.connect(alice).distributeRewards(quote + 1n)).to.be.revertedWith("Too little received");
    await expect(token.connect(alice).distributeRewards(ethers.MaxUint256)).to.be.revertedWith("Too little received");
    expect(await token.pendingRewardsTokens()).to.equal(E("600"));

    const receipt = await (await token.connect(alice).distributeRewards(quote)).wait();
    const evt = findEvent(receipt, token.interface, "RewardsDistributed");
    expect(evt.args.tokensSwapped).to.equal(E("600"));
    expect(evt.args.rewardsReceived).to.equal(quote);
    expect(await stock.balanceOf(token.target)).to.equal(quote);
    expect(await weth.balanceOf(token.target)).to.equal(0);
    expect(await ethers.provider.getBalance(token.target)).to.equal(0);
    expect(await token.pendingRewardsTokens()).to.equal(0);
    expect(await token.magnifiedRewardPerShare()).to.equal((quote * MAGNITUDE) / (await token.totalShares()));

    const claimable = await token.withdrawableRewardOf(bob.address);
    expect(claimable).to.be.gt(0);
    await token.connect(bob).claimRewards();
    expect(await stock.balanceOf(bob.address)).to.equal(claimable);
  });

  it("refuses a partial fill of the V3 leg and sends WETH left on the token along with the next distribution", async function () {
    const { token, stock, pool, weth, router, v3Quoter, alice, bob, path } = await loadFixture(v3StockRewardsFixture);
    await sell(router, weth, token, bob, E("20000")); // rewards fee = 600
    const [, ethOut] = await router.getAmountsOut(E("600"), [token.target, weth.target]);
    const [quote] = await v3Quoter.quoteExactInput.staticCall(path, ethOut);
    // The route's liquidity ends below the leg's output: the router fills what it can and the
    // token, left holding WETH, reverts (the pending amount survives the revert)
    await pool.setMaxOut(quote / 2n);
    await expect(token.connect(alice).distributeRewards(0)).to.be.revertedWith("partial fill");
    expect(await token.pendingRewardsTokens()).to.equal(E("600"));
    expect(await weth.balanceOf(token.target)).to.equal(0);
    await pool.setMaxOut(0);
    // WETH that reached the token some other way goes into the leg with the swapped rewards
    const stray = E("0.05");
    await weth.connect(bob).deposit({ value: stray });
    await weth.connect(bob).transfer(token.target, stray);
    const [withStray] = await v3Quoter.quoteExactInput.staticCall(path, ethOut + stray);
    expect(withStray).to.be.gt(quote);
    await expect(token.connect(alice).distributeRewards(withStray + 1n)).to.be.revertedWith("Too little received");
    const receipt = await (await token.connect(alice).distributeRewards(withStray)).wait();
    const evt = findEvent(receipt, token.interface, "RewardsDistributed");
    expect(evt.args.tokensSwapped).to.equal(E("600"));
    expect(evt.args.rewardsReceived).to.equal(withStray);
    expect(await stock.balanceOf(token.target)).to.equal(withStray);
    expect(await weth.balanceOf(token.target)).to.equal(0);
    expect(await ethers.provider.getBalance(token.target)).to.equal(0);
  });

  it("a WETH reward token refuses a V3 path", async function () {
    const { token, weth, alice, v3Factory } = await loadFixture(rewardsFixture);
    expect(await token.rewardRouteV3()).to.equal("0x");
    const stock = await ethers.deployContract("MockERC20", ["tApple", "tAAPL", 18, E("1000000")]);
    await v3Factory.createPool(weth.target, stock.target, 3000);
    await expect(token.connect(alice).setRewardRouteV3(packPath(weth.target, 3000, stock.target))).to.be.revertedWith("no V3 route for WETH");
    await expect(token.connect(alice).setRewardRouteV3("0x01")).to.be.revertedWith("no V3 route for WETH");
    // Clearing an empty path is harmless
    await expect(token.connect(alice).setRewardRouteV3("0x")).to.emit(token, "RewardRouteV3Updated").withArgs("0x");
    expect(await token.rewardRouteV3()).to.equal("0x");
  });
});

describe("HoodSaleToken (HOODSALE)", function () {
  it("wallet-to-wallet transfers are tax-free", async function () {
    const { hoodsale, alice, bob } = await loadFixture(hoodFixture);
    await hoodsale.connect(alice).transfer(bob.address, E("1000000")); // neither excluded
    expect(await hoodsale.balanceOf(bob.address)).to.equal(E("1000000"));
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(0);
  });

  it("AMM buys and sells take exactly 3%", async function () {
    const { hoodsale, router, weth, bob, alice } = await loadFixture(hoodFixture);

    const raw = (await router.getAmountsOut(E("1"), [weth.target, hoodsale.target]))[1];
    const buyFee = (raw * 300n) / BPS;
    await buy(router, weth, hoodsale, bob, E("1"));
    expect(await hoodsale.balanceOf(bob.address)).to.equal(raw - buyFee);
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(buyFee);

    const pair = await hoodsale.mainPair();
    const amount = E("100000");
    const sellFee = (amount * 300n) / BPS;
    const pairBefore = await hoodsale.balanceOf(pair);
    await sell(router, weth, hoodsale, alice, amount);
    expect(await hoodsale.balanceOf(pair)).to.equal(pairBefore + amount - sellFee);
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(buyFee + sellFee);
  });

  it("swap-back splits ETH between marketing wallet and treasury.depositBuyback (full buyback earmark)", async function () {
    const { hoodsale, router, weth, treasury, marketing, alice } = await loadFixture(hoodFixture);
    expect(await hoodsale.swapThreshold()).to.equal(E("100000")); // 100M / 1000

    await sell(router, weth, hoodsale, alice, E("2000000")); // fee 60k
    await sell(router, weth, hoodsale, alice, E("2000000")); // fee 60k => 120k >= threshold
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(E("120000"));

    const treBefore = await ethers.provider.getBalance(treasury.target);
    const mktBefore = await ethers.provider.getBalance(marketing.address);
    const reserveBefore = await treasury.buybackReserve();

    const receipt = await (await sell(router, weth, hoodsale, alice, E("10000"))).wait();
    const evt = findEvent(receipt, hoodsale.interface, "SwapBack");
    expect(evt).to.not.equal(null);
    expect(evt.args.tokensSwapped).to.equal(E("120000"));
    const { ethReceived, marketingEth, buybackEth } = evt.args;
    expect(marketingEth + buybackEth).to.equal(ethReceived);
    expect(marketingEth).to.equal((ethReceived * 5000n) / BPS); // default 50/50

    expect(await ethers.provider.getBalance(marketing.address)).to.equal(mktBefore + marketingEth);
    expect(await ethers.provider.getBalance(treasury.target)).to.equal(treBefore + buybackEth);
    // depositBuyback earmarks 100% (not just 30%)
    expect(await treasury.buybackReserve()).to.equal(reserveBefore + buybackEth);

    // only the triggering sell's fee remains
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(E("300"));
  });

  it("manualSwapBack flushes accrued tax below the threshold (owner-only)", async function () {
    const { hoodsale, router, weth, treasury, marketing, deployer, alice } = await loadFixture(hoodFixture);
    await sell(router, weth, hoodsale, alice, E("100000")); // fee 3k < threshold
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(E("3000"));

    await expect(hoodsale.connect(alice).manualSwapBack()).to.be.revertedWithCustomError(
      hoodsale,
      "OwnableUnauthorizedAccount"
    );

    const treBefore = await ethers.provider.getBalance(treasury.target);
    const mktBefore = await ethers.provider.getBalance(marketing.address);
    await expect(hoodsale.connect(deployer).manualSwapBack()).to.emit(hoodsale, "SwapBack");
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(0);
    expect(await ethers.provider.getBalance(treasury.target)).to.be.gt(treBefore);
    expect(await ethers.provider.getBalance(marketing.address)).to.be.gt(mktBefore);
  });

  it("setMarketingShareBps caps at 100% and is owner-only", async function () {
    const { hoodsale, deployer, alice } = await loadFixture(hoodFixture);
    await expect(hoodsale.connect(deployer).setMarketingShareBps(10001)).to.be.revertedWith("bps too high");
    await expect(hoodsale.connect(alice).setMarketingShareBps(1000)).to.be.revertedWithCustomError(
      hoodsale,
      "OwnableUnauthorizedAccount"
    );
    await expect(hoodsale.connect(deployer).setMarketingShareBps(8000))
      .to.emit(hoodsale, "MarketingShareUpdated")
      .withArgs(8000);
    expect(await hoodsale.marketingShareBps()).to.equal(8000);
  });
});
