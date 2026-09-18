// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/**
 * Test-only swapper for the v4 harness: swaps against any pool key, in all four shapes, through
 * the PoolManager's unlock callback. Not part of the platform; the site's router is
 * HoodSaleV4Router. Also exposes the tick and liquidity maths the tests need, so the JavaScript
 * side never re-implements Uniswap arithmetic.
 */
contract V4TestSwapper is SafeCallback {
    using PoolIdLibrary for PoolKey;

    struct Call {
        PoolKey key;
        SwapParams params;
        address payer;
        address to;
        uint256 ethProvided;
    }

    error TooLittleReceived(uint256 got, uint256 min);
    error TooMuchRequested(uint256 got, uint256 max);

    constructor(IPoolManager manager) SafeCallback(manager) {}

    receive() external payable {}

    /// @notice Exact-in swap. `zeroForOne` pays currency0 (ETH in an ETH/token pool).
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address to)
        external
        payable
        returns (uint256 amountOut)
    {
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        BalanceDelta delta = _run(key, params, to);
        int128 out = zeroForOne ? delta.amount1() : delta.amount0();
        amountOut = uint256(int256(out));
        if (amountOut < minOut) revert TooLittleReceived(amountOut, minOut);
    }

    /// @notice Exact-out swap. `zeroForOne` pays currency0 and receives exactly `amountOut` of currency1.
    function swapExactOut(PoolKey calldata key, bool zeroForOne, uint256 amountOut, uint256 maxIn, address to)
        external
        payable
        returns (uint256 amountIn)
    {
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: int256(amountOut),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        BalanceDelta delta = _run(key, params, to);
        int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
        amountIn = uint256(-int256(paid));
        if (amountIn > maxIn) revert TooMuchRequested(amountIn, maxIn);
    }

    function _run(PoolKey calldata key, SwapParams memory params, address to) private returns (BalanceDelta delta) {
        bytes memory result = poolManager.unlock(
            abi.encode(Call({key: key, params: params, payer: msg.sender, to: to, ethProvided: msg.value}))
        );
        delta = abi.decode(result, (BalanceDelta));
        // Whatever ETH the swap did not need goes back to the caller.
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok,) = msg.sender.call{value: left}("");
            require(ok, "refund failed");
        }
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        Call memory c = abi.decode(data, (Call));
        BalanceDelta delta = poolManager.swap(c.key, c.params, "");
        _settleOrTake(c.key.currency0, delta.amount0(), c.payer, c.to);
        _settleOrTake(c.key.currency1, delta.amount1(), c.payer, c.to);
        return abi.encode(delta);
    }

    function _settleOrTake(Currency currency, int128 amount, address payer, address to) private {
        if (amount < 0) {
            uint256 owed = uint256(int256(-amount));
            if (currency.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                IERC20(Currency.unwrap(currency)).transferFrom(payer, address(poolManager), owed);
                poolManager.settle();
            }
        } else if (amount > 0) {
            poolManager.take(currency, to, uint256(int256(amount)));
        }
    }

    // ------------------------------------------------------------ maths for the tests

    function poolId(PoolKey calldata key) external pure returns (PoolId) {
        return key.toId();
    }

    function sqrtPriceAtTick(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }

    function usableTicks(int24 tickSpacing) external pure returns (int24 lower, int24 upper) {
        return (TickMath.minUsableTick(tickSpacing), TickMath.maxUsableTick(tickSpacing));
    }

    function liquidityForAmounts(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceAX96,
        uint160 sqrtPriceBX96,
        uint256 amount0,
        uint256 amount1
    ) external pure returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, amount0, amount1);
    }
}
