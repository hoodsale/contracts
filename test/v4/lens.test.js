const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4, taxConfig, keyArray, mintCalldata, PERMIT2, DEAD } = require("./helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const Lock = 0, Burn = 1;
const Tax = 1;

// The site reads the platform lens and does not care which kind of pool a launch uses. These
// tests pin that down: a v4 launch reports the same price, liquidity and multiple as a V2 one.
describe("V4 lens", function () {
  async function launchedBurning() {
    return launched(Burn);
  }

  async function launched(liquidityAction = Lock) {
    const ctx = await deployPlatformV4();
    const { launcher, presaleFactory, alice, bob, carol, marketing } = ctx;
    const now = BigInt(await time.latest());
    const start = now + 1000n;

    await launcher.connect(alice).createToken(
      Tax,
      { name: "Lens", symbol: "LENS", totalSupply: E("1000000"), rewardToken: ethers.ZeroAddress },
      taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 }),
      alice.address
    );
    const created = await launcher.tokensOfCreator(alice.address);
    const tokenAddr = created[created.length - 1];
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);

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
      liquidityAction,
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
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    await presale.connect(alice).finalize(0, 0);
    return { ...ctx, token, tokenAddr, presale };
  }

  it("reports a v4 launch through the same view a V2 launch uses", async function () {
    const { lens, presale, tokenAddr } = await loadFixture(launched);
    const v = await lens.launchView(presale.target);

    expect(v.poolKind).to.equal(1);
    expect(v.token).to.equal(tokenAddr);
    // Listed at 800 tokens per ETH, so the price starts at the listing price and the multiple at 1.
    expect(v.listingPriceWei).to.equal((10n ** 18n * 10n ** 18n) / E("800"));
    expect(v.priceAvailable).to.equal(true);
    expect(v.currentPriceWei).to.be.closeTo(v.listingPriceWei, v.listingPriceWei / 1000n);
    expect(v.multiplierX18).to.be.closeTo(E("1"), E("0.01"));
    // 10 ETH raised, 10% platform fee, 60% of the rest into liquidity.
    expect(v.liquidityWeth).to.be.closeTo(E("5.4"), E("0.02"));
    // The creator's tax lives on the hook now, and the lens reads it from there.
    expect(v.buyTaxBps).to.equal(300);
    expect(v.sellTaxBps).to.equal(500);
  });

  it("shows the price moving after a buy", async function () {
    const { lens, launcher, swapper, presale, tokenAddr, dave } = await loadFixture(launched);
    const before = await lens.launchView(presale.target);
    const key = keyArray(await launcher.poolKeyOf(tokenAddr));
    const spend = E("1");
    await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });

    const after = await lens.launchView(presale.target);
    expect(after.currentPriceWei).to.be.greaterThan(before.currentPriceWei);
    expect(after.multiplierX18).to.be.greaterThan(E("1"));
    expect(after.liquidityWeth).to.be.greaterThan(before.liquidityWeth);
  });

  // The pool's active liquidity counts every position around the current price. Valued over the
  // full range, a small position in a narrow range reads as a pool many times deeper than it is,
  // which the review found could dress up a thin launch. The lens counts the launch position only.
  it("is not fooled by liquidity added in a narrow range around the price", async function () {
    const { v4Lens, lens, launcher, stateView, positionManager, swapper, token, tokenAddr, presale, alice } =
      await loadFixture(launched);
    const before = await v4Lens.launchStats(tokenAddr);
    const poolId = (await launcher.launchOf(tokenAddr)).poolId;
    const poolBefore = await stateView.getLiquidity(poolId);

    const key = await launcher.poolKeyOf(tokenAddr);
    const [sqrtPriceX96, tick] = await stateView.getSlot0(poolId);
    const spacing = BigInt(key.tickSpacing);
    const floor = (BigInt(tick) / spacing) * spacing;
    const [tickLower, tickUpper] = [floor - spacing, floor + 2n * spacing];
    const liquidity = await swapper.liquidityForAmounts(
      sqrtPriceX96,
      await swapper.sqrtPriceAtTick(tickLower),
      await swapper.sqrtPriceAtTick(tickUpper),
      E("0.05"),
      E("40")
    );
    await token.connect(alice).approve(PERMIT2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(
      PERMIT2,
      ["function approve(address token, address spender, uint160 amount, uint48 expiration)"],
      alice
    );
    await permit2.approve(tokenAddr, positionManager.target, E("40"), 2n ** 48n - 1n);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await positionManager.connect(alice).modifyLiquidities(
      mintCalldata({
        key,
        tickLower,
        tickUpper,
        liquidity,
        amount0Max: E("0.05"),
        amount1Max: E("40"),
        recipient: alice.address,
      }),
      deadline,
      { value: E("0.05") }
    );

    // Pennies in a narrow range multiply the pool's active liquidity...
    expect(await stateView.getLiquidity(poolId)).to.be.greaterThan(poolBefore * 5n);
    // ...but the launch still reads at what its own position holds.
    const after = await v4Lens.launchStats(tokenAddr);
    expect(after.reserveToken).to.equal(before.reserveToken);
    expect(after.reserveWeth).to.equal(before.reserveWeth);
    expect((await lens.launchView(presale.target)).liquidityWeth).to.be.closeTo(E("5.4"), E("0.02"));
    const v = await v4Lens.v4LaunchView(tokenAddr);
    expect(v.reserveWeth).to.equal(before.reserveWeth);
    expect(v.poolLiquidity).to.be.greaterThan(v.positionLiquidity * 5n);
  });

  // Once the lock is over the owner can withdraw the launch liquidity. The pool can still trade on
  // other liquidity, and like a V2 pair emptied down to its locked minimum it keeps its price
  // while its liquidity reads as nothing.
  it("keeps the pool's price after the launch liquidity is withdrawn", async function () {
    const { v4Lens, lens, launcher, stateView, positionManager, positionLocker, swapper, token, tokenAddr, presale, alice } =
      await loadFixture(launched);
    const before = await lens.launchView(presale.target);
    const launch = await launcher.launchOf(tokenAddr);
    const key = await launcher.poolKeyOf(tokenAddr);

    // Someone else keeps a small full-range position in the pool.
    const [sqrtPriceX96] = await stateView.getSlot0(launch.poolId);
    const [tickLower, tickUpper] = await swapper.usableTicks(key.tickSpacing);
    const other = await swapper.liquidityForAmounts(
      sqrtPriceX96,
      await swapper.sqrtPriceAtTick(tickLower),
      await swapper.sqrtPriceAtTick(tickUpper),
      E("0.5"),
      E("400")
    );
    await token.connect(alice).approve(PERMIT2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(
      PERMIT2,
      ["function approve(address token, address spender, uint160 amount, uint48 expiration)"],
      alice
    );
    await permit2.approve(tokenAddr, positionManager.target, E("400"), 2n ** 48n - 1n);
    let deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await positionManager.connect(alice).modifyLiquidities(
      mintCalldata({ key, tickLower, tickUpper, liquidity: other, amount0Max: E("0.5"), amount1Max: E("400"), recipient: alice.address }),
      deadline,
      { value: E("0.5") }
    );

    // The lock runs out and the owner takes the whole launch position out.
    await time.increase(31n * DAY);
    await positionLocker.connect(alice).unlock(launch.lockId);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const all = await positionManager.getPositionLiquidity(launch.tokenId);
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await positionManager.connect(alice).modifyLiquidities(
      coder.encode(
        ["bytes", "bytes[]"],
        [
          ethers.solidityPacked(["uint8", "uint8"], [0x01, 0x11]),
          [
            coder.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [launch.tokenId, all, 0, 0, "0x"]),
            coder.encode(["address", "address", "address"], [key.currency0, key.currency1, alice.address]),
          ],
        ]
      ),
      deadline
    );
    expect(await positionManager.getPositionLiquidity(launch.tokenId)).to.equal(0);

    const after = await lens.launchView(presale.target);
    expect(after.priceAvailable).to.equal(true);
    expect(after.currentPriceWei).to.be.closeTo(before.currentPriceWei, before.currentPriceWei / 100n);
    expect(after.liquidityWeth).to.be.lessThan(E("0.000001"));
    const v = await v4Lens.v4LaunchView(tokenAddr);
    expect(v.positionLiquidity).to.equal(0);
    expect(v.reserveWeth).to.equal(0);
    expect(v.priceAvailable).to.equal(true);
  });

  it("marks a V2 launch as a V2 pool", async function () {
    const ctx = await deployPlatformV4();
    const { tokenFactory, presaleFactory, lens, alice, bob, carol } = ctx;
    await tokenFactory.connect(alice).createStandardToken("Old", "OLD", E("1000000"));
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
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    await presale.connect(alice).finalize(0, 0);

    const v = await lens.launchView(presale.target);
    expect(v.poolKind).to.equal(0);
    expect(v.priceAvailable).to.equal(true);
    expect(await lens.poolKind(tokenAddr)).to.equal(0);
  });

  it("describes the pool, the position and the tax in one call", async function () {
    const { v4Lens, launcher, positionLocker, tokenAddr, alice } = await loadFixture(launched);
    const v = await v4Lens.v4LaunchView(tokenAddr);
    const launch = await launcher.launchOf(tokenAddr);

    expect(v.poolId).to.equal(launch.poolId);
    expect(v.lpFee).to.equal(500);
    expect(v.positionId).to.equal(launch.tokenId);
    expect(v.positionBurned).to.equal(false);
    expect(v.positionHolder).to.equal(alice.address);
    expect(v.positionLiquidity).to.be.greaterThan(0);
    expect(v.unlockTime).to.be.greaterThan(0);
    expect(v.platformTaxBps).to.equal(25);
    expect(v.marketingBuyBps).to.equal(300);
    expect(v.marketingSellBps).to.equal(500);
    expect(v.taxLocked).to.equal(false);
    positionLocker;
  });

  it("reports a burned position as burned", async function () {
    const { v4Lens, tokenAddr } = await loadFixture(launchedBurning);
    const v = await v4Lens.v4LaunchView(tokenAddr);
    expect(v.positionBurned).to.equal(true);
    expect(v.positionHolder).to.equal(DEAD);
  });

  it("answers with nothing for a token that has not launched", async function () {
    const ctx = await deployPlatformV4();
    const { v4Lens, launcher, alice, marketing } = ctx;
    await launcher.connect(alice).createToken(
      0,
      { name: "Soon", symbol: "SOON", totalSupply: E("1000"), rewardToken: ethers.ZeroAddress },
      taxConfig(marketing.address, { taxLocked: true, walletLocked: true }),
      alice.address
    );
    const created = await launcher.tokensOfCreator(alice.address);
    const stats = await v4Lens.launchStats(created[0]);
    expect(stats.priceAvailable).to.equal(false);
    expect(await v4Lens.isV4Token(created[0])).to.equal(false);
  });
});
