// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {V4Launcher} from "./V4Launcher.sol";

/**
 * @title HoodSaleV4Router
 * @notice Buys and sells a HoodSale launch's token in its own Uniswap v4 pool.
 *
 *         Uniswap's own interface only routes pools whose hook is on its allowlist, and a hook
 *         that takes a fee has to be reviewed to get there. Until that happens, this is how the
 *         site trades a launch; afterwards it stays as a direct path that always uses the pool the
 *         launch actually listed in.
 *
 *         It only ever trades the canonical pool the launcher recorded for a token, so a swap can
 *         never be steered into a look-alike pool, and it holds nothing between calls.
 */
contract HoodSaleV4Router is SafeCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    V4Launcher public immutable launcher;

    struct SwapCall {
        PoolKey key;
        bool buy;
        uint256 amountIn;
        address payer;
        address to;
    }

    event Swapped(address indexed token, address indexed account, bool buy, uint256 amountIn, uint256 amountOut);

    error Expired();
    error NotLaunched();
    error TooLittleReceived(uint256 got, uint256 min);
    error RefundFailed();
    error ZeroAmount();

    constructor(IPoolManager poolManager_, V4Launcher launcher_) SafeCallback(poolManager_) {
        require(address(launcher_) != address(0), "zero launcher");
        launcher = launcher_;
    }

    receive() external payable {}

    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    /// @notice Spends the ETH sent with the call on the token, and sends it to `to`.
    function buy(
        address token,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external payable nonReentrant before(deadline) returns (uint256 amountOut) {
        if (msg.value == 0) revert ZeroAmount();
        amountOut = _swap(token, true, msg.value, to == address(0) ? msg.sender : to);
        if (amountOut < minAmountOut) revert TooLittleReceived(amountOut, minAmountOut);
        _refundEth(msg.sender);
        emit Swapped(token, msg.sender, true, msg.value, amountOut);
    }

    /// @notice Sells `amountIn` of the token for ETH, which goes to `to`. Needs an allowance.
    function sell(
        address token,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external nonReentrant before(deadline) returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        amountOut = _swap(token, false, amountIn, to == address(0) ? msg.sender : to);
        if (amountOut < minAmountOut) revert TooLittleReceived(amountOut, minAmountOut);
        emit Swapped(token, msg.sender, false, amountIn, amountOut);
    }

    function _swap(address token, bool isBuy, uint256 amountIn, address to) private returns (uint256 amountOut) {
        if (!launcher.launchOf(token).done) revert NotLaunched();
        PoolKey memory key = launcher.poolKeyOf(token);
        bytes memory result = poolManager.unlock(
            abi.encode(SwapCall({key: key, buy: isBuy, amountIn: amountIn, payer: msg.sender, to: to}))
        );
        amountOut = abi.decode(result, (uint256));
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        SwapCall memory c = abi.decode(data, (SwapCall));
        BalanceDelta delta = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: c.buy,
                amountSpecified: -int256(c.amountIn),
                sqrtPriceLimitX96: c.buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Pay what the pool is owed, collect what it owes, and hand the output to the recipient.
        if (c.buy) {
            poolManager.settle{value: uint256(int256(-delta.amount0()))}();
            uint256 out = uint256(int256(delta.amount1()));
            poolManager.take(c.key.currency1, c.to, out);
            return abi.encode(out);
        }

        poolManager.sync(c.key.currency1);
        IERC20(Currency.unwrap(c.key.currency1)).safeTransferFrom(
            c.payer,
            address(poolManager),
            uint256(int256(-delta.amount1()))
        );
        poolManager.settle();
        uint256 ethOut = uint256(int256(delta.amount0()));
        poolManager.take(c.key.currency0, c.to, ethOut);
        return abi.encode(ethOut);
    }

    /// @dev A buy that hit the pool's price limit leaves ETH unspent; it goes straight back.
    function _refundEth(address to) private {
        uint256 left = address(this).balance;
        if (left == 0) return;
        (bool ok, ) = to.call{value: left}("");
        if (!ok) revert RefundFailed();
    }
}
