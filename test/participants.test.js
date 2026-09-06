const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

// On-chain participation history: contributor list, per-wallet totals and the activity feed.
describe("Participants and activity", function () {
  async function saleFixture() {
    const env = await deployPlatform();
    const { tokenFactory, presaleFactory } = env;
    await tokenFactory.createStandardToken("Act", "ACT", E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    const now = await time.latest();
    const params = {
      token: token.target, presaleRate: E("1000"), listingRate: E("800"),
      softCap: E("2"), hardCap: E("8"), minContribution: E("0.5"), maxContribution: E("4"),
      startTime: now + 100, endTime: now + 1000, liquidityBps: 6000, liquidityAction: 1,
      lockDuration: 0, launchTime: 0, whitelistEnabled: false,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
    await time.increaseTo(params.startTime);
    return { ...env, token, presale, params };
  }

  it("records contributions, keeps contributors unique and tracks totals", async function () {
    const { presale, alice, bob } = await loadFixture(saleFixture);
    await presale.connect(alice).contribute({ value: E("1") });
    await presale.connect(bob).contribute({ value: E("2") });
    await presale.connect(alice).contribute({ value: E("0.5") });

    expect(await presale.contributorsLength()).to.equal(2);
    expect(await presale.getContributors(0, 10)).to.deep.equal([alice.address, bob.address]);
    expect(await presale.activityLength()).to.equal(3);

    const acts = await presale.getActivities(0, 10);
    expect(acts.map((a) => Number(a.kind))).to.deep.equal([0, 0, 0]);
    expect(acts[2].account).to.equal(alice.address);
    expect(acts[2].amount).to.equal(E("0.5"));
    expect(acts[2].timestamp).to.be.gt(0n);

    const st = await presale.statsOf(alice.address);
    expect(st.contributed).to.equal(E("1.5"));
    expect(st.joinedAt).to.be.gt(0n);
    // pagination
    expect((await presale.getActivities(1, 1)).length).to.equal(1);
    expect((await presale.getActivities(5, 10)).length).to.equal(0);
  });

  it("records exits, refunds and claims and the lens derives states and shares", async function () {
    const { presale, params, lens, alice, bob, carol, token } = await loadFixture(saleFixture);
    await presale.connect(alice).contribute({ value: E("3") });
    await presale.connect(bob).contribute({ value: E("1") });
    await presale.connect(carol).contribute({ value: E("1") });
    await presale.connect(carol).emergencyWithdraw(); // Exit: 10% penalty

    let [rows, total] = await lens.presaleParticipants(presale.target, 0, 10);
    expect(total).to.equal(3);
    expect(rows[0].account).to.equal(alice.address);
    expect(rows[0].shareBps).to.equal(7500n); // 3 / 4 ETH
    expect(rows[0].tokensDue).to.equal(E("3000"));
    expect(rows[0].state).to.equal(0); // Active
    expect(rows[2].account).to.equal(carol.address);
    expect(rows[2].state).to.equal(1); // Exited
    expect(rows[2].contribution).to.equal(0n);
    expect(rows[2].exited).to.equal(E("1"));

    await time.increaseTo(params.endTime + 10);
    await presale.finalize(0, 0);
    await presale.connect(alice).claim();
    [rows] = await lens.presaleParticipants(presale.target, 0, 10);
    expect(rows[0].state).to.equal(3); // Claimed
    expect(rows[0].claimedTokens).to.equal(E("3000"));
    expect(await token.balanceOf(alice.address)).to.equal(E("3000"));

    const [acts, actTotal] = await lens.presaleActivity(presale.target, 0, 10);
    expect(actTotal).to.equal(5);
    expect(acts.map((a) => Number(a.kind))).to.deep.equal([0, 0, 0, 1, 3]);
    expect(acts[3].amount).to.equal(E("0.9")); // carol's net refund
    expect(acts[4].amount).to.equal(E("3000"));
    // pagination: the last two records
    const [tail] = await lens.presaleActivity(presale.target, 3, 10);
    expect(tail.length).to.equal(2);
  });

  it("marks refunded participants after a cancel", async function () {
    const { presale, lens, alice } = await loadFixture(saleFixture);
    await presale.connect(alice).contribute({ value: E("1") });
    await presale.cancel();
    await presale.connect(alice).claimRefund();
    const [rows] = await lens.presaleParticipants(presale.target, 0, 10);
    expect(rows[0].state).to.equal(2); // Refunded
    expect(rows[0].refunded).to.equal(E("1"));
    expect(rows[0].shareBps).to.equal(0n);
    const [acts] = await lens.presaleActivity(presale.target, 0, 10);
    expect(acts.map((a) => Number(a.kind))).to.deep.equal([0, 2]);
  });
});
