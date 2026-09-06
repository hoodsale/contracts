const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

describe("TokenMetadataRegistry", function () {
  async function metaFixture() {
    const env = await deployPlatform();
    await env.tokenFactory.createStandardToken("Meta", "META", E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await env.tokenFactory.allTokens(0));
    return { ...env, token };
  }

  const sample = {
    logoURI: "ipfs://bafylogo",
    bannerURI: "ipfs://bafybanner",
    description: "A community token launched on HoodSale.",
    website: "https://meta.example",
    twitter: "https://x.com/metatoken",
    telegram: "https://t.me/metatoken",
    discord: "",
    updatedAt: 0,
  };

  it("stores metadata written by the token owner", async function () {
    const { metadataRegistry, token, deployer } = await loadFixture(metaFixture);

    expect(await metadataRegistry.hasMetadata(token.target)).to.equal(false);
    await expect(metadataRegistry.setMetadata(token.target, sample))
      .to.emit(metadataRegistry, "MetadataUpdated")
      .withArgs(token.target, deployer.address);

    const m = await metadataRegistry.metadataOf(token.target);
    expect(m.logoURI).to.equal(sample.logoURI);
    expect(m.bannerURI).to.equal(sample.bannerURI);
    expect(m.description).to.equal(sample.description);
    expect(m.website).to.equal(sample.website);
    expect(m.twitter).to.equal(sample.twitter);
    expect(m.telegram).to.equal(sample.telegram);
    expect(m.updatedAt).to.be.gt(0);
    expect(await metadataRegistry.hasMetadata(token.target)).to.equal(true);
  });

  it("rejects writers that are not the token's editor", async function () {
    const { metadataRegistry, token, alice } = await loadFixture(metaFixture);
    expect(await metadataRegistry.canEdit(token.target, alice.address)).to.equal(false);
    await expect(
      metadataRegistry.connect(alice).setMetadata(token.target, sample)
    ).to.be.revertedWithCustomError(metadataRegistry, "NotEditor");
  });

  it("rejects tokens that did not come from the platform factory", async function () {
    const { metadataRegistry, weth } = await loadFixture(metaFixture);
    await expect(
      metadataRegistry.setMetadata(weth.target, sample)
    ).to.be.revertedWithCustomError(metadataRegistry, "NotPlatformToken");
  });

  it("caps description and uri lengths", async function () {
    const { metadataRegistry, token } = await loadFixture(metaFixture);
    await expect(
      metadataRegistry.setMetadata(token.target, { ...sample, description: "x".repeat(2001) })
    ).to.be.revertedWithCustomError(metadataRegistry, "TooLong");
    await expect(
      metadataRegistry.setMetadata(token.target, { ...sample, website: "y".repeat(401) })
    ).to.be.revertedWithCustomError(metadataRegistry, "TooLong");
  });

  it("lets the owner overwrite existing metadata", async function () {
    const { metadataRegistry, token } = await loadFixture(metaFixture);
    await metadataRegistry.setMetadata(token.target, sample);
    await metadataRegistry.setMetadata(token.target, { ...sample, description: "Updated copy." });
    expect((await metadataRegistry.metadataOf(token.target)).description).to.equal("Updated copy.");
  });
});

describe("HoodSaleLens", function () {
  async function saleFixture() {
    const env = await deployPlatform();
    const { deployer, tokenFactory, presaleFactory } = env;

    await tokenFactory.createStandardToken("Lens", "LENS", E("1000000"));
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
      liquidityAction: 0, // Lock
      lockDuration: 30n * 24n * 3600n,
      launchTime: 0,
      whitelistEnabled: false,
    };
    const required = await presaleFactory.requiredTokensFor(params);
    await token.approve(presaleFactory.target, required);
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
    return { ...env, token, presale, params };
  }

  it("returns a full presale view in one call", async function () {
    const { lens, presale, token, deployer, params } = await loadFixture(saleFixture);
    const v = await lens.presaleView(presale.target);

    expect(v.presale).to.equal(presale.target);
    expect(v.token).to.equal(token.target);
    expect(v.name).to.equal("Lens");
    expect(v.symbol).to.equal("LENS");
    expect(v.tokenType).to.equal(0); // Standard
    expect(v.saleOwner).to.equal(deployer.address);
    expect(v.status).to.equal(0); // Upcoming
    expect(v.softCap).to.equal(params.softCap);
    expect(v.hardCap).to.equal(params.hardCap);
    expect(v.presaleRate).to.equal(params.presaleRate);
    expect(v.listingRate).to.equal(params.listingRate);
    expect(v.liquidityBps).to.equal(params.liquidityBps);
    expect(v.liquidityAction).to.equal(0);
    expect(v.lockDuration).to.equal(params.lockDuration);
  });

  it("pages presale views and filters by status", async function () {
    const { lens, presale, params, alice } = await loadFixture(saleFixture);

    let [list, total] = await lens.presaleViews(0, 10, 255);
    expect(total).to.equal(1);
    expect(list.length).to.equal(1);

    // The Upcoming filter matches, the Live filter does not match yet
    [list] = await lens.presaleViews(0, 10, 0);
    expect(list.length).to.equal(1);
    [list] = await lens.presaleViews(0, 10, 1);
    expect(list.length).to.equal(0);

    await time.increaseTo(params.startTime);
    await presale.connect(alice).contribute({ value: E("1") });
    [list] = await lens.presaleViews(0, 10, 1); // Live
    expect(list.length).to.equal(1);
    expect(list[0].totalRaised).to.equal(E("1"));
    expect(list[0].contributorCount).to.equal(1);

    [list, total] = await lens.presaleViews(5, 10, 255);
    expect(list.length).to.equal(0);
    expect(total).to.equal(1);
  });

  it("reports launch performance after finalize", async function () {
    const { lens, presale, params, token, alice, bob, router, weth } = await loadFixture(saleFixture);

    await time.increaseTo(params.startTime);
    await presale.connect(alice).contribute({ value: E("3") });
    await presale.connect(bob).contribute({ value: E("2") });
    await time.increaseTo(params.endTime + 10);
    await presale.finalize(0, 0);

    const [list, totalFinalized] = await lens.launchViews(0, 10);
    expect(totalFinalized).to.equal(1);
    expect(list.length).to.equal(1);

    const v = list[0];
    expect(v.token).to.equal(token.target);
    expect(v.symbol).to.equal("LENS");
    expect(v.lpBurned).to.equal(false);
    expect(v.priceAvailable).to.equal(true);
    expect(v.totalRaised).to.equal(E("5"));
    expect(v.finalizedAt).to.be.gt(0);

    // listingRate 800 token = 1 ETH  =>  1 token = 1.25e15 wei
    expect(v.listingPriceWei).to.equal(E("1") / 800n);
    // At listing time the multiplier should be exactly 1x (within rounding tolerance)
    expect(v.multiplierX18).to.be.closeTo(E("1"), E("0.001"));

    // A buy pushes the price up: the multiplier rises above 1x
    await router.connect(alice).swapExactETHForTokens(
      0,
      [weth.target, token.target],
      alice.address,
      (await time.latest()) + 60,
      { value: E("1") }
    );
    const after = await lens.launchView(presale.target);
    expect(after.multiplierX18).to.be.gt(v.multiplierX18);
    expect(after.currentPriceWei).to.be.gt(v.currentPriceWei);
  });

  it("excludes presales that are not finalized from launch views", async function () {
    const { lens } = await loadFixture(saleFixture);
    const [list, totalFinalized] = await lens.launchViews(0, 10);
    expect(list.length).to.equal(0);
    expect(totalFinalized).to.equal(0);
  });

  it("reports token price and burned supply", async function () {
    const { lens, presale, params, token, alice } = await loadFixture(saleFixture);

    // Without liquidity the price is zero
    let [priceWei, rToken, rWeth] = await lens.tokenPrice(token.target);
    expect(priceWei).to.equal(0);
    expect(rToken).to.equal(0);
    expect(rWeth).to.equal(0);

    await time.increaseTo(params.startTime);
    await presale.connect(alice).contribute({ value: E("3") });
    await time.increaseTo(params.endTime + 10);
    await presale.finalize(0, 0);

    [priceWei, rToken, rWeth] = await lens.tokenPrice(token.target);
    expect(priceWei).to.be.gt(0);
    expect(rToken).to.be.gt(0);
    expect(rWeth).to.be.gt(0);

    expect(await lens.burnedSupply(token.target)).to.equal(0);
    await token.transfer("0x000000000000000000000000000000000000dEaD", E("100"));
    expect(await lens.burnedSupply(token.target)).to.equal(E("100"));
  });

  it("marks burned liquidity in the launch view", async function () {
    const env = await loadFixture(deployPlatform);
    const { tokenFactory, presaleFactory, lens, alice } = env;

    await tokenFactory.createStandardToken("Burnt", "BRN", E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));

    const now = await time.latest();
    const params = {
      token: token.target,
      presaleRate: E("1000"),
      listingRate: E("500"),
      softCap: E("2"),
      hardCap: E("8"),
      minContribution: E("0.5"),
      maxContribution: E("4"),
      startTime: now + 100,
      endTime: now + 1000,
      liquidityBps: 7000,
      liquidityAction: 1, // Burn
      lockDuration: 0,
      launchTime: 0,
      whitelistEnabled: false,
    };
    const required = await presaleFactory.requiredTokensFor(params);
    await token.approve(presaleFactory.target, required);
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));

    await time.increaseTo(params.startTime);
    await presale.connect(alice).contribute({ value: E("4") });
    await time.increaseTo(params.endTime + 10);
    await presale.finalize(0, 0);

    const v = await lens.launchView(presale.target);
    expect(v.lpBurned).to.equal(true);
    expect(v.listingPriceWei).to.equal(E("1") / 500n);
    expect(v.priceAvailable).to.equal(true);
  });
});
