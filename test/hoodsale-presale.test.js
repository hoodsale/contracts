const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

// HOODSALE is the platform's own token and its presale runs through the same flow.
describe("HOODSALE presale", function () {
  async function hoodsaleSaleFixture() {
    const env = await deployPlatform();
    const { deployer, hoodsale, presaleFactory } = env;

    const now = await time.latest();
    const params = {
      token: hoodsale.target,
      presaleRate: E("20000"),
      listingRate: E("16000"),
      softCap: E("3"),
      hardCap: E("10"),
      minContribution: E("0.1"),
      maxContribution: E("5"),
      startTime: now + 100,
      endTime: now + 1000,
      liquidityBps: 7000,
      liquidityAction: 0, // Lock
      lockDuration: 365n * 24n * 3600n,
      launchTime: 0,
      whitelistEnabled: false,
    };
    const required = await presaleFactory.requiredTokensFor(params);
    await hoodsale.approve(presaleFactory.target, required);
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
    return { ...env, presale, params, required };
  }

  it("is allowlisted as a platform token without being a factory token", async function () {
    const { presaleFactory, tokenFactory, hoodsale } = await loadFixture(deployPlatform);
    expect(await tokenFactory.isPlatformToken(hoodsale.target)).to.equal(false);
    expect(await presaleFactory.allowedToken(hoodsale.target)).to.equal(true);
  });

  it("only the platform owner can allowlist a token", async function () {
    const { presaleFactory, alice, weth } = await loadFixture(deployPlatform);
    await expect(
      presaleFactory.connect(alice).setTokenAllowed(weth.target, true)
    ).to.be.revertedWithCustomError(presaleFactory, "OwnableUnauthorizedAccount");
    expect(await presaleFactory.allowedToken(weth.target)).to.equal(false);
  });

  it("still rejects tokens that are neither factory made nor allowlisted", async function () {
    const { presaleFactory, weth, deployer } = await loadFixture(deployPlatform);
    const now = await time.latest();
    const params = {
      token: weth.target,
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: E("2"),
      hardCap: E("8"),
      minContribution: E("0.5"),
      maxContribution: E("4"),
      startTime: now + 100,
      endTime: now + 1000,
      liquidityBps: 6000,
      liquidityAction: 1,
      lockDuration: 0,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await expect(
      presaleFactory.createPresale(params, { value: E("0.1") })
    ).to.be.revertedWith("not a platform token");
  });

  it("creates the sale, pulls the exact token amount and excludes the sale from tax", async function () {
    const { presale, hoodsale, required, treasury } = await loadFixture(hoodsaleSaleFixture);

    expect(await hoodsale.balanceOf(presale.target)).to.equal(required);
    expect(await hoodsale.isExcludedFromFees(presale.target)).to.equal(true);
    // The 0.1 ETH creation fee went to the treasury, 30% of it was earmarked for the buyback reserve
    expect(await ethers.provider.getBalance(treasury.target)).to.equal(E("0.1"));
    expect(await treasury.buybackReserve()).to.equal(E("0.03"));
  });

  it("runs the full lifecycle: contribute, finalize, claim and trade", async function () {
    const { presale, params, hoodsale, alice, bob, treasury, locker, deployer, dexFactory, weth } =
      await loadFixture(hoodsaleSaleFixture);

    await time.increaseTo(params.startTime);
    await presale.connect(alice).contribute({ value: E("4") });
    await presale.connect(bob).contribute({ value: E("2") });
    expect(await presale.totalRaised()).to.equal(E("6"));

    await time.increaseTo(params.endTime + 10);
    const treasuryBefore = await ethers.provider.getBalance(treasury.target);
    await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");

    // Platform share is 10% of the amount raised
    expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.equal(E("0.6"));

    // Liquidity was really added and the LP was locked for one year
    const pair = await dexFactory.getPair(hoodsale.target, weth.target);
    expect(await hoodsale.balanceOf(pair)).to.be.gt(0);
    const lock = await locker.locks(await presale.lpLockId());
    expect(lock.owner).to.equal(deployer.address);
    expect(lock.amount).to.equal(await presale.lpAmount());

    // Participants claim at the full rate, claims are tax-free
    await presale.connect(alice).claim();
    expect(await hoodsale.balanceOf(alice.address)).to.equal(E("80000")); // 4 ETH * 20000
    await presale.connect(bob).claim();
    expect(await hoodsale.balanceOf(bob.address)).to.equal(E("40000"));

    // After launch, a 3% tax applies on sells
    const sellAmount = E("10000");
    await hoodsale.connect(alice).approve(await presale.router(), sellAmount);
    const router = await ethers.getContractAt("MockRouter", await presale.router());
    await router
      .connect(alice)
      .swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount,
        0,
        [hoodsale.target, weth.target],
        alice.address,
        (await time.latest()) + 60
      );
    expect(await hoodsale.balanceOf(hoodsale.target)).to.be.gt(0); // tax accrued in the contract
  });

  it("refunds contributors in full when the soft cap is missed", async function () {
    const { presale, params, alice } = await loadFixture(hoodsaleSaleFixture);
    await time.increaseTo(params.startTime);
    await presale.connect(alice).contribute({ value: E("1") });
    await time.increaseTo(params.endTime + 10);

    expect(await presale.status()).to.equal(3); // Failed
    await expect(presale.connect(alice).claimRefund()).to.changeEtherBalances(
      [alice, presale],
      [E("1"), E("-1")]
    );
  });

  it("reports the HOODSALE sale through the lens like any other presale", async function () {
    const { lens, presale, hoodsale } = await loadFixture(hoodsaleSaleFixture);
    const v = await lens.presaleView(presale.target);
    expect(v.token).to.equal(hoodsale.target);
    expect(v.symbol).to.equal("HOODSALE");
    expect(v.softCap).to.equal(E("3"));
    expect(v.hardCap).to.equal(E("10"));
  });

  it("flags the HOODSALE sale as a non factory token while factory tokens stay flagged", async function () {
    const { lens, presale, params, tokenFactory, presaleFactory } =
      await loadFixture(hoodsaleSaleFixture);

    // HOODSALE is only allowlisted, so the factory has no record of it. The UI
    // relies on this flag to avoid labelling it with the factory's default type.
    expect((await lens.presaleView(presale.target)).factoryToken).to.equal(false);
    expect((await lens.launchView(presale.target)).factoryToken).to.equal(false);

    // A factory made token running the same sale reports true
    await tokenFactory.createStandardToken("Factory", "FACT", E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    const now = await time.latest();
    const factoryParams = { ...params, token: token.target, startTime: now + 100, endTime: now + 1000 };
    const required = await presaleFactory.requiredTokensFor(factoryParams);
    await token.approve(presaleFactory.target, required);
    await presaleFactory.createPresale(factoryParams, { value: E("0.1") });
    const factorySale = await presaleFactory.allPresales(1);

    expect((await lens.presaleView(factorySale)).factoryToken).to.equal(true);
    expect((await lens.launchView(factorySale)).factoryToken).to.equal(true);
  });
});
