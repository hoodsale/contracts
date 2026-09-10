const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

// A plain ETH transfer to a sale is a contribution on exactly the terms contribute() applies.
// Anything that would not pass there reverts here too, so the sender keeps the money instead of
// losing it to a contract that used to record nothing.
describe("Plain ETH transfer to a presale", function () {
  async function makeSale(env, overrides = {}) {
    const { tokenFactory, presaleFactory, deployer } = env;
    const idx = Number(await tokenFactory.allTokensLength());
    await tokenFactory.createStandardToken(`P${idx}`, `P${idx}`, E(1_000_000));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(idx));
    const now = await time.latest();
    const params = {
      token: token.target,
      presaleRate: E(1000),
      listingRate: E(800),
      softCap: E(2),
      hardCap: E(8),
      minContribution: E(0.5),
      maxContribution: E(4),
      startTime: now + 100,
      endTime: now + 1000,
      liquidityBps: 6000,
      liquidityAction: 1, // burn
      lockDuration: 0,
      launchTime: 0,
      whitelistEnabled: false,
      ...overrides,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(deployer).createPresale(params, { value: await presaleFactory.creationFee() });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    return { presale, params, token };
  }

  const send = (signer, to, value) => signer.sendTransaction({ to, value });

  // ---------------------------------------------------------------- accepted

  it("records a valid transfer as a contribution, exactly like contribute()", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);

    await expect(send(env.alice, presale.target, E(1)))
      .to.emit(presale, "Contributed")
      .withArgs(env.alice.address, E(1), E(1));

    expect(await presale.contributionOf(env.alice.address)).to.equal(E(1));
    expect(await presale.totalRaised()).to.equal(E(1));
    expect(await presale.contributorCount()).to.equal(1n);
    const st = await presale.statsOf(env.alice.address);
    expect(st.contributed).to.equal(E(1));
    expect(st.joinedAt).to.be.greaterThan(0n);
    // the wallet is on the participant list, so distribute() reaches it
    expect(await presale.contributorsLength()).to.equal(1n);
    expect(await presale.getContributors(0, 10)).to.deep.equal([env.alice.address]);
  });

  it("adds to an existing contribution", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await presale.connect(env.alice).contribute({ value: E(1) });
    await send(env.alice, presale.target, E(1));
    expect(await presale.contributionOf(env.alice.address)).to.equal(E(2));
    expect(await presale.contributorCount()).to.equal(1n);
  });

  it("lets the tokens be claimed after launch", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params, token } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await send(env.alice, presale.target, E(3));
    await time.increaseTo(Number(params.endTime) + 1);
    await presale.finalize(0, 0);
    await presale.connect(env.alice).claim();
    expect(await token.balanceOf(env.alice.address)).to.equal(E(3) * 1000n);
  });

  // ---------------------------------------------------------------- rejected

  it("reverts before the sale starts", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale } = await makeSale(env);
    await expect(send(env.alice, presale.target, E(1))).to.be.revertedWith("not started");
  });

  it("reverts after the sale has ended", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(Number(params.endTime) + 1);
    await expect(send(env.alice, presale.target, E(1))).to.be.revertedWith("ended");
  });

  it("reverts on a cancelled sale", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await presale.cancel();
    await expect(send(env.alice, presale.target, E(1))).to.be.revertedWith("not active");
  });

  it("reverts on a launched sale", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await presale.connect(env.alice).contribute({ value: E(3) });
    await time.increaseTo(Number(params.endTime) + 1);
    await presale.finalize(0, 0);
    await expect(send(env.bob, presale.target, E(1))).to.be.revertedWith("not active");
  });

  it("reverts for a wallet that is not on the whitelist", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env, { whitelistEnabled: true });
    await presale.addToWhitelist([env.alice.address]);
    await time.increaseTo(params.startTime);
    await expect(send(env.bob, presale.target, E(1))).to.be.revertedWith("not whitelisted");
    await expect(send(env.alice, presale.target, E(1))).to.emit(presale, "Contributed");
  });

  it("reverts below the per wallet minimum", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await expect(send(env.alice, presale.target, E(0.1))).to.be.revertedWith("below min");
  });

  it("reverts above the per wallet maximum, in one go and cumulatively", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await expect(send(env.alice, presale.target, E(5))).to.be.revertedWith("above max");
    await send(env.alice, presale.target, E(3));
    await expect(send(env.alice, presale.target, E(2))).to.be.revertedWith("above max");
  });

  it("reverts when the hard cap would be exceeded, and once it is full", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env, { maxContribution: E(4), hardCap: E(8) });
    await time.increaseTo(params.startTime);
    await send(env.alice, presale.target, E(4));
    await send(env.bob, presale.target, E(4));
    expect(await presale.totalRaised()).to.equal(E(8));
    await expect(send(env.carol, presale.target, E(1))).to.be.revertedWith("hardcap exceeded");
    await expect(send(env.carol, presale.target, E(0.5))).to.be.revertedWith("hardcap exceeded");
  });

  it("reverts on a zero value transfer", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await expect(send(env.alice, presale.target, 0n)).to.be.revertedWith("zero value");
  });

  it("leaves the sender's ETH untouched when it reverts", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale } = await makeSale(env);
    const before = await ethers.provider.getBalance(env.alice.address);
    await expect(send(env.alice, presale.target, E(1))).to.be.reverted;
    const after = await ethers.provider.getBalance(env.alice.address);
    // only gas is gone; the ETH never left
    expect(before - after).to.be.lessThan(E(0.01));
    expect(await ethers.provider.getBalance(presale.target)).to.equal(0n);
  });

  // ------------------------------------------------------- the router refund

  it("still launches: the router's leftover refund is accepted, not treated as a contribution", async function () {
    const env = await loadFixture(deployPlatform);
    // liquidityAction Lock exercises the router path that can refund ETH
    const { presale, params } = await makeSale(env, {
      liquidityAction: 0,
      lockDuration: 30 * 24 * 3600,
    });
    await time.increaseTo(params.startTime);
    await presale.connect(env.alice).contribute({ value: E(3) });
    await time.increaseTo(Number(params.endTime) + 1);
    await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
    expect(Number(await presale.status())).to.equal(5);
    // the refund did not become somebody's contribution
    expect(await presale.contributorCount()).to.equal(1n);
    expect(await presale.totalRaised()).to.equal(E(3));
  });

  it("launches a sale that filled its hard cap through plain transfers", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params, token } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await send(env.alice, presale.target, E(4));
    await send(env.bob, presale.target, E(4));
    await time.increaseTo(Number(params.endTime) + 1);
    await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
    await presale.distribute(10);
    expect(await token.balanceOf(env.alice.address)).to.equal(E(4) * 1000n);
    expect(await token.balanceOf(env.bob.address)).to.equal(E(4) * 1000n);
  });

  // ----------------------------------------------------------- refund path

  it("refunds a plain transfer when the sale fails its soft cap", async function () {
    const env = await loadFixture(deployPlatform);
    const { presale, params } = await makeSale(env);
    await time.increaseTo(params.startTime);
    await send(env.alice, presale.target, E(1));
    await time.increaseTo(Number(params.endTime) + 1);
    expect(Number(await presale.status())).to.equal(3); // Failed
    await expect(presale.connect(env.alice).claimRefund()).to.changeEtherBalance(env.alice, E(1));
  });
});
