const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

// The rehearsal token stands in for HOODS on a live chain: same code, another name and symbol,
// allowlisted by the platform owner for one sale.
describe("HOODS rehearsal token", function () {
  async function fixture() {
    const env = await deployPlatform();
    const { deployer, router, treasury, marketing, presaleFactory } = env;
    const token = await ethers.deployContract("HoodSaleRehearsalToken", [
      deployer.address, router.target, treasury.target, marketing.address,
    ]);
    await token.setPresaleFactory(presaleFactory.target);
    await presaleFactory.setTokenAllowed(token.target, true);
    return { ...env, token };
  }

  it("is HoodSaleToken under another name", async function () {
    const { token, hoodsale, deployer } = await loadFixture(fixture);
    expect(await token.name()).to.equal("HoodSale Rehearsal");
    expect(await token.symbol()).to.equal("HOODSR");
    expect(await token.TAX_BPS()).to.equal(await hoodsale.TAX_BPS());
    expect(await token.totalSupply()).to.equal(await hoodsale.totalSupply());
    expect(await token.balanceOf(deployer.address)).to.equal(await token.totalSupply());
    expect(await token.mainPair()).to.not.equal(await hoodsale.mainPair());
    for (const name of ["manualSwapBack", "setSwapEnabled"]) {
      expect(token.interface.hasFunction(name), name).to.equal(false);
    }
  });

  it("runs a sale like HOODS: factory exemption, launch at the listing price, claim, and leaves HOODS alone", async function () {
    const { token, hoodsale, presaleFactory, treasury, alice, bob, dexFactory, weth } = await loadFixture(fixture);
    const now = await time.latest();
    const params = {
      token: token.target,
      presaleRate: E(20000),
      listingRate: E(16000),
      softCap: E(0.005),
      hardCap: E(0.02),
      minContribution: E(0.001),
      maxContribution: E(0.01),
      startTime: now + 60,
      endTime: now + 600,
      liquidityBps: 6000,
      liquidityAction: 0,
      lockDuration: 30n * 24n * 3600n,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.createPresale(params, { value: await presaleFactory.creationFee() });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
    expect(await token.isExcludedFromFees(presale.target)).to.equal(true);

    await time.increaseTo(params.startTime);
    await presale.connect(alice).contribute({ value: E(0.01) });
    await presale.connect(bob).contribute({ value: E(0.01) });
    await presale.finalize(0, 0);
    await presale.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(E(0.01) * 20000n);

    // The pool opened at the listing price: 16000 tokens per ETH
    const pair = await ethers.getContractAt("IUniswapV2Pair", await dexFactory.getPair(token.target, weth.target));
    const [r0, r1] = await pair.getReserves();
    const [tokenRes, ethRes] = (await pair.token0()).toLowerCase() === token.target.toLowerCase() ? [r0, r1] : [r1, r0];
    expect(tokenRes / ethRes).to.equal(16000n);

    // HOODS itself has no pool and is still the buyback target
    const hoodPair = await ethers.getContractAt("IUniswapV2Pair", await hoodsale.mainPair());
    const [h0, h1] = await hoodPair.getReserves();
    expect(h0).to.equal(0n);
    expect(h1).to.equal(0n);
    expect(await treasury.hoodsale()).to.equal(hoodsale.target);
  });

  it("is refused for a sale once taken off the allowlist", async function () {
    const { token, presaleFactory } = await loadFixture(fixture);
    await presaleFactory.setTokenAllowed(token.target, false);
    const now = await time.latest();
    const params = {
      token: token.target, presaleRate: E(20000), listingRate: E(16000), softCap: E(0.005), hardCap: E(0.02),
      minContribution: E(0.001), maxContribution: E(0.01), startTime: now + 60, endTime: now + 600,
      liquidityBps: 6000, liquidityAction: 1, lockDuration: 0, launchTime: 0, whitelistEnabled: false,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await expect(presaleFactory.createPresale(params, { value: await presaleFactory.creationFee() })).to.be.revertedWith("not a platform token");
  });
});
