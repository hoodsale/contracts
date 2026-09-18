// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {V4Launcher} from "./V4Launcher.sol";
import {HoodSaleV4Hook} from "./HoodSaleV4Hook.sol";
import {V4PositionLocker} from "./V4PositionLocker.sol";
import {IPositionManagerV4} from "./interfaces/IPositionManagerV4.sol";

/// @dev Uniswap's StateView, declared with the plain types its pool ids are.
interface IStateViewV4 {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);

    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/**
 * @title HoodSaleV4Lens
 * @notice Read-only companion to HoodSaleLens for launches that list on Uniswap v4.
 *
 *         A v4 pool has no pair contract to read reserves from: the price is a square root in the
 *         PoolManager's state and the liquidity is a single number covering a tick range. This
 *         turns both into the token and ETH amounts the rest of the platform already speaks in, so
 *         a v4 launch shows the same price, the same liquidity and the same multiple on the site
 *         as a V2 one.
 */
contract HoodSaleV4Lens {
    using PoolIdLibrary for PoolKey;

    uint256 private constant WAD = 1e18;
    /// @dev What launchStats values once the launch position is gone but the pool still trades:
    ///      a position this small holds dust, so the pool reads as empty while its ratio still
    ///      gives the price, the way a V2 pair emptied down to its locked minimum does.
    uint128 private constant DUST_LIQUIDITY = 1e12;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    V4Launcher public immutable launcher;
    HoodSaleV4Hook public immutable hook;
    IStateViewV4 public immutable stateView;
    IPositionManagerV4 public immutable positionManager;
    V4PositionLocker public immutable locker;

    struct V4LaunchView {
        address token;
        bytes32 poolId;
        address hookAddress;
        uint24 lpFee;
        int24 tickSpacing;
        uint160 sqrtPriceX96;
        int24 tick;
        /// @notice Liquidity active at the current price, from every position in the pool
        uint128 poolLiquidity;
        /// @notice Price in wei per token (1e18 scaled), the same unit HoodSaleLens reports
        uint256 currentPriceWei;
        /// @notice What the launch position holds; see launchStats
        uint256 reserveToken;
        uint256 reserveWeth;
        bool priceAvailable;
        /// @notice The position holding the launch liquidity
        uint256 positionId;
        uint128 positionLiquidity;
        address positionHolder;
        bool positionBurned;
        uint256 lockId;
        uint64 unlockTime;
        bool lockWithdrawn;
        /// @notice The pool's tax, in bps of the ETH side of a trade
        uint16 platformTaxBps;
        uint16 marketingBuyBps;
        uint16 marketingSellBps;
        uint16 rewardsBuyBps;
        uint16 rewardsSellBps;
        address marketingWallet;
        bool taxLocked;
        bool walletLocked;
        /// @notice Collected fees waiting to be sent on
        uint256 pendingMarketing;
        uint256 pendingRewards;
    }

    constructor(V4Launcher launcher_, IStateViewV4 stateView_) {
        require(address(launcher_) != address(0) && address(stateView_) != address(0), "zero addr");
        launcher = launcher_;
        stateView = stateView_;
        hook = HoodSaleV4Hook(payable(launcher_.hook()));
        positionManager = IPositionManagerV4(launcher_.positionManager());
        locker = V4PositionLocker(launcher_.locker());
    }

    /// @notice Whether this token launched through the v4 launcher this lens reads.
    function isV4Token(address token) public view returns (bool) {
        return launcher.launchOf(token).done;
    }

    /**
     * @notice The pool's holdings and price in the same shape a V2 pair reports, so the platform
     *         lens can treat both listings alike. Only the launch position is counted: the pool's
     *         active liquidity also holds whatever anyone adds in a narrow range around the price,
     *         which would read as a pool many times deeper than it is if valued over the full range.
     * @return reserveToken Tokens the launch position holds at the current price
     * @return reserveWeth ETH the launch position holds against them; dust once the launch
     *         position has been withdrawn from a pool that still trades
     * @return priceAvailable False before the pool is open, and once nothing is left in it
     * @return positionBurned Whether the launch liquidity was burned rather than locked
     */
    function launchStats(address token)
        external
        view
        returns (uint256 reserveToken, uint256 reserveWeth, bool priceAvailable, bool positionBurned)
    {
        V4Launcher.Launch memory launch = launcher.launchOf(token);
        if (!launch.done) return (0, 0, false, false);
        positionBurned = launch.burned;

        bytes32 poolId = PoolId.unwrap(launch.poolId);
        (uint160 sqrtPriceX96, , , ) = stateView.getSlot0(poolId);
        if (sqrtPriceX96 == 0) return (0, 0, false, positionBurned);
        uint128 liquidity = positionManager.getPositionLiquidity(launch.tokenId);
        if (liquidity == 0) {
            if (stateView.getLiquidity(poolId) == 0) return (0, 0, false, positionBurned);
            liquidity = DUST_LIQUIDITY;
        }

        (reserveToken, reserveWeth) = _amounts(sqrtPriceX96, liquidity);
        priceAvailable = reserveToken > 0 && reserveWeth > 0;
    }

    /// @notice The creator's tax on the pool, in bps, excluding the platform's own share. Matches
    ///         what HoodSaleLens reports for a V2 token's own taxes.
    function creatorTaxes(address token) external view returns (uint16 buyBps, uint16 sellBps) {
        HoodSaleV4Hook.PoolConfig memory cfg = hook.configOfToken(token);
        if (!cfg.exists) return (0, 0);
        return (cfg.marketingBuyBps + cfg.rewardsBuyBps, cfg.marketingSellBps + cfg.rewardsSellBps);
    }

    /// @notice Everything the token page shows about a v4 launch.
    function v4LaunchView(address token) external view returns (V4LaunchView memory v) {
        V4Launcher.Launch memory launch = launcher.launchOf(token);
        v.token = token;
        if (!launch.done) return v;

        PoolKey memory key = launcher.poolKeyOf(token);
        v.poolId = PoolId.unwrap(launch.poolId);
        v.hookAddress = address(key.hooks);
        v.lpFee = key.fee;
        v.tickSpacing = key.tickSpacing;

        v.positionId = launch.tokenId;
        v.positionBurned = launch.burned;
        v.positionLiquidity = positionManager.getPositionLiquidity(launch.tokenId);

        (v.sqrtPriceX96, v.tick, , ) = stateView.getSlot0(v.poolId);
        v.poolLiquidity = stateView.getLiquidity(v.poolId);
        if (v.sqrtPriceX96 > 0 && v.positionLiquidity > 0) {
            (v.reserveToken, v.reserveWeth) = _amounts(v.sqrtPriceX96, v.positionLiquidity);
        }
        // The price is the pool's own, whoever provides the liquidity it trades against.
        if (v.sqrtPriceX96 > 0 && v.poolLiquidity > 0) {
            v.currentPriceWei = Math.mulDiv(WAD, 1 << 192, uint256(v.sqrtPriceX96) * uint256(v.sqrtPriceX96));
            v.priceAvailable = true;
        }

        // A position withdrawn from its lock can be burned by its owner, and then has no holder.
        try positionManager.ownerOf(launch.tokenId) returns (address holder) {
            v.positionHolder = holder;
        } catch {}
        if (!launch.burned) {
            v.lockId = launch.lockId;
            (, address lockOwner, uint64 unlockTime, bool withdrawn) = locker.locks(launch.lockId);
            v.unlockTime = unlockTime;
            v.lockWithdrawn = withdrawn;
            // The lock owner is who can take the position back, and who its fees go to.
            v.positionHolder = withdrawn ? v.positionHolder : lockOwner;
        }

        HoodSaleV4Hook.PoolConfig memory cfg = hook.configOf(launch.poolId);
        v.platformTaxBps = hook.PLATFORM_TAX_BPS();
        v.marketingBuyBps = cfg.marketingBuyBps;
        v.marketingSellBps = cfg.marketingSellBps;
        v.rewardsBuyBps = cfg.rewardsBuyBps;
        v.rewardsSellBps = cfg.rewardsSellBps;
        v.marketingWallet = cfg.marketingWallet;
        v.taxLocked = cfg.taxLocked;
        v.walletLocked = cfg.walletLocked;
        v.pendingMarketing = hook.pendingMarketing(launch.poolId);
        v.pendingRewards = hook.pendingRewards(launch.poolId);
    }

    /// @dev What a full-range position of this size holds at this price. A launch always covers
    ///      the whole range, so the bounds are the tick spacing's own limits.
    function _amounts(uint160 sqrtPriceX96, uint128 liquidity)
        private
        view
        returns (uint256 amountToken, uint256 amountEth)
    {
        int24 spacing = hook.TICK_SPACING();
        uint160 lower = TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(spacing));
        uint160 upper = TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(spacing));
        amountEth = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, upper, liquidity, false);
        amountToken = SqrtPriceMath.getAmount1Delta(lower, sqrtPriceX96, liquidity, false);
    }
}
