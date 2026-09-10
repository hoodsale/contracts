const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

// Regression tests against the exploit scenarios found in the audit.
describe("Security regressions", function () {
  describe("Pair pre-creation griefing", function () {
    it("token creation still succeeds when the token/WETH pair already exists", async function () {
      const { tokenFactory, dexFactory, weth, deployer } = await loadFixture(deployPlatform);

      // The attacker precomputes the next token address and creates the pair.
      const standardDeployer = await tokenFactory.standardDeployer();
      const nonce = await ethers.provider.getTransactionCount(standardDeployer);
      const predicted = ethers.getCreateAddress({ from: standardDeployer, nonce });
      await dexFactory.createPair(predicted, weth.target);
      expect(await dexFactory.getPair(predicted, weth.target)).to.not.equal(ethers.ZeroAddress);

      await expect(tokenFactory.createStandardToken("Pre", "PRE", E("1000000"))).to.not.be.reverted;

      const tokenAddr = await tokenFactory.allTokens(0);
      expect(tokenAddr).to.equal(predicted);
      const token = await ethers.getContractAt("StandardToken", tokenAddr);
      // The existing pair is adopted, no new one is created
      expect(await token.mainPair()).to.equal(await dexFactory.getPair(tokenAddr, weth.target));
      expect(await token.isAmmPair(await token.mainPair())).to.equal(true);
      expect(await token.balanceOf(deployer.address)).to.equal(E("1000000"));
    });

    it("HOODS deploys against a pre-created pair", async function () {
      const { dexFactory, weth, router, treasury, deployer, marketing } = await loadFixture(deployPlatform);
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
      await dexFactory.createPair(predicted, weth.target);

      const hs = await ethers.deployContract("HoodSaleToken", [
        deployer.address,
        router.target,
        treasury.target,
        marketing.address,
      ]);
      expect(hs.target).to.equal(predicted);
      expect(await hs.mainPair()).to.equal(await dexFactory.getPair(hs.target, weth.target));
    });
  });

  describe("Finalize against a pre-seeded pair", function () {
    async function saleFixture() {
      const env = await deployPlatform();
      const { deployer, alice, bob, tokenFactory, presaleFactory } = env;

      await tokenFactory.createStandardToken("Seed", "SEED", E("1000000"));
      const tokenAddr = await tokenFactory.allTokens(0);
      const token = await ethers.getContractAt("StandardToken", tokenAddr);

      const now = await time.latest();
      const params = {
        token: tokenAddr,
        presaleRate: E("1000"),
        listingRate: E("800"),
        softCap: E("2"),
        hardCap: E("8"),
        minContribution: E("0.5"),
        maxContribution: E("4"),
        startTime: now + 100,
        endTime: now + 1000,
        liquidityBps: 6000,
        liquidityAction: 0, // Lock
        lockDuration: 30n * 24n * 3600n,
        launchTime: 0,
        whitelistEnabled: false,
      };
      const required = await presaleFactory.requiredTokensFor(params);
      await token.approve(presaleFactory.target, required);
      await presaleFactory.createPresale(params, { value: E("0.1") });
      const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));

      await time.increaseTo(now + 100);
      await presale.connect(alice).contribute({ value: E("3") });
      await presale.connect(bob).contribute({ value: E("2") });
      return { ...env, token, presale, params };
    }

    it("finalizes even when a griefer seeds the pair with WETH only", async function () {
      const { presale, params, token, weth, dexFactory, carol, locker, deployer } =
        await loadFixture(saleFixture);

      // The griefer donates only WETH to the pair: the router path would revert with a
      // division by zero in quote; the low-level mint path gets past it.
      const pair = await dexFactory.getPair(token.target, weth.target);
      await weth.connect(carol).deposit({ value: E("0.01") });
      await weth.connect(carol).transfer(pair, E("0.01"));
      await (await ethers.getContractAt("MockPair", pair)).sync();

      await time.increaseTo(params.endTime + 10);
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");

      // LP was actually minted and locked
      const lpAmount = await presale.lpAmount();
      expect(lpAmount).to.be.gt(0);
      const lock = await locker.locks(await presale.lpLockId());
      expect(lock.amount).to.equal(lpAmount);
      expect(lock.owner).to.equal(deployer.address);
    });

    it("finalizes when a griefer seeds the pair with both tokens at a skewed ratio", async function () {
      const { presale, params, token, weth, dexFactory, carol, deployer } = await loadFixture(saleFixture);

      const pair = await dexFactory.getPair(token.target, weth.target);
      // The owner is tax exempt so the transfer goes through in full; we give carol tokens and have her send them to the pair.
      await token.transfer(carol.address, E("100"));
      await token.connect(carol).transfer(pair, E("100"));
      await weth.connect(carol).deposit({ value: E("1") });
      await weth.connect(carol).transfer(pair, E("1"));
      await (await ethers.getContractAt("MockPair", pair)).sync();

      await time.increaseTo(params.endTime + 10);
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
      expect(await presale.lpAmount()).to.be.gt(0);
    });

    it("contributors can still claim after a griefed finalize", async function () {
      const { presale, params, token, weth, dexFactory, carol, alice } = await loadFixture(saleFixture);
      const pair = await dexFactory.getPair(token.target, weth.target);
      await weth.connect(carol).deposit({ value: E("0.01") });
      await weth.connect(carol).transfer(pair, E("0.01"));
      await (await ethers.getContractAt("MockPair", pair)).sync();

      await time.increaseTo(params.endTime + 10);
      await presale.finalize(0, 0);

      await presale.connect(alice).claim();
      expect(await token.balanceOf(alice.address)).to.equal(E("3000")); // 3 ETH * 1000
    });

    // A plain transfer is a contribution now, on the same terms as contribute(), so a stray one
    // reverts rather than being swallowed. The router is the exception: its leftover refund
    // arrives during finalize and must never revert, or the sale would be stuck.
    it("refuses a stray transfer instead of swallowing it, and still finalizes", async function () {
      const { presale, params, carol } = await loadFixture(saleFixture);
      // past the end time, so nothing about this transfer could ever be a valid contribution
      await time.increaseTo(params.endTime + 10);
      await expect(carol.sendTransaction({ to: presale.target, value: E("0.001") })).to.be.revertedWith("ended");
      expect(await ethers.provider.getBalance(presale.target)).to.equal(await presale.totalRaised());

      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
      expect(Number(await presale.status())).to.equal(5);
    });
  });

  describe("Rewards accounting exclusions", function () {
    async function rewardsFixture() {
      const env = await deployPlatform();
      const { deployer, tokenFactory, weth } = env;
      await tokenFactory.createRewardsToken(
        "Rew", "REW", E("1000000"), weth.target, deployer.address, [200, 200, 100, 100]
      );
      const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(0));
      return { ...env, token };
    }

    it("excludes a presale from rewards so distributed rewards are not stranded", async function () {
      const { token, tokenFactory, presaleFactory, deployer } = await loadFixture(rewardsFixture);

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
        liquidityAction: 1, // Burn
        lockDuration: 0,
        launchTime: 0,
        whitelistEnabled: false,
      };
      const required = await presaleFactory.requiredTokensFor(params);
      await token.approve(presaleFactory.target, required);
      await presaleFactory.createPresale(params, { value: E("0.1") });
      const presale = await presaleFactory.allPresales(0);

      expect(await token.isExcludedFromRewards(presale)).to.equal(true);
      expect(await token.sharesOf(presale)).to.equal(0);
      expect(await tokenFactory.presaleFactory()).to.equal(presaleFactory.target);
    });

    it("auto-excludes newly registered AMM pairs from rewards", async function () {
      const { token, dexFactory, weth, deployer, alice } = await loadFixture(rewardsFixture);

      // A second pool: token/another ERC20
      const other = await ethers.deployContract("MockWETH");
      await dexFactory.createPair(token.target, other.target);
      const secondPair = await dexFactory.getPair(token.target, other.target);

      // Tokens go to the pair, it must not receive a rewards share
      await token.transfer(secondPair, E("50000"));
      expect(await token.sharesOf(secondPair)).to.be.gt(0);

      await token.setAmmPair(secondPair, true);
      expect(await token.isExcludedFromRewards(secondPair)).to.equal(true);
      expect(await token.sharesOf(secondPair)).to.equal(0);
    });
  });

  describe("LiquidityLocker paged views", function () {
    it("returns paged lock ids with the true total", async function () {
      const { locker, tokenFactory, deployer } = await loadFixture(deployPlatform);
      await tokenFactory.createStandardToken("Lock", "LCK", E("1000000"));
      const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));

      const unlock = (await time.latest()) + 3600;
      await token.approve(locker.target, E("300"));
      for (let i = 0; i < 3; i++) {
        await locker.lock(token.target, E("100"), unlock + i, deployer.address);
      }

      let [ids, total] = await locker.locksOfOwnerPaged(deployer.address, 0, 2);
      expect(total).to.equal(3);
      expect(ids.map(Number)).to.deep.equal([0, 1]);

      [ids, total] = await locker.locksOfOwnerPaged(deployer.address, 2, 10);
      expect(ids.map(Number)).to.deep.equal([2]);

      [ids, total] = await locker.locksOfOwnerPaged(deployer.address, 9, 5);
      expect(ids.length).to.equal(0);
      expect(total).to.equal(3);

      [ids, total] = await locker.locksOfTokenPaged(token.target, 1, 2);
      expect(total).to.equal(3);
      expect(ids.map(Number)).to.deep.equal([1, 2]);
    });

    it("locksOfOwner filters out locks handed to a new owner", async function () {
      const { locker, tokenFactory, deployer, alice } = await loadFixture(deployPlatform);
      await tokenFactory.createStandardToken("Lock", "LCK", E("1000000"));
      const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));

      const unlock = (await time.latest()) + 3600;
      await token.approve(locker.target, E("200"));
      await locker.lock(token.target, E("100"), unlock, deployer.address);
      await locker.lock(token.target, E("100"), unlock, deployer.address);

      await locker.transferLockOwnership(0, alice.address);
      expect((await locker.locksOfOwner(deployer.address)).map(Number)).to.deep.equal([1]);
      expect((await locker.locksOfOwner(alice.address)).map(Number)).to.deep.equal([0]);
    });
  });
});
