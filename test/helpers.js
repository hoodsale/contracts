const { ethers } = require("hardhat");

/**
 * Deploys the whole platform together with MockDex.
 * Signers: deployer (platform owner), alice/bob/carol/dave (users),
 * marketing (HOODSALE marketing wallet).
 */
async function deployPlatform() {
  const [deployer, alice, bob, carol, dave, marketing, keeper] = await ethers.getSigners();

  const weth = await ethers.deployContract("MockWETH");
  const dexFactory = await ethers.deployContract("MockFactory");
  const router = await ethers.deployContract("MockRouter", [dexFactory.target, weth.target]);
  await dexFactory.setRouter(router.target);

  const treasury = await ethers.deployContract("Treasury", [deployer.address]);
  const locker = await ethers.deployContract("LiquidityLocker");
  const tokenFactory = await ethers.deployContract("TokenFactory", [
    deployer.address,
    treasury.target,
    router.target,
  ]);

  // The V3 leg of the reward swap: a mock factory, SwapRouter02 and QuoterV2 (tokenized stocks
  // trade on Uniswap V3 on Robinhood Chain)
  const v3Factory = await ethers.deployContract("MockV3Factory");
  const v3Router = await ethers.deployContract("MockSwapRouter02", [v3Factory.target, weth.target]);
  await v3Factory.setRouter(v3Router.target);
  const v3Quoter = await ethers.deployContract("MockQuoterV2", [v3Factory.target]);

  const standardDeployer = await ethers.deployContract("StandardTokenDeployer", [tokenFactory.target]);
  const taxDeployer = await ethers.deployContract("TaxTokenDeployer", [tokenFactory.target]);
  const rewardsDeployer = await ethers.deployContract("RewardsTokenDeployer", [
    tokenFactory.target,
    v3Router.target,
    v3Quoter.target,
  ]);
  await tokenFactory.setDeployers(standardDeployer.target, taxDeployer.target, rewardsDeployer.target);

  const presaleFactory = await ethers.deployContract("PresaleFactory", [
    deployer.address,
    treasury.target,
    tokenFactory.target,
    locker.target,
    router.target,
  ]);
  await tokenFactory.setPresaleFactory(presaleFactory.target);
  // Presale's creation code lives in its own contract (24KB limit on the factory)
  const presaleCode = await ethers.deployContract("PresaleCode");
  await presaleFactory.setPresaleCode(presaleCode.target);

  const hoodsale = await ethers.deployContract("HoodSaleToken", [
    deployer.address,
    router.target,
    treasury.target,
    marketing.address,
  ]);
  await treasury.setRouter(router.target);
  await treasury.setHoodsale(hoodsale.target);
  await hoodsale.setPresaleFactory(presaleFactory.target);
  await presaleFactory.setTokenAllowed(hoodsale.target, true);
  // The platform's launch bot: triggers scheduled sales on the owner's behalf
  await presaleFactory.setLaunchKeeper(keeper.address);

  const metadataRegistry = await ethers.deployContract("TokenMetadataRegistry", [tokenFactory.target]);
  await metadataRegistry.setPresaleFactory(presaleFactory.target);
  const lens = await ethers.deployContract("HoodSaleLens", [
    presaleFactory.target,
    tokenFactory.target,
    router.target,
  ]);
  // One-transaction token + quick presale creation; WETH is the only reward token allowed at the
  // start (tests add their own through setRewardTokenAllowed)
  const quickLaunch = await ethers.deployContract("QuickLaunch", [
    tokenFactory.target,
    presaleFactory.target,
    metadataRegistry.target,
    [weth.target],
    ethers.ZeroAddress,
  ]);
  // Only QuickLaunch may create quick presales
  await presaleFactory.setQuickLaunch(quickLaunch.target);

  return {
    metadataRegistry,
    lens,
    quickLaunch,
    presaleCode,
    v3Factory,
    v3Router,
    v3Quoter,
    rewardsDeployer,
    deployer,
    alice,
    bob,
    carol,
    dave,
    marketing,
    keeper,
    weth,
    dexFactory,
    router,
    treasury,
    locker,
    tokenFactory,
    presaleFactory,
    hoodsale,
  };
}

module.exports = { deployPlatform };
