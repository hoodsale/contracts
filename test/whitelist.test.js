const { expect } = require("chai");
const { loadFixture, mine, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));

// Whitelist mode: a sale starts either whitelisted or public; until finalize the owner
// can switch between the two modes at any time and manage the list.
describe("Whitelist mode", function () {
  async function makeSale(env, overrides = {}) {
    const { tokenFactory, presaleFactory } = env;
    const idx = Number(await tokenFactory.allTokensLength());
    await tokenFactory.createStandardToken(`Wl${idx}`, `WL${idx}`, E("1000000"));
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
      lockDuration: 30n * 24n * 3600n,
      launchTime: 0,
      whitelistEnabled: true,
      ...overrides,
    };
    const required = await presaleFactory.requiredTokensFor(params);
    await token.approve(presaleFactory.target, required);
    await presaleFactory.createPresale(params, { value: E("0.1") });
    const addr = await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n);
    return { token, params, presale: await ethers.getContractAt("Presale", addr) };
  }

  async function whitelistedFixture() {
    const env = await deployPlatform();
    const sale = await makeSale(env, { whitelistEnabled: true });
    await time.increaseTo(sale.params.startTime);
    return { ...env, ...sale };
  }

  async function publicFixture() {
    const env = await deployPlatform();
    const sale = await makeSale(env, { whitelistEnabled: false });
    await time.increaseTo(sale.params.startTime);
    return { ...env, ...sale };
  }

  describe("a sale created as whitelist only", function () {
    it("starts in whitelist mode with an empty list", async function () {
      const { presale, lens, alice } = await loadFixture(whitelistedFixture);
      expect(await presale.whitelistEnabled()).to.equal(true);
      expect(await presale.whitelistCount()).to.equal(0);
      expect(await presale.canContribute(alice.address)).to.equal(false);

      const v = await lens.presaleView(presale.target);
      expect(v.whitelistEnabled).to.equal(true);
      expect(v.whitelistCount).to.equal(0);
    });

    it("blocks wallets that are not on the list", async function () {
      const { presale, alice } = await loadFixture(whitelistedFixture);
      await expect(presale.connect(alice).contribute({ value: E("1") })).to.be.revertedWith(
        "not whitelisted"
      );
    });

    it("lets the owner add wallets in batch and then they can contribute", async function () {
      const { presale, alice, bob, carol } = await loadFixture(whitelistedFixture);

      await expect(presale.addToWhitelist([alice.address, bob.address]))
        .to.emit(presale, "WhitelistUpdated")
        .withArgs(alice.address, true);
      expect(await presale.whitelistCount()).to.equal(2);
      expect(await presale.isWhitelisted(alice.address)).to.equal(true);
      expect(await presale.canContribute(alice.address)).to.equal(true);
      expect(await presale.canContribute(carol.address)).to.equal(false);

      await presale.connect(alice).contribute({ value: E("1") });
      await presale.connect(bob).contribute({ value: E("1") });
      await expect(presale.connect(carol).contribute({ value: E("1") })).to.be.revertedWith(
        "not whitelisted"
      );
      expect(await presale.totalRaised()).to.equal(E("2"));
    });

    it("ignores duplicates and the zero address when adding", async function () {
      const { presale, alice } = await loadFixture(whitelistedFixture);
      await presale.addToWhitelist([alice.address, alice.address, ethers.ZeroAddress]);
      expect(await presale.whitelistCount()).to.equal(1);
    });

    it("lets the owner remove wallets again", async function () {
      const { presale, alice, bob } = await loadFixture(whitelistedFixture);
      await presale.addToWhitelist([alice.address, bob.address]);

      await expect(presale.removeFromWhitelist([alice.address]))
        .to.emit(presale, "WhitelistUpdated")
        .withArgs(alice.address, false);
      expect(await presale.whitelistCount()).to.equal(1);
      expect(await presale.isWhitelisted(alice.address)).to.equal(false);
      await expect(presale.connect(alice).contribute({ value: E("1") })).to.be.revertedWith(
        "not whitelisted"
      );
      // Removing someone who is not on the list changes nothing
      await presale.removeFromWhitelist([alice.address]);
      expect(await presale.whitelistCount()).to.equal(1);
    });

    it("can be opened to the public and closed again", async function () {
      const { presale, alice, bob, carol } = await loadFixture(whitelistedFixture);
      await presale.addToWhitelist([alice.address]);

      await expect(presale.setWhitelistEnabled(false))
        .to.emit(presale, "WhitelistModeSet")
        .withArgs(false);
      expect(await presale.canContribute(carol.address)).to.equal(true);
      await presale.connect(carol).contribute({ value: E("1") });

      // After switching back to whitelist mode the list still applies as is, carol can no longer contribute
      await presale.setWhitelistEnabled(true);
      await expect(presale.connect(carol).contribute({ value: E("1") })).to.be.revertedWith(
        "not whitelisted"
      );
      await presale.connect(alice).contribute({ value: E("1") });
      // Carol's earlier contribution is preserved
      expect(await presale.contributionOf(carol.address)).to.equal(E("1"));
      expect(await presale.whitelistCount()).to.equal(1);
      expect(await presale.isWhitelisted(bob.address)).to.equal(false);
    });
  });

  describe("a sale created as public", function () {
    it("accepts anyone until the owner turns the whitelist on", async function () {
      const { presale, alice, bob } = await loadFixture(publicFixture);
      expect(await presale.whitelistEnabled()).to.equal(false);
      await presale.connect(alice).contribute({ value: E("1") });

      await presale.setWhitelistEnabled(true);
      await expect(presale.connect(bob).contribute({ value: E("1") })).to.be.revertedWith(
        "not whitelisted"
      );
      await presale.addToWhitelist([bob.address]);
      await presale.connect(bob).contribute({ value: E("1") });

      // And it can go back to public again
      await presale.setWhitelistEnabled(false);
      const { carol } = await loadFixture(publicFixture);
      expect(await presale.canContribute(carol.address)).to.equal(true);
    });
  });

  describe("permissions and lifecycle", function () {
    it("only the sale owner can manage the mode or the list", async function () {
      const { presale, alice } = await loadFixture(whitelistedFixture);
      await expect(presale.connect(alice).setWhitelistEnabled(false)).to.be.revertedWith(
        "not sale owner"
      );
      await expect(presale.connect(alice).addToWhitelist([alice.address])).to.be.revertedWith(
        "not sale owner"
      );
      await expect(presale.connect(alice).removeFromWhitelist([alice.address])).to.be.revertedWith(
        "not sale owner"
      );
    });

    it("locks management once the sale is cancelled or finalized", async function () {
      const { presale, params, alice, bob } = await loadFixture(whitelistedFixture);
      await presale.addToWhitelist([alice.address, bob.address]);
      await presale.connect(alice).contribute({ value: E("2") });
      await presale.connect(bob).contribute({ value: E("1") });
      await time.increaseTo(params.endTime + 10);
      await presale.finalize(0, 0);

      await expect(presale.setWhitelistEnabled(false)).to.be.revertedWith("not active");
      await expect(presale.addToWhitelist([alice.address])).to.be.revertedWith("not active");

      const env = await loadFixture(whitelistedFixture);
      await env.presale.cancel();
      await expect(env.presale.setWhitelistEnabled(false)).to.be.revertedWith("not active");
    });

    it("does not interfere with exits, claims or refunds", async function () {
      const { presale, params, alice, bob, token } = await loadFixture(whitelistedFixture);
      await presale.addToWhitelist([alice.address, bob.address]);
      await presale.connect(alice).contribute({ value: E("2") });
      await presale.connect(bob).contribute({ value: E("1") });

      // Even while whitelisted, early exit works the same way
      await expect(presale.connect(bob).emergencyWithdraw()).to.emit(presale, "EmergencyWithdrawn");

      await time.increaseTo(params.endTime + 10);
      await presale.finalize(0, 0);
      await presale.connect(alice).claim();
      expect(await token.balanceOf(alice.address)).to.equal(E("2000"));
    });

    it("works for the HOODS sale created through the allowlist path", async function () {
      const env = await loadFixture(deployPlatform);
      const { hoodsale, presaleFactory, alice, bob } = env;
      // The shared deployPlatform snapshot is minutes old by the time the full suite gets here,
      // while the next block is stamped from the wall clock: mine one so `now` is current.
      await mine();
      const now = await time.latest();
      const params = {
        token: hoodsale.target,
        presaleRate: E("20000"),
        listingRate: E("16000"),
        softCap: E("3"),
        hardCap: E("10"),
        minContribution: E("0.1"),
        maxContribution: E("5"),
        startTime: now + 100,
        endTime: now + 1000,
        liquidityBps: 7000,
        liquidityAction: 0,
        lockDuration: 365n * 24n * 3600n,
        launchTime: 0,
        whitelistEnabled: true,
      };
      await hoodsale.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
      await presaleFactory.createPresale(params, { value: E("0.1") });
      const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));

      await presale.addToWhitelist([alice.address]);
      await time.increaseTo(params.startTime);
      await presale.connect(alice).contribute({ value: E("1") });
      await expect(presale.connect(bob).contribute({ value: E("1") })).to.be.revertedWith(
        "not whitelisted"
      );
    });
  });
});
