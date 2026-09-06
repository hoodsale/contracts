// Deploys the platform on a Robinhood Chain (chainId 4663) mainnet fork with the REAL Uniswap V2
// router and the REAL Uniswap V3 (SwapRouter02, QuoterV2, factory) for the reward swap's V3 leg.
// Follows the same deploy order as test/helpers.js; the only difference is that the on-chain
// Router02 / Factory / WETH and the V3 set are used instead of the mocks.
//
// Usage: FORK_URL=https://rpc.mainnet.chain.robinhood.com npx hardhat test test/fork/robinhood-uniswap.test.js
// (hardhat.config.js enables forking only when FORK_URL is given; FORK_BLOCK pins the block.)
const { ethers, network } = require("hardhat");
const { takeSnapshot } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { v3AddressesFor } = require("../../scripts/lib/reward-tokens");

const addr = (a) => ethers.getAddress(a.toLowerCase());

/** Real addresses on Robinhood Chain mainnet (verified on 2026-09-02). */
const ROBINHOOD = {
  chainId: 4663,
  router: addr("0x89e5db8b5aa49aa85ac63f691524311aeb649eba"), // Uniswap V2 Router02
  factory: addr("0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f"), // Uniswap V2 Factory
  weth: addr("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  usdg: addr("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  tsla: addr("0x322F0929c4625eD5bAd873c95208D54E1c003b2d"), // tokenized stock
  aapl: addr("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"), // tokenized stock
  // Uniswap V3: factory, SwapRouter02 and QuoterV2 (scripts/lib/reward-tokens.js)
  v3: v3AddressesFor(4663),
};

const DEAD = "0x000000000000000000000000000000000000dEaD";
/** The LP amount UniswapV2Pair permanently locks on the first mint (minted to address(0)). */
const MINIMUM_LIQUIDITY = 1000n;

// The real contracts have no artifacts; the functions we need are defined with a human-readable ABI.
const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
  "function createPair(address tokenA, address tokenB) returns (address)",
  "function feeTo() view returns (address)",
  "function allPairsLength() view returns (uint256)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function kLast() view returns (uint256)",
  "function MINIMUM_LIQUIDITY() view returns (uint256)",
  "function sync()",
  "function mint(address to) returns (uint256 liquidity)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
];

const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)",
];

// ------------------------------------------------------------------ rpc helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorText(e) {
  return [e && e.message, e && e.shortMessage, e && e.error && e.error.message, e && e.cause && e.cause.message]
    .filter(Boolean)
    .join(" | ");
}

/** Transient errors of the public RPC (429, timeout, dropped connection). */
function isTransientRpcError(e) {
  return /429|Too Many Requests|rate limit|limit exceeded|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|timeout|timed out|502|503|504/i.test(
    errorText(e)
  );
}

/** The pinned block's state is no longer served by the RPC (not an archive node). */
function isPrunedStateError(e) {
  return /metadata is not found|missing trie node|header not found|state (is )?not available/i.test(errorText(e));
}

function explain(e) {
  if (isPrunedStateError(e)) {
    const err = new Error(
      "The Robinhood public RPC no longer serves state for the pinned FORK_BLOCK (it keeps roughly the last " +
        "5k to 20k blocks, about 10 to 30 minutes at 10 blocks per second). Re-run with a fresh FORK_BLOCK " +
        "(npm run test:fork resolves one automatically). Original error: " +
        errorText(e)
    );
    err.cause = e;
    return err;
  }
  return e;
}

/** Small retry with exponential backoff for read-only RPC operations. */
async function withRetry(fn, { attempts = 4, baseDelayMs = 1500, label = "rpc" } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientRpcError(e)) throw explain(e);
      const delay = baseDelayMs * 2 ** i;
      console.log(`      [fork] ${label}: transient RPC error, retry ${i + 1}/${attempts} in ${delay} ms`);
      await sleep(delay);
    }
  }
  throw explain(last);
}

/**
 * For state-changing setup steps: on failure it reverts to the snapshot and
 * starts over, so half-finished deploys do not pile up on top of the retry.
 */
async function withSnapshotRetry(fn, { attempts = 3, baseDelayMs = 2000, label = "setup" } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const snap = await takeSnapshot();
    try {
      return await fn();
    } catch (e) {
      last = e;
      await snap.restore();
      if (!isTransientRpcError(e)) throw explain(e);
      const delay = baseDelayMs * 2 ** i;
      console.log(`      [fork] ${label}: transient RPC error, retry ${i + 1}/${attempts} in ${delay} ms`);
      await sleep(delay);
    }
  }
  throw explain(last);
}

/** Funds the test wallets with hardhat_setBalance. */
async function fundSigners(signers, amountWei) {
  for (const s of signers) {
    await network.provider.send("hardhat_setBalance", [s.address, ethers.toQuantity(amountWei)]);
  }
}

/** Fork info (chainId, pinned block). */
async function forkInfo() {
  const meta = await network.provider.send("hardhat_metadata", []);
  return meta.forkedNetwork ? { ...meta.forkedNetwork, clientVersion: meta.clientVersion } : null;
}

/**
 * EDR does not allow eth_call on the fork block ITSELF: despite chains[4663].hardforkHistory
 * in the config it returns the error "No known hardfork for execution on historical
 * block". After the first locally produced block, calls work normally;
 * that is why one block is mined before any read-only call.
 */
async function mineOne() {
  await network.provider.send("evm_mine", []);
}

// ------------------------------------------------------------------ contract access

function routerAt(runner = ethers.provider) {
  return new ethers.Contract(ROBINHOOD.router, ROUTER_ABI, runner);
}

function factoryAt(runner = ethers.provider) {
  return new ethers.Contract(ROBINHOOD.factory, FACTORY_ABI, runner);
}

function wethAt(runner = ethers.provider) {
  return new ethers.Contract(ROBINHOOD.weth, WETH_ABI, runner);
}

function pairAt(address, runner = ethers.provider) {
  return new ethers.Contract(address, PAIR_ABI, runner);
}

function erc20At(address, runner = ethers.provider) {
  return new ethers.Contract(address, ERC20_ABI, runner);
}

/** Returns the pair reserves in (token, WETH) order. */
async function reservesOf(pair, tokenAddress) {
  const [r0, r1] = await pair.getReserves();
  const token0 = await pair.token0();
  return ethers.getAddress(token0) === ethers.getAddress(tokenAddress)
    ? { token: r0, weth: r1 }
    : { token: r1, weth: r0 };
}

// ------------------------------------------------------------------ Uniswap V2 math

/** Babylonian integer square root (same result as UniswapV2 Math.sqrt: floor). */
function sqrt(x) {
  if (x < 0n) throw new Error("negative sqrt");
  if (x < 2n) return x;
  let z = x;
  let y = x / 2n + 1n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

/** UniswapV2Library.getAmountOut: 0.3% pool fee. */
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}

/** LP minted on the first mint: sqrt(a * b) - MINIMUM_LIQUIDITY. */
function firstMintLiquidity(amountToken, amountWeth) {
  return sqrt(amountToken * amountWeth) - MINIMUM_LIQUIDITY;
}

// ------------------------------------------------------------------ platform setup

/**
 * Deploys the whole platform on the Robinhood Chain fork with the real Uniswap V2 router.
 * Signers: deployer (platform owner), alice/bob/carol/dave (users),
 * marketing (HOODS marketing wallet), keeper (launch bot).
 */
async function deployPlatformOnFork() {
  return withSnapshotRetry(
    async () => {
      const signers = await ethers.getSigners();
      const [deployer, alice, bob, carol, dave, marketing, keeper] = signers;
      await fundSigners([deployer, alice, bob, carol, dave, marketing, keeper], ethers.parseEther("100000"));

      const routerAddress = ROBINHOOD.router;

      const treasury = await ethers.deployContract("Treasury", [deployer.address]);
      const locker = await ethers.deployContract("LiquidityLocker");
      const tokenFactory = await ethers.deployContract("TokenFactory", [
        deployer.address,
        treasury.target,
        routerAddress,
      ]);

      const standardDeployer = await ethers.deployContract("StandardTokenDeployer", [tokenFactory.target]);
      const taxDeployer = await ethers.deployContract("TaxTokenDeployer", [tokenFactory.target]);
      // The rewards deployer carries the real SwapRouter02 and QuoterV2 of Robinhood Chain
      const rewardsDeployer = await ethers.deployContract("RewardsTokenDeployer", [
        tokenFactory.target,
        ROBINHOOD.v3.router,
        ROBINHOOD.v3.quoter,
      ]);
      await tokenFactory.setDeployers(standardDeployer.target, taxDeployer.target, rewardsDeployer.target);

      const presaleFactory = await ethers.deployContract("PresaleFactory", [
        deployer.address,
        treasury.target,
        tokenFactory.target,
        locker.target,
        routerAddress,
      ]);
      await tokenFactory.setPresaleFactory(presaleFactory.target);
      // Presale's creation code lives in its own contract (24KB limit on the factory)
      const presaleCode = await ethers.deployContract("PresaleCode");
      await presaleFactory.setPresaleCode(presaleCode.target);

      // The HOODS constructor opens the HOODS/WETH pair on the real factory
      const hoodsale = await ethers.deployContract("HoodSaleToken", [
        deployer.address,
        routerAddress,
        treasury.target,
        marketing.address,
      ]);
      await treasury.setRouter(routerAddress);
      await treasury.setHoodsale(hoodsale.target);
      await hoodsale.setPresaleFactory(presaleFactory.target);
      await presaleFactory.setTokenAllowed(hoodsale.target, true);
      await presaleFactory.setLaunchKeeper(keeper.address);

      const metadataRegistry = await ethers.deployContract("TokenMetadataRegistry", [tokenFactory.target]);
      await metadataRegistry.setPresaleFactory(presaleFactory.target);
      const lens = await ethers.deployContract("HoodSaleLens", [
        presaleFactory.target,
        tokenFactory.target,
        routerAddress,
      ]);
      // One-transaction token + quick presale creation; WETH is the only reward token allowed at
      // the start (the V3 stock tests add TSLA through setRewardTokenAllowed)
      const quickLaunch = await ethers.deployContract("QuickLaunch", [
        tokenFactory.target,
        presaleFactory.target,
        metadataRegistry.target,
        [ROBINHOOD.weth],
        ethers.ZeroAddress,
      ]);
      await presaleFactory.setQuickLaunch(quickLaunch.target);

      return {
        metadataRegistry,
        lens,
        quickLaunch,
        presaleCode,
        rewardsDeployer,
        v3Router: ROBINHOOD.v3.router,
        v3Quoter: ROBINHOOD.v3.quoter,
        v3Factory: ROBINHOOD.v3.factory,
        deployer,
        alice,
        bob,
        carol,
        dave,
        marketing,
        keeper,
        // Real on-chain contracts (instead of MockDex)
        weth: wethAt(deployer),
        dexFactory: factoryAt(deployer),
        router: routerAt(deployer),
        routerAddress,
        treasury,
        locker,
        tokenFactory,
        presaleFactory,
        hoodsale,
      };
    },
    { label: "deployPlatformOnFork" }
  );
}

// ------------------------------------------------------------------ test helpers

async function deadline() {
  const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  return (await time.latest()) + 600;
}

function findEvent(receipt, iface, name) {
  for (const log of receipt.logs) {
    let parsed = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch (e) {
      parsed = null;
    }
    if (parsed && parsed.name === name) return parsed;
  }
  return null;
}

module.exports = {
  ROBINHOOD,
  DEAD,
  MINIMUM_LIQUIDITY,
  ROUTER_ABI,
  FACTORY_ABI,
  PAIR_ABI,
  WETH_ABI,
  ERC20_ABI,
  deployPlatformOnFork,
  fundSigners,
  forkInfo,
  mineOne,
  withRetry,
  withSnapshotRetry,
  isTransientRpcError,
  isPrunedStateError,
  routerAt,
  factoryAt,
  wethAt,
  pairAt,
  erc20At,
  reservesOf,
  sqrt,
  getAmountOut,
  firstMintLiquidity,
  deadline,
  findEvent,
};
