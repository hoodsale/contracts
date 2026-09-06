const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

// Finalize window: if the sale is not finalized within 14 days after it ends,
// participants can claim a full refund even when the soft cap was met.
describe("Presale finalize grace period", function () {
  async function presaleFixture() {
    const env = await deployPlatform();
    const { deployer, alice, bob, tokenFactory, presaleFactory } = env;

    await tokenFactory.createStandardToken("Grace", "GRC", ethers.parseEther("1000000"));
    const tokenAddr = await tokenFactory.allTokens(0);
    const token = await ethers.getContractAt("StandardToken", tokenAddr);

    const now = await time.latest();
    const params = {
      token: tokenAddr,
      presaleRate: ethers.parseEther("1000"),
      listingRate: ethers.parseEther("800"),
      softCap: ethers.parseEther("2"),
      hardCap: ethers.parseEther("8"),
      minContribution: ethers.parseEther("0.5"),
      maxContribution: ethers.parseEther("4"),
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
    await presaleFactory.createPresale(params, { value: ethers.parseEther("0.1") });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));

    await time.increaseTo(now + 100);
    await presale.connect(alice).contribute({ value: ethers.parseEther("2") });
    await presale.connect(bob).contribute({ value: ethers.parseEther("1") });
    return { ...env, token, presale, params };
  }

  const GRACE = 14 * 24 * 3600;

  it("allows finalize within the grace window", async function () {
    const { presale, params } = await loadFixture(presaleFixture);
    await time.increaseTo(params.endTime + GRACE - 60);
    await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
  });

  it("blocks finalize after the grace window", async function () {
    const { presale, params } = await loadFixture(presaleFixture);
    await time.increaseTo(params.endTime + GRACE + 1);
    await expect(presale.finalize(0, 0)).to.be.revertedWith("finalize window passed");
  });

  it("blocks refunds during the window while softcap is met, then allows full refunds after it", async function () {
    const { presale, params, alice, bob } = await loadFixture(presaleFixture);

    await time.increaseTo(params.endTime + 10);
    expect(await presale.status()).to.equal(2); // Ended (waiting for finalize)
    await expect(presale.connect(alice).claimRefund()).to.be.revertedWith("refund not available");

    await time.increaseTo(params.endTime + GRACE + 1);
    expect(await presale.status()).to.equal(3); // Failed

    await expect(presale.connect(alice).claimRefund()).to.changeEtherBalances(
      [alice, presale],
      [ethers.parseEther("2"), ethers.parseEther("-2")]
    );
    await expect(presale.connect(bob).claimRefund()).to.changeEtherBalances(
      [bob, presale],
      [ethers.parseEther("1"), ethers.parseEther("-1")]
    );
    await expect(presale.connect(alice).claimRefund()).to.be.revertedWith("nothing to refund");
  });

  it("owner can still cancel after the window to recover tokens", async function () {
    const { presale, params, token, deployer } = await loadFixture(presaleFixture);
    await time.increaseTo(params.endTime + GRACE + 1);
    const balBefore = await token.balanceOf(deployer.address);
    await expect(presale.cancel()).to.emit(presale, "Cancelled");
    expect(await token.balanceOf(deployer.address)).to.be.gt(balBefore);
  });
});
