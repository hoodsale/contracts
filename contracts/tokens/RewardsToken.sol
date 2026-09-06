// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {PlatformTaxBase} from "./PlatformTaxBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IWETH, IUniswapV2Router02} from "../interfaces/IUniswapV2.sol";
import {IV3SwapRouter, IUniswapV3Factory, V3Path} from "../interfaces/IUniswapV3.sol";

/// @title RewardsToken
/// @notice In addition to the platform tax, charges a rewards tax (and an optional marketing
///         tax) on buys and sells. All taxes accumulate in the contract:
///         - Platform + marketing share: automatically swapped to ETH on sells once the
///           threshold is exceeded (Treasury + marketing wallet).
///         - Rewards share: swapped via `distributeRewards` through the DEX into the chosen
///           reward token (WETH, USDG or a Robinhood tokenized stock, e.g. tAAPL) and
///           distributed to holders per share. Holders withdraw with `claimRewards()`.
///         The reward swap always leaves this token through its own Uniswap V2 pool (token ->
///         WETH). From WETH on it follows either the V2 route (rewardRoute, intermediate hops on
///         the V2 factory) or, when one is set, the V3 route (rewardRouteV3, a packed Uniswap V3
///         path from WETH to the reward token through SwapRouter02). On Robinhood Chain the
///         tokenized stocks trade on V3, so the platform stores V3 routes for them.
///         Wallet-to-wallet transfers are tax-free.
contract RewardsToken is PlatformTaxBase, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 private constant MAGNITUDE = 2 ** 128;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev Minimum share base for distribution, prevents overflow with an extremely small base
    uint256 private constant MIN_SHARES_FOR_DISTRIBUTION = 1e18;

    address public immutable rewardToken;
    /// @notice Uniswap V3 SwapRouter02 of the chain (zero when the platform has no V3 leg)
    address public immutable v3Router;
    /// @notice Uniswap V3 QuoterV2 of the chain, for off-chain quotes (the keeper, the site)
    address public immutable v3Quoter;
    address public marketingWallet;
    uint16 public rewardsBuyTaxBps;
    uint16 public rewardsSellTaxBps;
    uint16 public marketingBuyTaxBps;
    uint16 public marketingSellTaxBps;

    /// @notice Accumulation waiting to be swapped to the reward token
    uint256 public pendingRewardsTokens;
    /// @notice Intermediate hops of the reward swap route: path = [this token, ...rewardRoute, rewardToken].
    ///         Defaults to [WETH]; empty if the reward token is WETH. For rewards without a WETH pool,
    ///         such as stocks, the owner can set a route like [WETH, USDG].
    address[] private _rewardRoute;
    uint256 public constant MAX_ROUTE_HOPS = 3;
    /// @notice Packed Uniswap V3 path from WETH to the reward token (token, fee, token, ...).
    ///         Empty means the reward swap uses the V2 route; set, it takes precedence: the
    ///         token -> WETH leg runs on V2, then WETH -> reward token runs on SwapRouter02.
    bytes private _rewardRouteV3;
    /// @notice Marketing accumulation waiting to be swapped to ETH
    uint256 public pendingMarketingTokens;

    uint256 public magnifiedRewardPerShare;
    uint256 public totalShares;
    uint256 public totalRewardsDistributed;
    mapping(address => uint256) public sharesOf;
    mapping(address => int256) private magnifiedCorrections;
    mapping(address => uint256) public withdrawnRewards;
    mapping(address => bool) public isExcludedFromRewards;

    event RewardsDistributed(uint256 tokensSwapped, uint256 rewardsReceived);
    event RewardsClaimed(address indexed account, uint256 amount);
    event TaxesUpdated(uint16 rewardsBuy, uint16 rewardsSell, uint16 marketingBuy, uint16 marketingSell);
    event ExcludedFromRewards(address indexed account, bool value);
    event RewardRouteUpdated(address[] intermediates);
    event RewardRouteV3Updated(bytes path);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address tokenFactory_,
        address router_,
        uint16 platformTaxBps_,
        address rewardToken_,
        address marketingWallet_,
        uint16[4] memory taxes_, // [rewardsBuy, rewardsSell, marketingBuy, marketingSell]
        address v3Router_,
        address v3Quoter_,
        bytes memory v3Path_
    ) PlatformTaxBase(name_, symbol_, creator_, treasury_, tokenFactory_, router_, platformTaxBps_) {
        require(rewardToken_ != address(0) && rewardToken_ != address(this), "bad reward token");
        require(marketingWallet_ != address(0), "zero marketing");
        _checkTaxes(taxes_[0], taxes_[2], platformTaxBps_);
        _checkTaxes(taxes_[1], taxes_[3], platformTaxBps_);

        rewardToken = rewardToken_;
        v3Router = v3Router_;
        v3Quoter = v3Quoter_;
        marketingWallet = marketingWallet_;
        rewardsBuyTaxBps = taxes_[0];
        rewardsSellTaxBps = taxes_[1];
        marketingBuyTaxBps = taxes_[2];
        marketingSellTaxBps = taxes_[3];

        isExcludedFromRewards[address(this)] = true;
        isExcludedFromRewards[mainPair] = true;
        isExcludedFromRewards[DEAD] = true;
        isExcludedFromRewards[treasury_] = true;

        address weth = IUniswapV2Router02(router_).WETH();
        if (rewardToken_ != weth) _rewardRoute.push(weth);
        if (v3Path_.length > 0) _setRewardRouteV3(v3Path_);

        _mint(creator_, totalSupply_);
    }

    // ---------------------------------------------------------------- taxes

    function setTaxes(
        uint16 rewardsBuy_,
        uint16 rewardsSell_,
        uint16 marketingBuy_,
        uint16 marketingSell_
    ) external onlyOwner {
        _checkTaxes(rewardsBuy_, marketingBuy_, platformTaxBps);
        _checkTaxes(rewardsSell_, marketingSell_, platformTaxBps);
        rewardsBuyTaxBps = rewardsBuy_;
        rewardsSellTaxBps = rewardsSell_;
        marketingBuyTaxBps = marketingBuy_;
        marketingSellTaxBps = marketingSell_;
        emit TaxesUpdated(rewardsBuy_, rewardsSell_, marketingBuy_, marketingSell_);
    }

    function setMarketingWallet(address wallet) external onlyOwner {
        require(wallet != address(0), "zero marketing");
        marketingWallet = wallet;
    }

    function _checkTaxes(uint16 a, uint16 b, uint16 platform_) private pure {
        if (uint256(a) + b + platform_ > MAX_TOTAL_TAX_BPS) revert TaxTooHigh();
    }

    function _takeFees(address from, address to, uint256 value) internal override returns (uint256) {
        uint256 fees = super._takeFees(from, to, value); // platform share accumulates in the contract
        bool isBuy = isAmmPair[from];
        bool isSell = isAmmPair[to];
        uint16 rewardsBps = isBuy ? rewardsBuyTaxBps : (isSell ? rewardsSellTaxBps : 0);
        uint16 marketingBps = isBuy ? marketingBuyTaxBps : (isSell ? marketingSellTaxBps : 0);

        uint256 rewardsFee = (value * rewardsBps) / BPS;
        if (rewardsFee > 0) {
            _rawTransfer(from, address(this), rewardsFee);
            pendingRewardsTokens += rewardsFee;
        }
        uint256 marketingFee = (value * marketingBps) / BPS;
        if (marketingFee > 0) {
            _rawTransfer(from, address(this), marketingFee);
            pendingMarketingTokens += marketingFee;
        }
        return fees + rewardsFee + marketingFee;
    }

    function _pendingSellTokens() internal view override returns (uint256) {
        return pendingPlatformTokens + pendingMarketingTokens; // excluding the rewards share
    }

    function _swapBack() internal override inSwapFlag {
        uint256 platformPortion = pendingPlatformTokens;
        uint256 marketingPortion = pendingMarketingTokens;
        uint256 total = platformPortion + marketingPortion;
        if (total == 0) return;

        (uint256 ethGained, bool ok) = _swapTokensForEth(total);
        if (!ok) return;
        pendingPlatformTokens = 0;
        pendingMarketingTokens = 0;

        uint256 marketingEth = (ethGained * marketingPortion) / total;
        uint256 platformEth = ethGained - marketingEth;
        _sendEth(platformTreasury, platformEth);
        _sendEth(marketingWallet, marketingEth);
        emit SwapBack(total, ethGained);
    }

    // ------------------------------------------------------------- rewards

    /// @notice Swaps the accumulated rewards tax to the reward token and distributes it to holders.
    /// @dev Against sandwich risk, only the owner/platform can call it and it requires amountOutMin,
    ///      in units of the reward token and enforced on the final leg only: on a V3 route leg 1
    ///      (token -> ETH) runs with a zero floor and leg 2 consumes all of its output, so a
    ///      sandwich on either leg lowers the final output and trips the same floor.
    function distributeRewards(uint256 amountOutMin) external onlyOwnerOrPlatform nonReentrant {
        require(!inSwap, "in swap");
        uint256 amount = pendingRewardsTokens;
        require(amount > 0, "nothing to distribute");
        require(totalShares >= MIN_SHARES_FOR_DISTRIBUTION, "shares too low");
        pendingRewardsTokens = 0;

        address weth = router.WETH();
        address[] memory path = rewardPath();

        uint256 before = IERC20(rewardToken).balanceOf(address(this));
        _approve(address(this), address(router), amount);
        inSwap = true;
        if (_rewardRouteV3.length > 0) {
            // Leg 1 on V2: this token -> ETH (the pool cannot pay WETH to one of its own tokens),
            // wrapped; leg 2 on V3: WETH -> ... -> reward token, with the caller's floor.
            address[] memory toWeth = new address[](2);
            toWeth[0] = address(this);
            toWeth[1] = weth;
            uint256 ethBefore = address(this).balance;
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0, toWeth, address(this), block.timestamp);
            uint256 ethGained = address(this).balance - ethBefore;
            require(ethGained > 0, "no eth received");
            IWETH(weth).deposit{value: ethGained}();
            // The whole WETH balance goes into the V3 leg (a leftover of an earlier partial fill
            // included) and the leg must consume all of it: SwapRouter02 fills only as far as the
            // route's liquidity reaches, so a route that runs dry reverts here instead of stranding
            // WETH, and the pending amount is restored by the revert.
            uint256 wethIn = IERC20(weth).balanceOf(address(this));
            require(IERC20(weth).approve(v3Router, wethIn), "approve failed");
            IV3SwapRouter(v3Router).exactInput(
                IV3SwapRouter.ExactInputParams({
                    path: _rewardRouteV3,
                    recipient: address(this),
                    amountIn: wethIn,
                    amountOutMinimum: amountOutMin
                })
            );
            require(IERC20(weth).balanceOf(address(this)) == 0, "partial fill");
        } else if (rewardToken == weth) {
            // Uniswap V2 pair.swap cannot send the output to one of the pool's own tokens
            // (this contract) (INVALID_TO). So it is received as ETH and wrapped into WETH.
            uint256 ethBefore = address(this).balance;
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(
                amount,
                amountOutMin,
                path,
                address(this),
                block.timestamp
            );
            uint256 ethGained = address(this).balance - ethBefore;
            if (ethGained > 0) IWETH(weth).deposit{value: ethGained}();
        } else {
            router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amount,
                amountOutMin,
                path,
                address(this),
                block.timestamp
            );
        }
        inSwap = false;
        uint256 received = IERC20(rewardToken).balanceOf(address(this)) - before;
        require(received > 0, "no rewards received");

        magnifiedRewardPerShare += (received * MAGNITUDE) / totalShares;
        totalRewardsDistributed += received;
        emit RewardsDistributed(amount, received);
    }

    /// @notice Full path followed by the reward swap: [this token, ...intermediate hops, rewardToken].
    function rewardPath() public view returns (address[] memory path) {
        uint256 n = _rewardRoute.length;
        path = new address[](n + 2);
        path[0] = address(this);
        for (uint256 i = 0; i < n; i++) path[i + 1] = _rewardRoute[i];
        path[n + 1] = rewardToken;
    }

    function rewardRoute() external view returns (address[] memory) {
        return _rewardRoute;
    }

    /// @notice The packed Uniswap V3 path of the reward swap after the token's own WETH pool
    ///         (empty: the V2 route applies)
    function rewardRouteV3() external view returns (bytes memory) {
        return _rewardRouteV3;
    }

    /// @notice Sets the Uniswap V3 path from WETH to the reward token, or clears it with an empty
    ///         path. Every pool of the path must exist on the V3 factory of v3Router. Setting a V2
    ///         route (setRewardRoute) clears it as well.
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
        address weth = router.WETH();
        require(rewardToken != weth, "no V3 route for WETH");
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

    /// @notice Changes the intermediate hops of the reward swap route (e.g. [WETH, USDG]).
    ///         If the reward token is not WETH, at least one intermediate hop is required; otherwise
    ///         the pool cannot send the output to this contract.
    function setRewardRoute(address[] calldata intermediates) external onlyOwner {
        require(intermediates.length <= MAX_ROUTE_HOPS, "route too long");
        address weth = router.WETH();
        if (intermediates.length == 0) require(rewardToken == weth, "route required");
        for (uint256 i = 0; i < intermediates.length; i++) {
            address hop = intermediates[i];
            require(hop != address(0) && hop != address(this) && hop != rewardToken, "bad hop");
        }
        if (intermediates.length > 0) require(intermediates[0] == weth, "route must start at WETH");
        delete _rewardRoute;
        for (uint256 i = 0; i < intermediates.length; i++) _rewardRoute.push(intermediates[i]);
        if (_rewardRouteV3.length > 0) {
            delete _rewardRouteV3;
            emit RewardRouteV3Updated("");
        }
        emit RewardRouteUpdated(intermediates);
    }

    function claimRewards() external nonReentrant {
        uint256 amount = withdrawableRewardOf(msg.sender);
        require(amount > 0, "nothing to claim");
        withdrawnRewards[msg.sender] += amount;
        IERC20(rewardToken).safeTransfer(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    /// @dev int256 conversions use SafeCast; with an extremely large reward accumulation
    ///      it reverts explicitly instead of silently wrapping to negative.
    function accumulativeRewardOf(address account) public view returns (uint256) {
        return uint256(
            (magnifiedRewardPerShare * sharesOf[account]).toInt256() + magnifiedCorrections[account]
        ) / MAGNITUDE;
    }

    function withdrawableRewardOf(address account) public view returns (uint256) {
        return accumulativeRewardOf(account) - withdrawnRewards[account];
    }

    /// @dev The platform (factory) can also call this; presale contracts can thus hold
    ///      tokens without receiving a rewards share (otherwise the rewards attributable to
    ///      the unclaimed supply would be locked with nobody able to withdraw them).
    function setExcludedFromRewards(address account, bool value) external onlyOwnerOrPlatform {
        require(account != mainPair && account != address(this), "always excluded");
        if (isExcludedFromRewards[account] == value) return;
        _setExcludedFromRewards(account, value);
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

    /// @dev AMM pairs must not receive a rewards share; otherwise the rewards attributable
    ///      to the supply in the pool get locked and real holders' share is diluted.
    function _afterAmmPairSet(address pair, bool value) internal override {
        if (value && !isExcludedFromRewards[pair]) {
            _setExcludedFromRewards(pair, true);
        }
    }

    // -------------------------------------------------------- share tracking

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value); // all balance movements, including taxes
        if (from != address(0)) _syncShares(from);
        if (to != address(0)) _syncShares(to);
    }

    function _syncShares(address account) private {
        if (isExcludedFromRewards[account]) return;
        _setShares(account, balanceOf(account));
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
