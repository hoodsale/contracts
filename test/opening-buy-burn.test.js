const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const SUPPLY = E("100000000");

// The opening buy-and-burn: the sale owner spends their own ETH on the first trade against the
// new pool and burns everything it buys, in the same transaction as the launch, so that nothing
// can be sequenced between the liquidity being added and the buy.
//
// The numbers here mirror the real HOODS sale: 5 ETH hard cap, 11,884,000 tokens per ETH at both
// the presale and the listing rate, 70% of the net raise into liquidity, LP burned.
describe("Opening buy and burn", function () {
  const RATE = E("11884000");

  async function buildLaunch(raise) {
    const env = await deployPlatform();
    const { deployer, alice, bob, carol, hoodsale, presaleFactory } = env;

    // Mirror the mainnet fee so the pool numbers match the real sale.
    await presaleFactory.setFees(250, 1000);

    const now = await time.latest();
    const params = {
      token: hoodsale.target,
      presaleRate: RATE,
      listingRate: RATE,
      softCap: E("1.25"),
      hardCap: E("5"),
      minContribution: E("0.01"),
      maxContribution: E("2"),
      startTime: now + 100,
      endTime: now + 100000,
      liquidityBps: 7000,
      liquidityAction: 1, // Burn
      lockDuration: 0,
      launchTime: 0,
      whitelistEnabled: false,
    };

    // The sale is created by a contract that then plays the part the owner's own wallet plays on
    // mainnet under EIP-7702: it owns the sale and drives finalize and the buy in one transaction.
    const launcher = await ethers.deployContract("TestLauncher");
    const required = await presaleFactory.requiredTokensFor(params);
    await hoodsale.transfer(launcher.target, required);
    // createPresale requires the sale creator to be the token owner. On mainnet that is the
    // owner's own wallet, which is also what runs the batch under EIP-7702.
    await hoodsale.transferOwnership(launcher.target);
    const erc20 = new ethers.Interface(["function approve(address,uint256)"]);
    await launcher.call(
      hoodsale.target,
      0,
      erc20.encodeFunctionData("approve", [presaleFactory.target, required])
    );
    const factoryIface = presaleFactory.interface;
    const fee = await presaleFactory.creationFee();
    await launcher.call(
      presaleFactory.target,
      fee,
      factoryIface.encodeFunctionData("createPresale", [params]),
      { value: fee }
    );
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );

    await time.increaseTo(params.startTime + 1);
    let left = E(String(raise));
    for (const who of [alice, bob, carol]) {
      const amount = left > E("2") ? E("2") : left;
      if (amount > 0n) {
        await presale.connect(who).contribute({ value: amount });
        left -= amount;
      }
    }
    // A sale below its hard cap only becomes finalizable once its end time has passed.
    if (E(String(raise)) < params.hardCap) await time.increaseTo(params.endTime + 1);

    return { ...env, presale, params, launcher, required };
  }

  async function launchFixture() {
    return buildLaunch(5);
  }

  async function softCapFixture() {
    return buildLaunch(1.25);
  }

  it("fills the pool exactly as the sale intends before anyone can trade", async function () {
    const { presale, hoodsale, launcher } = await loadFixture(launchFixture);
    expect(await presale.totalRaised()).to.equal(E("5"));
    await launcher.launchOnly(presale.target);

    const pair = await ethers.getContractAt("MockPair", await hoodsale.mainPair());
    const [r0, r1] = await pair.getReserves();
    const isToken0 = (await pair.token0()) === hoodsale.target;
    const poolEth = isToken0 ? r1 : r0;
    const poolTok = isToken0 ? r0 : r1;
    expect(poolEth).to.equal(E("3.4125"));
    expect(poolTok).to.equal(E("40554150"));
  });

  it("burns what it buys, in the same transaction as the launch", async function () {
    const { presale, hoodsale, launcher, deployer } = await loadFixture(launchFixture);
    const supplyBefore = await hoodsale.totalSupply();

    await expect(launcher.launch(presale.target, hoodsale.target, { value: E("5") })).to.emit(
      hoodsale,
      "OpeningBuyBurn"
    );

    const supplyAfter = await hoodsale.totalSupply();
    expect(supplyAfter).to.be.lessThan(supplyBefore);
    // The tokens are destroyed, not parked: the dead address holds none of them.
    expect(await hoodsale.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(0);
    // And the token keeps no ETH of its own.
    expect(await ethers.provider.getBalance(hoodsale.target)).to.equal(0);
  });

  it("spends the whole offer when the pool can take it", async function () {
    const { presale, hoodsale, launcher } = await loadFixture(launchFixture);
    await (await launcher.launch(presale.target, hoodsale.target, { value: E("5") })).wait();

    const ev = (await hoodsale.queryFilter(hoodsale.filters.OpeningBuyBurn())).at(-1);
    // The cap is 150% of the pool's ETH reserve, which is 5.11875 ETH at a full raise, so a
    // 5 ETH offer goes in whole.
    expect(ev.args.ethSpent).to.equal(E("5"));
    expect(ev.args.tokensBurned).to.be.greaterThan(E("24000000"));
  });

  it("caps the spend on a small raise and refunds the difference", async function () {
    const { presale, hoodsale, launcher } = await loadFixture(softCapFixture);
    expect(await presale.totalRaised()).to.equal(E("1.25"));

    const before = await ethers.provider.getBalance(launcher.target);
    await (await launcher.launch(presale.target, hoodsale.target, { value: E("5") })).wait();

    const ev = (await hoodsale.queryFilter(hoodsale.filters.OpeningBuyBurn())).at(-1);
    // The pool holds 0.853125 ETH at a soft cap raise, so the 150% cap binds at 1.2796875.
    expect(ev.args.ethSpent).to.equal(E("1.2796875"));
    // The unspent 3.72 ETH comes back rather than being thrown at a shallow pool.
    const after = await ethers.provider.getBalance(launcher.target);
    expect(after - before).to.be.greaterThan(E("3.7"));
    expect(await ethers.provider.getBalance(hoodsale.target)).to.equal(0);
  });

  it("leaves much less of the supply for the first buyer", async function () {
    const { presale, hoodsale, launcher, router, weth, dave } = await loadFixture(launchFixture);
    const supply = await hoodsale.totalSupply();
    await launcher.launch(presale.target, hoodsale.target, { value: E("5") });

    const path = [await router.WETH(), hoodsale.target];
    await router
      .connect(dave)
      .swapExactETHForTokens(0, path, dave.address, (await time.latest()) + 600, { value: E("1") });
    const got = await hoodsale.balanceOf(dave.address);
    // Without the opening buy a 1 ETH buy takes about 8.9% of the supply; with it, far less.
    expect((got * 10000n) / supply).to.be.lessThan(400n); // under 4%
  });

  it("cannot run twice, and cannot run outside the listing block", async function () {
    const { presale, hoodsale, launcher, deployer } = await loadFixture(launchFixture);
    await launcher.launch(presale.target, hoodsale.target, { value: E("5") });
    expect(await hoodsale.openingDone()).to.equal(true);

    await expect(hoodsale.openingBuyBurn({ value: E("1") })).to.be.revertedWith("opening done");
  });

  it("refuses before the pool exists", async function () {
    const { hoodsale } = await loadFixture(launchFixture);
    expect(await hoodsale.poolOpenedBlock()).to.equal(0);
    await expect(hoodsale.openingBuyBurn({ value: E("1") })).to.be.revertedWith("not the listing block");
  });

  it("refuses a later call, so nobody can spend into it after the launch block", async function () {
    const { presale, hoodsale, launcher } = await loadFixture(launchFixture);
    await launcher.launchOnly(presale.target);
    // The pool is open, but the listing block has passed.
    await expect(hoodsale.openingBuyBurn({ value: E("1") })).to.be.revertedWith("not the listing block");
  });

  it("does not stop a launch that skips it", async function () {
    const { presale, hoodsale, launcher, alice } = await loadFixture(launchFixture);
    await launcher.launchOnly(presale.target);
    expect(await presale.status()).to.equal(5);
    await presale.connect(alice).claim();
    expect(await hoodsale.balanceOf(alice.address)).to.be.greaterThan(0);
  });

  it("leaves the token tradeable in both directions afterwards", async function () {
    const { presale, hoodsale, launcher, router, dave } = await loadFixture(launchFixture);
    await launcher.launch(presale.target, hoodsale.target, { value: E("5") });

    const weth = await router.WETH();
    await router
      .connect(dave)
      .swapExactETHForTokens(0, [weth, hoodsale.target], dave.address, (await time.latest()) + 600, {
        value: E("0.5"),
      });
    const bought = await hoodsale.balanceOf(dave.address);
    expect(bought).to.be.greaterThan(0);

    await hoodsale.connect(dave).approve(router.target, bought);
    const ethBefore = await ethers.provider.getBalance(dave.address);
    await router
      .connect(dave)
      .swapExactTokensForETHSupportingFeeOnTransferTokens(bought, 0, [hoodsale.target, weth], dave.address, (await time.latest()) + 600);
    expect(await ethers.provider.getBalance(dave.address)).to.be.greaterThan(ethBefore - E("0.01"));
  });

  it("adds no owner powers: there is no setter for the cap, the window or the latch", async function () {
    const { hoodsale } = await loadFixture(launchFixture);
    const names = hoodsale.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    for (const forbidden of [
      "setOpeningCap",
      "setOpeningWindow",
      "setPoolOpenedBlock",
      "resetOpening",
      "sweep",
      "withdraw",
    ]) {
      expect(names).to.not.include(forbidden);
    }
  });
});
