const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatform } = require("./helpers");

const E = ethers.parseEther;
const LOCK_TAXES = 1;
const LOCK_TAX_WALLET = 2;
const LOCK_FEE_EXEMPTIONS = 4;
const LOCK_OWNERSHIP = 8;
const ALL = 15;

// One-way owner locks on every platform token: lock() freezes the project tax rates, the tax
// wallet or the owner's fee-exempt list, or renounces ownership (which locks everything and
// records the renouncer). Nothing locked can be unlocked, the platform keeps its bounded role
// and the metadata registry keeps a renounced token's profile with the wallet that renounced.
describe("Token owner locks", function () {
  async function fixture() {
    const ctx = await deployPlatform();
    const { tokenFactory, weth, alice, bob } = ctx;
    await tokenFactory.connect(alice).createStandardToken("Std", "STD", E("1000000"));
    await tokenFactory.connect(alice).createTaxToken("Tax", "TAX", E("1000000"), bob.address, 300, 400);
    await tokenFactory
      .connect(alice)
      .createRewardsToken("Rew", "REW", E("1000000"), weth.target, bob.address, [200, 200, 100, 100]);
    const standard = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
    const tax = await ethers.getContractAt("TaxToken", await tokenFactory.allTokens(1));
    const rewards = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(2));
    return { ...ctx, standard, tax, rewards };
  }

  async function flags(token) {
    return {
      taxes: await token.taxLocked(),
      wallet: await token.taxWalletLocked(),
      exemptions: await token.feeExemptionsLocked(),
    };
  }

  async function presaleParams(token) {
    const now = await time.latest();
    return {
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
      liquidityAction: 1,
      lockDuration: 0,
      launchTime: 0,
      whitelistEnabled: false,
    };
  }

  describe("a fresh token", function () {
    it("has nothing locked on a Tax or Rewards token and the constants exposed", async function () {
      const { tax, rewards } = await loadFixture(fixture);
      expect(await flags(tax)).to.deep.equal({ taxes: false, wallet: false, exemptions: false });
      expect(await flags(rewards)).to.deep.equal({ taxes: false, wallet: false, exemptions: false });
      expect(await tax.renouncedBy()).to.equal(ethers.ZeroAddress);
      expect(await tax.LOCK_TAXES()).to.equal(LOCK_TAXES);
      expect(await tax.LOCK_TAX_WALLET()).to.equal(LOCK_TAX_WALLET);
      expect(await tax.LOCK_FEE_EXEMPTIONS()).to.equal(LOCK_FEE_EXEMPTIONS);
      expect(await tax.LOCK_OWNERSHIP()).to.equal(LOCK_OWNERSHIP);
    });

    it("counts the rates and the wallet of a Standard token as locked from creation", async function () {
      const { standard } = await loadFixture(fixture);
      expect(await flags(standard)).to.deep.equal({ taxes: true, wallet: true, exemptions: false });
      expect(await standard.owner()).to.not.equal(ethers.ZeroAddress);
    });

    it("lets the owner change everything while nothing is locked", async function () {
      const { tax, alice, carol } = await loadFixture(fixture);
      await tax.connect(alice).setTaxes(100, 200);
      await tax.connect(alice).setMarketingWallet(carol.address);
      await tax.connect(alice).excludeFromFees(carol.address, true);
      expect(await tax.buyTaxBps()).to.equal(100);
      expect(await tax.marketingWallet()).to.equal(carol.address);
      expect(await tax.isExcludedFromFees(carol.address)).to.equal(true);
    });
  });

  describe("lock()", function () {
    it("rejects a stranger and bad flags", async function () {
      const { tax, alice, bob } = await loadFixture(fixture);
      await expect(tax.connect(bob).lock(LOCK_TAXES)).to.be.revertedWithCustomError(tax, "OwnableUnauthorizedAccount");
      await expect(tax.connect(alice).lock(0)).to.be.revertedWithCustomError(tax, "BadLockFlags");
      await expect(tax.connect(alice).lock(16)).to.be.revertedWithCustomError(tax, "BadLockFlags");
      await expect(tax.connect(alice).lock(255)).to.be.revertedWithCustomError(tax, "BadLockFlags");
    });

    it("freezes the tax rates alone", async function () {
      const { tax, alice, carol } = await loadFixture(fixture);
      await expect(tax.connect(alice).lock(LOCK_TAXES)).to.emit(tax, "LocksApplied").withArgs(LOCK_TAXES);
      expect(await flags(tax)).to.deep.equal({ taxes: true, wallet: false, exemptions: false });
      await expect(tax.connect(alice).setTaxes(100, 100)).to.be.revertedWithCustomError(tax, "SettingLocked");
      await tax.connect(alice).setMarketingWallet(carol.address);
      await tax.connect(alice).excludeFromFees(carol.address, true);
      expect(await tax.buyTaxBps()).to.equal(300);
    });

    it("freezes the tax wallet alone", async function () {
      const { tax, alice, carol } = await loadFixture(fixture);
      await tax.connect(alice).lock(LOCK_TAX_WALLET);
      expect(await flags(tax)).to.deep.equal({ taxes: false, wallet: true, exemptions: false });
      await expect(tax.connect(alice).setMarketingWallet(carol.address)).to.be.revertedWithCustomError(tax, "SettingLocked");
      await tax.connect(alice).setTaxes(100, 100);
      expect(await tax.sellTaxBps()).to.equal(100);
    });

    it("freezes the owner's fee-exempt list but not the platform's", async function () {
      const { tax, alice, carol, presaleFactory } = await loadFixture(fixture);
      await tax.connect(alice).lock(LOCK_FEE_EXEMPTIONS);
      expect(await flags(tax)).to.deep.equal({ taxes: false, wallet: false, exemptions: true });
      await expect(tax.connect(alice).excludeFromFees(carol.address, true)).to.be.revertedWithCustomError(tax, "SettingLocked");
      await expect(tax.connect(alice).excludeFromFees(alice.address, false)).to.be.revertedWithCustomError(tax, "SettingLocked");
      expect(await tax.isExcludedFromFees(alice.address)).to.equal(true);
      // A presale created afterwards is still exempted by the presale factory
      const p = await presaleParams(tax);
      await tax.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(p));
      await presaleFactory.connect(alice).createPresale(p, { value: await presaleFactory.creationFee() });
      const presale = await presaleFactory.allPresales(0);
      expect(await tax.isExcludedFromFees(presale)).to.equal(true);
      // The rest of the owner powers are untouched
      await tax.connect(alice).setTaxes(100, 100);
      await tax.connect(alice).setAmmPair(carol.address, true);
    });

    it("adds locks one at a time and never removes one", async function () {
      const { tax, alice } = await loadFixture(fixture);
      await tax.connect(alice).lock(LOCK_TAXES);
      await expect(tax.connect(alice).lock(LOCK_TAXES | LOCK_FEE_EXEMPTIONS))
        .to.emit(tax, "LocksApplied")
        .withArgs(LOCK_TAXES | LOCK_FEE_EXEMPTIONS);
      expect(await flags(tax)).to.deep.equal({ taxes: true, wallet: false, exemptions: true });
      await tax.connect(alice).lock(LOCK_TAX_WALLET);
      expect(await flags(tax)).to.deep.equal({ taxes: true, wallet: true, exemptions: true });
      expect(await tax.owner()).to.equal(alice.address);
    });

    it("keeps its locks when the token changes hands", async function () {
      const { tax, alice, carol } = await loadFixture(fixture);
      await tax.connect(alice).lock(LOCK_TAXES | LOCK_TAX_WALLET);
      await tax.connect(alice).transferOwnership(carol.address);
      expect(await tax.owner()).to.equal(carol.address);
      expect(await flags(tax)).to.deep.equal({ taxes: true, wallet: true, exemptions: false });
      await expect(tax.connect(carol).setTaxes(0, 0)).to.be.revertedWithCustomError(tax, "SettingLocked");
      await expect(tax.connect(carol).setMarketingWallet(carol.address)).to.be.revertedWithCustomError(tax, "SettingLocked");
      await carol.sendTransaction({ to: tax.target, value: 0 });
      await tax.connect(carol).lock(LOCK_FEE_EXEMPTIONS);
      expect(await tax.feeExemptionsLocked()).to.equal(true);
    });

    it("works the same on a Rewards token and leaves the reward route to the owner", async function () {
      const { rewards, alice, carol, weth } = await loadFixture(fixture);
      await rewards.connect(alice).lock(LOCK_TAXES | LOCK_TAX_WALLET | LOCK_FEE_EXEMPTIONS);
      expect(await flags(rewards)).to.deep.equal({ taxes: true, wallet: true, exemptions: true });
      await expect(rewards.connect(alice).setTaxes(100, 100, 0, 0)).to.be.revertedWithCustomError(rewards, "SettingLocked");
      await expect(rewards.connect(alice).setMarketingWallet(carol.address)).to.be.revertedWithCustomError(rewards, "SettingLocked");
      await expect(rewards.connect(alice).excludeFromFees(carol.address, true)).to.be.revertedWithCustomError(rewards, "SettingLocked");
      // The route and the reward exclusions are not settings the locks cover
      await rewards.connect(alice).setRewardRoute([]);
      expect(await rewards.rewardToken()).to.equal(weth.target);
      await rewards.connect(alice).setExcludedFromRewards(carol.address, true);
      expect(await rewards.isExcludedFromRewards(carol.address)).to.equal(true);
    });

    it("lets a Standard owner lock the fee-exempt list", async function () {
      const { standard, alice, carol } = await loadFixture(fixture);
      await standard.connect(alice).lock(LOCK_FEE_EXEMPTIONS);
      expect(await flags(standard)).to.deep.equal({ taxes: true, wallet: true, exemptions: true });
      await expect(standard.connect(alice).excludeFromFees(carol.address, true)).to.be.revertedWithCustomError(standard, "SettingLocked");
    });
  });

  describe("renouncing", function () {
    it("lock(LOCK_OWNERSHIP) locks everything, removes the owner and records who renounced", async function () {
      const { tax, alice, carol } = await loadFixture(fixture);
      await expect(tax.connect(alice).lock(LOCK_OWNERSHIP))
        .to.emit(tax, "LocksApplied")
        .withArgs(ALL)
        .and.to.emit(tax, "OwnershipTransferred")
        .withArgs(alice.address, ethers.ZeroAddress);
      expect(await tax.owner()).to.equal(ethers.ZeroAddress);
      expect(await tax.renouncedBy()).to.equal(alice.address);
      expect(await flags(tax)).to.deep.equal({ taxes: true, wallet: true, exemptions: true });
      await expect(tax.connect(alice).setTaxes(0, 0)).to.be.revertedWithCustomError(tax, "OwnableUnauthorizedAccount");
      await expect(tax.connect(alice).lock(LOCK_TAXES)).to.be.revertedWithCustomError(tax, "OwnableUnauthorizedAccount");
      await expect(tax.connect(alice).excludeFromFees(carol.address, true)).to.be.revertedWithCustomError(tax, "NotAuthorized");
    });

    it("renounceOwnership() does the same", async function () {
      const { rewards, alice } = await loadFixture(fixture);
      await expect(rewards.connect(alice).renounceOwnership()).to.emit(rewards, "LocksApplied").withArgs(ALL);
      expect(await rewards.owner()).to.equal(ethers.ZeroAddress);
      expect(await rewards.renouncedBy()).to.equal(alice.address);
      expect(await flags(rewards)).to.deep.equal({ taxes: true, wallet: true, exemptions: true });
      await expect(rewards.connect(alice).setRewardRoute([])).to.be.revertedWithCustomError(rewards, "OwnableUnauthorizedAccount");
    });

    it("mixed flags with LOCK_OWNERSHIP still lock everything", async function () {
      const { standard, alice } = await loadFixture(fixture);
      await expect(standard.connect(alice).lock(LOCK_OWNERSHIP | LOCK_TAXES)).to.emit(standard, "LocksApplied").withArgs(ALL);
      expect(await standard.owner()).to.equal(ethers.ZeroAddress);
      expect(await standard.renouncedBy()).to.equal(alice.address);
    });

    it("still lets the presale factory exempt a presale of a renounced token", async function () {
      const { tax, alice, presaleFactory } = await loadFixture(fixture);
      // Only the token owner may create a sale, so the sale comes first and the renounce after
      const p = await presaleParams(tax);
      await tax.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(p));
      await presaleFactory.connect(alice).createPresale(p, { value: await presaleFactory.creationFee() });
      await tax.connect(alice).lock(LOCK_OWNERSHIP);
      const presale = await presaleFactory.allPresales(0);
      expect(await tax.isExcludedFromFees(presale)).to.equal(true);
      await expect(presaleFactory.connect(alice).createPresale(await presaleParams(tax), { value: await presaleFactory.creationFee() }))
        .to.be.revertedWith("not token owner");
    });

    it("a quick token records QuickLaunch as its renouncer", async function () {
      const { quickLaunch, alice, presaleFactory } = await loadFixture(fixture);
      const fee = await presaleFactory.quickCreationFee();
      await quickLaunch.connect(alice).launch(
        {
          name: "Quick", symbol: "QCK", hardCap: E("4"), durationOption: 0, creatorSharePercent: 0, tokenType: 0,
          rewardToken: ethers.ZeroAddress, taxWallet: ethers.ZeroAddress, buyTaxBps: 0, sellTaxBps: 0,
          rewardsBuyBps: 0, rewardsSellBps: 0, logoURI: "", description: "",
        },
        { value: fee }
      );
      const presale = await quickLaunch.allLaunches(0);
      const sale = await ethers.getContractAt("Presale", presale);
      const token = await ethers.getContractAt("StandardToken", (await sale.params()).token);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.renouncedBy()).to.equal(quickLaunch.target);
      expect(await flags(token)).to.deep.equal({ taxes: true, wallet: true, exemptions: true });
    });
  });

  describe("the metadata registry", function () {
    const profile = (description) => ({
      logoURI: "ipfs://logo", bannerURI: "", description, website: "", twitter: "", telegram: "", discord: "", updatedAt: 0,
    });

    it("names the owner, then the renouncer, as the controller", async function () {
      const { tax, alice, bob, metadataRegistry } = await loadFixture(fixture);
      expect(await metadataRegistry.controllerOf(tax.target)).to.equal(alice.address);
      await tax.connect(alice).lock(LOCK_OWNERSHIP);
      expect(await metadataRegistry.controllerOf(tax.target)).to.equal(alice.address);
      expect(await metadataRegistry.canEdit(tax.target, alice.address)).to.equal(true);
      expect(await metadataRegistry.canEdit(tax.target, bob.address)).to.equal(false);
      expect(await metadataRegistry.controllerOf(bob.address)).to.equal(ethers.ZeroAddress);
    });

    it("keeps the profile and the tokenomics with the wallet that renounced", async function () {
      const { tax, alice, bob, metadataRegistry } = await loadFixture(fixture);
      await tax.connect(alice).renounceOwnership();
      await expect(metadataRegistry.connect(alice).setMetadata(tax.target, profile("Renounced, still ours.")))
        .to.emit(metadataRegistry, "MetadataUpdated")
        .withArgs(tax.target, alice.address);
      await expect(metadataRegistry.connect(alice).setTokenomics(tax.target, [{ label: "Everything", bps: 10000, note: "" }]))
        .to.emit(metadataRegistry, "TokenomicsUpdated")
        .withArgs(tax.target, alice.address, 1);
      await expect(metadataRegistry.connect(bob).setMetadata(tax.target, profile("Nope"))).to.be.revertedWithCustomError(metadataRegistry, "NotEditor");
      await expect(metadataRegistry.connect(bob).setTokenomics(tax.target, [])).to.be.revertedWithCustomError(metadataRegistry, "NotTokenOwner");
    });

    it("hands the tokenomics to a new owner, not the old one", async function () {
      const { tax, alice, carol, metadataRegistry } = await loadFixture(fixture);
      await tax.connect(alice).transferOwnership(carol.address);
      await expect(metadataRegistry.connect(alice).setTokenomics(tax.target, [])).to.be.revertedWithCustomError(metadataRegistry, "NotTokenOwner");
      await metadataRegistry.connect(carol).setTokenomics(tax.target, [{ label: "Everything", bps: 10000, note: "" }]);
      // Carol renounces: the profile follows her, not the creator
      await tax.connect(carol).renounceOwnership();
      expect(await metadataRegistry.canEdit(tax.target, carol.address)).to.equal(true);
      expect(await metadataRegistry.canEdit(tax.target, alice.address)).to.equal(false);
    });
  });

  describe("bytecode", function () {
    it("keeps every deployable contract under the 24KB limit", async function () {
      const limit = 24576;
      for (const name of ["StandardTokenDeployer", "TaxTokenDeployer", "RewardsTokenDeployer", "RewardsTokenCode", "PresaleCode", "TokenMetadataRegistry"]) {
        const { deployedBytecode } = await hre.artifacts.readArtifact(name);
        expect((deployedBytecode.length - 2) / 2, name).to.be.at.most(limit);
      }
    });
  });
});
