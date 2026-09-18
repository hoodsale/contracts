// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IWETH} from "../../interfaces/IUniswapV2.sol";
import {IV3SwapRouter, IUniswapV3Factory, V3Path} from "../../interfaces/IUniswapV3.sol";
import {IV4LauncherView} from "../interfaces/IV4Launcher.sol";

/// @dev The launcher's presale factory, fixed when the launcher was deployed.
interface IPresaleFactorySource {
    function presaleFactory() external view returns (address);
}

/**
 * @title RewardsTokenV4
 * @notice A rewards token launched into a Uniswap v4 pool.
 *
 *         The token itself charges nothing on transfer. The pool's hook takes the holders' share
 *         out of every trade in ETH and sends it here. `distributeRewards` turns that ETH into the
 *         reward token (WETH, USDG or a tokenized stock, which trade on Uniswap V3 on this chain)
 *         and credits it to holders per share; holders withdraw with `claimRewards`.
 *
 *         This is simpler than the V2 rewards token, which had to sell its own tax tokens through
 *         its own pool first. Here the reward swap starts from ETH, so it never touches this
 *         token's own liquidity and cannot move its price.
 */
contract RewardsTokenV4 is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint8 public constant POOL_VERSION = 4;
    uint256 private constant MAGNITUDE = 2 ** 128;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev Minimum share base for distribution, prevents overflow with an extremely small base
    uint256 private constant MIN_SHARES_FOR_DISTRIBUTION = 1e18;
    uint256 public constant MAX_ROUTE_HOPS = 3;
    /// @notice 2 Rewards, matching TokenFactory.TokenType
    uint8 public constant TOKEN_TYPE = 2;

    address public immutable launcher;
    address public immutable tokenFactory;
    address public immutable rewardToken;
    address public immutable weth;
    /// @notice Uniswap V3 SwapRouter02 of the chain, which the reward swap runs through
    address public immutable v3Router;
    /// @notice Uniswap V3 QuoterV2 of the chain, for off-chain quotes (the keeper, the site)
    address public immutable v3Quoter;
    /// @notice The pool's hook, the only address allowed to fund the rewards
    address public immutable hook;

    address public renouncedBy;

    /// @notice ETH the hook has sent, waiting to be turned into the reward token
    uint256 public pendingRewardEth;
    /// @notice Packed Uniswap V3 path from WETH to the reward token; empty when the reward is WETH
    bytes private _rewardRouteV3;

    uint256 public magnifiedRewardPerShare;
    uint256 public totalShares;
    uint256 public totalRewardsDistributed;
    mapping(address => uint256) public sharesOf;
    mapping(address => int256) private magnifiedCorrections;
    mapping(address => uint256) public withdrawnRewards;
    mapping(address => bool) public isExcludedFromRewards;
    /// @notice Addresses that hold the supply on behalf of others (the pool's custody, the
    ///         launcher, the hook, the burn address, the platform): excluded at creation and never
    ///         let back in, by anyone
    mapping(address => bool) public isAlwaysExcluded;

    event RewardsFunded(uint256 amount);
    event RewardsDistributed(uint256 ethSpent, uint256 rewardsReceived);
    event RewardsClaimed(address indexed account, uint256 amount);
    event ExcludedFromRewards(address indexed account, bool value);
    event RewardRouteV3Updated(bytes path);

    error NotAuthorized();
    error NotHook();
    error AlwaysExcluded();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address launcher_,
        address tokenFactory_,
        address rewardToken_,
        address weth_,
        address v3Router_,
        address v3Quoter_,
        bytes memory v3Path_
    ) ERC20(name_, symbol_) Ownable(launcher_) {
        require(launcher_ != address(0) && rewardToken_ != address(0) && weth_ != address(0), "zero addr");
        launcher = launcher_;
        tokenFactory = tokenFactory_;
        rewardToken = rewardToken_;
        weth = weth_;
        v3Router = v3Router_;
        v3Quoter = v3Quoter_;
        hook = IV4LauncherView(launcher_).hook();

        // Nothing that holds the supply on behalf of others earns rewards: the pool's own
        // liquidity (which the PoolManager custodies), this contract, the burn address and the
        // platform's own contracts. Otherwise the rewards owed to those balances would be stranded
        // and every real holder's share diluted.
        _excludeForGood(address(this));
        _excludeForGood(DEAD);
        _excludeForGood(launcher_);
        _excludeForGood(hook);
        _excludeForGood(IV4LauncherView(launcher_).poolManager());
        _excludeForGood(IV4LauncherView(launcher_).positionManager());
        _excludeForGood(IV4LauncherView(launcher_).treasury());

        if (v3Path_.length > 0) _setRewardRouteV3(v3Path_);
        _mint(launcher_, totalSupply_);
    }

    function poolVersion() external pure returns (uint8) {
        return POOL_VERSION;
    }

    function tokenType() external pure returns (uint8) {
        return TOKEN_TYPE;
    }

    /// @dev Only the pool's hook funds the rewards, so a stray transfer cannot inflate them.
    receive() external payable {
        if (msg.sender != hook) revert NotHook();
        pendingRewardEth += msg.value;
        emit RewardsFunded(msg.value);
    }

    /// @dev Who may run a distribution: the token owner, the platform's factories, or the launch
    ///      keeper that runs the payouts. Running one only turns the collected ETH into the reward
    ///      along the route the owner set; it cannot change where the rewards go. The route and the
    ///      exclusions have gates of their own below, and the keeper is in neither.
    modifier onlyDistributor() {
        if (
            msg.sender != owner() &&
            msg.sender != tokenFactory &&
            msg.sender != _presaleFactory() &&
            msg.sender != IV4LauncherView(launcher).keeper()
        ) revert NotAuthorized();
        _;
    }

    /// @dev Read from the launcher, where it cannot change, rather than from the TokenFactory,
    ///      whose owner could point it at a wallet that then decides who earns rewards.
    function _presaleFactory() private view returns (address) {
        return IPresaleFactorySource(launcher).presaleFactory();
    }

    function renounceOwnership() public override onlyOwner {
        renouncedBy = owner();
        _transferOwnership(address(0));
    }

    // ------------------------------------------------------------- rewards

    /**
     * @notice Turns the ETH the hook collected into the reward token and credits it to holders.
     * @param amountOutMin The least the swap may return, in reward token units. Required because
     *        the swap is public and could otherwise be sandwiched; only the owner, the platform or
     *        the keeper may call this.
     */
    function distributeRewards(uint256 amountOutMin) external onlyDistributor nonReentrant {
        _distribute(pendingRewardEth, amountOutMin);
    }

    /**
     * @notice Distributes only `amount` of the collected ETH. When the reward's route has thinned
     *         out, the pending ETH can still reach holders in pieces the route can take.
     */
    function distributeRewardsPartly(uint256 amount, uint256 amountOutMin) external onlyDistributor nonReentrant {
        require(amount <= pendingRewardEth, "more than pending");
        _distribute(amount, amountOutMin);
    }

    function _distribute(uint256 amount, uint256 amountOutMin) private {
        require(amount > 0, "nothing to distribute");
        require(totalShares >= MIN_SHARES_FOR_DISTRIBUTION, "shares too low");
        pendingRewardEth -= amount;

        uint256 before = IERC20(rewardToken).balanceOf(address(this));

        if (rewardToken != weth) {
            require(_rewardRouteV3.length > 0, "no reward route");
            // Exactly the ETH being distributed goes into the swap, and the route must consume
            // all of it: SwapRouter02 fills only as far as the liquidity reaches, so a route that
            // runs dry reverts here instead of stranding WETH. WETH anyone sent here directly is
            // left out, so it cannot push a swap past what the route can take.
            uint256 wethBefore = IERC20(weth).balanceOf(address(this));
            IWETH(weth).deposit{value: amount}();
            require(IERC20(weth).approve(v3Router, amount), "approve failed");
            IV3SwapRouter(v3Router).exactInput(
                IV3SwapRouter.ExactInputParams({
                    path: _rewardRouteV3,
                    recipient: address(this),
                    amountIn: amount,
                    amountOutMinimum: amountOutMin
                })
            );
            require(IERC20(weth).balanceOf(address(this)) == wethBefore, "partial fill");
        } else {
            IWETH(weth).deposit{value: amount}();
        }

        uint256 received = IERC20(rewardToken).balanceOf(address(this)) - before;
        require(received > 0, "no rewards received");
        require(received >= amountOutMin, "below minimum");

        magnifiedRewardPerShare += (received * MAGNITUDE) / totalShares;
        totalRewardsDistributed += received;
        emit RewardsDistributed(amount, received);
    }

    function claimRewards() external nonReentrant {
        uint256 amount = withdrawableRewardOf(msg.sender);
        require(amount > 0, "nothing to claim");
        withdrawnRewards[msg.sender] += amount;
        IERC20(rewardToken).safeTransfer(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    function accumulativeRewardOf(address account) public view returns (uint256) {
        return
            uint256((magnifiedRewardPerShare * sharesOf[account]).toInt256() + magnifiedCorrections[account]) /
            MAGNITUDE;
    }

    function withdrawableRewardOf(address account) public view returns (uint256) {
        return accumulativeRewardOf(account) - withdrawnRewards[account];
    }

    /// @notice The packed V3 path the reward swap follows from WETH; empty when the reward is WETH.
    function rewardRouteV3() external view returns (bytes memory) {
        return _rewardRouteV3;
    }

    // --------------------------------------------------------------- admin

    /**
     * @notice Takes a wallet out of the rewards, or puts it back. The owner may do either. The
     *         platform's presale factory may only take an address out, which it does for each
     *         presale contract it creates so the supply waiting to be claimed earns nothing nobody
     *         could withdraw; it can never put an address back in. The addresses that hold the
     *         supply for others stay out whoever asks.
     */
    function setExcludedFromRewards(address account, bool value) external {
        bool byOwner = msg.sender == owner();
        if (!byOwner && !(msg.sender == _presaleFactory() && value)) revert NotAuthorized();
        if (!value && isAlwaysExcluded[account]) revert AlwaysExcluded();
        if (isExcludedFromRewards[account] == value) return;
        _setExcludedFromRewards(account, value);
    }

    /// @notice Sets the Uniswap V3 path the reward swap follows from WETH. Owner only: the route
    ///         decides where the holders' rewards are bought, so no platform key may change it.
    function setRewardRouteV3(bytes calldata path) external onlyOwner {
        _setRewardRouteV3(path);
    }

    function _setRewardRouteV3(bytes memory path) private {
        if (path.length == 0) {
            delete _rewardRouteV3;
            emit RewardRouteV3Updated(path);
            return;
        }
        require(v3Router != address(0), "no V3 router");
        require(rewardToken != weth, "no route needed for WETH");
        require(V3Path.isWellFormed(path), "bad V3 path");
        uint256 pools = V3Path.poolCount(path);
        require(pools <= MAX_ROUTE_HOPS + 1, "route too long");
        require(V3Path.firstToken(path) == weth, "route must start at WETH");
        require(V3Path.lastToken(path) == rewardToken, "route must end at reward");
        IUniswapV3Factory v3Factory = IUniswapV3Factory(IV3SwapRouter(v3Router).factory());
        for (uint256 i = 0; i < pools; i++) {
            (address a, uint24 fee, address b) = V3Path.hop(path, i);
            require(a != address(this) && b != address(this) && a != b, "bad hop");
            require(v3Factory.getPool(a, b, fee) != address(0), "no V3 pool");
        }
        _rewardRouteV3 = path;
        emit RewardRouteV3Updated(path);
    }

    // -------------------------------------------------------- share tracking

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0)) _syncShares(from);
        if (to != address(0)) _syncShares(to);
    }

    function _syncShares(address account) private {
        if (isExcludedFromRewards[account]) return;
        _setShares(account, balanceOf(account));
    }

    function _excludeForGood(address account) private {
        isAlwaysExcluded[account] = true;
        _setExcludedFromRewards(account, true);
    }

    function _setExcludedFromRewards(address account, bool value) private {
        isExcludedFromRewards[account] = value;
        if (value) {
            _setShares(account, 0);
        } else {
            _setShares(account, balanceOf(account));
        }
        emit ExcludedFromRewards(account, value);
    }

    function _setShares(address account, uint256 newShares) private {
        uint256 oldShares = sharesOf[account];
        if (newShares == oldShares) return;
        sharesOf[account] = newShares;
        if (newShares > oldShares) {
            uint256 added = newShares - oldShares;
            totalShares += added;
            magnifiedCorrections[account] -= (magnifiedRewardPerShare * added).toInt256();
        } else {
            uint256 removed = oldShares - newShares;
            totalShares -= removed;
            magnifiedCorrections[account] += (magnifiedRewardPerShare * removed).toInt256();
        }
    }
}
