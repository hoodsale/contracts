// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IV3SwapRouter, V3Path} from "../interfaces/IUniswapV3.sol";

/// @dev A Uniswap V3 stand-in for the offline tests: every pool is a constant product pool with
///      a fee tier, and it reports liquidity() and slot0() the way a V3 pool whose whole liquidity
///      sits in the current tick range would (virtual reserves x = L / sqrtP, y = L * sqrtP).
///      In production the official Uniswap V3 contracts on Robinhood Chain are used.
contract MockV3Pool {
    using SafeERC20 for IERC20;

    uint256 private constant Q96 = 2 ** 96;

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint256 private reserve0;
    uint256 private reserve1;

    // Test-only overrides. A virtual state makes liquidity() and slot0() report these values
    // instead of the balance-derived ones: a narrow concentrated position whose virtual reserves
    // claim more than the pool holds (cleared with zeros). A cap on the output of one swap models
    // a range whose liquidity runs out: the swap pays at most maxOut and consumes only the input
    // that output takes, like a real pool reaching the end of its liquidity (zero for no cap).
    uint128 private virtualLiquidity;
    uint160 private virtualSqrtPriceX96;
    uint256 public maxOut;

    constructor(address token0_, address token1_, uint24 fee_) {
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    /// @dev Books whatever was transferred in since the last call as reserves
    function sync() public {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }

    /// @dev Removes a share of both reserves, like burning that share of the LP (tests drain pools with it)
    function withdraw(address to, uint256 bps) external {
        require(bps <= 10_000, "bps");
        IERC20(token0).safeTransfer(to, (reserve0 * bps) / 10_000);
        IERC20(token1).safeTransfer(to, (reserve1 * bps) / 10_000);
        sync();
    }

    function setVirtualState(uint128 liquidity_, uint160 sqrtPriceX96_) external {
        virtualLiquidity = liquidity_;
        virtualSqrtPriceX96 = sqrtPriceX96_;
    }

    function setMaxOut(uint256 maxOut_) external {
        maxOut = maxOut_;
    }

    function liquidity() external view returns (uint128) {
        if (virtualLiquidity != 0) return virtualLiquidity;
        return uint128(Math.sqrt(reserve0) * Math.sqrt(reserve1));
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        if (virtualSqrtPriceX96 != 0) {
            sqrtPriceX96 = virtualSqrtPriceX96;
        } else if (reserve0 > 0 && reserve1 > 0) {
            // sqrt(reserve1 / reserve0) * 2^96
            sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(reserve1, Q96 * Q96, reserve0)));
        }
        tick = 0;
        observationIndex = 0;
        observationCardinality = 1;
        observationCardinalityNext = 1;
        feeProtocol = 0;
        unlocked = true;
    }

    /// @dev The router transferred `tokenIn` in before calling; swaps the difference at the fee tier.
    ///      With a cap set the swap stops at maxOut and hands the input it did not consume back
    ///      to the router, which returns it to its caller: a partial fill.
    function swap(address tokenIn, address to) external returns (uint256 amountOut, uint256 amountInUsed) {
        require(msg.sender == MockV3Factory(factory).router(), "pool: only router");
        bool zeroForOne = tokenIn == token0;
        require(zeroForOne || tokenIn == token1, "pool: bad token");
        (uint256 rIn, uint256 rOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this)) - rIn;
        amountOut = quote(tokenIn, amountIn);
        amountInUsed = amountIn;
        if (maxOut != 0 && amountOut > maxOut) {
            amountOut = maxOut;
            amountInUsed = quoteIn(tokenIn, maxOut);
            IERC20(tokenIn).safeTransfer(msg.sender, amountIn - amountInUsed);
        }
        require(amountOut > 0 && amountOut < rOut, "pool: insufficient liquidity");
        IERC20(zeroForOne ? token1 : token0).safeTransfer(to, amountOut);
        sync();
    }

    /// @dev Constant product with the fee taken from the input, like Uniswap V2 and V3
    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        bool zeroForOne = tokenIn == token0;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (rIn == 0 || rOut == 0) return 0;
        uint256 inWithFee = amountIn * (1_000_000 - fee);
        return (inWithFee * rOut) / (rIn * 1_000_000 + inWithFee);
    }

    /// @dev The input a given output takes (rounded up), the inverse of quote
    function quoteIn(address tokenIn, uint256 amountOut) public view returns (uint256) {
        bool zeroForOne = tokenIn == token0;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        require(amountOut < rOut, "pool: insufficient liquidity");
        return (rIn * amountOut * 1_000_000) / ((rOut - amountOut) * (1_000_000 - fee)) + 1;
    }

    /// @dev What one swap of amountIn pays with the cap applied
    function quoteCapped(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        amountOut = quote(tokenIn, amountIn);
        if (maxOut != 0 && amountOut > maxOut) amountOut = maxOut;
    }
}

contract MockV3Factory {
    address public router;
    address private immutable deployer;
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    constructor() {
        deployer = msg.sender;
    }

    function setRouter(address router_) external {
        require(msg.sender == deployer && router == address(0), "factory: router set");
        router = router_;
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        require(tokenA != tokenB, "factory: identical");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(getPool[t0][t1][fee] == address(0), "factory: exists");
        pool = address(new MockV3Pool(t0, t1, fee));
        getPool[t0][t1][fee] = pool;
        getPool[t1][t0][fee] = pool;
    }
}

/// @dev SwapRouter02.exactInput over the mock pools; the deadline is not modelled (the real router
///      takes it through multicall). Like the real router it pulls only the input the first pool
///      consumed: on a partial fill the rest stays with the caller.
contract MockSwapRouter02 {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable WETH9;

    constructor(address factory_, address weth_) {
        factory = factory_;
        WETH9 = weth_;
    }

    function exactInput(IV3SwapRouter.ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        bytes memory path = params.path;
        require(V3Path.isWellFormed(path), "router: bad path");
        uint256 pools = V3Path.poolCount(path);
        address tokenIn = V3Path.firstToken(path);
        uint256 amount = params.amountIn;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amount);
        for (uint256 i = 0; i < pools; i++) {
            (address a, uint24 fee, address b) = V3Path.hop(path, i);
            address pool = MockV3Factory(factory).getPool(a, b, fee);
            require(pool != address(0), "router: no pool");
            IERC20(a).safeTransfer(pool, amount);
            address to = i + 1 == pools ? params.recipient : address(this);
            uint256 used;
            (amount, used) = MockV3Pool(pool).swap(a, to);
            // The first pool paid the unconsumed input back: the caller keeps it, as with the
            // real router's callback that pays only what the pool took. Later hops leave their
            // unconsumed intermediate in the router, as the real one does.
            if (i == 0 && used < params.amountIn) IERC20(tokenIn).safeTransfer(msg.sender, params.amountIn - used);
        }
        require(amount >= params.amountOutMinimum, "Too little received");
        return amount;
    }
}

/// @dev QuoterV2.quoteExactInput over the mock pools. Not a view, like the real one (which quotes
///      by simulating the swap and reverting), so callers use a static call.
contract MockQuoterV2 {
    address public immutable factory;

    constructor(address factory_) {
        factory = factory_;
    }

    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        )
    {
        require(V3Path.isWellFormed(path), "quoter: bad path");
        uint256 pools = V3Path.poolCount(path);
        amountOut = amountIn;
        for (uint256 i = 0; i < pools; i++) {
            (address a, uint24 fee, address b) = V3Path.hop(path, i);
            address pool = MockV3Factory(factory).getPool(a, b, fee);
            require(pool != address(0), "quoter: no pool");
            amountOut = MockV3Pool(pool).quoteCapped(a, amountOut);
            require(amountOut > 0, "quoter: insufficient liquidity");
        }
        sqrtPriceX96AfterList = new uint160[](pools);
        initializedTicksCrossedList = new uint32[](pools);
        gasEstimate = 0;
    }
}
