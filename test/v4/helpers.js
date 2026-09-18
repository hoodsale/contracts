// Local Uniswap v4 for the HoodSale tests.
//
// v4-core and v4-periphery are built with Foundry under evmVersion cancun, while this project
// compiles at paris. Hardhat therefore never compiles their sources: PoolManager, PositionManager,
// StateView and V4Quoter are deployed from the artifacts the npm packages ship, which are the very
// bytecode that runs on Robinhood Chain mainnet (test/v4/fixtures/mainnet-v4.json records the
// runtime sizes). Permit2 and the CREATE2 proxy have no artifacts and no constructor worth running,
// so their mainnet runtime code is planted at their canonical addresses.
const { ethers, network } = require("hardhat");

const POOL_MANAGER_ARTIFACT = require("@uniswap/v4-core/out/PoolManager.sol/PoolManager.json");
const POSITION_MANAGER_ARTIFACT = require("@uniswap/v4-periphery/foundry-out/PositionManager.sol/PositionManager.json");
const STATE_VIEW_ARTIFACT = require("@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json");
const QUOTER_ARTIFACT = require("@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json");

const MAINNET = require("./fixtures/mainnet-v4.json");

/** Canonical addresses, the same on every chain including Robinhood Chain. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CREATE2_PROXY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** Uniswap v4 hook flag bits (v4-core Hooks.sol). */
const HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1 << 13,
  AFTER_INITIALIZE: 1 << 12,
  BEFORE_ADD_LIQUIDITY: 1 << 11,
  AFTER_ADD_LIQUIDITY: 1 << 10,
  BEFORE_REMOVE_LIQUIDITY: 1 << 9,
  AFTER_REMOVE_LIQUIDITY: 1 << 8,
  BEFORE_SWAP: 1 << 7,
  AFTER_SWAP: 1 << 6,
  BEFORE_DONATE: 1 << 5,
  AFTER_DONATE: 1 << 4,
  BEFORE_SWAP_RETURNS_DELTA: 1 << 3,
  AFTER_SWAP_RETURNS_DELTA: 1 << 2,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1 << 1,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1 << 0,
};
const ALL_HOOK_MASK = (1 << 14) - 1;

/** Actions the PositionManager understands (v4-periphery Actions.sol). */
const ACTIONS = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  SWEEP: 0x14,
};
/** ActionConstants: address(1) means "the caller", address(2) "this contract". */
const MSG_SENDER = "0x0000000000000000000000000000000000000001";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const ETH = ethers.ZeroAddress;

/** Plants a contract's runtime code at a fixed address (Permit2, the CREATE2 proxy). */
async function plantCode(address, code) {
  await network.provider.send("hardhat_setCode", [address, code]);
}

/**
 * Deploys the Uniswap v4 set on the local network.
 * Returns the contracts plus the test swapper used to trade against any pool.
 */
async function deployV4Core(owner) {
  const [deployer] = await ethers.getSigners();
  const from = owner ?? deployer;

  await plantCode(PERMIT2, MAINNET.contracts.permit2.code);
  await plantCode(CREATE2_PROXY, MAINNET.contracts.create2Proxy.code);

  const poolManager = await new ethers.ContractFactory(
    POOL_MANAGER_ARTIFACT.abi,
    POOL_MANAGER_ARTIFACT.bytecode.object,
    from
  ).deploy(from.address);
  await poolManager.waitForDeployment();

  // The descriptor only renders token art; the position manager never calls it in these tests.
  // Its WETH is only used to unwrap, which no HoodSale path does, so a standalone mock is enough.
  const posmWeth = await ethers.deployContract("MockWETH", [], from);
  const positionManager = await new ethers.ContractFactory(
    POSITION_MANAGER_ARTIFACT.abi,
    POSITION_MANAGER_ARTIFACT.bytecode.object,
    from
  ).deploy(poolManager.target, PERMIT2, 300_000n, ethers.ZeroAddress, posmWeth.target);
  await positionManager.waitForDeployment();

  const stateView = await new ethers.ContractFactory(
    STATE_VIEW_ARTIFACT.abi,
    STATE_VIEW_ARTIFACT.bytecode.object,
    from
  ).deploy(poolManager.target);
  await stateView.waitForDeployment();

  const quoter = await new ethers.ContractFactory(QUOTER_ARTIFACT.abi, QUOTER_ARTIFACT.bytecode.object, from).deploy(
    poolManager.target
  );
  await quoter.waitForDeployment();

  const swapper = await ethers.deployContract("V4TestSwapper", [poolManager.target], from);

  return { poolManager, positionManager, stateView, quoter, swapper, posmWeth, permit2: PERMIT2 };
}

/** The pool key HoodSale uses: native ETH first, the token second. */
function poolKeyFor(token, { fee = 500, tickSpacing = 10, hooks = ethers.ZeroAddress } = {}) {
  return { currency0: ETH, currency1: token, fee, tickSpacing, hooks };
}

/** sqrt(tokenAmount / ethAmount) in Q64.96, the price a launch opens at. */
function sqrtPriceX96For(tokenAmount, ethAmount) {
  const ratio = (BigInt(tokenAmount) * (1n << 192n)) / BigInt(ethAmount);
  return bigintSqrt(ratio);
}

function bigintSqrt(x) {
  if (x < 2n) return x;
  let z = x;
  let y = x / 2n + 1n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

/** abi.encode of one MINT_POSITION + SETTLE_PAIR + SWEEP batch, ETH paid with the call. */
function mintCalldata({ key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, recipient, sweepTo }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.solidityPacked(
    ["uint8", "uint8", "uint8"],
    [ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR, ACTIONS.SWEEP]
  );
  const KEY = "(address,address,uint24,int24,address)";
  const params = [
    coder.encode(
      [KEY, "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"],
      [
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
        tickLower,
        tickUpper,
        liquidity,
        amount0Max,
        amount1Max,
        recipient,
        "0x",
      ]
    ),
    coder.encode(["address", "address"], [key.currency0, key.currency1]),
    coder.encode(["address", "address"], [key.currency0, sweepTo ?? MSG_SENDER]),
  ];
  return coder.encode(["bytes", "bytes[]"], [actions, params]);
}

module.exports = {
  deployV4Core,
  poolKeyFor,
  sqrtPriceX96For,
  bigintSqrt,
  mintCalldata,
  plantCode,
  ACTIONS,
  HOOK_FLAGS,
  ALL_HOOK_MASK,
  MSG_SENDER,
  PERMIT2,
  CREATE2_PROXY,
  DEAD,
  ETH,
  MAINNET,
};

// ---------------------------------------------------------------- hook deployment

// The tests mine and deploy the hook through the very code the deploy script uses, so a change
// that would break a real deployment breaks the suite first.
const Miner = require("../../scripts/lib/hook-miner");

/**
 * Deploys HoodSaleV4Hook at an address carrying its permission bits.
 * `launcher` may be an EOA in tests that exercise the hook on its own.
 */
async function deployHook(signer, poolManager, launcher, treasury) {
  const hre = require("hardhat");
  const factory = await ethers.getContractFactory("HoodSaleV4Hook");
  const initcode = await Miner.hookInitcode(hre, poolManager, launcher, treasury);
  const mined = Miner.mineHookSalt(ethers, initcode, Miner.HOODSALE_HOOK_FLAGS);
  await Miner.deployWithCreate2(hre, signer, initcode, mined.salt, mined.address);
  return { hook: factory.attach(mined.address), address: mined.address, salt: mined.salt };
}

module.exports.HOODSALE_HOOK_FLAGS = Miner.HOODSALE_HOOK_FLAGS;
module.exports.mineHookSalt = Miner.mineHookSalt;
module.exports.deployHook = deployHook;

// ------------------------------------------------------- the whole platform, with v4

/**
 * The V2 platform exactly as test/helpers.js builds it, plus everything a Uniswap v4 launch
 * needs: the v4 contracts, the locker, the launcher, the hook at its mined address, and the
 * dual-mode token deployers registered with the untouched TokenFactory.
 */
async function deployPlatformV4() {
  const { deployPlatform } = require("../helpers");
  const base = await deployPlatform();
  const { deployer, tokenFactory, presaleFactory, treasury, v3Router, v3Quoter, keeper } = base;

  const v4 = await deployV4Core(deployer);
  const positionLocker = await ethers.deployContract("V4PositionLocker", [deployer.address, v4.positionManager.target]);
  const launcher = await ethers.deployContract("V4Launcher", [
    deployer.address,
    v4.poolManager.target,
    v4.positionManager.target,
    PERMIT2,
    tokenFactory.target,
    presaleFactory.target,
    positionLocker.target,
    treasury.target,
  ]);
  const { hook } = await deployHook(deployer, v4.poolManager.target, launcher.target, treasury.target);
  await launcher.setHook(hook.target);
  await launcher.setKeeper(keeper.address);
  await positionLocker.setLauncher(launcher.target, true);

  // The v4 reader the platform lens delegates to; the launcher is how it is found.
  const v4Lens = await ethers.deployContract("HoodSaleV4Lens", [launcher.target, v4.stateView.target]);
  await launcher.setLens(v4Lens.target);
  // How the site trades a launch until Uniswap's own interface routes the hook.
  const v4Router = await ethers.deployContract("HoodSaleV4Router", [v4.poolManager.target, launcher.target]);

  // The same deployers as before for a V2 launch, a plain token for a v4 one.
  const rewardsTokenCodeV4 = await ethers.deployContract("RewardsTokenCodeV4");
  const standardDeployer = await ethers.deployContract("StandardTokenDeployerV4", [
    tokenFactory.target,
    launcher.target,
  ]);
  const taxDeployer = await ethers.deployContract("TaxTokenDeployerV4", [tokenFactory.target, launcher.target]);
  const rewardsDeployer = await ethers.deployContract("RewardsTokenDeployerV4", [
    tokenFactory.target,
    v3Router.target,
    v3Quoter.target,
    base.rewardsTokenCode.target,
    rewardsTokenCodeV4.target,
    launcher.target,
  ]);
  await tokenFactory.setDeployers(standardDeployer.target, taxDeployer.target, rewardsDeployer.target);

  return {
    ...base,
    ...v4,
    hook,
    launcher,
    positionLocker,
    v4Lens,
    v4Router,
    rewardsTokenCodeV4,
    v4Deployers: { standardDeployer, taxDeployer, rewardsDeployer },
  };
}

/** The tax a launch is created with, in the launcher's shape. */
function taxConfig(marketingWallet, overrides = {}) {
  return {
    marketingWallet,
    marketingBuyBps: 0,
    marketingSellBps: 0,
    rewardsBuyBps: 0,
    rewardsSellBps: 0,
    taxLocked: false,
    walletLocked: false,
    ...overrides,
  };
}

module.exports.deployPlatformV4 = deployPlatformV4;
module.exports.taxConfig = taxConfig;

/** Turns a PoolKey read from a contract into a plain array ethers can encode again. */
function keyArray(key) {
  return [key[0], key[1], Number(key[2]), Number(key[3]), key[4]];
}

module.exports.keyArray = keyArray;
