// Integration tests for the Uniswap v4 launch mode against the REAL v4 deployment on a Robinhood
// Chain mainnet fork: the actual PoolManager, PositionManager, Permit2, StateView, V4Quoter and
// Universal Router. The offline suite runs the same bytecode locally; what only a fork can show is
// that a launch works inside Uniswap's own periphery, and in particular that Uniswap's router can
// settle a swap through a hook that takes a fee.
//
// Run: npm run test:fork:v4
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const H = require("./helpers");
const V4 = require("../v4/helpers");

const E = ethers.parseEther;
const DAY = 86400n;
const FEE = E("0.1");
const Lock = 0;
const Tax = 1;

/** Uniswap v4 on Robinhood Chain (developers.uniswap.org/docs/protocols/v4/deployments). */
const V4_MAINNET = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
];
const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
];
const PERMIT2_ABI = ["function approve(address token, address spender, uint160 amount, uint48 expiration)"];

// Universal Router command and v4 actions used below.
const CMD_V4_SWAP = "0x10";
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;
const KEY_TUPLE = "(address,address,uint24,int24,address)";

if (!process.env.FORK_URL) {
  describe.skip("Robinhood Chain fork (real Uniswap v4)", function () {
    it("skipped: FORK_URL is not set, run `npm run test:fork:v4`", function () {});
  });
} else {
  describe("Robinhood Chain fork (real Uniswap v4)", forkSuite);
}

function forkSuite() {
  let ctx;

  before(async function () {
    this.timeout(600000);
    await H.mineOne();
    const info = await H.forkInfo();
    expect(info.chainId).to.equal(4663);
    ctx = await deployOnFork();
  });

  /** The platform on the fork, wired to the real v4 contracts. */
  async function deployOnFork() {
    const base = await H.deployPlatformOnFork();
    const { deployer, tokenFactory, presaleFactory, treasury, keeper } = base;

    const positionLocker = await ethers.deployContract("V4PositionLocker", [
      deployer.address,
      V4_MAINNET.positionManager,
    ]);
    const launcher = await ethers.deployContract("V4Launcher", [
      deployer.address,
      V4_MAINNET.poolManager,
      V4_MAINNET.positionManager,
      V4_MAINNET.permit2,
      tokenFactory.target,
      presaleFactory.target,
      positionLocker.target,
      treasury.target,
    ]);
    const { hook } = await V4.deployHook(deployer, V4_MAINNET.poolManager, launcher.target, treasury.target);
    await launcher.setHook(hook.target);
    await launcher.setKeeper(keeper.address);
    await positionLocker.setLauncher(launcher.target, true);
    const v4Lens = await ethers.deployContract("HoodSaleV4Lens", [launcher.target, V4_MAINNET.stateView]);
    await launcher.setLens(v4Lens.target);
    const v4Router = await ethers.deployContract("HoodSaleV4Router", [V4_MAINNET.poolManager, launcher.target]);

    const rewardsTokenCodeV4 = await ethers.deployContract("RewardsTokenCodeV4");
    // The fork helper does not hand back the V2 code contract; the live deployer knows it.
    const rewardsTokenCodeV2 = await base.rewardsDeployer.rewardsTokenCode();
    const standardDeployer = await ethers.deployContract("StandardTokenDeployerV4", [
      tokenFactory.target,
      launcher.target,
    ]);
    const taxDeployer = await ethers.deployContract("TaxTokenDeployerV4", [tokenFactory.target, launcher.target]);
    const rewardsDeployer = await ethers.deployContract("RewardsTokenDeployerV4", [
      tokenFactory.target,
      H.ROBINHOOD.v3.router,
      H.ROBINHOOD.v3.quoter,
      rewardsTokenCodeV2,
      rewardsTokenCodeV4.target,
      launcher.target,
    ]);
    await tokenFactory.setDeployers(standardDeployer.target, taxDeployer.target, rewardsDeployer.target);

    return { ...base, hook, launcher, positionLocker, v4Lens, v4Router };
  }

  /** Creates a v4 token, sells it and finalizes into a real v4 pool. */
  async function launch() {
    const { launcher, presaleFactory, alice, bob, carol, marketing } = ctx;
    const now = BigInt(await time.latest());
    const start = now + 100n;
    await launcher.connect(alice).createToken(
      Tax,
      { name: "ForkTest", symbol: "FORK", totalSupply: E("1000000"), rewardToken: ethers.ZeroAddress },
      V4.taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 }),
      alice.address
    );
    const created = await launcher.tokensOfCreator(alice.address);
    const tokenAddr = created[created.length - 1];
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);

    const params = {
      token: tokenAddr,
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: E("2"),
      hardCap: E("4"),
      minContribution: E("0.1"),
      maxContribution: E("2"),
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction: Lock,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("2") });
    await presale.connect(carol).contribute({ value: E("2") });
    const receipt = await (await presale.connect(alice).finalize(0, 0)).wait();
    await presale.connect(bob).claim();
    return { token, tokenAddr, presale, gasUsed: receipt.gasUsed };
  }

  let launched;

  it("opens a real Uniswap v4 pool at the listing price", async function () {
    this.timeout(600000);
    launched = await launch();
    const { launcher, positionLocker } = ctx;
    const info = await launcher.launchOf(launched.tokenAddr);
    expect(info.done).to.equal(true);

    const stateView = new ethers.Contract(V4_MAINNET.stateView, STATE_VIEW_ABI, ethers.provider);
    const slot0 = await stateView.getSlot0(info.poolId);
    const price = (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * 10n ** 18n) >> 192n;
    expect(price).to.be.closeTo(E("800"), E("0.5"));
    expect(await stateView.getLiquidity(info.poolId)).to.be.greaterThan(0);
    expect(slot0.lpFee).to.equal(500);

    // The lock is visible on Uniswap's own PositionManager.
    const posm = new ethers.Contract(
      V4_MAINNET.positionManager,
      ["function ownerOf(uint256) view returns (address)"],
      ethers.provider
    );
    expect(await posm.ownerOf(info.tokenId)).to.equal(positionLocker.target);
    console.log(`      finalize into a real v4 pool: ${launched.gasUsed} gas`);
  });

  it("lets Uniswap's own Universal Router buy through the hook", async function () {
    this.timeout(600000);
    const { launcher, hook, dave } = ctx;
    const key = await launcher.poolKeyOf(launched.tokenAddr);
    const keyTuple = [key[0], key[1], Number(key[2]), Number(key[3]), key[4]];
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const amountIn = E("0.2");

    const actions = ethers.solidityPacked(
      ["uint8", "uint8", "uint8"],
      [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]
    );
    const params = [
      coder.encode(
        [`(${KEY_TUPLE} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`],
        [[keyTuple, true, amountIn, 0, "0x"]]
      ),
      coder.encode(["address", "uint256"], [ethers.ZeroAddress, amountIn]),
      coder.encode(["address", "uint256"], [launched.tokenAddr, 0]),
    ];
    const router = new ethers.Contract(V4_MAINNET.universalRouter, UNIVERSAL_ROUTER_ABI, dave);

    const hookBefore = await ethers.provider.getBalance(hook.target);
    const tokensBefore = await launched.token.balanceOf(dave.address);
    await router.execute(CMD_V4_SWAP, [coder.encode(["bytes", "bytes[]"], [actions, params])], await H.deadline(), {
      value: amountIn,
    });

    // The swap settles: Uniswap's router pays exactly what it was quoted, and the hook's fee comes
    // out of the swap itself rather than out of the trader's declared amount.
    expect(await launched.token.balanceOf(dave.address)).to.be.greaterThan(tokensBefore);
    expect((await ethers.provider.getBalance(hook.target)) - hookBefore).to.equal((amountIn * 325n) / 10_000n);
  });

  it("lets Uniswap's own Universal Router sell through the hook", async function () {
    this.timeout(600000);
    const { launcher, hook, bob } = ctx;
    const key = await launcher.poolKeyOf(launched.tokenAddr);
    const keyTuple = [key[0], key[1], Number(key[2]), Number(key[3]), key[4]];
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const amountIn = E("1000");

    // Selling goes through Permit2, the way Uniswap's own interface does it.
    await launched.token.connect(bob).approve(V4_MAINNET.permit2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(V4_MAINNET.permit2, PERMIT2_ABI, bob);
    await permit2.approve(launched.tokenAddr, V4_MAINNET.universalRouter, amountIn, 2n ** 48n - 1n);

    const actions = ethers.solidityPacked(
      ["uint8", "uint8", "uint8"],
      [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]
    );
    const params = [
      coder.encode(
        [`(${KEY_TUPLE} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`],
        [[keyTuple, false, amountIn, 0, "0x"]]
      ),
      coder.encode(["address", "uint256"], [launched.tokenAddr, amountIn]),
      coder.encode(["address", "uint256"], [ethers.ZeroAddress, 0]),
    ];
    const router = new ethers.Contract(V4_MAINNET.universalRouter, UNIVERSAL_ROUTER_ABI, bob);

    const hookBefore = await ethers.provider.getBalance(hook.target);
    const ethBefore = await ethers.provider.getBalance(bob.address);
    const receipt = await (
      await router.execute(CMD_V4_SWAP, [coder.encode(["bytes", "bytes[]"], [actions, params])], await H.deadline())
    ).wait();
    const received = (await ethers.provider.getBalance(bob.address)) - ethBefore + receipt.fee;

    expect(received).to.be.greaterThan(0);
    const fee = (await ethers.provider.getBalance(hook.target)) - hookBefore;
    // 5% marketing plus the platform's 0.25%, taken out of the ETH the sale produced.
    expect(fee).to.equal(((received + fee) * 525n) / 10_000n);
  });

  it("quotes through Uniswap's own quoter with the fee included", async function () {
    this.timeout(600000);
    const { launcher, v4Router, dave } = ctx;
    const key = await launcher.poolKeyOf(launched.tokenAddr);
    const keyTuple = [key[0], key[1], Number(key[2]), Number(key[3]), key[4]];
    const quoter = new ethers.Contract(V4_MAINNET.quoter, QUOTER_ABI, ethers.provider);
    const spend = E("0.1");
    const quoted = await quoter.quoteExactInputSingle.staticCall([keyTuple, true, spend, "0x"]);
    const out = await v4Router
      .connect(dave)
      .buy.staticCall(launched.tokenAddr, 0, dave.address, await H.deadline(), { value: spend });
    expect(out).to.equal(quoted[0]);
  });

  it("trades through the site's own router and pays the Treasury", async function () {
    this.timeout(600000);
    const { v4Router, hook, treasury, launcher, dave } = ctx;
    const spend = E("0.1");
    await v4Router.connect(dave).buy(launched.tokenAddr, 0, dave.address, await H.deadline(), { value: spend });

    const poolId = (await launcher.launchOf(launched.tokenAddr)).poolId;
    const reserveBefore = await treasury.buybackReserve();
    await hook.flush(poolId);
    await hook.flushPlatform();
    expect(await treasury.buybackReserve()).to.be.greaterThan(reserveBefore);
  });

  it("reports the launch through the platform lens", async function () {
    this.timeout(600000);
    const { lens } = ctx;
    const v = await lens.launchView(launched.presale.target);
    expect(v.poolKind).to.equal(1);
    expect(v.priceAvailable).to.equal(true);
    expect(v.buyTaxBps).to.equal(300);
    expect(v.liquidityWeth).to.be.greaterThan(0);
    console.log(`      lens price ${ethers.formatEther(v.currentPriceWei)} ETH, liquidity ${ethers.formatEther(v.liquidityWeth)} ETH`);
  });
}
