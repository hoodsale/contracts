const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

describe("Tokenomics registry", function () {
  async function fx() {
    const env = await deployPlatform();
    await env.tokenFactory.createStandardToken("Tok", "TOK", E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await env.tokenFactory.allTokens(0));
    return { ...env, token };
  }
  const plan = [
    { label: "Presale", bps: 4000, note: "" },
    { label: "Liquidity", bps: 2500, note: "Locked 180 days" },
    { label: "Team", bps: 1500, note: "12 month vesting" },
    { label: "Marketing", bps: 1000, note: "" },
    { label: "Treasury", bps: 1000, note: "" },
  ];

  it("stores a plan that sums to 100% and reads it back", async function () {
    const { metadataRegistry, token, deployer } = await loadFixture(fx);
    expect(await metadataRegistry.hasTokenomics(token.target)).to.equal(false);
    await expect(metadataRegistry.setTokenomics(token.target, plan))
      .to.emit(metadataRegistry, "TokenomicsUpdated").withArgs(token.target, deployer.address, 5);
    const got = await metadataRegistry.tokenomicsOf(token.target);
    expect(got.length).to.equal(5);
    expect(got[2].label).to.equal("Team");
    expect(got[2].bps).to.equal(1500);
    expect(got[2].note).to.equal("12 month vesting");
    expect(await metadataRegistry.hasTokenomics(token.target)).to.equal(true);
  });

  it("rejects plans that do not sum to 100%, empty labels, zero slices and too many slices", async function () {
    const { metadataRegistry, token } = await loadFixture(fx);
    const bad = [...plan]; bad[0] = { ...bad[0], bps: 3999 };
    await expect(metadataRegistry.setTokenomics(token.target, bad)).to.be.revertedWithCustomError(metadataRegistry, "BadAllocation");
    await expect(metadataRegistry.setTokenomics(token.target, [{ label: "", bps: 10000, note: "" }])).to.be.revertedWithCustomError(metadataRegistry, "BadAllocation");
    await expect(metadataRegistry.setTokenomics(token.target, [{ label: "All", bps: 10000, note: "" }, { label: "Zero", bps: 0, note: "" }])).to.be.revertedWithCustomError(metadataRegistry, "BadAllocation");
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `S${i}`, bps: i === 0 ? 10000 - 12 * 1 : 1, note: "" }));
    await expect(metadataRegistry.setTokenomics(token.target, many)).to.be.revertedWithCustomError(metadataRegistry, "BadAllocation");
    await expect(metadataRegistry.setTokenomics(token.target, [{ label: "x".repeat(33), bps: 10000, note: "" }])).to.be.revertedWithCustomError(metadataRegistry, "TooLong");
  });

  it("only the token owner can write, and only for eligible tokens", async function () {
    const { metadataRegistry, token, alice, weth, hoodsale } = await loadFixture(fx);
    await expect(metadataRegistry.connect(alice).setTokenomics(token.target, plan)).to.be.revertedWithCustomError(metadataRegistry, "NotTokenOwner");
    await expect(metadataRegistry.setTokenomics(weth.target, plan)).to.be.revertedWithCustomError(metadataRegistry, "NotPlatformToken");
    // HOODSALE is on the allowlist and its owner is the deployer
    await expect(metadataRegistry.setTokenomics(hoodsale.target, plan)).to.emit(metadataRegistry, "TokenomicsUpdated");
  });

  it("replaces an existing plan and clears it with an empty array", async function () {
    const { metadataRegistry, token } = await loadFixture(fx);
    await metadataRegistry.setTokenomics(token.target, plan);
    await metadataRegistry.setTokenomics(token.target, [{ label: "Fair launch", bps: 10000, note: "" }]);
    expect((await metadataRegistry.tokenomicsOf(token.target)).length).to.equal(1);
    await metadataRegistry.setTokenomics(token.target, []);
    expect(await metadataRegistry.hasTokenomics(token.target)).to.equal(false);
  });
});
