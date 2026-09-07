const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { deployPlatform } = require("./helpers");
const { reconstructConstructorArgs, toPlainArgs, FQN, bytecodeMatches } = require("../scripts/lib/constructorArgs");
const { buildVerificationPackage, writeVerificationPackage } = require("../scripts/verify-standard-json");
const { verifyOne, verifyAddresses, classifyVerifyError, probeExplorerApi, STATUS } = require("../scripts/verify-contract");
const verifyPlatform = require("../scripts/verify-platform");
const { createWatcher } = require("../scripts/auto-verify");

const E = (n) => ethers.parseEther(String(n));

// bigint/number -> string, addresses lowercased; for deep comparison
function norm(v) {
  if (typeof v === "bigint" || typeof v === "number") return v.toString();
  if (typeof v === "string") return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = norm(v[k]);
    return o;
  }
  return v;
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hoodsale-${name}-`));
}

async function fixture() {
  const env = await deployPlatform();
  const { tokenFactory, presaleFactory, treasury, locker, router, hoodsale, metadataRegistry, lens, weth, v3Router, v3Quoter, rewardsTokenCode } = env;
  const { deployer, alice, bob, carol, dave, marketing } = env;
  const provider = ethers.provider;

  // One token of each type, with distinctive parameters
  await tokenFactory.connect(alice).createStandardToken("Alpha One", "ALP1", E("12345678"));
  await tokenFactory.connect(bob).createTaxToken("Taxed Two", "TAX2", E("500000"), carol.address, 250, 375);
  await tokenFactory
    .connect(carol)
    .createRewardsToken("Rewarding Three", "RWD3", E("2000000"), weth.target, dave.address, [150, 250, 100, 200]);
  // One more tax token that is never changed (for the events path)
  await tokenFactory.connect(dave).createTaxToken("Untouched", "UNT", E("777"), alice.address, 111, 222);

  const tokens = [];
  for (let i = 0; i < 4; i++) tokens.push(await tokenFactory.allTokens(i));
  const [standardAddr, taxAddr, rewardsAddr, untouchedAddr] = tokens;

  // Presale: whitelist + launchTime + burn option
  const std = await ethers.getContractAt("StandardToken", standardAddr);
  const now = (await provider.getBlock("latest")).timestamp;
  const params = {
    token: standardAddr,
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
    lockDuration: 30n * 24n * 3600n,
    launchTime: now + 1500,
    whitelistEnabled: true,
  };
  const required = await presaleFactory.requiredTokensFor(params);
  await std.connect(alice).approve(presaleFactory.target, required);
  await presaleFactory.connect(alice).createPresale(params, { value: E("0.1") });
  const presaleAddr = await presaleFactory.allPresales(0);

  // The owners change everything afterwards: reconstruction must still return the ORIGINAL values
  const tax = await ethers.getContractAt("TaxToken", taxAddr);
  await tax.connect(bob).setTaxes(100, 200);
  await tax.connect(bob).setMarketingWallet(dave.address);
  const rw = await ethers.getContractAt("RewardsToken", rewardsAddr);
  await rw.connect(carol).setTaxes(50, 60, 70, 80);
  await rw.connect(carol).setMarketingWallet(alice.address);
  await treasury.transferOwnership(bob.address);
  await tokenFactory.setRouter(bob.address);
  await tokenFactory.setTreasury(carol.address);
  await presaleFactory.setLocker(dave.address);
  await presaleFactory.setTreasury(alice.address);
  await hoodsale.setMarketingWallet(alice.address);
  await hoodsale.setTreasury(bob.address);
  await hoodsale.transferOwnership(carol.address);

  const deployments = {
    network: "hardhat",
    router: router.target,
    treasury: treasury.target,
    locker: locker.target,
    tokenFactory: tokenFactory.target,
    presaleFactory: presaleFactory.target,
    hoodsale: hoodsale.target,
    metadataRegistry: metadataRegistry.target,
    lens: lens.target,
    marketingWallet: marketing.address,
  };

  const expected = {
    [standardAddr]: {
      contract: FQN.StandardToken,
      args: ["Alpha One", "ALP1", E("12345678"), alice.address, treasury.target, tokenFactory.target, router.target, 25],
    },
    [taxAddr]: {
      contract: FQN.TaxToken,
      args: ["Taxed Two", "TAX2", E("500000"), bob.address, treasury.target, tokenFactory.target, router.target, 25, carol.address, 250, 375],
    },
    [rewardsAddr]: {
      contract: FQN.RewardsToken,
      args: [
        "Rewarding Three", "RWD3", E("2000000"), carol.address, treasury.target, tokenFactory.target, router.target, 25,
        weth.target, dave.address, [150, 250, 100, 200],
        // the Uniswap V3 leg: the chain's router and quoter, and no platform path for WETH
        v3Router.target, v3Quoter.target, "0x",
      ],
    },
    [untouchedAddr]: {
      contract: FQN.TaxToken,
      args: ["Untouched", "UNT", E("777"), dave.address, treasury.target, tokenFactory.target, router.target, 25, alice.address, 111, 222],
    },
    [presaleAddr]: {
      contract: FQN.Presale,
      args: [params, alice.address, router.target, locker.target, treasury.target, 1000, 1000],
    },
    [await tokenFactory.standardDeployer()]: { contract: FQN.StandardTokenDeployer, args: [tokenFactory.target] },
    [await tokenFactory.taxDeployer()]: { contract: FQN.TaxTokenDeployer, args: [tokenFactory.target] },
    [await tokenFactory.rewardsDeployer()]: { contract: FQN.RewardsTokenDeployer, args: [tokenFactory.target, v3Router.target, v3Quoter.target, rewardsTokenCode.target] },
    [rewardsTokenCode.target]: { contract: FQN.RewardsTokenCode, args: [] },
    [treasury.target]: { contract: FQN.Treasury, args: [deployer.address] },
    [locker.target]: { contract: FQN.LiquidityLocker, args: [] },
    [tokenFactory.target]: { contract: FQN.TokenFactory, args: [deployer.address, treasury.target, router.target] },
    [presaleFactory.target]: {
      contract: FQN.PresaleFactory,
      args: [deployer.address, treasury.target, tokenFactory.target, locker.target, router.target],
    },
    [hoodsale.target]: { contract: FQN.HoodSaleToken, args: [deployer.address, router.target, treasury.target, marketing.address] },
    [metadataRegistry.target]: { contract: FQN.TokenMetadataRegistry, args: [tokenFactory.target] },
    [lens.target]: { contract: FQN.HoodSaleLens, args: [presaleFactory.target, tokenFactory.target, router.target] },
  };

  return { ...env, provider, deployments, expected, standardAddr, taxAddr, rewardsAddr, untouchedAddr, presaleAddr, params };
}

describe("constructor argument reconstruction", function () {
  it("sanity: the owners really changed the mutable state", async function () {
    const { taxAddr, rewardsAddr, treasury, tokenFactory, hoodsale, bob, alice } = await loadFixture(fixture);
    const tax = await ethers.getContractAt("TaxToken", taxAddr);
    expect(await tax.buyTaxBps()).to.equal(100);
    expect(await tax.marketingWallet()).to.not.equal((await loadFixture(fixture)).carol.address);
    const rw = await ethers.getContractAt("RewardsToken", rewardsAddr);
    expect(await rw.rewardsBuyTaxBps()).to.equal(50);
    expect(await rw.marketingWallet()).to.equal(alice.address);
    expect(await treasury.owner()).to.equal(bob.address);
    expect(await tokenFactory.router()).to.equal(bob.address);
    expect(await hoodsale.marketingWallet()).to.equal(alice.address);
  });

  it("returns the exact fully qualified name and original args for every contract (default strategies)", async function () {
    const { provider, deployments, expected } = await loadFixture(fixture);
    for (const [address, exp] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments });
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), `${exp.contract} ${address}`).to.deep.equal(norm(exp.args));
      expect(r.address).to.equal(ethers.getAddress(address));
    }
  });

  it("uses creation calldata for tokens and the creation tx for EOA-deployed platform contracts", async function () {
    const { provider, deployments, taxAddr, rewardsAddr, standardAddr, tokenFactory, hoodsale, treasury } = await loadFixture(fixture);
    for (const a of [taxAddr, rewardsAddr, standardAddr]) {
      const r = await reconstructConstructorArgs(provider, a, { deployments });
      // The V3 path of a Rewards token is not in the factory calldata: it comes from the creation
      // receipt, the router and quoter are immutables
      const fromCalldata = Object.entries(r.meta.sources).filter(([k]) => !["rewardRouteV3", "v3Router", "v3Quoter"].includes(k));
      expect(fromCalldata.every(([, s]) => s === "creation-calldata"), a).to.equal(true);
      if (a === rewardsAddr) {
        expect(r.meta.sources.rewardRouteV3).to.equal("creation-receipt");
        expect(r.meta.sources.v3Router).to.equal("immutable-state");
      }
      expect(r.meta.warnings).to.deep.equal([]);
      expect(r.meta.creation.blockNumber).to.be.a("number");
    }
    for (const a of [tokenFactory.target, hoodsale.target, treasury.target]) {
      const r = await reconstructConstructorArgs(provider, a, { deployments });
      expect(r.meta.sources.all, a).to.equal("creation-tx");
      expect(r.meta.warnings).to.deep.equal([]);
    }
  });

  it("still recovers the original values from creation-block state (archive path)", async function () {
    const { provider, deployments, expected } = await loadFixture(fixture);
    for (const [address, exp] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments, strategies: ["creation-state"] });
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), `${exp.contract} ${address}`).to.deep.equal(norm(exp.args));
    }
  });

  it("falls back to current state with explicit warnings when only events are available", async function () {
    const { provider, deployments, taxAddr, untouchedAddr, rewardsAddr, expected, dave } = await loadFixture(fixture);
    // Modified tax token: current values + CHANGED warnings
    const changed = await reconstructConstructorArgs(provider, taxAddr, { deployments, strategies: ["events", "current"] });
    expect(changed.args[9]).to.equal(100n);
    expect(changed.args[10]).to.equal(200n);
    expect(changed.args[8]).to.equal(dave.address);
    expect(changed.meta.sources.buyTaxBps).to.equal("current-CHANGED");
    expect(changed.meta.sources.marketingWallet).to.equal("current-CHANGED");
    expect(changed.meta.warnings.join(" ")).to.match(/setTaxes/).and.match(/setMarketingWallet/);
    // Never-modified tax token: current == original, verified through events
    const same = await reconstructConstructorArgs(provider, untouchedAddr, { deployments, strategies: ["events", "current"] });
    expect(norm(same.args)).to.deep.equal(norm(expected[untouchedAddr].args));
    expect(same.meta.sources.buyTaxBps).to.equal("current-unchanged-by-events");
    expect(same.meta.warnings).to.deep.equal([]);
    // Rewards: always UNVERIFIED because marketingWallet emits no event; the V3 path never changed
    const rw = await reconstructConstructorArgs(provider, rewardsAddr, { deployments, strategies: ["events", "current"] });
    expect(rw.meta.sources.marketingWallet).to.equal("current-UNVERIFIED");
    expect(rw.meta.sources.rewardRouteV3).to.equal("current-unchanged-by-events");
    expect(rw.meta.warnings.join(" ")).to.match(/emits no event/);
    expect(rw.args[13]).to.equal("0x");
  });

  // A Rewards token whose V3 path was set by the deployer at creation (the platform route of its
  // reward token) and changed afterwards: the receipt keeps the original exactly, the archive path
  // reads it at the creation block, and the events path reports the change.
  async function v3PathFixture() {
    const env = await deployPlatform();
    const { tokenFactory, quickLaunch, v3Factory, v3Router, v3Quoter, weth, treasury, router, carol, dave } = env;
    const tsla = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E("1000000")]);
    const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 1_000_000n * 10n ** 6n]);
    await v3Factory.createPool(weth.target, tsla.target, 3000);
    await v3Factory.createPool(weth.target, usdg.target, 500);
    await v3Factory.createPool(usdg.target, tsla.target, 3000);
    const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, tsla.target, 3000));
    await weth.deposit({ value: E("50") });
    await weth.transfer(pool.target, E("50"));
    await tsla.transfer(pool.target, E("345"));
    await pool.sync();
    const path = ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, tsla.target]);
    const otherPath = ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address"],
      [weth.target, 500, usdg.target, 3000, tsla.target]
    );
    await quickLaunch.setRewardTokenAllowed(tsla.target, true);
    await quickLaunch.setRewardRouteV3(tsla.target, path);

    // Created directly through the factory: the deployer passes the platform path
    const direct = await (
      await tokenFactory.connect(carol).createRewardsToken("Direct Stock", "DSTK", E("3000000"), tsla.target, dave.address, [150, 250, 100, 200])
    ).wait();
    const directAddr = await tokenFactory.allTokens(0);
    const directToken = await ethers.getContractAt("RewardsToken", directAddr);
    expect(await directToken.rewardRouteV3()).to.equal(path);
    // The owner points it elsewhere, then clears it through a V2 route
    await directToken.connect(carol).setRewardRouteV3(otherPath);
    await directToken.connect(carol).setRewardRoute([weth.target, usdg.target]);
    expect(await directToken.rewardRouteV3()).to.equal("0x");

    // Launched through QuickLaunch: the constructor stores the path, launch applies it again in the same tx
    const q = {
      name: "Quick Stock", symbol: "QSTK", hardCap: E("1"), durationOption: 0, creatorSharePercent: 0,
      tokenType: 2, rewardToken: tsla.target, taxWallet: ethers.ZeroAddress, buyTaxBps: 100, sellTaxBps: 100,
      rewardsBuyBps: 300, rewardsSellBps: 300, logoURI: "", description: "",
    };
    const launch = await (await quickLaunch.connect(dave).launch(q, { value: await env.presaleFactory.quickCreationFee() })).wait();
    const quickAddr = await tokenFactory.allTokens(1);
    const quickToken = await ethers.getContractAt("RewardsToken", quickAddr);
    expect(await quickToken.rewardRouteV3()).to.equal(path);

    const deployments = { network: "hardhat", router: router.target, treasury: treasury.target, tokenFactory: tokenFactory.target, presaleFactory: env.presaleFactory.target, quickLaunch: quickLaunch.target };
    const base = [treasury.target, tokenFactory.target, router.target, 25, tsla.target];
    const expected = {
      [directAddr]: ["Direct Stock", "DSTK", E("3000000"), carol.address, ...base, dave.address, [150, 250, 100, 200], v3Router.target, v3Quoter.target, path],
      [quickAddr]: ["Quick Stock", "QSTK", await quickLaunch.TOTAL_SUPPLY(), quickLaunch.target, ...base, dave.address, [300, 300, 100, 100], v3Router.target, v3Quoter.target, path],
    };
    return { ...env, provider: ethers.provider, deployments, expected, directAddr, quickAddr, path, otherPath, txs: { direct: direct.hash, launch: launch.hash } };
  }

  it("recovers the original V3 path of a Rewards token from the creation receipt after the route changed", async function () {
    const { provider, deployments, expected, directAddr, quickAddr, path, txs } = await loadFixture(v3PathFixture);
    for (const [address, args] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments });
      expect(r.contract, address).to.equal(FQN.RewardsToken);
      expect(norm(r.args), address).to.deep.equal(norm(args));
      expect(r.meta.sources.rewardRouteV3, address).to.equal("creation-receipt");
      // the quick token's taxes come from the creation-block state (no factory calldata), which
      // carries the usual marketing wallet note; nothing about the route
      expect(r.meta.warnings.filter((w) => !/setMarketingWallet/.test(w)), address).to.deep.equal([]);
      // the encoded arguments decode back to the same values
      const artifact = await hre.artifacts.readArtifact(FQN.RewardsToken);
      const types = artifact.abi.find((f) => f.type === "constructor").inputs;
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, new ethers.Interface(artifact.abi).encodeDeploy(r.args));
      expect(decoded[13]).to.equal(path);
    }
    // the receipt path also works when the creation is passed in (as the watcher does)
    const known = await reconstructConstructorArgs(provider, quickAddr, { deployments, creation: { blockNumber: (await provider.getTransactionReceipt(txs.launch)).blockNumber, transactionHash: txs.launch } });
    expect(known.args[13]).to.equal(path);
    // the archive path reads the path at the creation block
    const archive = await reconstructConstructorArgs(provider, directAddr, { deployments, strategies: ["creation-state"] });
    expect(archive.args[13]).to.equal(path);
    expect(archive.meta.sources.rewardRouteV3).to.equal("creation-state");
    // events only: the direct token changed its route (current empty path, CHANGED), the quick one did not
    const changed = await reconstructConstructorArgs(provider, directAddr, { deployments, strategies: ["events", "current"] });
    expect(changed.args[13]).to.equal("0x");
    expect(changed.meta.sources.rewardRouteV3).to.equal("current-CHANGED");
    expect(changed.meta.warnings.join(" ")).to.match(/RewardRouteV3Updated/);
    const same = await reconstructConstructorArgs(provider, quickAddr, { deployments, strategies: ["events", "current"] });
    expect(same.args[13]).to.equal(path);
    expect(same.meta.sources.rewardRouteV3).to.equal("current-unchanged-by-events");
  });

  it("identifies platform contracts by bytecode when no deployments file is given", async function () {
    const { provider, expected, deployments } = await loadFixture(fixture);
    for (const key of ["treasury", "locker", "tokenFactory", "presaleFactory", "hoodsale", "metadataRegistry", "lens"]) {
      const address = deployments[key];
      const r = await reconstructConstructorArgs(provider, address, {});
      expect(r.contract, key).to.equal(expected[address].contract);
      expect(norm(r.args), key).to.deep.equal(norm(expected[address].args));
      expect(r.meta.viaBytecode).to.equal(true);
    }
    // tokens/presale/deployers are recognised from the chain even without deployments
    for (const address of Object.keys(expected)) {
      const r = await reconstructConstructorArgs(provider, address, {});
      expect(r.contract, address).to.equal(expected[address].contract);
    }
  });

  it("accepts a known creation block and skips the log search", async function () {
    const { provider, deployments, taxAddr, tokenFactory, expected } = await loadFixture(fixture);
    const logs = await tokenFactory.queryFilter(tokenFactory.filters.TokenCreated(taxAddr));
    const creation = { blockNumber: logs[0].blockNumber, transactionHash: logs[0].transactionHash };
    const r = await reconstructConstructorArgs(provider, taxAddr, { deployments, creation });
    expect(norm(r.args)).to.deep.equal(norm(expected[taxAddr].args));
    expect(r.meta.creation.transactionHash).to.equal(creation.transactionHash);
  });

  it("rejects EOAs and foreign contracts with clear errors", async function () {
    const { provider, deployments, weth, alice } = await loadFixture(fixture);
    await expect(reconstructConstructorArgs(provider, alice.address, { deployments })).to.be.rejectedWith(/no code/);
    await expect(reconstructConstructorArgs(provider, weth.target, { deployments })).to.be.rejectedWith(/not a HoodSale/);
  });

  it("ABI-encodes the reconstructed args to exactly the tail of the deployment transaction", async function () {
    const { provider, deployments, treasury, tokenFactory, presaleFactory, hoodsale, lens, metadataRegistry } = await loadFixture(fixture);
    for (const c of [treasury, tokenFactory, presaleFactory, hoodsale, lens, metadataRegistry]) {
      const r = await reconstructConstructorArgs(provider, c.target, { deployments });
      const artifact = await hre.artifacts.readArtifact(r.contract);
      const encoded = new ethers.Interface(artifact.abi).encodeDeploy(r.args);
      const data = c.deploymentTransaction().data;
      expect(data.endsWith(encoded.slice(2)), r.contract).to.equal(true);
      expect(data.length, r.contract).to.equal(artifact.bytecode.length + encoded.length - 2);
    }
  });

  it("bytecodeMatches masks metadata and immutables only", function () {
    // 2-byte fake "code" + CBOR length 0 -> tail 0x0000
    expect(bytecodeMatches("0xaabb0000", "0xaabb0000", {})).to.equal(true);
    expect(bytecodeMatches("0xaabb0000", "0xaacc0000", {})).to.equal(false);
    expect(bytecodeMatches("0xaabb0000", "0xaacc0000", { 1: [{ start: 1, length: 1 }] })).to.equal(true);
    expect(bytecodeMatches("0xaabb0000", "0xaabb000000", {})).to.equal(false);
  });
});

describe("manual verification package (Standard JSON input)", function () {
  it("builds a package from the build-info with identical compiler settings", async function () {
    const { deployments, taxAddr, expected } = await loadFixture(fixture);
    const pkg = await buildVerificationPackage(hre, { address: taxAddr }, { deployments });
    const buildInfo = await hre.artifacts.getBuildInfo(FQN.TaxToken);

    expect(pkg.contractName).to.equal(FQN.TaxToken);
    expect(pkg.compilerVersion).to.equal(`v${buildInfo.solcLongVersion}`);
    expect(pkg.compilerVersion).to.match(/^v0\.8\.26\+commit\./);
    expect(pkg.optimizer).to.deep.equal({ enabled: true, runs: 200 });
    expect(pkg.viaIR).to.equal(true);
    expect(pkg.standardJsonInput.settings).to.deep.equal(buildInfo.input.settings);
    expect(pkg.standardJsonInput.language).to.equal("Solidity");

    const sources = Object.keys(pkg.standardJsonInput.sources);
    expect(sources).to.include("contracts/tokens/TaxToken.sol");
    expect(sources).to.include("contracts/tokens/PlatformTaxBase.sol");
    expect(sources).to.include("contracts/interfaces/IUniswapV2.sol");
    expect(sources).to.include("@openzeppelin/contracts/token/ERC20/ERC20.sol");
    expect(sources).to.not.include("contracts/Presale.sol");
    expect(sources).to.not.include("contracts/test/MockDex.sol");
    for (const s of sources) expect(pkg.standardJsonInput.sources[s].content).to.equal(buildInfo.input.sources[s].content);

    // Decoding the encoded arguments yields the original values
    const artifact = await hre.artifacts.readArtifact(FQN.TaxToken);
    const types = artifact.abi.find((f) => f.type === "constructor").inputs;
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, pkg.constructorArguments.abiEncoded);
    expect(norm(Array.from(decoded))).to.deep.equal(norm(expected[taxAddr].args));
    expect(pkg.constructorArguments.abiEncodedNoPrefix).to.equal(pkg.constructorArguments.abiEncoded.slice(2));
    expect(norm(pkg.constructorArguments.decoded)).to.deep.equal(norm(expected[taxAddr].args));
    expect(pkg.readme).to.match(/Standard JSON input/);
    expect(pkg.explorer).to.equal(null); // no explorer for the hardhat network
  });

  it("encodes the Presale struct argument and keeps only the presale dependency closure", async function () {
    const { deployments, presaleAddr, expected } = await loadFixture(fixture);
    const pkg = await buildVerificationPackage(hre, { address: presaleAddr }, { deployments });
    const artifact = await hre.artifacts.readArtifact(FQN.Presale);
    const types = artifact.abi.find((f) => f.type === "constructor").inputs;
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, pkg.constructorArguments.abiEncoded);
    const exp = expected[presaleAddr].args;
    const p = decoded[0];
    expect(norm(Object.fromEntries(Object.keys(exp[0]).map((k) => [k, p[k]])))).to.deep.equal(norm(exp[0]));
    expect(norm(Array.from(decoded).slice(1))).to.deep.equal(norm(exp.slice(1)));
    const sources = Object.keys(pkg.standardJsonInput.sources);
    expect(sources).to.include("contracts/Presale.sol").and.include("contracts/LiquidityLocker.sol");
    expect(sources).to.not.include("contracts/PresaleFactory.sol");
  });

  it("writes <address>.json, <address>.input.json, README.md and a .gitignore", async function () {
    const { deployments, rewardsAddr } = await loadFixture(fixture);
    const out = tmpDir("verify-out");
    const pkg = await buildVerificationPackage(hre, { address: rewardsAddr }, { deployments });
    const { packagePath, inputPath } = writeVerificationPackage(hre, pkg, out);
    expect(packagePath).to.equal(path.join(out, "hardhat", `${rewardsAddr}.json`));
    expect(fs.existsSync(inputPath)).to.equal(true);
    expect(fs.readFileSync(path.join(out, ".gitignore"), "utf8")).to.match(/^\*/);
    expect(fs.existsSync(path.join(out, "hardhat", "README.md"))).to.equal(true);
    const back = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    expect(back.contractName).to.equal(FQN.RewardsToken);
    expect(JSON.parse(fs.readFileSync(inputPath, "utf8"))).to.deep.equal(pkg.standardJsonInput);
  });
});

describe("explorer API handling", function () {
  function serve(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/api` }));
    });
  }

  it("detects a Cloudflare challenge page (HTTP 403 + HTML)", async function () {
    const { server, url } = await serve((req, res) => {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl</body></html>");
    });
    try {
      const r = await probeExplorerApi(url, "blockscout");
      expect(r.status).to.equal("cloudflare");
      expect(r.httpStatus).to.equal(403);
    } finally {
      server.close();
    }
  });

  it("recognises a healthy JSON API and an unreachable one", async function () {
    const seen = [];
    const { server, url } = await serve((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "1", message: "OK", result: "0x10" }));
    });
    try {
      const r = await probeExplorerApi(url, "my-key");
      expect(r.status).to.equal("ok");
      expect(seen[0]).to.match(/apikey=my-key/);
    } finally {
      server.close();
    }
    const dead = await probeExplorerApi("http://127.0.0.1:1/api", null, { timeoutMs: 2000 });
    expect(dead.status).to.equal("unreachable");
  });

  it("classifies hardhat-verify errors", function () {
    expect(classifyVerifyError(new Error("The block explorer's API responded that the contract X at 0x1 is already verified."))).to.equal("already-verified");
    expect(classifyVerifyError(new Error("A network request failed. Error: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"))).to.equal("blocked");
    expect(classifyVerifyError(new Error("Failed to send contract verification request. HTTP status code 403 Just a moment"))).to.equal("blocked");
    expect(classifyVerifyError(new Error("The address 0x1 does not have bytecode. Check the explorer"))).to.equal("not-indexed");
    expect(classifyVerifyError(new Error("A network request failed. Error: fetch failed"))).to.equal("network");
    expect(classifyVerifyError(new Error("The selected network is hardhat. Please select a network supported by Etherscan."))).to.equal("unsupported-network");
    expect(classifyVerifyError(new Error("The contract verification failed. Reason: Fail - Unable to verify"))).to.equal("failed");
  });
});

describe("verification scripts (offline, in-process network)", function () {
  it("verify-contract DRY_RUN prints the submission without touching the network", async function () {
    const { deployments, taxAddr, presaleAddr, expected } = await loadFixture(fixture);
    const lines = [];
    const results = await verifyAddresses(hre, [taxAddr, presaleAddr], { dryRun: true, deployments, quiet: true, log: (l) => lines.push(l) });
    expect(results.map((r) => r.status)).to.deep.equal([STATUS.DRY_RUN, STATUS.DRY_RUN]);
    expect(results[0].contract).to.equal(FQN.TaxToken);
    expect(results[1].contract).to.equal(FQN.Presale);
    expect(norm(results[0].plainArgs)).to.deep.equal(norm(expected[taxAddr].args));
    expect(results[0].encodedArgs).to.match(/^0x[0-9a-f]+$/);
    expect(results[0].sourceCount).to.be.greaterThan(3);
    const text = lines.join("\n");
    expect(text).to.include("verify:verify");
    expect(text).to.include(FQN.TaxToken);
    expect(text).to.match(/compiler:\s+v0\.8\.26/);
  });

  it("verify-contract on an explorer-less network reports unsupported-network and never throws", async function () {
    const { deployments, standardAddr } = await loadFixture(fixture);
    const r = await verifyOne(hre, { address: standardAddr }, { deployments, log: () => {} });
    expect(r.status).to.equal(STATUS.UNSUPPORTED);
    expect(r.contract).to.equal(FQN.StandardToken);
  });

  it("FORCE_MANUAL writes the manual package instead of calling the API", async function () {
    const { deployments, standardAddr } = await loadFixture(fixture);
    const out = tmpDir("force-manual");
    const r = await verifyOne(hre, { address: standardAddr }, { deployments, forceManual: true, outDir: out, log: () => {} });
    expect(r.status).to.equal(STATUS.MANUAL);
    expect(fs.existsSync(r.packagePath)).to.equal(true);
    expect(fs.existsSync(r.inputPath)).to.equal(true);
    expect(r.encodedArgs).to.match(/^0x/);
  });

  it("reports a clean failure for an address that is not a platform contract", async function () {
    const { deployments, weth } = await loadFixture(fixture);
    const r = await verifyOne(hre, { address: weth.target }, { deployments, dryRun: true, log: () => {} });
    expect(r.status).to.equal(STATUS.FAILED);
    expect(r.message).to.match(/not a HoodSale/);
  });

  it("verify-platform DRY_RUN covers every platform contract plus the three deployers and the rewards code holder in deploy order", async function () {
    const { deployments, expected, tokenFactory } = await loadFixture(fixture);
    const lines = [];
    const results = await verifyPlatform.run(hre, { dryRun: true, deployments, log: (l) => lines.push(l) });
    const labels = results.map((r) => r.label);
    expect(labels).to.deep.equal([
      "treasury", "locker", "tokenFactory", "standardDeployer", "taxDeployer", "rewardsDeployer", "rewardsTokenCode",
      "presaleFactory", "hoodsale", "metadataRegistry", "lens",
    ]);
    for (const r of results) {
      expect(r.status, r.label).to.equal(STATUS.DRY_RUN);
      expect(r.contract, r.label).to.equal(expected[r.address].contract);
      expect(norm(r.plainArgs), r.label).to.deep.equal(norm(expected[r.address].args));
    }
    expect(results[3].address).to.equal(await tokenFactory.standardDeployer());
    expect(lines.join("\n")).to.include("summary: dry-run=11");
  });

  it("verify-platform marks keys missing from the deployments file as skipped", async function () {
    const { deployments } = await loadFixture(fixture);
    const partial = { ...deployments };
    delete partial.lens;
    delete partial.metadataRegistry;
    const results = await verifyPlatform.run(hre, { dryRun: true, deployments: partial, quiet: true, log: () => {} });
    const skipped = results.filter((r) => r.status === "skipped").map((r) => r.label);
    expect(skipped).to.deep.equal(["metadataRegistry", "lens"]);
  });
});

describe("auto-verify watcher (offline)", function () {
  it("picks up every TokenCreated / PresaleCreated from the cursor and dry-runs them", async function () {
    const { deployments, expected, standardAddr, taxAddr, rewardsAddr, untouchedAddr, presaleAddr } = await loadFixture(fixture);
    const lines = [];
    const w = createWatcher(hre, {
      deployments,
      verifyPresales: true,
      stateFile: path.join(tmpDir("verify-state"), "hardhat.json"),
      startBlock: 0,
      confirmations: 0,
      dryRun: true,
      logChunk: 3, // also exercise the chunked scan
      log: (...a) => lines.push(a.join(" ")),
    });
    const s = await w.tick();
    expect(s.error).to.equal(null);
    expect(s.found).to.equal(5);
    expect(s.pending).to.equal(0);
    expect(s.done).to.equal(5);
    const done = w.state.done;
    for (const a of [standardAddr, taxAddr, rewardsAddr, untouchedAddr, presaleAddr]) {
      const d = done[a.toLowerCase()];
      expect(d, a).to.not.equal(undefined);
      expect(d.status).to.equal(STATUS.DRY_RUN);
      expect(d.contract).to.equal(expected[a].contract);
      expect(d.kind).to.equal(a === presaleAddr ? "presale" : "token");
    }
    expect(fs.existsSync(w.stateFile)).to.equal(false); // DRY_RUN does not write the state file
    // A second round finds nothing new
    const s2 = await w.tick();
    expect(s2.found).to.equal(0);
    expect(s2.done).to.equal(5);
  });

  it("waits for confirmations, persists the cursor and resumes from the state file", async function () {
    const { deployments, standardAddr } = await loadFixture(fixture);
    const stateFile = path.join(tmpDir("verify-state"), "hardhat.json");
    const out = tmpDir("verify-out");
    const latest = await ethers.provider.getBlockNumber();
    const mk = () =>
      createWatcher(hre, { deployments, verifyPresales: true, stateFile, startBlock: 0, confirmations: latest + 5, forceManual: true, outDir: out, log: () => {} });

    const w1 = mk();
    const s1 = await w1.tick();
    expect(s1.found).to.equal(0); // not enough confirmations yet
    expect(fs.existsSync(stateFile)).to.equal(true);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).cursor).to.equal(0);

    await mine(latest + 10);
    const s2 = await w1.tick();
    expect(s2.found).to.equal(5);
    expect(s2.done).to.equal(5);
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(saved.cursor).to.equal((await ethers.provider.getBlockNumber()) - (latest + 5));
    expect(saved.done[standardAddr.toLowerCase()].status).to.equal(STATUS.MANUAL);
    expect(fs.existsSync(saved.done[standardAddr.toLowerCase()].packagePath)).to.equal(true);

    // A new process resumes from the same file: nothing is queued again
    const w2 = mk();
    expect(w2.state.cursor).to.equal(saved.cursor);
    const s3 = await w2.tick();
    expect(s3.found).to.equal(0);
    expect(Object.keys(w2.state.done)).to.have.length(5);
  });

  it("retries with exponential backoff and gives up after MAX_ATTEMPTS without crashing", async function () {
    const { deployments, presaleAddr } = await loadFixture(fixture);
    const calls = [];
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const w = createWatcher(hre, {
        deployments,
        verifyPresales: true,
        stateFile: path.join(tmpDir("verify-state"), "hardhat.json"),
        startBlock: 0,
        confirmations: 0,
        maxAttempts: 3,
        backoffBaseMs: 1000,
        backoffMaxMs: 3000,
        log: () => {},
        verifyFn: async (_hre, target) => {
          calls.push(target.address);
          if (target.address === presaleAddr) return { status: STATUS.VERIFIED, message: "ok", contract: FQN.Presale };
          throw new Error("explorer exploded");
        },
      });
      await w.tick(); // all contracts, attempt 1
      expect(calls).to.have.length(5);
      expect(w.state.done[presaleAddr.toLowerCase()].status).to.equal(STATUS.VERIFIED);
      const pending = Object.values(w.state.pending);
      expect(pending).to.have.length(4);
      expect(pending.every((p) => p.attempts === 1 && p.nextAttemptAt === now + 1000)).to.equal(true);

      await w.tick(); // not due yet
      expect(calls).to.have.length(5);
      now += 1000;
      await w.tick(); // attempt 2, backoff 2000
      expect(calls).to.have.length(9);
      expect(Object.values(w.state.pending).every((p) => p.attempts === 2 && p.nextAttemptAt === now + 2000)).to.equal(true);
      now += 2000;
      await w.tick(); // attempt 3 = MAX_ATTEMPTS -> gave-up
      expect(calls).to.have.length(13);
      expect(Object.keys(w.state.pending)).to.have.length(0);
      const gaveUp = Object.values(w.state.done).filter((d) => d.status === "gave-up");
      expect(gaveUp).to.have.length(4);
      expect(gaveUp[0].message).to.match(/explorer exploded/);
    } finally {
      Date.now = realNow;
    }
  });
});
