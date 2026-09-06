const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatform } = require("./helpers");

// Profile records: factory tokens and the platform tokens on the PresaleFactory
// allowlist (HOODSALE) are eligible; no other token is.
describe("TokenMetadataRegistry allowlist", function () {
  const sample = {
    logoURI: "ipfs://logo",
    bannerURI: "",
    description: "The platform token.",
    website: "https://hoodsale.example",
    twitter: "hoodsale",
    telegram: "",
    discord: "",
    updatedAt: 0,
  };

  it("treats the allowlisted HOODSALE token as eligible", async function () {
    const { metadataRegistry, hoodsale, weth, presaleFactory } = await loadFixture(deployPlatform);
    expect(await metadataRegistry.presaleFactory()).to.equal(presaleFactory.target);
    expect(await metadataRegistry.isEligible(hoodsale.target)).to.equal(true);
    expect(await metadataRegistry.isEligible(weth.target)).to.equal(false);
  });

  it("lets the HOODSALE owner write its profile and nobody else", async function () {
    const { metadataRegistry, hoodsale, alice, deployer } = await loadFixture(deployPlatform);
    await expect(
      metadataRegistry.connect(alice).setMetadata(hoodsale.target, sample)
    ).to.be.revertedWithCustomError(metadataRegistry, "NotEditor");
    await expect(metadataRegistry.setMetadata(hoodsale.target, sample))
      .to.emit(metadataRegistry, "MetadataUpdated")
      .withArgs(hoodsale.target, deployer.address);
    expect((await metadataRegistry.metadataOf(hoodsale.target)).description).to.equal(sample.description);
    expect(await metadataRegistry.hasMetadata(hoodsale.target)).to.equal(true);
  });

  it("still rejects tokens outside the platform", async function () {
    const { metadataRegistry, weth } = await loadFixture(deployPlatform);
    await expect(metadataRegistry.setMetadata(weth.target, sample)).to.be.revertedWithCustomError(
      metadataRegistry, "NotPlatformToken"
    );
  });

  it("only the platform owner can point the registry at the presale factory", async function () {
    const { metadataRegistry, alice, presaleFactory } = await loadFixture(deployPlatform);
    await expect(
      metadataRegistry.connect(alice).setPresaleFactory(presaleFactory.target)
    ).to.be.revertedWithCustomError(metadataRegistry, "NotPlatformOwner");
    await expect(metadataRegistry.setPresaleFactory(presaleFactory.target))
      .to.emit(metadataRegistry, "PresaleFactorySet")
      .withArgs(presaleFactory.target);
  });
});
