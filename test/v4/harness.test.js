const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployV4Core, poolKeyFor, sqrtPriceX96For, mintCalldata, PERMIT2, MAINNET, ETH } = require("./helpers");

// Proves the local Uniswap v4 harness behaves like the real thing before any HoodSale contract is
// built on it: the deployed bytecode is mainnet's, a pool opens at the price we ask for, a
// full-range position mints, and both swap directions settle.
describe("v4 harness", function () {
  async function withPool() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const v4 = await deployV4Core(deployer);

    const token = await ethers.deployContract("MockERC20", ["Test", "TST", 18, ethers.parseEther("1000000")]);
    const key = poolKeyFor(token.target);

    // 200,000 tokens against 4 ETH, the shape of a small launch.
    const tokenLiquidity = ethers.parseEther("200000");
    const ethLiquidity = ethers.parseEther("4");
    const sqrtPriceX96 = sqrtPriceX96For(tokenLiquidity, ethLiquidity);
    await v4.poolManager.initialize(
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      sqrtPriceX96
    );

    const [tickLower, tickUpper] = await v4.swapper.usableTicks(key.tickSpacing);
    const sqrtLower = await v4.swapper.sqrtPriceAtTick(tickLower);
    const sqrtUpper = await v4.swapper.sqrtPriceAtTick(tickUpper);
    const liquidity = await v4.swapper.liquidityForAmounts(
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
      ethLiquidity,
      tokenLiquidity
    );

    await token.approve(PERMIT2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(
      PERMIT2,
      ["function approve(address token, address spender, uint160 amount, uint48 expiration)"],
      deployer
    );
    await permit2.approve(token.target, v4.positionManager.target, tokenLiquidity, 2n ** 48n - 1n);

    const calldata = mintCalldata({
      key,
      tickLower,
      tickUpper,
      liquidity,
      amount0Max: ethLiquidity,
      amount1Max: tokenLiquidity,
      recipient: deployer.address,
    });
    const tokenId = await v4.positionManager.nextTokenId();
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await v4.positionManager.modifyLiquidities(calldata, deadline, { value: ethLiquidity });

    return { ...v4, token, key, deployer, alice, bob, tokenId, sqrtPriceX96, liquidity };
  }

  it("runs the same PoolManager and PositionManager bytecode as Robinhood Chain mainnet", async function () {
    const { poolManager, positionManager, stateView } = await loadFixture(withPool);
    const sizeOf = async (c) => ((await ethers.provider.getCode(c.target)).length - 2) / 2;
    expect(await sizeOf(poolManager)).to.equal(MAINNET.contracts.poolManager.bytes);
    expect(await sizeOf(positionManager)).to.equal(MAINNET.contracts.positionManager.bytes);
    expect(await sizeOf(stateView)).to.equal(MAINNET.contracts.stateView.bytes);
    const permit2Size = ((await ethers.provider.getCode(PERMIT2)).length - 2) / 2;
    expect(permit2Size).to.equal(MAINNET.contracts.permit2.bytes);
  });

  it("opens the pool at the price the launch asks for and holds the minted liquidity", async function () {
    const { stateView, swapper, key, sqrtPriceX96, positionManager, tokenId, deployer, liquidity } =
      await loadFixture(withPool);
    const poolId = await swapper.poolId([key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
    const slot0 = await stateView.getSlot0(poolId);
    expect(slot0[0]).to.equal(sqrtPriceX96);
    expect(await stateView.getLiquidity(poolId)).to.equal(liquidity);
    expect(await positionManager.ownerOf(tokenId)).to.equal(deployer.address);
    expect(await positionManager.getPositionLiquidity(tokenId)).to.equal(liquidity);
  });

  it("swaps ETH for tokens and back through the pool", async function () {
    const { swapper, token, key, alice, bob } = await loadFixture(withPool);
    const k = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];

    const spend = ethers.parseEther("0.1");
    await swapper.connect(alice).swapExactIn(k, true, spend, 0, alice.address, { value: spend });
    const bought = await token.balanceOf(alice.address);
    // 0.1 ETH into a 4 ETH pool at 50,000 tokens per ETH, minus the 0.05% pool fee and price impact.
    expect(bought).to.be.greaterThan(ethers.parseEther("4000"));
    expect(bought).to.be.lessThan(ethers.parseEther("5000"));

    // The ETH goes to a wallet that pays no gas, so the balance change is the swap alone.
    const ethBefore = await ethers.provider.getBalance(bob.address);
    await token.connect(alice).approve(swapper.target, bought);
    await swapper.connect(alice).swapExactOut(k, false, ethers.parseEther("0.05"), bought, bob.address);
    expect((await ethers.provider.getBalance(bob.address)) - ethBefore).to.equal(ethers.parseEther("0.05"));
    expect(await token.balanceOf(alice.address)).to.be.lessThan(bought);
  });
});
