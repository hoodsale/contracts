const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4, taxConfig, keyArray } = require("./helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const Lock = 0;
const Rewards = 2;

describe("V4 rewards token", function () {
  async function launched() {
    const ctx = await deployPlatformV4();
    const { launcher, presaleFactory, weth, alice, bob, carol, marketing } = ctx;

    const now = BigInt(await time.latest());
    const start = now + 1000n;
    const spec = {
      name: "Yield",
      symbol: "YLD",
      totalSupply: E("1000000"),
      rewardToken: weth.target,
    };
    // 2% of every buy and 3% of every sell go to holders, on top of the platform's share.
    await launcher
      .connect(alice)
      .createToken(
        Rewards,
        spec,
        taxConfig(marketing.address, { rewardsBuyBps: 200, rewardsSellBps: 300 }),
        alice.address
      );
    const created = await launcher.tokensOfCreator(alice.address);
    const tokenAddr = created[created.length - 1];
    const token = await ethers.getContractAt("RewardsTokenV4", tokenAddr);

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
    const required = await presaleFactory.requiredTokensFor(params);
    await token.connect(alice).approve(presaleFactory.target, required);
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );

    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    await presale.connect(alice).finalize(0, 0);
    await presale.connect(bob).claim();
    await presale.connect(carol).claim();

    const key = keyArray(await launcher.poolKeyOf(tokenAddr));
    const poolId = (await launcher.launchOf(tokenAddr)).poolId;
    return { ...ctx, token, tokenAddr, presale, key, poolId };
  }

  it("pays the holders' share out of trades, not out of transfers", async function () {
    const { token, hook, swapper, key, poolId, dave } = await loadFixture(launched);
    const spend = E("1");
    await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });

    // 2% of the ETH spent is the holders' share; the platform's 0.25% is separate.
    const fee = (spend * 225n) / 10_000n;
    const rewardsShare = (fee * 200n) / 225n;
    expect(await hook.pendingRewards(poolId)).to.equal(rewardsShare);

    await hook.flush(poolId);
    expect(await token.pendingRewardEth()).to.equal(rewardsShare);

    // A plain transfer between wallets costs nothing at all.
    const before = await token.pendingRewardEth();
    await token.connect(dave).transfer(ethers.Wallet.createRandom().address, E("1"));
    expect(await token.pendingRewardEth()).to.equal(before);
  });

  it("distributes to holders and lets them claim", async function () {
    const { token, hook, swapper, key, poolId, keeper, bob, carol, weth, dave } = await loadFixture(launched);
    const spend = E("1");
    await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });
    await hook.flush(poolId);

    const owed = await token.pendingRewardEth();
    await token.connect(keeper).distributeRewards(0);
    expect(await token.pendingRewardEth()).to.equal(0);
    // The reward token here is WETH, so the ETH the hook collected is simply wrapped.
    expect(await token.totalRewardsDistributed()).to.equal(owed);

    const bobOwed = await token.withdrawableRewardOf(bob.address);
    expect(bobOwed).to.be.greaterThan(0);
    await token.connect(bob).claimRewards();
    expect(await weth.balanceOf(bob.address)).to.equal(bobOwed);
    // Bob and carol bought the same amount, so they are owed the same.
    expect(await token.withdrawableRewardOf(carol.address)).to.be.closeTo(bobOwed, 10n);
  });

  it("gives the pool's own liquidity no share of the rewards", async function () {
    const { token, poolManager, positionManager, launcher, positionLocker } = await loadFixture(launched);
    expect(await token.isExcludedFromRewards(poolManager.target)).to.equal(true);
    expect(await token.isExcludedFromRewards(positionManager.target)).to.equal(true);
    expect(await token.isExcludedFromRewards(launcher.target)).to.equal(true);
    expect(await token.sharesOf(poolManager.target)).to.equal(0);
    positionLocker;
  });

  it("takes its rewards only from the hook", async function () {
    const { token, alice } = await loadFixture(launched);
    await expect(
      alice.sendTransaction({ to: token.target, value: E("1") })
    ).to.be.revertedWithCustomError(token, "NotHook");
  });

  // The launch a creator actually asks for: a v4 pool, 2% of every trade to the marketing wallet
  // and 2% to holders, paid in a tokenized stock.
  describe("paying holders in a tokenized stock", function () {
    async function stockLaunch() {
      const ctx = await deployPlatformV4();
      const { deployer, v3Factory, weth, quickLaunch, launcher, presaleFactory, alice, bob, carol, marketing } = ctx;

      // A stock trades against WETH on Uniswap V3 on this chain, so the platform stores the path
      // and every new token created for that reward picks it up.
      const tsla = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E("1000000")]);
      await v3Factory.createPool(weth.target, tsla.target, 3000);
      const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, tsla.target, 3000));
      await weth.deposit({ value: E("50") });
      await weth.transfer(pool.target, E("50"));
      await tsla.transfer(pool.target, E("345"));
      await pool.sync();
      const path = ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, tsla.target]);
      await quickLaunch.setRewardTokenAllowed(tsla.target, true);
      await quickLaunch.setRewardRouteV3(tsla.target, path);

      const now = BigInt(await time.latest());
      const start = now + 1000n;
      await launcher.connect(alice).createToken(
        Rewards,
        { name: "Stock Yield", symbol: "SYLD", totalSupply: E("1000000"), rewardToken: tsla.target },
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
      expect(await token.rewardRouteV3()).to.equal(path);

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
      deployer;
      return { ...ctx, token, tokenAddr, tsla, key, poolId };
    }

    it("charges both shares on a trade and pays holders the stock", async function () {
      const { token, tsla, hook, swapper, key, poolId, keeper, marketing, bob, dave } = await loadFixture(stockLaunch);

      const spend = E("1");
      await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });

      // 2% marketing, 2% holders, 0.25% platform: 4.25% of the ETH spent.
      const fee = (spend * 425n) / 10_000n;
      expect(await ethers.provider.getBalance(hook.target)).to.equal(fee);
      expect(await hook.pendingMarketing(poolId)).to.equal((fee * 200n) / 425n);
      expect(await hook.pendingRewards(poolId)).to.equal((fee * 200n) / 425n);

      const marketingBefore = await ethers.provider.getBalance(marketing.address);
      await hook.flush(poolId);
      // The creator's share arrives as ETH, the holders' share as ETH the token will convert.
      expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal((fee * 200n) / 425n);
      expect(await token.pendingRewardEth()).to.equal((fee * 200n) / 425n);

      await token.connect(keeper).distributeRewards(0);
      expect(await token.pendingRewardEth()).to.equal(0);
      // The ETH became the stock, and it is the stock holders can claim.
      expect(await token.totalRewardsDistributed()).to.be.greaterThan(0);
      const owed = await token.withdrawableRewardOf(bob.address);
      expect(owed).to.be.greaterThan(0);
      await token.connect(bob).claimRewards();
      expect(await tsla.balanceOf(bob.address)).to.equal(owed);
    });

    // Anyone can send WETH to the token. The swap used to take the whole WETH balance and insist
    // the route consumed it, so a donation larger than the route could take blocked every
    // distribution. Only the ETH being distributed goes into the swap now.
    it("leaves WETH sent to it out of the reward swap", async function () {
      const { token, weth, hook, swapper, key, poolId, keeper, dave } = await loadFixture(stockLaunch);
      await swapper.connect(dave).swapExactIn(key, true, E("1"), 0, dave.address, { value: E("1") });
      await hook.flush(poolId);

      await weth.connect(dave).deposit({ value: E("5") });
      await weth.connect(dave).transfer(token.target, E("5"));
      await token.connect(keeper).distributeRewards(0);
      expect(await token.pendingRewardEth()).to.equal(0);
      expect(await token.totalRewardsDistributed()).to.be.greaterThan(0);
      expect(await weth.balanceOf(token.target)).to.equal(E("5"));
    });
  });

  // The review found the platform keeper could steer a v4 Rewards token: set its reward route and
  // its exclusions, even after the owner renounced. A stolen keeper key could then route the
  // holders' rewards through a pool of its own, or shut every holder out. The keeper now only runs
  // distributions along the route the owner chose.
  describe("who may steer the rewards", function () {
    it("lets the keeper distribute but not set the route or the exclusions", async function () {
      const { token, hook, swapper, key, poolId, keeper, bob, dave } = await loadFixture(launched);
      await swapper.connect(dave).swapExactIn(key, true, E("1"), 0, dave.address, { value: E("1") });
      await hook.flush(poolId);

      await expect(token.connect(keeper).setRewardRouteV3("0x")).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
      await expect(token.connect(keeper).setExcludedFromRewards(bob.address, true)).to.be.revertedWithCustomError(
        token,
        "NotAuthorized"
      );
      // Running the distribution is still the keeper's job.
      await token.connect(keeper).distributeRewards(0);
      expect(await token.pendingRewardEth()).to.equal(0);
    });

    it("keeps the pool's custody and the platform out of the rewards for good", async function () {
      const { token, poolManager, hook, launcher, alice } = await loadFixture(launched);
      for (const account of [poolManager.target, hook.target, launcher.target]) {
        expect(await token.isAlwaysExcluded(account)).to.equal(true);
        await expect(token.connect(alice).setExcludedFromRewards(account, false)).to.be.revertedWithCustomError(
          token,
          "AlwaysExcluded"
        );
      }
    });

    it("lets the presale factory take an address out but never put one back", async function () {
      const { token, presale, presaleFactory, bob } = await loadFixture(launched);
      // The sale contract was taken out of the rewards when the sale was created.
      expect(await token.isExcludedFromRewards(presale.target)).to.equal(true);

      const factory = await ethers.getImpersonatedSigner(presaleFactory.target);
      await ethers.provider.send("hardhat_setBalance", [presaleFactory.target, "0x" + E("1").toString(16)]);
      await token.connect(factory).setExcludedFromRewards(bob.address, true);
      expect(await token.isExcludedFromRewards(bob.address)).to.equal(true);
      await expect(token.connect(factory).setExcludedFromRewards(bob.address, false)).to.be.revertedWithCustomError(
        token,
        "NotAuthorized"
      );
    });

    // The review found the rights of "the presale factory" were read from the TokenFactory, whose
    // owner can repoint it; a wallet set there could have shut holders out. They are read from the
    // launcher now, where the presale factory is fixed.
    it("takes the presale factory from the launcher, not from the TokenFactory", async function () {
      const { token, tokenFactory, presaleFactory, launcher, deployer, bob, dave } = await loadFixture(launched);
      expect(await launcher.presaleFactory()).to.equal(presaleFactory.target);
      await tokenFactory.connect(deployer).setPresaleFactory(dave.address);
      await expect(token.connect(dave).setExcludedFromRewards(bob.address, true)).to.be.revertedWithCustomError(
        token,
        "NotAuthorized"
      );
      await expect(token.connect(dave).distributeRewards(0)).to.be.revertedWithCustomError(token, "NotAuthorized");
    });

    it("freezes the route and the exclusions once the owner renounces", async function () {
      const { token, alice, bob, keeper } = await loadFixture(launched);
      await token.connect(alice).renounceOwnership();
      await expect(token.connect(alice).setRewardRouteV3("0x")).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
      await expect(token.connect(alice).setExcludedFromRewards(bob.address, true)).to.be.revertedWithCustomError(
        token,
        "NotAuthorized"
      );
      await expect(token.connect(keeper).setExcludedFromRewards(bob.address, true)).to.be.revertedWithCustomError(
        token,
        "NotAuthorized"
      );
    });

    it("can pay out part of the pending rewards when the route is too thin for all of it", async function () {
      const { token, hook, swapper, key, poolId, keeper, dave } = await loadFixture(launched);
      await swapper.connect(dave).swapExactIn(key, true, E("1"), 0, dave.address, { value: E("1") });
      await hook.flush(poolId);
      const pending = await token.pendingRewardEth();

      await token.connect(keeper).distributeRewardsPartly(pending / 2n, 0);
      expect(await token.pendingRewardEth()).to.equal(pending - pending / 2n);
      await expect(token.connect(keeper).distributeRewardsPartly(pending, 0)).to.be.revertedWith("more than pending");
    });
  });

  it("lets only the owner, the platform or the keeper distribute", async function () {
    const { token, hook, swapper, key, poolId, bob, dave } = await loadFixture(launched);
    const spend = E("1");
    await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });
    await hook.flush(poolId);
    await expect(token.connect(bob).distributeRewards(0)).to.be.revertedWithCustomError(token, "NotAuthorized");
  });
});
