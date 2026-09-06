const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;

// Scheduled launch: if the owner sets a date, from that moment on the platform's launch
// bot (keeper) may call finalize on the owner's behalf. The owner can always launch
// themselves too and keeps the right to cancel until finalize happens. Nobody else
// can trigger the launch.
describe("Scheduled launch", function () {
  async function makeSale(env, overrides = {}) {
    const { tokenFactory, presaleFactory } = env;
    const idx = Number(await tokenFactory.allTokensLength());
    await tokenFactory.createStandardToken(`Sched${idx}`, `SCH${idx}`, E("1000000"));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(idx));

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
      liquidityAction: 0,
      lockDuration: 30n * BigInt(DAY),
      launchTime: 0,
      whitelistEnabled: false,
      ...overrides,
    };
    const required = await presaleFactory.requiredTokensFor(params);
    await token.approve(presaleFactory.target, required);
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const addr = await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n);
    return { token, params, presale: await ethers.getContractAt("Presale", addr) };
  }

  async function scheduledFixture() {
    const env = await deployPlatform();
    const now = await time.latest();
    const sale = await makeSale(env, { launchTime: now + 1600 });
    await time.increaseTo(sale.params.startTime);
    await sale.presale.connect(env.alice).contribute({ value: E("3") });
    await sale.presale.connect(env.bob).contribute({ value: E("2") });
    return { ...env, ...sale };
  }

  describe("validation", function () {
    it("accepts a launch time between the end and the finalize window", async function () {
      const env = await loadFixture(deployPlatform);
      const now = await time.latest();
      const { presale, params } = await makeSale(env, { launchTime: now + 2000 });
      expect((await presale.getParams()).launchTime).to.equal(params.launchTime);
    });

    it("rejects a launch time before the sale ends", async function () {
      const env = await loadFixture(deployPlatform);
      const now = await time.latest();
      await expect(makeSale(env, { launchTime: now + 500 })).to.be.revertedWith("launch before end");
    });

    it("rejects a launch time past the finalize window", async function () {
      const env = await loadFixture(deployPlatform);
      const now = await time.latest();
      await expect(
        makeSale(env, { launchTime: now + 1000 + 15 * DAY })
      ).to.be.revertedWith("launch after window");
    });

    it("treats zero as no schedule", async function () {
      const env = await loadFixture(deployPlatform);
      const { presale } = await makeSale(env);
      expect((await presale.getParams()).launchTime).to.equal(0);
      expect(await presale.isLaunchDue()).to.equal(false);
    });

    it("only the platform owner can set the launch keeper", async function () {
      const { presaleFactory, alice, keeper } = await loadFixture(deployPlatform);
      expect(await presaleFactory.launchKeeper()).to.equal(keeper.address);
      await expect(
        presaleFactory.connect(alice).setLaunchKeeper(alice.address)
      ).to.be.revertedWithCustomError(presaleFactory, "OwnableUnauthorizedAccount");
    });
  });

  describe("before the launch time", function () {
    it("keeps finalize restricted to the owner, even for the keeper", async function () {
      const { presale, params, carol, keeper } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.endTime + 10);

      expect(await presale.isLaunchDue()).to.equal(false);
      expect(await presale.isReadyToFinalize()).to.equal(true);
      await expect(presale.connect(carol).finalize(0, 0)).to.be.revertedWith(
        "not authorized to launch"
      );
      await expect(presale.connect(keeper).finalize(0, 0)).to.be.revertedWith(
        "not authorized to launch"
      );
    });

    it("still lets the owner cancel with full refunds and no platform fee", async function () {
      const { presale, params, treasury, alice, bob } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.endTime + 10);

      const treasuryBefore = await ethers.provider.getBalance(treasury.target);
      await expect(presale.cancel()).to.emit(presale, "Cancelled");
      // No platform fee is taken on cancel
      expect(await ethers.provider.getBalance(treasury.target)).to.equal(treasuryBefore);

      await expect(presale.connect(alice).claimRefund()).to.changeEtherBalances(
        [alice, presale],
        [E("3"), E("-3")]
      );
      await expect(presale.connect(bob).claimRefund()).to.changeEtherBalances(
        [bob, presale],
        [E("2"), E("-2")]
      );
    });

    it("lets the owner launch early, before the scheduled time", async function () {
      const { presale, params } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.endTime + 10);
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
      expect(await presale.status()).to.equal(5); // Finalized
    });
  });

  describe("after the launch time", function () {
    it("lets the platform keeper trigger the launch", async function () {
      const { presale, params, keeper, treasury } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.launchTime);

      expect(await presale.isLaunchDue()).to.equal(true);
      const treasuryBefore = await ethers.provider.getBalance(treasury.target);
      await expect(presale.connect(keeper).finalize(0, 0)).to.emit(presale, "Finalized");

      // The platform fee is still 10% of the amount raised, even when the keeper triggers it
      expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.equal(
        E("0.5")
      );
    });

    it("still refuses everyone who is not the owner or the keeper", async function () {
      const { presale, params, carol, dave } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.launchTime);
      await expect(presale.connect(carol).finalize(0, 0)).to.be.revertedWith(
        "not authorized to launch"
      );
      await expect(presale.connect(dave).finalize(0, 0)).to.be.revertedWith(
        "not authorized to launch"
      );
    });

    it("pays the owner and the contributors exactly as an owner launch would", async function () {
      const { presale, params, keeper, alice, token, deployer } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.launchTime);

      const ownerBefore = await ethers.provider.getBalance(deployer.address);
      await presale.connect(keeper).finalize(0, 0);
      // The owner receives the leftover ETH even though they did not trigger it
      expect(await ethers.provider.getBalance(deployer.address)).to.be.gt(ownerBefore);

      await presale.connect(alice).claim();
      expect(await token.balanceOf(alice.address)).to.equal(E("3000"));
    });

    it("lets the owner launch it themselves after the schedule too", async function () {
      const { presale, params } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.launchTime + 50);
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
    });

    it("keeps the owner's cancel right until the launch actually happens", async function () {
      const { presale, params, alice } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.launchTime + 50);
      await expect(presale.cancel()).to.emit(presale, "Cancelled");
      await expect(presale.connect(alice).claimRefund()).to.changeEtherBalances(
        [alice, presale],
        [E("3"), E("-3")]
      );
    });

    it("does nothing when the platform has no keeper configured", async function () {
      const { presale, params, presaleFactory, keeper } = await loadFixture(scheduledFixture);
      await presaleFactory.setLaunchKeeper(ethers.ZeroAddress);
      await time.increaseTo(params.launchTime);
      await expect(presale.connect(keeper).finalize(0, 0)).to.be.revertedWith(
        "not authorized to launch"
      );
      // The owner can still launch
      await expect(presale.finalize(0, 0)).to.emit(presale, "Finalized");
    });

    it("does not let the keeper launch a sale that missed its soft cap", async function () {
      const env = await loadFixture(deployPlatform);
      const now = await time.latest();
      const { presale, params } = await makeSale(env, { launchTime: now + 1600 });
      await time.increaseTo(params.startTime);
      await presale.connect(env.alice).contribute({ value: E("1") }); // softcap 2 ETH
      await time.increaseTo(params.launchTime);

      expect(await presale.isLaunchDue()).to.equal(true);
      expect(await presale.isReadyToFinalize()).to.equal(false);
      await expect(presale.connect(env.keeper).finalize(0, 0)).to.be.revertedWith("softcap not met");
      // The contributor still gets a full refund
      await expect(presale.connect(env.alice).claimRefund()).to.changeEtherBalances(
        [env.alice, presale],
        [E("1"), E("-1")]
      );
    });

    it("cannot be launched twice", async function () {
      const { presale, params, keeper } = await loadFixture(scheduledFixture);
      await time.increaseTo(params.launchTime);
      await presale.connect(keeper).finalize(0, 0);
      await expect(presale.finalize(0, 0)).to.be.revertedWith("not active");
    });
  });

  describe("lens reporting", function () {
    it("exposes the schedule and the launch readiness flags", async function () {
      const { lens, presale, params } = await loadFixture(scheduledFixture);

      let v = await lens.presaleView(presale.target);
      expect(v.launchTime).to.equal(params.launchTime);
      expect(v.launchDue).to.equal(false);
      expect(v.readyToFinalize).to.equal(false); // the sale is still running

      await time.increaseTo(params.endTime + 10);
      v = await lens.presaleView(presale.target);
      expect(v.readyToFinalize).to.equal(true);
      expect(v.launchDue).to.equal(false);

      await time.increaseTo(params.launchTime);
      v = await lens.presaleView(presale.target);
      expect(v.launchDue).to.equal(true);
    });
  });
});
