const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { deployPlatform } = require("./helpers");

const E = (n) => ethers.parseEther(String(n));
const QUICK_FEE = E(0.03);

// Presale.Status
const Upcoming = 0n, Live = 1n, Ended = 2n, Failed = 3n, Cancelled = 4n, Finalized = 5n;

const profile = (overrides = {}) => ({
  logoURI: "ipfs://logo",
  bannerURI: "",
  description: "Edited profile.",
  website: "https://project.example",
  twitter: "https://x.com/project",
  telegram: "",
  discord: "",
  updatedAt: 0,
  ...overrides,
});

// Who may write a token's profile: the token owner, or the wallet that created the token through
// QuickLaunch (quick tokens renounce ownership at creation). The sale state never matters.
describe("TokenMetadataRegistry editors", function () {
  async function expectEdit(registry, signer, token, text) {
    await expect(registry.connect(signer).setMetadata(token, profile({ description: text })))
      .to.emit(registry, "MetadataUpdated")
      .withArgs(token, signer.address);
    expect((await registry.metadataOf(token)).description).to.equal(text);
  }

  async function expectNoEdit(registry, signer, token) {
    await expect(registry.connect(signer).setMetadata(token, profile())).to.be.revertedWithCustomError(
      registry,
      "NotEditor"
    );
  }

  // ------------------------------------------------------------ normal sale

  // The deployer owns the token and runs a sale that starts in 100 seconds
  async function normalFixture() {
    const env = await deployPlatform();
    const { tokenFactory, presaleFactory } = env;
    await tokenFactory.createStandardToken("Norm", "NORM", E(1_000_000));
    const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
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
      liquidityAction: 1,
      lockDuration: 0,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.createPresale(params, { value: E(0.1) });
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(0));
    return { ...env, token, presale, params };
  }

  describe("normal sale", function () {
    it("lets the token owner edit before, during and after the sale", async function () {
      const { metadataRegistry, token, presale, params, deployer, alice, bob } = await loadFixture(normalFixture);
      const t = token.target;
      expect(await metadataRegistry.canEdit(t, deployer.address)).to.equal(true);

      expect(await presale.status()).to.equal(Upcoming);
      await expectEdit(metadataRegistry, deployer, t, "Before the sale.");

      await time.increaseTo(params.startTime);
      await presale.connect(alice).contribute({ value: E(3) });
      expect(await presale.status()).to.equal(Live);
      await expectEdit(metadataRegistry, deployer, t, "During the sale.");

      await presale.connect(bob).contribute({ value: E(2) });
      await time.increaseTo(params.endTime + 1);
      expect(await presale.status()).to.equal(Ended);
      await expectEdit(metadataRegistry, deployer, t, "After the end.");

      await presale.finalize(0, 0);
      expect(await presale.status()).to.equal(Finalized);
      await expectEdit(metadataRegistry, deployer, t, "After the launch.");
      expect(await metadataRegistry.canEdit(t, deployer.address)).to.equal(true);
    });

    it("lets the token owner edit after a cancelled sale", async function () {
      const { metadataRegistry, token, presale, params, deployer, alice } = await loadFixture(normalFixture);
      await time.increaseTo(params.startTime);
      await presale.connect(alice).contribute({ value: E(1) });
      await presale.cancel();
      expect(await presale.status()).to.equal(Cancelled);
      await expectEdit(metadataRegistry, deployer, token.target, "After the cancel.");
    });

    it("lets the token owner edit after a failed sale", async function () {
      const { metadataRegistry, token, presale, params, deployer, alice } = await loadFixture(normalFixture);
      await time.increaseTo(params.startTime);
      await presale.connect(alice).contribute({ value: E(1) }); // below the 2 ETH soft cap
      await time.increaseTo(params.endTime + 1);
      expect(await presale.status()).to.equal(Failed);
      await expectEdit(metadataRegistry, deployer, token.target, "After the failure.");
      await presale.connect(alice).claimRefund();
      await expectEdit(metadataRegistry, deployer, token.target, "After the refunds.");
    });

    it("rejects a stranger in every state", async function () {
      const { metadataRegistry, token, presale, params, alice, bob } = await loadFixture(normalFixture);
      const t = token.target;
      expect(await metadataRegistry.canEdit(t, alice.address)).to.equal(false);
      await expectNoEdit(metadataRegistry, alice, t);

      await time.increaseTo(params.startTime);
      await presale.connect(alice).contribute({ value: E(3) });
      await expectNoEdit(metadataRegistry, alice, t); // a contributor is not an editor

      await time.increaseTo(params.endTime + 1);
      await presale.finalize(0, 0);
      await expectNoEdit(metadataRegistry, alice, t);
      await expectNoEdit(metadataRegistry, bob, t);
      expect(await metadataRegistry.canEdit(t, alice.address)).to.equal(false);
    });

    it("follows the token ownership when it changes hands", async function () {
      const { metadataRegistry, token, deployer, alice } = await loadFixture(normalFixture);
      await token.transferOwnership(alice.address);
      expect(await metadataRegistry.canEdit(token.target, deployer.address)).to.equal(false);
      expect(await metadataRegistry.canEdit(token.target, alice.address)).to.equal(true);
      await expectNoEdit(metadataRegistry, deployer, token.target);
      await expectEdit(metadataRegistry, alice, token.target, "New owner.");
    });
  });

  // ------------------------------------------------------------ quick sale

  /** Runs QuickLaunch.launch for carol: hard cap 1 ETH, 30 minutes, 5% creator share. */
  async function launchQuick(env, creator, overrides = {}) {
    const o = { name: "Hood Flash", symbol: "HFLASH", hardCap: E(1), duration: 0, share: 5, ...overrides };
    const tx = await env.quickLaunch.connect(creator).launch(
      {
        name: o.name, symbol: o.symbol, hardCap: o.hardCap, durationOption: o.duration, creatorSharePercent: o.share,
        tokenType: 0, rewardToken: ethers.ZeroAddress, taxWallet: ethers.ZeroAddress,
        buyTaxBps: 0, sellTaxBps: 0, rewardsBuyBps: 0, rewardsSellBps: 0,
        logoURI: "ipfs://flash-logo", description: "A quick sale.",
      },
      { value: QUICK_FEE }
    );
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return env.quickLaunch.interface.parseLog(l);
        } catch (e) {
          return null;
        }
      })
      .find((e) => e && e.name === "QuickLaunched");
    const token = await ethers.getContractAt("StandardToken", ev.args.token);
    const presale = await ethers.getContractAt("Presale", ev.args.presale);
    return { token, presale };
  }

  async function fundedWallets(env, n, eth) {
    const wallets = [];
    for (let i = 0; i < n; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await env.deployer.sendTransaction({ to: w.address, value: E(eth) });
      wallets.push(w);
    }
    return wallets;
  }

  async function quickFixture() {
    const env = await deployPlatform();
    const sale = await launchQuick(env, env.carol);
    return { ...env, ...sale };
  }

  describe("quick sale", function () {
    it("lets the creator edit right after the launch, although the token has no owner", async function () {
      const { metadataRegistry, quickLaunch, token, presale, carol } = await loadFixture(quickFixture);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await quickLaunch.creatorOf(presale.target)).to.equal(carol.address);
      expect(await metadataRegistry.canEdit(token.target, carol.address)).to.equal(true);
      expect(await presale.status()).to.equal(Live);

      // The launch wrote the logo and the description; the creator adds the links
      expect((await metadataRegistry.metadataOf(token.target)).logoURI).to.equal("ipfs://flash-logo");
      await expect(
        metadataRegistry.connect(carol).setMetadata(
          token.target,
          profile({ logoURI: "ipfs://flash-logo", description: "A quick sale.", website: "https://flash.example" })
        )
      )
        .to.emit(metadataRegistry, "MetadataUpdated")
        .withArgs(token.target, carol.address);
      const m = await metadataRegistry.metadataOf(token.target);
      expect(m.website).to.equal("https://flash.example");
      expect(m.twitter).to.equal("https://x.com/project");
      expect(m.logoURI).to.equal("ipfs://flash-logo");
    });

    it("lets the creator edit during the sale and after the automatic launch at the hard cap", async function () {
      const f = await loadFixture(quickFixture);
      const { metadataRegistry, token, presale, carol } = f;
      const wallets = await fundedWallets(f, 50, 0.05);
      for (const w of wallets.slice(0, 49)) await presale.connect(w).contribute({ value: E(0.02) });
      expect(await presale.status()).to.equal(Live);
      await expectEdit(metadataRegistry, carol, token.target, "During the sale.");

      // The filling contribution launches the sale
      await expect(presale.connect(wallets[49]).contribute({ value: E(0.0195) })).to.emit(presale, "AutoLaunched");
      expect(await presale.status()).to.equal(Finalized);
      await expectEdit(metadataRegistry, carol, token.target, "After the automatic launch.");
      await presale.distribute(100);
      expect(await presale.distributionComplete()).to.equal(true);
      await expectEdit(metadataRegistry, carol, token.target, "After the delivery.");
    });

    it("lets the creator edit after the launch at the end of the sale", async function () {
      const f = await loadFixture(quickFixture);
      const { metadataRegistry, token, presale, carol, keeper } = f;
      const wallets = await fundedWallets(f, 13, 0.05);
      for (const w of wallets) await presale.connect(w).contribute({ value: E(0.02) }); // 0.26 of 0.25 ETH
      await time.increaseTo((await presale.getParams()).endTime + 1n);
      expect(await presale.status()).to.equal(Ended);
      await expectEdit(metadataRegistry, carol, token.target, "Waiting for the launch.");
      await expect(presale.connect(keeper).finalize(0, 0)).to.emit(presale, "Finalized");
      expect(await presale.status()).to.equal(Finalized);
      await expectEdit(metadataRegistry, carol, token.target, "Launched.");
    });

    it("lets the creator edit after a failed sale", async function () {
      const f = await loadFixture(quickFixture);
      const { metadataRegistry, token, presale, carol } = f;
      const wallets = await fundedWallets(f, 5, 0.05);
      for (const w of wallets) await presale.connect(w).contribute({ value: E(0.02) }); // 0.1 of 0.25 ETH
      await time.increaseTo((await presale.getParams()).endTime + 1n);
      expect(await presale.status()).to.equal(Failed);
      await expectEdit(metadataRegistry, carol, token.target, "The sale failed.");
      await presale.connect(wallets[0]).claimRefund();
      await expectEdit(metadataRegistry, carol, token.target, "Refunds are open.");
      expect(await metadataRegistry.canEdit(token.target, carol.address)).to.equal(true);
    });

    it("rejects every other wallet, the platform owner included", async function () {
      const f = await loadFixture(quickFixture);
      const { metadataRegistry, token, presale, deployer, alice, dave } = f;
      const t = token.target;
      for (const s of [deployer, alice, dave]) {
        expect(await metadataRegistry.canEdit(t, s.address)).to.equal(false);
        await expectNoEdit(metadataRegistry, s, t);
      }
      const wallets = await fundedWallets(f, 1, 0.05);
      await presale.connect(wallets[0]).contribute({ value: E(0.02) });
      await expectNoEdit(metadataRegistry, wallets[0], t);
      // Another creator's launch does not open this token
      const other = await launchQuick(f, dave, { name: "Other", symbol: "OTHR" });
      expect(await metadataRegistry.canEdit(other.token.target, dave.address)).to.equal(true);
      expect(await metadataRegistry.canEdit(t, dave.address)).to.equal(false);
      expect(await metadataRegistry.canEdit(other.token.target, f.carol.address)).to.equal(false);
    });

    it("keeps the tokenomics locked: the creator cannot rewrite them", async function () {
      const { metadataRegistry, token, carol, deployer } = await loadFixture(quickFixture);
      const plan = [{ label: "Fair launch", bps: 10000, note: "" }];
      await expect(metadataRegistry.connect(carol).setTokenomics(token.target, plan)).to.be.revertedWithCustomError(
        metadataRegistry,
        "NotTokenOwner"
      );
      await expect(metadataRegistry.connect(carol).setTokenomics(token.target, [])).to.be.revertedWithCustomError(
        metadataRegistry,
        "NotTokenOwner"
      );
      await expect(metadataRegistry.connect(deployer).setTokenomics(token.target, plan)).to.be.revertedWithCustomError(
        metadataRegistry,
        "NotTokenOwner"
      );
      const slices = await metadataRegistry.tokenomicsOf(token.target);
      expect(slices.map((s) => s.label)).to.deep.equal(["Presale", "Liquidity", "Burned"]);
    });
  });

  // ------------------------------------------------------------ canEdit

  describe("canEdit", function () {
    it("is false for the zero account, for a token without owner() and for an address without code", async function () {
      const { metadataRegistry, token, weth, deployer, alice } = await loadFixture(normalFixture);
      expect(await metadataRegistry.canEdit(token.target, ethers.ZeroAddress)).to.equal(false);
      // MockWETH has no owner() function
      expect(await metadataRegistry.canEdit(weth.target, deployer.address)).to.equal(false);
      expect(await metadataRegistry.canEdit(weth.target, alice.address)).to.equal(false);
      // An EOA as the token
      expect(await metadataRegistry.canEdit(alice.address, alice.address)).to.equal(false);
      expect(await metadataRegistry.canEdit(alice.address, deployer.address)).to.equal(false);
      // The zero address as the token
      expect(await metadataRegistry.canEdit(ethers.ZeroAddress, deployer.address)).to.equal(false);
    });

    it("is true for the HOODSALE owner and for nobody else", async function () {
      const { metadataRegistry, hoodsale, deployer, alice } = await loadFixture(deployPlatform);
      expect(await metadataRegistry.canEdit(hoodsale.target, deployer.address)).to.equal(true);
      expect(await metadataRegistry.canEdit(hoodsale.target, alice.address)).to.equal(false);
    });

    it("needs the presale factory and its quick launch for the creator path", async function () {
      const f = await loadFixture(quickFixture);
      const { tokenFactory, presaleFactory, token, carol, deployer, treasury, locker, router } = f;

      // A registry that knows no presale factory: the owner path only
      const bare = await ethers.deployContract("TokenMetadataRegistry", [tokenFactory.target]);
      expect(await bare.canEdit(token.target, carol.address)).to.equal(false);
      await bare.setPresaleFactory(presaleFactory.target);
      expect(await bare.canEdit(token.target, carol.address)).to.equal(true);

      // A presale factory without a QuickLaunch: no creator path either
      const factoryWithoutQuick = await ethers.deployContract("PresaleFactory", [
        deployer.address,
        treasury.target,
        tokenFactory.target,
        locker.target,
        router.target,
      ]);
      expect(await factoryWithoutQuick.quickLaunch()).to.equal(ethers.ZeroAddress);
      await bare.setPresaleFactory(factoryWithoutQuick.target);
      expect(await bare.canEdit(token.target, carol.address)).to.equal(false);
    });

    it("keeps the creator path when QuickLaunch is replaced by a generation that names the old one", async function () {
      const f = await loadFixture(quickFixture);
      const { metadataRegistry, quickLaunch, presaleFactory, tokenFactory, weth, token, presale, carol, dave } = f;
      const args = [tokenFactory.target, presaleFactory.target, metadataRegistry.target, [weth.target]];
      const next = await ethers.deployContract("QuickLaunch", [...args, quickLaunch.target]);
      await presaleFactory.setQuickLaunch(next.target);
      // The registry follows the factory's QuickLaunch, which answers for the old sale
      expect(await next.creatorOf(presale.target)).to.equal(carol.address);
      expect(await metadataRegistry.canEdit(token.target, carol.address)).to.equal(true);
      await expectEdit(metadataRegistry, carol, token.target, "After the replacement.");
      await expectNoEdit(metadataRegistry, dave, token.target);
      // A replacement that names no previous generation drops the path
      const orphan = await ethers.deployContract("QuickLaunch", [...args, ethers.ZeroAddress]);
      await presaleFactory.setQuickLaunch(orphan.target);
      expect(await metadataRegistry.canEdit(token.target, carol.address)).to.equal(false);
      await expectNoEdit(metadataRegistry, carol, token.target);
    });

    it("a token that never went through QuickLaunch has no creator editor", async function () {
      const { metadataRegistry, quickLaunch, token, carol, deployer } = await loadFixture(normalFixture);
      expect(await quickLaunch.presaleOfToken(token.target)).to.equal(ethers.ZeroAddress);
      expect(await metadataRegistry.canEdit(token.target, carol.address)).to.equal(false);
      expect(await metadataRegistry.canEdit(token.target, deployer.address)).to.equal(true);
    });
  });
});
