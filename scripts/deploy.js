const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { rewardAllowlistFor, rewardRoutesFor, applyRewardRoutes, describeRewardRoutes, v3AddressesFor } = require("./lib/reward-tokens");

// Official Uniswap V2 Router02 on Robinhood Chain mainnet (chainId 4663)
const ROBINHOOD_UNISWAP_V2_ROUTER = "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  console.log(`Deploying with ${deployer.address} on ${network}`);

  let router = process.env.ROUTER_ADDRESS;
  const marketingWallet = process.env.MARKETING_WALLET || deployer.address;
  // Local stand-ins for the foreign reward tokens (WETH is the mock DEX's own)
  let weth;
  let usdg;
  let tsla;
  // The Uniswap V3 leg of the reward swap: SwapRouter02 and QuoterV2 of the chain (the mocks
  // locally; zero addresses on a chain without V3, where stock rewards are not possible)
  let v3Factory;
  let v3Router = hre.ethers.ZeroAddress;
  let v3Quoter = hre.ethers.ZeroAddress;

  // Deploy a mock DEX on the local network
  if (!router && (network === "hardhat" || network === "localhost")) {
    const mockWeth = await hre.ethers.deployContract("MockWETH");
    await mockWeth.waitForDeployment();
    const factory = await hre.ethers.deployContract("MockFactory");
    await factory.waitForDeployment();
    const mockRouter = await hre.ethers.deployContract("MockRouter", [factory.target, mockWeth.target]);
    await mockRouter.waitForDeployment();
    await (await factory.setRouter(mockRouter.target)).wait();
    router = mockRouter.target;
    weth = mockWeth.target;
    // A mock USDG (6 decimals, 100M to the deployer) with its WETH pair, so quick Rewards sales
    // can pay in a stablecoin locally; seed.js fills the pool
    const mockUsdg = await hre.ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 100_000_000n * 10n ** 6n]);
    await mockUsdg.waitForDeployment();
    await (await factory.createPair(mockUsdg.target, mockWeth.target)).wait();
    usdg = mockUsdg.target;
    console.log("MockDex:", { weth, factory: factory.target, router, usdg });

    // A mock Uniswap V3 (factory, SwapRouter02, QuoterV2) with a mock tokenized stock, so quick
    // Rewards sales can pay a stock locally the way they do on Robinhood Chain: WETH/USDG at
    // 0.05% (40,000 USDG / 20 ETH) and WETH/TSLA at 0.3% (345 TSLA / 50 ETH, about the mainnet
    // rate). Liquidity goes into a mock pool by transferring both tokens and calling sync().
    const mockV3Factory = await hre.ethers.deployContract("MockV3Factory");
    await mockV3Factory.waitForDeployment();
    const mockV3Router = await hre.ethers.deployContract("MockSwapRouter02", [mockV3Factory.target, mockWeth.target]);
    await mockV3Router.waitForDeployment();
    await (await mockV3Factory.setRouter(mockV3Router.target)).wait();
    const mockV3Quoter = await hre.ethers.deployContract("MockQuoterV2", [mockV3Factory.target]);
    await mockV3Quoter.waitForDeployment();
    const mockTsla = await hre.ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, hre.ethers.parseEther("1000000")]);
    await mockTsla.waitForDeployment();
    const fill = async (tokenA, amountA, tokenB, amountB, fee) => {
      await (await mockV3Factory.createPool(tokenA.target, tokenB.target, fee)).wait();
      const pool = await hre.ethers.getContractAt("MockV3Pool", await mockV3Factory.getPool(tokenA.target, tokenB.target, fee));
      await (await tokenA.transfer(pool.target, amountA)).wait();
      await (await tokenB.transfer(pool.target, amountB)).wait();
      await (await pool.sync()).wait();
      return pool.target;
    };
    await (await mockWeth.deposit({ value: hre.ethers.parseEther("70") })).wait();
    const usdgPool = await fill(mockWeth, hre.ethers.parseEther("20"), mockUsdg, 40_000n * 10n ** 6n, 500);
    const tslaPool = await fill(mockWeth, hre.ethers.parseEther("50"), mockTsla, hre.ethers.parseEther("345"), 3000);
    v3Factory = mockV3Factory.target;
    v3Router = mockV3Router.target;
    v3Quoter = mockV3Quoter.target;
    tsla = mockTsla.target;
    console.log("MockUniswapV3:", { v3Factory, v3Router, v3Quoter, tsla, usdgPool, tslaPool });
  }
  if (!router) router = ROBINHOOD_UNISWAP_V2_ROUTER;
  if (!v3Factory) {
    const v3 = v3AddressesFor(Number((await hre.ethers.provider.getNetwork()).chainId));
    if (v3) ({ factory: v3Factory, router: v3Router, quoter: v3Quoter } = v3);
    else console.log("No Uniswap V3 addresses for this chain: the reward swap has no V3 leg (no stock rewards)");
  }

  const treasury = await hre.ethers.deployContract("Treasury", [deployer.address]);
  await treasury.waitForDeployment();

  const locker = await hre.ethers.deployContract("LiquidityLocker");
  await locker.waitForDeployment();

  const tokenFactory = await hre.ethers.deployContract("TokenFactory", [
    deployer.address,
    treasury.target,
    router,
  ]);
  await tokenFactory.waitForDeployment();

  const standardDeployer = await hre.ethers.deployContract("StandardTokenDeployer", [tokenFactory.target]);
  const taxDeployer = await hre.ethers.deployContract("TaxTokenDeployer", [tokenFactory.target]);
  // The rewards deployer carries the chain's V3 router and quoter and hands every new Rewards
  // token the V3 route QuickLaunch stores for its reward token
  const rewardsDeployer = await hre.ethers.deployContract("RewardsTokenDeployer", [tokenFactory.target, v3Router, v3Quoter]);
  await Promise.all([
    standardDeployer.waitForDeployment(),
    taxDeployer.waitForDeployment(),
    rewardsDeployer.waitForDeployment(),
  ]);
  await (
    await tokenFactory.setDeployers(standardDeployer.target, taxDeployer.target, rewardsDeployer.target)
  ).wait();

  const presaleFactory = await hre.ethers.deployContract("PresaleFactory", [
    deployer.address,
    treasury.target,
    tokenFactory.target,
    locker.target,
    router,
  ]);
  await presaleFactory.waitForDeployment();
  await (await tokenFactory.setPresaleFactory(presaleFactory.target)).wait();
  // Presale's creation code lives in its own contract (the factory would exceed the 24KB limit)
  const presaleCode = await hre.ethers.deployContract("PresaleCode");
  await presaleCode.waitForDeployment();
  await (await presaleFactory.setPresaleCode(presaleCode.target)).wait();

  const hoodsale = await hre.ethers.deployContract("HoodSaleToken", [
    deployer.address,
    router,
    treasury.target,
    marketingWallet,
  ]);
  await hoodsale.waitForDeployment();

  await (await treasury.setRouter(router)).wait();
  await (await treasury.setHoodsale(hoodsale.target)).wait();

  // Let HOODS run its own presale through the platform
  await (await hoodsale.setPresaleFactory(presaleFactory.target)).wait();
  await (await presaleFactory.setTokenAllowed(hoodsale.target, true)).wait();
  // Platform bot that triggers scheduled launches on behalf of the owner
  await (await presaleFactory.setLaunchKeeper(process.env.LAUNCH_KEEPER || deployer.address)).wait();
  // The platform share of a completed raise: 2.5% on mainnet (scripts/set-fees.js), mirrored here
  // so the local site shows the live numbers. The exit penalty stays at the contract default.
  const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS || 250);
  await (await presaleFactory.setFees(platformFeeBps, await presaleFactory.exitPenaltyBps())).wait();
  // No creation fees on mainnet (both are factory settings, the contract defaults are 0.1 and 0.03 ETH)
  await (await presaleFactory.setCreationFee(hre.ethers.parseEther(process.env.CREATION_FEE_ETH || "0"))).wait();
  await (await presaleFactory.setQuickCreationFee(hre.ethers.parseEther(process.env.QUICK_CREATION_FEE_ETH || "0"))).wait();

  const metadataRegistry = await hre.ethers.deployContract("TokenMetadataRegistry", [tokenFactory.target]);
  await metadataRegistry.waitForDeployment();
  // Let allowlisted platform tokens (HOODS) write a profile as well
  await (await metadataRegistry.setPresaleFactory(presaleFactory.target)).wait();

  const lens = await hre.ethers.deployContract("HoodSaleLens", [
    presaleFactory.target,
    tokenFactory.target,
    router,
  ]);
  await lens.waitForDeployment();

  // Quick presale: token + sale with locked rules in one transaction. The reward allowlist is
  // WETH, USDG and the tokenized stocks on mainnet, the mock WETH, USDG and TSLA locally.
  const localMocks = { router, usdg, tsla, v3Factory, v3Router, v3Quoter };
  const rewardTokens = await rewardAllowlistFor(hre, localMocks);
  const quickLaunch = await hre.ethers.deployContract("QuickLaunch", [
    tokenFactory.target,
    presaleFactory.target,
    metadataRegistry.target,
    rewardTokens,
    hre.ethers.ZeroAddress, // the first generation
  ]);
  await quickLaunch.waitForDeployment();
  // Only QuickLaunch may create quick presales
  await (await presaleFactory.setQuickLaunch(quickLaunch.target)).wait();
  console.log("QuickLaunch reward allowlist:", rewardTokens);
  // The tokenized stocks swap through the Uniswap V3 paths stored here (the best quoted candidate
  // per stock on mainnet, WETH -0.3%-> TSLA on the local mock)
  await applyRewardRoutes(hre, quickLaunch, await rewardRoutesFor(hre, localMocks, { log: console.log }), console.log);
  for (const line of await describeRewardRoutes(hre, quickLaunch)) console.log(`  route ${line}`);

  const addresses = {
    network,
    router,
    ...(weth ? { weth } : {}),
    ...(usdg ? { usdg } : {}),
    ...(tsla ? { tsla } : {}),
    ...(v3Factory ? { v3Factory } : {}),
    ...(v3Router !== hre.ethers.ZeroAddress ? { v3Router, v3Quoter } : {}),
    treasury: treasury.target,
    locker: locker.target,
    tokenFactory: tokenFactory.target,
    presaleFactory: presaleFactory.target,
    presaleCode: presaleCode.target,
    hoodsale: hoodsale.target,
    metadataRegistry: metadataRegistry.target,
    lens: lens.target,
    quickLaunch: quickLaunch.target,
    rewardsDeployer: rewardsDeployer.target,
    marketingWallet,
  };
  console.log(addresses);

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${network}.json`), JSON.stringify(addresses, null, 2));
  console.log(`Saved to deployments/${network}.json`);

  // Keep the frontend config up to date on the local network as well
  if (network === "hardhat" || network === "localhost") {
    const frontendConfig = path.join(__dirname, "..", "..", "frontend", "src", "config", "localhost.json");
    if (fs.existsSync(path.dirname(frontendConfig))) {
      fs.writeFileSync(frontendConfig, JSON.stringify(addresses, null, 2));
      console.log("Updated frontend/src/config/localhost.json");
    }
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
