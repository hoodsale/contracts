// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

interface IOwnable {
    function owner() external view returns (address);
}

/**
 * @title HoodSaleV4Hook
 * @notice The tax of a HoodSale launch that lists on Uniswap v4.
 *
 *         On V2 the tax lives in the token's transfer function. That cannot work on v4: Uniswap's
 *         router settles the exact amount it was quoted, so a token that shortens its own transfers
 *         makes every routed swap revert. Here the tax is charged by the pool instead, and only in
 *         the pool this hook is attached to: a wallet-to-wallet transfer is free, and so is any
 *         other pool someone opens for the same token. That is why a launch's liquidity is locked
 *         in this pool.
 *
 *         The fee is always taken in ETH, on the ETH side of the trade, in the shape the swap
 *         allows: when ETH is the amount the trader specified it is taken in `beforeSwap` (the
 *         trader spends what they declared and the pool swaps the rest, or the pool releases a
 *         little more and the trader still receives what they asked for); otherwise it is taken in
 *         `afterSwap` out of the ETH the swap produced or required.
 *
 *         Nothing is pushed anywhere during a swap. The shares are booked and sent later by
 *         `flush`, which anyone may call, so a marketing wallet that rejects ETH can never make
 *         trading revert. The platform's share reaches the Treasury as plain ETH, which books its
 *         buyback portion exactly as it does for a V2 launch.
 */
contract HoodSaleV4Hook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint256 public constant BPS = 10_000;
    /// @notice The platform's share of every trade, matching the V2 tokens' platform tax
    uint16 public constant PLATFORM_TAX_BPS = 25;
    /// @notice Total tax cap per direction (buy or sell), 10% including the platform share
    uint16 public constant MAX_TOTAL_TAX_BPS = 1_000;
    /// @notice The LP fee every HoodSale pool opens with (0.05%)
    uint24 public constant LP_FEE = 500;
    int24 public constant TICK_SPACING = 10;
    /// @dev Gas allowance for a push to a wallet or contract we do not control
    uint256 private constant PUSH_GAS = 100_000;

    address public immutable launcher;
    address public immutable platformTreasury;

    struct PoolConfig {
        address token;
        /// @notice Receives the creator's share; never zero on a registered pool
        address marketingWallet;
        /// @notice A rewards token that turns ETH into holder rewards; zero on Standard and Tax launches
        address rewardsSink;
        uint16 marketingBuyBps;
        uint16 marketingSellBps;
        uint16 rewardsBuyBps;
        uint16 rewardsSellBps;
        bool taxLocked;
        bool walletLocked;
        bool exists;
    }

    mapping(PoolId => PoolConfig) private _configOf;
    mapping(PoolId => PoolKey) private _keyOf;
    /// @notice The HoodSale pool of a token; zero id when the token has no launch here
    mapping(address => PoolId) public poolIdOf;

    /// @notice ETH owed to a pool's marketing wallet, waiting for a flush
    mapping(PoolId => uint256) public pendingMarketing;
    /// @notice ETH owed to a pool's rewards token, waiting for a flush
    mapping(PoolId => uint256) public pendingRewards;
    /// @notice ETH owed to the platform Treasury across every pool
    uint256 public pendingPlatform;

    event PoolRegistered(PoolId indexed poolId, address indexed token, PoolKey key, PoolConfig config);
    event FeeTaken(PoolId indexed poolId, bool buy, uint256 platform, uint256 marketing, uint256 rewards);
    event TaxesUpdated(PoolId indexed poolId, uint16 marketingBuy, uint16 marketingSell, uint16 rewardsBuy, uint16 rewardsSell);
    event MarketingWalletUpdated(PoolId indexed poolId, address wallet);
    event TaxesLocked(PoolId indexed poolId);
    event MarketingWalletLocked(PoolId indexed poolId);
    event Flushed(PoolId indexed poolId, address indexed to, uint256 amount, bool ok);
    event PlatformFlushed(uint256 amount, bool ok);

    error NotLauncher();
    error NotTokenOwner();
    error AlreadyRegistered();
    error Unregistered();
    error BadKey();
    error ZeroWallet();
    error TaxTooHigh();
    error SettingLocked();
    error NoRewardsSink();
    error PartialFill();

    constructor(IPoolManager poolManager_, address launcher_, address treasury_) BaseHook(poolManager_) {
        require(launcher_ != address(0) && treasury_ != address(0), "zero addr");
        launcher = launcher_;
        platformTreasury = treasury_;
    }

    /// @dev Only the PoolManager pays ETH here, when the hook takes its fee out of a swap.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    // ------------------------------------------------------------ registration

    /// @notice The launcher declares a pool's tax before opening it. Called once per token.
    function register(PoolKey calldata key, PoolConfig calldata cfg) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (
            !key.currency0.isAddressZero() ||
            Currency.unwrap(key.currency1) != cfg.token ||
            cfg.token == address(0) ||
            address(key.hooks) != address(this) ||
            key.fee != LP_FEE ||
            key.tickSpacing != TICK_SPACING
        ) revert BadKey();
        if (cfg.marketingWallet == address(0)) revert ZeroWallet();
        if (cfg.rewardsSink == address(0) && (cfg.rewardsBuyBps != 0 || cfg.rewardsSellBps != 0)) revert NoRewardsSink();
        _checkTaxes(cfg.marketingBuyBps, cfg.rewardsBuyBps);
        _checkTaxes(cfg.marketingSellBps, cfg.rewardsSellBps);

        PoolId id = key.toId();
        if (_configOf[id].exists) revert AlreadyRegistered();

        PoolConfig memory stored = cfg;
        stored.exists = true;
        _configOf[id] = stored;
        _keyOf[id] = key;
        poolIdOf[cfg.token] = id;
        emit PoolRegistered(id, cfg.token, key, stored);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (sender != launcher) revert NotLauncher();
        if (!_configOf[key.toId()].exists) revert Unregistered();
        return BaseHook.beforeInitialize.selector;
    }

    // ------------------------------------------------------------ the tax

    function _beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata
    ) internal view override returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId id = key.toId();
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        // ETH is the currency the trader named when they either spend ETH exactly (a buy with an
        // exact input) or receive ETH exactly (a sell with an exact output). Only then can the fee
        // be taken here, off the amount they named.
        if (!_ethIsSpecified(params)) return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 ethAmount = _abs(params.amountSpecified);
        uint256 fee = (ethAmount * _totalBps(cfg, params.zeroForOne)) / BPS;
        return (BaseHook.beforeSwap.selector, toBeforeSwapDelta(int128(uint128(fee)), 0), 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        PoolId id = key.toId();
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) return (BaseHook.afterSwap.selector, 0);

        bool buy = params.zeroForOne;
        uint256 fee;
        int128 unspecifiedDelta;

        if (_ethIsSpecified(params)) {
            // beforeSwap already moved the swap amount by the fee; here it is only collected.
            fee = (_abs(params.amountSpecified) * _totalBps(cfg, buy)) / BPS;
            // On an exact output the pool was asked for the trader's amount plus the fee. If it
            // could not deliver all of it the trader would silently receive less than they asked
            // for, so the swap is refused instead.
            if (params.amountSpecified > 0 && int256(delta.amount0()) < params.amountSpecified + int256(fee)) {
                revert PartialFill();
            }
        } else {
            // The ETH side is whatever the swap produced or consumed.
            fee = (_abs(int256(delta.amount0())) * _totalBps(cfg, buy)) / BPS;
            unspecifiedDelta = int128(uint128(fee));
        }

        if (fee > 0) {
            // The credit for this arrives from the PoolManager the moment this call returns.
            poolManager.take(CurrencyLibrary.ADDRESS_ZERO, address(this), fee);
            _book(id, cfg, buy, fee);
        }
        return (BaseHook.afterSwap.selector, unspecifiedDelta);
    }

    /// @dev Splits a collected fee into the three shares. The platform keeps its exact bps and the
    ///      rest follows the configured rates, so rounding never leaves ETH unaccounted for.
    function _book(PoolId id, PoolConfig storage cfg, bool buy, uint256 fee) private {
        uint16 total = _totalBps(cfg, buy);
        uint16 marketingBps = buy ? cfg.marketingBuyBps : cfg.marketingSellBps;
        uint16 rewardsBps = buy ? cfg.rewardsBuyBps : cfg.rewardsSellBps;

        uint256 marketing = (fee * marketingBps) / total;
        uint256 rewards = (fee * rewardsBps) / total;
        uint256 platform = fee - marketing - rewards;

        if (marketing > 0) pendingMarketing[id] += marketing;
        if (rewards > 0) pendingRewards[id] += rewards;
        if (platform > 0) pendingPlatform += platform;
        emit FeeTaken(id, buy, platform, marketing, rewards);
    }

    // ------------------------------------------------------------ paying out

    /// @notice Sends a pool's collected creator and rewards shares. Anyone may call it; a
    ///         recipient that rejects the ETH only leaves its own share pending.
    function flush(PoolId id) external {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) revert Unregistered();
        _push(id, cfg.marketingWallet, pendingMarketing);
        if (cfg.rewardsSink != address(0)) _push(id, cfg.rewardsSink, pendingRewards);
    }

    /// @notice Sends the platform's collected share to the Treasury. Anyone may call it.
    function flushPlatform() external {
        uint256 amount = pendingPlatform;
        if (amount == 0) return;
        pendingPlatform = 0;
        (bool ok, ) = platformTreasury.call{value: amount, gas: PUSH_GAS}("");
        if (!ok) pendingPlatform = amount;
        emit PlatformFlushed(amount, ok);
    }

    function _push(PoolId id, address to, mapping(PoolId => uint256) storage ledger) private {
        uint256 amount = ledger[id];
        if (amount == 0) return;
        ledger[id] = 0;
        (bool ok, ) = to.call{value: amount, gas: PUSH_GAS}("");
        if (!ok) ledger[id] = amount;
        emit Flushed(id, to, amount, ok);
    }

    // ------------------------------------------------------------ creator controls

    modifier onlyTokenOwner(PoolId id) {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) revert Unregistered();
        if (msg.sender != IOwnable(cfg.token).owner()) revert NotTokenOwner();
        _;
    }

    function setTaxes(
        PoolId id,
        uint16 marketingBuy,
        uint16 marketingSell,
        uint16 rewardsBuy,
        uint16 rewardsSell
    ) external onlyTokenOwner(id) {
        PoolConfig storage cfg = _configOf[id];
        if (cfg.taxLocked) revert SettingLocked();
        if (cfg.rewardsSink == address(0) && (rewardsBuy != 0 || rewardsSell != 0)) revert NoRewardsSink();
        _checkTaxes(marketingBuy, rewardsBuy);
        _checkTaxes(marketingSell, rewardsSell);
        cfg.marketingBuyBps = marketingBuy;
        cfg.marketingSellBps = marketingSell;
        cfg.rewardsBuyBps = rewardsBuy;
        cfg.rewardsSellBps = rewardsSell;
        emit TaxesUpdated(id, marketingBuy, marketingSell, rewardsBuy, rewardsSell);
    }

    function setMarketingWallet(PoolId id, address wallet) external onlyTokenOwner(id) {
        PoolConfig storage cfg = _configOf[id];
        if (cfg.walletLocked) revert SettingLocked();
        if (wallet == address(0)) revert ZeroWallet();
        cfg.marketingWallet = wallet;
        emit MarketingWalletUpdated(id, wallet);
    }

    /// @notice Freezes this pool's tax rates for good.
    function lockTaxes(PoolId id) external onlyTokenOwner(id) {
        _configOf[id].taxLocked = true;
        emit TaxesLocked(id);
    }

    /// @notice Freezes the wallet that receives the creator's share for good.
    function lockMarketingWallet(PoolId id) external onlyTokenOwner(id) {
        _configOf[id].walletLocked = true;
        emit MarketingWalletLocked(id);
    }

    // ------------------------------------------------------------ views

    function configOf(PoolId id) external view returns (PoolConfig memory) {
        return _configOf[id];
    }

    function poolKeyOf(PoolId id) external view returns (PoolKey memory) {
        return _keyOf[id];
    }

    function configOfToken(address token) external view returns (PoolConfig memory) {
        return _configOf[poolIdOf[token]];
    }

    /// @notice The total fee a trade pays in one direction, platform share included.
    function feeBps(PoolId id, bool buy) external view returns (uint16) {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) return 0;
        return _totalBps(cfg, buy);
    }

    /// @notice What a trade of `ethAmount` pays in fees, in ETH.
    function quoteFee(PoolId id, bool buy, uint256 ethAmount) external view returns (uint256) {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) return 0;
        return (ethAmount * _totalBps(cfg, buy)) / BPS;
    }

    // ------------------------------------------------------------ internals

    function _totalBps(PoolConfig storage cfg, bool buy) private view returns (uint16) {
        return
            PLATFORM_TAX_BPS +
            (buy ? cfg.marketingBuyBps : cfg.marketingSellBps) +
            (buy ? cfg.rewardsBuyBps : cfg.rewardsSellBps);
    }

    /// @dev True when the trader named an ETH amount: a buy paying an exact amount of ETH, or a
    ///      sell receiving an exact amount of ETH.
    function _ethIsSpecified(SwapParams calldata params) private pure returns (bool) {
        return (params.amountSpecified < 0) == params.zeroForOne;
    }

    function _checkTaxes(uint16 marketing, uint16 rewards) private pure {
        if (uint256(marketing) + rewards + PLATFORM_TAX_BPS > MAX_TOTAL_TAX_BPS) revert TaxTooHigh();
    }

    function _abs(int256 value) private pure returns (uint256) {
        return value < 0 ? uint256(-value) : uint256(value);
    }
}
