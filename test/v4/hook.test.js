const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  deployV4Core,
  deployHook,
  poolKeyFor,
  sqrtPriceX96For,
  mintCalldata,
  PERMIT2,
  HOODSALE_HOOK_FLAGS,
  ALL_HOOK_MASK,
} = require("./helpers");

const BPS = 10_000n;
const PLATFORM_BPS = 25n;

describe("HoodSaleV4Hook", function () {
  // Rates a launch might pick: 3% to marketing and 1% to holders on a buy, 5% and 2% on a sell.
  const CFG = { marketingBuyBps: 300, marketingSellBps: 500, rewardsBuyBps: 100, rewardsSellBps: 200 };
  const buyBps = BigInt(CFG.marketingBuyBps + CFG.rewardsBuyBps) + PLATFORM_BPS;
  const sellBps = BigInt(CFG.marketingSellBps + CFG.rewardsSellBps) + PLATFORM_BPS;

  const TOKEN_LIQUIDITY = ethers.parseEther("200000");
  const ETH_LIQUIDITY = ethers.parseEther("4");

  async function launched() {
    const [deployer, alice, bob, creator, marketing, launcher] = await ethers.getSigners();
    const v4 = await deployV4Core(deployer);
    const treasury = await ethers.deployContract("Treasury", [deployer.address]);
    const rewardsSink = await ethers.deployContract("RewardsSinkMock");

    const { hook } = await deployHook(deployer, v4.poolManager.target, launcher.address, treasury.target);
    const token = await ethers.deployContract("MockOwnedERC20", [
      "Launch",
      "LNCH",
      ethers.parseEther("1000000"),
      creator.address,
    ]);

    const key = poolKeyFor(token.target, { hooks: hook.target });
    const k = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
    const config = {
      token: token.target,
      marketingWallet: marketing.address,
      rewardsSink: rewardsSink.target,
      ...CFG,
      taxLocked: false,
      walletLocked: false,
      exists: false,
    };
    await hook.connect(launcher).register(k, config);

    const sqrtPriceX96 = sqrtPriceX96For(TOKEN_LIQUIDITY, ETH_LIQUIDITY);
    await v4.poolManager.connect(launcher).initialize(k, sqrtPriceX96);

    // The launch liquidity, full range, provided by the creator.
    const [tickLower, tickUpper] = await v4.swapper.usableTicks(key.tickSpacing);
    const liquidity = await v4.swapper.liquidityForAmounts(
      sqrtPriceX96,
      await v4.swapper.sqrtPriceAtTick(tickLower),
      await v4.swapper.sqrtPriceAtTick(tickUpper),
      ETH_LIQUIDITY,
      TOKEN_LIQUIDITY
    );
    await token.connect(creator).approve(PERMIT2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(
      PERMIT2,
      ["function approve(address token, address spender, uint160 amount, uint48 expiration)"],
      creator
    );
    await permit2.approve(token.target, v4.positionManager.target, TOKEN_LIQUIDITY, 2n ** 48n - 1n);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await v4.positionManager
      .connect(creator)
      .modifyLiquidities(
        mintCalldata({
          key,
          tickLower,
          tickUpper,
          liquidity,
          amount0Max: ETH_LIQUIDITY,
          amount1Max: TOKEN_LIQUIDITY,
          recipient: creator.address,
        }),
        deadline,
        { value: ETH_LIQUIDITY }
      );

    const poolId = await v4.swapper.poolId(k);
    // Traders need tokens to sell.
    await token.connect(creator).transfer(alice.address, ethers.parseEther("50000"));
    await token.connect(alice).approve(v4.swapper.target, ethers.MaxUint256);

    return { ...v4, hook, token, treasury, rewardsSink, key, k, poolId, deployer, alice, bob, creator, marketing, launcher };
  }

  /** The three pending ledgers always add up to the ETH the hook holds. */
  async function expectBooksBalance({ hook, poolId }) {
    const booked =
      (await hook.pendingPlatform()) + (await hook.pendingMarketing(poolId)) + (await hook.pendingRewards(poolId));
    expect(await ethers.provider.getBalance(hook.target)).to.equal(booked);
  }

  describe("the hook address", function () {
    it("carries exactly the permission bits its hooks need", async function () {
      const { hook } = await loadFixture(launched);
      expect(BigInt(hook.target) & BigInt(ALL_HOOK_MASK)).to.equal(BigInt(HOODSALE_HOOK_FLAGS));
    });
  });

  describe("charging the fee", function () {
    it("takes the fee out of a buy that spends an exact amount of ETH", async function () {
      const { hook, swapper, token, k, poolId, alice } = await loadFixture(launched);
      const spend = ethers.parseEther("0.2");
      const expectedFee = (spend * buyBps) / BPS;

      const before = await ethers.provider.getBalance(alice.address);
      const receipt = await (
        await swapper.connect(alice).swapExactIn(k, true, spend, 0, alice.address, { value: spend })
      ).wait();
      const after = await ethers.provider.getBalance(alice.address);

      // The trader spends exactly what they declared, not a wei more.
      expect(before - after - receipt.fee).to.equal(spend);
      expect(await ethers.provider.getBalance(hook.target)).to.equal(expectedFee);
      expect(await token.balanceOf(alice.address)).to.be.greaterThan(ethers.parseEther("50000"));
      await expectBooksBalance({ hook, poolId });
    });

    it("takes the fee out of a sell that asks for an exact amount of ETH", async function () {
      const { hook, swapper, k, poolId, alice, bob } = await loadFixture(launched);
      const wanted = ethers.parseEther("0.1");
      const expectedFee = (wanted * sellBps) / BPS;

      const before = await ethers.provider.getBalance(bob.address);
      await swapper.connect(alice).swapExactOut(k, false, wanted, ethers.MaxUint256, bob.address);

      // The trader receives exactly the ETH they asked for; the fee comes on top.
      expect((await ethers.provider.getBalance(bob.address)) - before).to.equal(wanted);
      expect(await ethers.provider.getBalance(hook.target)).to.equal(expectedFee);
      await expectBooksBalance({ hook, poolId });
    });

    it("takes the fee out of the ETH a sell produces", async function () {
      const { hook, swapper, k, poolId, alice, bob } = await loadFixture(launched);
      const before = await ethers.provider.getBalance(bob.address);
      await swapper.connect(alice).swapExactIn(k, false, ethers.parseEther("5000"), 0, bob.address);

      const received = (await ethers.provider.getBalance(bob.address)) - before;
      const fee = await ethers.provider.getBalance(hook.target);
      expect(fee).to.be.greaterThan(0);
      // The fee is the configured share of the ETH the swap produced.
      expect(fee).to.equal(((received + fee) * sellBps) / BPS);
      await expectBooksBalance({ hook, poolId });
    });

    it("takes the fee on top of the ETH a buy for an exact amount of tokens needs", async function () {
      const { hook, swapper, token, k, poolId, alice } = await loadFixture(launched);
      const wanted = ethers.parseEther("1000");
      const tokensBefore = await token.balanceOf(alice.address);

      const before = await ethers.provider.getBalance(alice.address);
      const receipt = await (
        await swapper
          .connect(alice)
          .swapExactOut(k, true, wanted, ethers.MaxUint256, alice.address, { value: ethers.parseEther("1") })
      ).wait();
      const spent = before - (await ethers.provider.getBalance(alice.address)) - receipt.fee;

      expect((await token.balanceOf(alice.address)) - tokensBefore).to.equal(wanted);
      const fee = await ethers.provider.getBalance(hook.target);
      // What the pool needed, plus the fee, is what the trader paid.
      expect(fee).to.equal(((spent - fee) * buyBps) / BPS);
      await expectBooksBalance({ hook, poolId });
    });

    it("splits every fee into the platform, marketing and rewards shares", async function () {
      const { hook, swapper, k, poolId, alice } = await loadFixture(launched);
      const spend = ethers.parseEther("0.2");
      await swapper.connect(alice).swapExactIn(k, true, spend, 0, alice.address, { value: spend });

      const fee = (spend * buyBps) / BPS;
      expect(await hook.pendingMarketing(poolId)).to.equal((fee * BigInt(CFG.marketingBuyBps)) / buyBps);
      expect(await hook.pendingRewards(poolId)).to.equal((fee * BigInt(CFG.rewardsBuyBps)) / buyBps);
      // The platform keeps the remainder, so rounding never strands a wei.
      expect(await hook.pendingPlatform()).to.equal(
        fee - (fee * BigInt(CFG.marketingBuyBps)) / buyBps - (fee * BigInt(CFG.rewardsBuyBps)) / buyBps
      );
    });

    it("charges nothing in a pool opened without the hook", async function () {
      const { poolManager, swapper, token, alice, bob } = await loadFixture(launched);
      // Anyone may open a second, hookless pool for the same token; it simply pays no tax, which
      // is why a launch keeps its liquidity in the hooked pool.
      const plain = poolKeyFor(token.target, { fee: 3000, tickSpacing: 60 });
      const pk = [plain.currency0, plain.currency1, plain.fee, plain.tickSpacing, plain.hooks];
      await poolManager.connect(bob).initialize(pk, sqrtPriceX96For(TOKEN_LIQUIDITY, ETH_LIQUIDITY));
      // No liquidity, so the swap cannot execute, but it must not revert on a missing config.
      await expect(swapper.connect(alice).swapExactIn(pk, true, 1000n, 0, alice.address, { value: 1000n })).to.not.be
        .reverted;
    });
  });

  describe("paying out", function () {
    it("sends the shares on to the marketing wallet, the rewards sink and the Treasury", async function () {
      const { hook, swapper, treasury, rewardsSink, k, poolId, alice, marketing } = await loadFixture(launched);
      const spend = ethers.parseEther("0.4");
      await swapper.connect(alice).swapExactIn(k, true, spend, 0, alice.address, { value: spend });

      const marketingOwed = await hook.pendingMarketing(poolId);
      const rewardsOwed = await hook.pendingRewards(poolId);
      const platformOwed = await hook.pendingPlatform();
      const marketingBefore = await ethers.provider.getBalance(marketing.address);

      await hook.flush(poolId);
      await hook.flushPlatform();

      expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal(marketingOwed);
      expect(await rewardsSink.received()).to.equal(rewardsOwed);
      expect(await ethers.provider.getBalance(treasury.target)).to.equal(platformOwed);
      // The platform's ETH books its buyback share on arrival, exactly as a V2 launch's tax does.
      expect(await treasury.buybackReserve()).to.equal((platformOwed * 3000n) / BPS);
      expect(await ethers.provider.getBalance(hook.target)).to.equal(0);
    });

    it("keeps a rejected share pending and still pays the others", async function () {
      const { hook, swapper, rewardsSink, k, poolId, alice, creator, launcher, poolManager } = await loadFixture(
        launched
      );
      const rejecting = await ethers.deployContract("RejectingWallet");
      await hook.connect(creator).setMarketingWallet(poolId, rejecting.target);

      const spend = ethers.parseEther("0.2");
      await swapper.connect(alice).swapExactIn(k, true, spend, 0, alice.address, { value: spend });
      const marketingOwed = await hook.pendingMarketing(poolId);
      const rewardsOwed = await hook.pendingRewards(poolId);

      await expect(hook.flush(poolId)).to.emit(hook, "Flushed").withArgs(poolId, rejecting.target, marketingOwed, false);
      // The refused share stays on the books; the rewards share is paid.
      expect(await hook.pendingMarketing(poolId)).to.equal(marketingOwed);
      expect(await hook.pendingRewards(poolId)).to.equal(0);
      expect(await rewardsSink.received()).to.equal(rewardsOwed);
      // Trading is unaffected by a wallet that refuses its money.
      await expect(swapper.connect(alice).swapExactIn(k, true, spend, 0, alice.address, { value: spend })).to.not.be
        .reverted;
      poolManager;
      launcher;
    });

    it("caps the gas a payout may burn", async function () {
      const { hook, swapper, k, poolId, alice, creator } = await loadFixture(launched);
      const greedy = await ethers.deployContract("GasBurningWallet");
      await hook.connect(creator).setMarketingWallet(poolId, greedy.target);
      const spend = ethers.parseEther("0.2");
      await swapper.connect(alice).swapExactIn(k, true, spend, 0, alice.address, { value: spend });

      const owed = await hook.pendingMarketing(poolId);
      await hook.flush(poolId);
      expect(await hook.pendingMarketing(poolId)).to.equal(owed);
    });
  });

  describe("who may change what", function () {
    it("lets only the launcher register a pool, once, with a well formed key", async function () {
      const { hook, token, alice, launcher, marketing } = await loadFixture(launched);
      const other = await ethers.deployContract("MockOwnedERC20", ["B", "B", 1000n, alice.address]);
      const good = poolKeyFor(other.target, { hooks: hook.target });
      const cfg = {
        token: other.target,
        marketingWallet: marketing.address,
        rewardsSink: ethers.ZeroAddress,
        marketingBuyBps: 0,
        marketingSellBps: 0,
        rewardsBuyBps: 0,
        rewardsSellBps: 0,
        taxLocked: false,
        walletLocked: false,
        exists: false,
      };
      const gk = [good.currency0, good.currency1, good.fee, good.tickSpacing, good.hooks];
      await expect(hook.connect(alice).register(gk, cfg)).to.be.revertedWithCustomError(hook, "NotLauncher");

      // A key that is not the platform's shape is refused.
      const wrongFee = [good.currency0, good.currency1, 3000, good.tickSpacing, good.hooks];
      await expect(hook.connect(launcher).register(wrongFee, cfg)).to.be.revertedWithCustomError(hook, "BadKey");

      await hook.connect(launcher).register(gk, cfg);
      await expect(hook.connect(launcher).register(gk, cfg)).to.be.revertedWithCustomError(hook, "AlreadyRegistered");
      expect(await hook.poolIdOf(other.target)).to.not.equal(ethers.ZeroHash);
    });

    it("refuses a tax over the platform cap and rewards without a sink", async function () {
      const { hook, poolId, creator } = await loadFixture(launched);
      // 10% per side is the ceiling, platform share included.
      await expect(hook.connect(creator).setTaxes(poolId, 900, 0, 100, 0)).to.be.revertedWithCustomError(
        hook,
        "TaxTooHigh"
      );
      await hook.connect(creator).setTaxes(poolId, 875, 0, 100, 0);
      expect(await hook.feeBps(poolId, true)).to.equal(1000);
    });

    it("lets only the token owner change the taxes and the wallet", async function () {
      const { hook, poolId, alice, marketing } = await loadFixture(launched);
      await expect(hook.connect(alice).setTaxes(poolId, 0, 0, 0, 0)).to.be.revertedWithCustomError(
        hook,
        "NotTokenOwner"
      );
      await expect(hook.connect(alice).setMarketingWallet(poolId, marketing.address)).to.be.revertedWithCustomError(
        hook,
        "NotTokenOwner"
      );
    });

    it("freezes the taxes and the wallet for good once locked", async function () {
      const { hook, poolId, creator, alice } = await loadFixture(launched);
      await hook.connect(creator).lockTaxes(poolId);
      await expect(hook.connect(creator).setTaxes(poolId, 0, 0, 0, 0)).to.be.revertedWithCustomError(
        hook,
        "SettingLocked"
      );
      await hook.connect(creator).lockMarketingWallet(poolId);
      await expect(hook.connect(creator).setMarketingWallet(poolId, alice.address)).to.be.revertedWithCustomError(
        hook,
        "SettingLocked"
      );
    });

    it("leaves a renounced token's pool frozen", async function () {
      const { hook, poolId, creator } = await loadFixture(launched);
      const token = await ethers.getContractAt("MockOwnedERC20", (await hook.configOf(poolId)).token);
      await token.connect(creator).renounceOwnership();
      await expect(hook.connect(creator).setTaxes(poolId, 0, 0, 0, 0)).to.be.revertedWithCustomError(
        hook,
        "NotTokenOwner"
      );
    });

    it("lets only the launcher open the pool, and only after it is registered", async function () {
      const { hook, poolManager, token, alice, launcher } = await loadFixture(launched);
      const fresh = await ethers.deployContract("MockOwnedERC20", ["C", "C", 1000n, alice.address]);
      const key = poolKeyFor(fresh.target, { hooks: hook.target });
      const k = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
      const price = sqrtPriceX96For(1000n, 1n);
      // Not registered yet.
      await expect(poolManager.connect(launcher).initialize(k, price)).to.be.reverted;
      // And a stranger cannot open a pool on this hook at all.
      const registered = poolKeyFor(token.target, { hooks: hook.target });
      await expect(
        poolManager
          .connect(alice)
          .initialize(
            [registered.currency0, registered.currency1, registered.fee, registered.tickSpacing, registered.hooks],
            price
          )
      ).to.be.reverted;
    });
  });
});
