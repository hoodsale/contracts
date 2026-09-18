// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {TokenFactory} from "../TokenFactory.sol";
import {HoodSaleV4Hook} from "./HoodSaleV4Hook.sol";
import {V4PositionLocker} from "./V4PositionLocker.sol";
import {IPositionManagerV4} from "./interfaces/IPositionManagerV4.sol";
import {IAllowanceTransferV4} from "./interfaces/IAllowanceTransferV4.sol";
import {IPresaleFactoryView, IPresaleParamsView} from "./interfaces/IV4Launcher.sol";

interface IOwnableToken {
    function transferOwnership(address newOwner) external;

    function owner() external view returns (address);
}

/**
 * @title V4Launcher
 * @notice Creates HoodSale tokens that list on Uniswap v4 and opens their pools.
 *
 *         It sits beside the V2 path rather than replacing it. Tokens are still created through
 *         the platform's TokenFactory, so a v4 launch appears in the same registry and emits the
 *         same event; what differs is that the factory's deployers hand back a plain, tax-free
 *         token when this contract is the creator, and the tax is configured on the pool's hook
 *         instead.
 *
 *         A presale calls `launch` when it finalizes. The pool opens at the listing price, the
 *         whole launch liquidity is minted as one full-range position, and that position is either
 *         burned or handed to the locker, exactly as the V2 path burns or locks its LP tokens.
 */
contract V4Launcher is Ownable, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice Matches Presale's LiquidityAction enum: Lock first, then Burn
    uint8 public constant ACTION_LOCK = 0;
    uint8 public constant ACTION_BURN = 1;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct TaxConfig {
        address marketingWallet;
        uint16 marketingBuyBps;
        uint16 marketingSellBps;
        uint16 rewardsBuyBps;
        uint16 rewardsSellBps;
        bool taxLocked;
        bool walletLocked;
    }

    struct TokenSpec {
        string name;
        string symbol;
        uint256 totalSupply;
        /// @notice The reward token of a Rewards launch; ignored by the other types
        address rewardToken;
    }

    struct Launch {
        PoolId poolId;
        uint256 tokenId;
        uint256 lockId;
        bool burned;
        bool done;
    }

    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable permit2;
    TokenFactory public immutable tokenFactory;
    address public immutable presaleFactory;
    V4PositionLocker public immutable locker;
    address public immutable treasury;

    /// @notice The pool hook every launch of this launcher uses; set once, right after deployment
    address public hook;
    /// @notice The reader contract the site and the platform lens use for v4 launches
    address public lens;
    /// @notice The platform bot allowed to run rewards distributions
    address public keeper;

    mapping(address => TaxConfig) private _pendingConfig;
    mapping(address => Launch) private _launchOf;
    mapping(address => PoolKey) private _poolKeyOf;
    mapping(address => address) public creatorOf;
    mapping(address => address[]) private _tokensOfCreator;
    address[] public allTokens;

    event V4TokenCreated(address indexed token, address indexed creator, address owner, uint8 tokenType);
    event TaxConfigUpdated(address indexed token, TaxConfig config);
    event Launched(
        address indexed token,
        address indexed presale,
        PoolId poolId,
        uint256 tokenId,
        uint256 lockId,
        uint128 liquidity,
        uint160 sqrtPriceX96
    );
    event HookSet(address hook);
    event LensSet(address lens);
    event KeeperSet(address keeper);

    error HookNotSet();
    error HookAlreadySet();
    error HookMismatch();
    error NotPresale();
    error TokenMismatch();
    error NoPendingConfig();
    error AlreadyLaunched();
    error PriceOutOfRange();
    error RefundFailed();
    error NotTokenOwner();
    error BadTokenType();
    error TaxTooHigh();
    error ZeroWallet();

    constructor(
        address owner_,
        address poolManager_,
        address positionManager_,
        address permit2_,
        TokenFactory tokenFactory_,
        address presaleFactory_,
        V4PositionLocker locker_,
        address treasury_
    ) Ownable(owner_) {
        require(
            poolManager_ != address(0) &&
                positionManager_ != address(0) &&
                permit2_ != address(0) &&
                address(tokenFactory_) != address(0) &&
                presaleFactory_ != address(0) &&
                address(locker_) != address(0) &&
                treasury_ != address(0),
            "zero addr"
        );
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        tokenFactory = tokenFactory_;
        presaleFactory = presaleFactory_;
        locker = locker_;
        treasury = treasury_;
    }

    /// @dev The PositionManager returns unspent ETH here after a mint, and so may the PoolManager.
    receive() external payable {}

    // -------------------------------------------------------------- admin

    /// @notice Points the launcher at its hook. The hook's address encodes its permissions and
    ///         names this launcher, so the two are tied together and this can only be done once.
    function setHook(address hook_) external onlyOwner {
        if (hook != address(0)) revert HookAlreadySet();
        if (HoodSaleV4Hook(payable(hook_)).launcher() != address(this)) revert HookMismatch();
        hook = hook_;
        emit HookSet(hook_);
    }

    function setLens(address lens_) external onlyOwner {
        lens = lens_;
        emit LensSet(lens_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    // ----------------------------------------------------------- creation

    /**
     * @notice Creates a token that will list on Uniswap v4 and records the tax its pool will
     *         charge. The supply and the ownership go to `owner_`; nothing is locked in until the
     *         pool opens, so the tax can still be corrected with `setTaxConfig`.
     * @param tokenType 0 Standard, 1 Tax, 2 Rewards, matching TokenFactory.TokenType
     */
    function createToken(
        uint8 tokenType,
        TokenSpec calldata spec,
        TaxConfig calldata cfg,
        address owner_
    ) external returns (address token) {
        if (hook == address(0)) revert HookNotSet();
        require(owner_ != address(0), "zero owner");
        _validateConfig(cfg);

        if (tokenType == 0) {
            token = tokenFactory.createStandardToken(spec.name, spec.symbol, spec.totalSupply);
        } else if (tokenType == 1) {
            token = tokenFactory.createTaxToken(
                spec.name,
                spec.symbol,
                spec.totalSupply,
                cfg.marketingWallet,
                cfg.marketingBuyBps,
                cfg.marketingSellBps
            );
        } else if (tokenType == 2) {
            token = tokenFactory.createRewardsToken(
                spec.name,
                spec.symbol,
                spec.totalSupply,
                spec.rewardToken,
                cfg.marketingWallet,
                [cfg.rewardsBuyBps, cfg.rewardsSellBps, cfg.marketingBuyBps, cfg.marketingSellBps]
            );
        } else {
            revert BadTokenType();
        }

        _pendingConfig[token] = cfg;
        creatorOf[token] = msg.sender;
        _tokensOfCreator[msg.sender].push(token);
        allTokens.push(token);

        IERC20(token).safeTransfer(owner_, spec.totalSupply);
        IOwnableToken(token).transferOwnership(owner_);

        emit V4TokenCreated(token, msg.sender, owner_, tokenType);
        emit TaxConfigUpdated(token, cfg);
    }

    /// @notice Corrects the tax a token's pool will charge, before the pool is opened. Afterwards
    ///         the rates live on the hook and are changed there.
    function setTaxConfig(address token, TaxConfig calldata cfg) external {
        if (_launchOf[token].done) revert AlreadyLaunched();
        if (_pendingConfig[token].marketingWallet == address(0)) revert NoPendingConfig();
        if (msg.sender != IOwnableToken(token).owner()) revert NotTokenOwner();
        _validateConfig(cfg);
        _pendingConfig[token] = cfg;
        emit TaxConfigUpdated(token, cfg);
    }

    // ------------------------------------------------------------- launch

    /**
     * @notice Opens the token's pool and provides the launch liquidity. Called by the presale as
     *         it finalizes, which must have approved this contract for `tokenAmount` first.
     * @param liquidityAction ACTION_BURN sends the position to the burn address, ACTION_LOCK hands
     *        it to the locker for `lockDuration`.
     * @return poolId The pool that was opened
     * @return tokenId The position that holds the launch liquidity
     * @return lockId The lock holding that position, when it was locked rather than burned
     * @return liquidity The liquidity the position was opened with
     */
    function launch(
        address token,
        uint256 tokenAmount,
        uint8 liquidityAction,
        uint64 lockDuration,
        address saleOwner
    ) external payable nonReentrant returns (PoolId poolId, uint256 tokenId, uint256 lockId, uint128 liquidity) {
        if (hook == address(0)) revert HookNotSet();
        if (!IPresaleFactoryView(presaleFactory).isPresale(msg.sender)) revert NotPresale();
        (address saleToken, , , , , , , , , , , , , ) = IPresaleParamsView(msg.sender).params();
        if (saleToken != token) revert TokenMismatch();

        TaxConfig memory cfg = _pendingConfig[token];
        if (cfg.marketingWallet == address(0)) revert NoPendingConfig();
        if (_launchOf[token].done) revert AlreadyLaunched();
        require(tokenAmount > 0 && msg.value > 0, "zero liquidity");

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        PoolKey memory key = _keyFor(token);
        poolId = key.toId();
        uint160 sqrtPriceX96 = _sqrtPriceX96For(tokenAmount, msg.value);

        HoodSaleV4Hook(payable(hook)).register(
            key,
            HoodSaleV4Hook.PoolConfig({
                token: token,
                marketingWallet: cfg.marketingWallet,
                // A rewards token turns the holders' share into rewards itself, so it is its own sink.
                rewardsSink: (cfg.rewardsBuyBps != 0 || cfg.rewardsSellBps != 0) ? token : address(0),
                marketingBuyBps: cfg.marketingBuyBps,
                marketingSellBps: cfg.marketingSellBps,
                rewardsBuyBps: cfg.rewardsBuyBps,
                rewardsSellBps: cfg.rewardsSellBps,
                taxLocked: cfg.taxLocked,
                walletLocked: cfg.walletLocked,
                exists: false
            })
        );
        IPoolManager(poolManager).initialize(key, sqrtPriceX96);

        (tokenId, liquidity) = _mintPosition(
            key,
            tokenAmount,
            msg.value,
            sqrtPriceX96,
            liquidityAction == ACTION_LOCK ? address(locker) : DEAD
        );

        if (liquidityAction == ACTION_LOCK) {
            lockId = locker.lock(tokenId, uint64(block.timestamp) + lockDuration, saleOwner);
        }

        _launchOf[token] = Launch({
            poolId: poolId,
            tokenId: tokenId,
            lockId: lockId,
            burned: liquidityAction != ACTION_LOCK,
            done: true
        });
        _poolKeyOf[token] = key;

        _refund(token, msg.sender);
        emit Launched(token, msg.sender, poolId, tokenId, lockId, liquidity, sqrtPriceX96);
    }

    /// @dev Mints the whole launch liquidity as one full-range position owned by `recipient`.
    function _mintPosition(
        PoolKey memory key,
        uint256 tokenAmount,
        uint256 ethAmount,
        uint160 sqrtPriceX96,
        address recipient
    ) private returns (uint256 tokenId, uint128 liquidity) {
        int24 tickLower = TickMath.minUsableTick(key.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(key.tickSpacing);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            ethAmount,
            tokenAmount
        );

        IERC20(Currency.unwrap(key.currency1)).forceApprove(permit2, tokenAmount);
        IAllowanceTransferV4(permit2).approve(
            Currency.unwrap(key.currency1),
            positionManager,
            uint160(tokenAmount),
            uint48(block.timestamp)
        );

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION),
            uint8(Actions.SETTLE_PAIR),
            uint8(Actions.SWEEP)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            uint128(ethAmount),
            uint128(tokenAmount),
            recipient,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        // Whatever ETH the position did not need comes straight back here.
        params[2] = abi.encode(key.currency0, address(this));

        tokenId = IPositionManagerV4(positionManager).nextTokenId();
        IPositionManagerV4(positionManager).modifyLiquidities{value: ethAmount}(
            abi.encode(actions, params),
            block.timestamp
        );
    }

    /// @dev Rounding leaves a little ETH or a few tokens behind; they belong to the sale.
    function _refund(address token, address to) private {
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IERC20(token).safeTransfer(to, tokenDust);
        uint256 ethDust = address(this).balance;
        if (ethDust > 0) {
            (bool ok, ) = to.call{value: ethDust}("");
            if (!ok) revert RefundFailed();
        }
    }

    // -------------------------------------------------------------- views

    function poolKeyOf(address token) external view returns (PoolKey memory) {
        return _poolKeyOf[token];
    }

    function launchOf(address token) external view returns (Launch memory) {
        return _launchOf[token];
    }

    function pendingConfig(address token) external view returns (TaxConfig memory) {
        return _pendingConfig[token];
    }

    function isV4Token(address token) external view returns (bool) {
        return _pendingConfig[token].marketingWallet != address(0);
    }

    function tokensOfCreator(address creator) external view returns (address[] memory) {
        return _tokensOfCreator[creator];
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice The pool key a token lists with: native ETH first, then the token.
    function keyFor(address token) external view returns (PoolKey memory) {
        return _keyFor(token);
    }

    // ---------------------------------------------------------- internals

    function _keyFor(address token) private view returns (PoolKey memory) {
        return
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(token),
                fee: HoodSaleV4Hook(payable(hook)).LP_FEE(),
                tickSpacing: HoodSaleV4Hook(payable(hook)).TICK_SPACING(),
                hooks: IHooks(hook)
            });
    }

    /// @dev The pool's opening price, from the amounts the sale is listing with. Native ETH sorts
    ///      first, so the price is tokens per ETH in Q64.96.
    function _sqrtPriceX96For(uint256 tokenAmount, uint256 ethAmount) private pure returns (uint160) {
        uint256 ratio = Math.mulDiv(tokenAmount, 1 << 192, ethAmount);
        uint256 root = Math.sqrt(ratio);
        if (root < TickMath.MIN_SQRT_PRICE || root >= TickMath.MAX_SQRT_PRICE) revert PriceOutOfRange();
        return uint160(root);
    }

    function _validateConfig(TaxConfig calldata cfg) private view {
        if (cfg.marketingWallet == address(0)) revert ZeroWallet();
        uint16 platform = HoodSaleV4Hook(payable(hook)).PLATFORM_TAX_BPS();
        uint16 max = HoodSaleV4Hook(payable(hook)).MAX_TOTAL_TAX_BPS();
        if (uint256(cfg.marketingBuyBps) + cfg.rewardsBuyBps + platform > max) revert TaxTooHigh();
        if (uint256(cfg.marketingSellBps) + cfg.rewardsSellBps + platform > max) revert TaxTooHigh();
    }
}
