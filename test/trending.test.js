const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;

// Trending signals: ETH raised in the last 24 hours, exits and new wallets.
describe("Momentum views for trending", function () {
  async function saleFixture() {
    const env = await deployPlatform();
    const { tokenFactory, presaleFactory } = env;
    await tokenFactory.createStandardToken("Trend", "TRND", E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    const now = await time.latest();
    const params = {
      token: token.target, presaleRate: E("1000"), listingRate: E("800"),
      softCap: E("2"), hardCap: E("8"), minContribution: E("0.5"), maxContribution: E("4"),
      startTime: now + 100, endTime: now + 10 * DAY, liquidityBps: 6000, liquidityAction: 1,
      lockDuration: 0, launchTime: 0, whitelistEnabled: false,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
    await time.increaseTo(params.startTime);
    return { ...env, token, presale, params };
  }

  it("separates old activity from activity since the cutoff", async function () {
    const { presale, lens, alice, bob, carol } = await loadFixture(saleFixture);
    await presale.connect(alice).contribute({ value: E("1") });
    await presale.connect(bob).contribute({ value: E("1") });
    await time.increase(2 * DAY);
    await presale.connect(carol).contribute({ value: E("2") }); // new wallet
    await presale.connect(alice).contribute({ value: E("0.5") }); // existing wallet, new contribution
    await presale.connect(bob).emergencyWithdraw(); // 0.9 net refund

    const since = (await time.latest()) - DAY;
    const m = await lens.presaleMomentum(presale.target, since);
    expect(m.symbol).to.equal("TRND");
    expect(m.totalRaised).to.equal(E("3.5"));
    expect(m.contributorCount).to.equal(2);
    expect(m.raisedSince).to.equal(E("2.5"));
    expect(m.exitedSince).to.equal(E("0.9"));
    expect(m.newWalletsSince).to.equal(1);
    expect(m.activitySince).to.equal(3);
    expect(m.priceAvailable).to.equal(false);

    // since = 0 counts everything
    const all = await lens.presaleMomentum(presale.target, 0);
    expect(all.raisedSince).to.equal(E("4.5"));
    expect(all.newWalletsSince).to.equal(3);
    expect(all.activitySince).to.equal(5);
  });

  it("reports the launch multiplier for finalized sales and pages across sales", async function () {
    const { presale, params, lens, alice, bob, tokenFactory, presaleFactory } = await loadFixture(saleFixture);
    await presale.connect(alice).contribute({ value: E("3") });
    await presale.connect(bob).contribute({ value: E("2") });
    await time.increaseTo(params.endTime + 10);
    await presale.finalize(0, 0);

    // a second sale (empty, upcoming)
    await tokenFactory.createStandardToken("Second", "SEC", E("1000000"));
    const t2 = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(1));
    const now = await time.latest();
    const p2 = { ...params, token: t2.target, startTime: now + 500, endTime: now + 5 * DAY };
    await t2.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(p2));
    await presaleFactory.createPresale(p2, { value: E("0.1") });

    const [list, total] = await lens.momentumViews(0, 10, 0);
    expect(total).to.equal(2);
    expect(list.length).to.equal(2);
    expect(list[0].status).to.equal(5); // Finalized
    expect(list[0].priceAvailable).to.equal(true);
    expect(list[0].multiplierX18).to.be.closeTo(E("1"), E("0.001")); // 1x at listing time
    expect(list[1].status).to.equal(0); // Upcoming
    expect(list[1].raisedSince).to.equal(0n);
    expect(list[1].startTime).to.equal(p2.startTime);

    const [page] = await lens.momentumViews(1, 10, 0);
    expect(page.length).to.equal(1);
    const [empty] = await lens.momentumViews(5, 10, 0);
    expect(empty.length).to.equal(0);
  });

  it("walks back across more than one chunk of activity", async function () {
    const { presale, lens, alice } = await loadFixture(saleFixture);
    // 60 small contributions: exceeds the 50-entry chunk limit (max 4 ETH per wallet: 60 x 0.05 = 3 ETH)
    // since the min contribution is 0.5, the first contribution is 0.5 and the rest are 0.05
    await presale.connect(alice).contribute({ value: E("0.5") });
    for (let i = 0; i < 59; i++) await presale.connect(alice).contribute({ value: E("0.05") });
    const m = await lens.presaleMomentum(presale.target, 0);
    expect(m.activitySince).to.equal(60);
    expect(m.raisedSince).to.equal(E("0.5") + E("0.05") * 59n);
    expect(m.newWalletsSince).to.equal(1);
  });
});
