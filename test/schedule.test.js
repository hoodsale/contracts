const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;

// The schedule can only be changed before the sale starts, and only by the owner.
describe("Presale schedule updates", function () {
  async function upcomingFixture() {
    const env = await deployPlatform();
    const { tokenFactory, presaleFactory } = env;
    await tokenFactory.createStandardToken("Sched", "SCHD", E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    const now = await time.latest();
    const params = {
      token: token.target, presaleRate: E("1000"), listingRate: E("800"),
      softCap: E("2"), hardCap: E("8"), minContribution: E("0.5"), maxContribution: E("4"),
      startTime: now + DAY, endTime: now + 3 * DAY, liquidityBps: 6000, liquidityAction: 1,
      lockDuration: 0, launchTime: 0, whitelistEnabled: false,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
    return { ...env, token, presale, params };
  }

  it("lets the owner move the dates before the sale starts and the lens reflects it", async function () {
    const { presale, lens, alice } = await loadFixture(upcomingFixture);
    const now = await time.latest();
    const start = now + 2 * DAY, end = now + 5 * DAY;
    await expect(presale.updateSchedule(start, end, 0))
      .to.emit(presale, "ScheduleUpdated").withArgs(start, end, 0);
    const p = await presale.getParams();
    expect(p.startTime).to.equal(start);
    expect(p.endTime).to.equal(end);
    const v = await lens.presaleView(presale.target);
    expect(v.startTime).to.equal(start);
    expect(v.endTime).to.equal(end);

    // no contributions before the new start, allowed after it
    await time.increaseTo(start - 10);
    await expect(presale.connect(alice).contribute({ value: E("1") })).to.be.revertedWith("not started");
    await time.increaseTo(start);
    await expect(presale.connect(alice).contribute({ value: E("1") })).to.emit(presale, "Contributed");
  });

  it("can set or clear a launch time within the finalize window", async function () {
    const { presale } = await loadFixture(upcomingFixture);
    const now = await time.latest();
    const start = now + DAY, end = now + 2 * DAY;
    await presale.updateSchedule(start, end, end + 3 * DAY);
    expect((await presale.getParams()).launchTime).to.equal(end + 3 * DAY);
    await presale.updateSchedule(start, end, 0);
    expect((await presale.getParams()).launchTime).to.equal(0);
    await expect(presale.updateSchedule(start, end, end - 1)).to.be.revertedWith("launch before end");
    await expect(presale.updateSchedule(start, end, end + 15 * DAY)).to.be.revertedWith("launch after window");
  });

  it("validates the new dates", async function () {
    const { presale } = await loadFixture(upcomingFixture);
    const now = await time.latest();
    await expect(presale.updateSchedule(now - 10, now + DAY, 0)).to.be.revertedWith("start in past");
    await expect(presale.updateSchedule(now + DAY, now + DAY, 0)).to.be.revertedWith("bad times");
    await expect(presale.updateSchedule(now + DAY, now + DAY + 91 * DAY, 0)).to.be.revertedWith("sale too long");
  });

  it("rejects anyone but the sale owner", async function () {
    const { presale, alice } = await loadFixture(upcomingFixture);
    const now = await time.latest();
    await expect(presale.connect(alice).updateSchedule(now + DAY, now + 2 * DAY, 0)).to.be.revertedWith("not sale owner");
  });

  it("locks the schedule once the sale has started, ended, or been cancelled", async function () {
    const { presale, params } = await loadFixture(upcomingFixture);
    await time.increaseTo(params.startTime);
    let now = await time.latest();
    await expect(presale.updateSchedule(now + DAY, now + 2 * DAY, 0)).to.be.revertedWith("sale already started");
    await time.increaseTo(params.endTime + 10);
    now = await time.latest();
    await expect(presale.updateSchedule(now + DAY, now + 2 * DAY, 0)).to.be.revertedWith("sale already started");
  });

  it("is refused after a cancel", async function () {
    const { presale } = await loadFixture(upcomingFixture);
    await presale.cancel();
    const now = await time.latest();
    await expect(presale.updateSchedule(now + DAY, now + 2 * DAY, 0)).to.be.revertedWith("not active");
  });
});
