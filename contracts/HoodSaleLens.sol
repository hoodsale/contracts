// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IUniswapV2Router02, IUniswapV2Factory, IUniswapV2Pair} from "./interfaces/IUniswapV2.sol";
import {Presale, PresaleParams} from "./Presale.sol";
import {PresaleFactory} from "./PresaleFactory.sol";
import {TokenFactory} from "./TokenFactory.sol";

/// @dev The owner-set taxes of the Tax and Rewards token types (the platform tax is separate).
interface ITaxTokenView {
    function buyTaxBps() external view returns (uint16);
    function sellTaxBps() external view returns (uint16);
}

interface IRewardsTokenView {
    function rewardsBuyTaxBps() external view returns (uint16);
    function rewardsSellTaxBps() external view returns (uint16);
    function marketingBuyTaxBps() external view returns (uint16);
    function marketingSellTaxBps() external view returns (uint16);
}

/// @title HoodSaleLens
/// @notice Read-only helper contract. Aggregates presale and post-launch
///         performance data in a single call so the frontend does not have to
///         make dozens of separate calls. Does not modify chain state.
contract HoodSaleLens {
    uint256 private constant WAD = 1e18;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct PresaleView {
        address presale;
        address token;
        string name;
        string symbol;
        /// @notice TokenFactory.TokenType of a factory token (0 Standard, 1 Tax, 2 Rewards); a quick
        ///         sale reports the type its creator picked at launch. 0 for allowlisted tokens.
        uint8 tokenType;
        /// @notice The reward token of a Rewards token (WETH, USDG or a tokenized stock), zero otherwise
        address rewardToken;
        address saleOwner;
        uint8 status; // Presale.Status
        uint256 totalRaised;
        uint256 contributorCount;
        uint256 softCap;
        uint256 hardCap;
        uint256 minContribution;
        uint256 maxContribution;
        uint256 presaleRate;
        uint256 listingRate;
        uint64 startTime;
        uint64 endTime;
        uint16 liquidityBps;
        uint8 liquidityAction; // 0 Lock, 1 Burn
        uint64 lockDuration;
        uint64 finalizedAt;
        /// @notice 0 means no scheduled launch; only the owner can finalize
        uint64 launchTime;
        /// @notice Launch time has arrived; the platform bot may trigger it on the owner's behalf
        bool launchDue;
        /// @notice Status and time conditions allow finalization
        bool readyToFinalize;
        /// @notice Whether whitelist mode is currently enabled
        bool whitelistEnabled;
        /// @notice Number of wallets on the whitelist
        uint256 whitelistCount;
        /// @notice Whether the token was created by TokenFactory. If false, it is a
        ///         platform token added via the allowlist (e.g. HOODS) and tokenType holds the default value.
        bool factoryToken;
        /// @notice Quick presale: locked rules, automatic launch and token delivery, no cancel
        bool quick;
        /// @notice The wallet the sale is run for: the quick sale creator, otherwise the sale owner
        address creator;
        /// @notice Quick sales: the creator's share of the gross raise in bps (informational)
        uint16 creatorShareBps;
        /// @notice Wallets that have received their tokens (claim or distribute)
        uint256 distributed;
        /// @notice Wallets with a contribution (the target of the token delivery)
        uint256 participantsTotal;
        /// @notice The token's own tax on DEX buys in bps, on top of the platform tax: the creator
        ///         tax of a Tax token (fixed forever on a quick token, its owner is renounced) or
        ///         rewards plus marketing on a Rewards token; 0 for Standard and allowlisted tokens
        uint16 buyTaxBps;
        /// @notice Same for DEX sells
        uint16 sellTaxBps;
    }

    /// @notice Price performance of a token whose launch is complete (finalized).
    struct LaunchView {
        address presale;
        address token;
        string name;
        string symbol;
        uint8 tokenType;
        uint64 finalizedAt;
        uint256 totalRaised;
        /// @notice Listing price in wei per token (1e18 scaled)
        uint256 listingPriceWei;
        /// @notice Current pool price in wei per token (1e18 scaled)
        uint256 currentPriceWei;
        /// @notice Current price / listing price, 1e18 = 1x
        uint256 multiplierX18;
        /// @notice ETH-side liquidity in the pool (WETH reserve)
        uint256 liquidityWeth;
        bool lpBurned;
        bool priceAvailable;
        /// @notice Whether the token was created by TokenFactory (see PresaleView.factoryToken)
        bool factoryToken;
        /// @notice Quick presale (see PresaleView.quick)
        bool quick;
        /// @notice The token's own DEX taxes in bps (see PresaleView.buyTaxBps)
        uint16 buyTaxBps;
        uint16 sellTaxBps;
    }

    /// @notice A row of the participants table.
    struct ParticipantView {
        address account;
        uint256 contribution; // current (active) contribution
        uint256 contributed; // total deposited
        uint256 exited;
        uint256 refunded;
        uint256 claimedTokens;
        uint256 tokensDue; // tokens owed for the active contribution
        uint256 shareBps; // share of the active contribution in the total raised
        uint64 joinedAt;
        uint8 state; // 0 Active, 1 Exited, 2 Refunded, 3 Claimed
    }

    /// @notice Raw signals for trend ranking: ETH raised, early exits and new wallets
    ///         since a given moment (since); post-launch multiplier.
    struct MomentumView {
        address presale;
        address token;
        string name;
        string symbol;
        uint8 status;
        uint64 startTime;
        uint64 endTime;
        uint256 totalRaised;
        uint256 hardCap;
        uint256 contributorCount;
        uint256 whitelistCount;
        uint256 raisedSince; // contributions since `since` (wei)
        uint256 exitedSince; // early-exit refunds since `since` (wei, net)
        uint256 newWalletsSince; // wallets that joined for the first time since `since`
        uint256 activitySince; // number of activity records since `since`
        uint256 multiplierX18; // post-finalize price / listing price (1e18 = 1x)
        bool priceAvailable;
        bool quick; // quick presale (see PresaleView.quick)
        uint16 buyTaxBps; // the token's own DEX taxes in bps (see PresaleView.buyTaxBps)
        uint16 sellTaxBps;
    }

    PresaleFactory public immutable presaleFactory;
    TokenFactory public immutable tokenFactory;
    IUniswapV2Router02 public immutable router;

    constructor(address presaleFactory_, address tokenFactory_, address router_) {
        require(
            presaleFactory_ != address(0) && tokenFactory_ != address(0) && router_ != address(0),
            "zero addr"
        );
        presaleFactory = PresaleFactory(presaleFactory_);
        tokenFactory = TokenFactory(tokenFactory_);
        router = IUniswapV2Router02(router_);
    }

    // ------------------------------------------------------------ presale

    function presaleView(address presaleAddr) public view returns (PresaleView memory v) {
        Presale sale = Presale(payable(presaleAddr));
        PresaleParams memory p = sale.getParams();
        TokenFactory.TokenInfo memory info = tokenFactory.tokenInfo(p.token);

        v.presale = presaleAddr;
        v.token = p.token;
        v.name = IERC20Metadata(p.token).name();
        v.symbol = IERC20Metadata(p.token).symbol();
        v.tokenType = uint8(info.tokenType);
        v.rewardToken = info.rewardToken;
        v.saleOwner = sale.saleOwner();
        v.status = uint8(sale.status());
        v.totalRaised = sale.totalRaised();
        v.contributorCount = sale.contributorCount();
        v.softCap = p.softCap;
        v.hardCap = p.hardCap;
        v.minContribution = p.minContribution;
        v.maxContribution = p.maxContribution;
        v.presaleRate = p.presaleRate;
        v.listingRate = p.listingRate;
        v.startTime = p.startTime;
        v.endTime = p.endTime;
        v.liquidityBps = p.liquidityBps;
        v.liquidityAction = uint8(p.liquidityAction);
        v.lockDuration = p.lockDuration;
        v.finalizedAt = sale.finalizedAt();
        v.launchTime = p.launchTime;
        v.launchDue = sale.isLaunchDue();
        v.readyToFinalize = sale.isReadyToFinalize();
        v.whitelistEnabled = sale.whitelistEnabled();
        v.whitelistCount = sale.whitelistCount();
        v.factoryToken = tokenFactory.isPlatformToken(p.token);
        v.quick = presaleFactory.isQuick(presaleAddr);
        v.creator = v.quick ? presaleFactory.quickCreatorOf(presaleAddr) : v.saleOwner;
        v.creatorShareBps = sale.creatorShareBps();
        (v.distributed, v.participantsTotal) = sale.distributionProgress();
        (v.buyTaxBps, v.sellTaxBps) = _tokenTaxes(p.token, info.tokenType);
    }

    /// @notice Reads presales in pages. If `onlyStatus` is given (0xff = all),
    ///         only presales in that status are returned.
    function presaleViews(uint256 start, uint256 count, uint8 onlyStatus)
        external
        view
        returns (PresaleView[] memory list, uint256 total)
    {
        total = presaleFactory.allPresalesLength();
        if (start >= total) return (new PresaleView[](0), total);
        uint256 end = start + count > total ? total : start + count;

        PresaleView[] memory buffer = new PresaleView[](end - start);
        uint256 n;
        for (uint256 i = start; i < end; i++) {
            PresaleView memory v = presaleView(presaleFactory.allPresales(i));
            if (onlyStatus == type(uint8).max || v.status == onlyStatus) {
                buffer[n++] = v;
            }
        }
        list = new PresaleView[](n);
        for (uint256 i = 0; i < n; i++) list[i] = buffer[i];
    }

    // ------------------------------------------------------------ participants

    /// @notice Returns a presale's participants in pages (ordered by first participation).
    function presaleParticipants(address presaleAddr, uint256 start, uint256 count)
        external
        view
        returns (ParticipantView[] memory list, uint256 total)
    {
        Presale sale = Presale(payable(presaleAddr));
        total = sale.contributorsLength();
        address[] memory accounts = sale.getContributors(start, count);
        uint256 raised = sale.totalRaised();
        uint256 rate = sale.getParams().presaleRate;
        list = new ParticipantView[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            (uint256 contributed, uint256 exited, uint256 refunded, uint256 claimedTokens, uint64 joinedAt) =
                sale.statsOf(a);
            uint256 contribution = sale.contributionOf(a);
            uint8 state = 0;
            if (refunded > 0) state = 2;
            else if (claimedTokens > 0) state = 3;
            else if (contribution == 0 && exited > 0) state = 1;
            list[i] = ParticipantView({
                account: a,
                contribution: contribution,
                contributed: contributed,
                exited: exited,
                refunded: refunded,
                claimedTokens: claimedTokens,
                tokensDue: (contribution * rate) / WAD,
                shareBps: raised == 0 ? 0 : (contribution * 10_000) / raised,
                joinedAt: joinedAt,
                state: state
            });
        }
    }

    /// @notice Returns a presale's activity history in pages (oldest to newest).
    function presaleActivity(address presaleAddr, uint256 start, uint256 count)
        external
        view
        returns (Presale.Activity[] memory list, uint256 total)
    {
        Presale sale = Presale(payable(presaleAddr));
        total = sale.activityLength();
        list = sale.getActivities(start, count);
    }

    // ---------------------------------------------------------------- trend

    /// @notice Momentum signals for a presale since the moment `since`.
    function presaleMomentum(address presaleAddr, uint64 since) public view returns (MomentumView memory m) {
        Presale sale = Presale(payable(presaleAddr));
        PresaleParams memory p = sale.getParams();
        m.presale = presaleAddr;
        m.token = p.token;
        m.name = IERC20Metadata(p.token).name();
        m.symbol = IERC20Metadata(p.token).symbol();
        m.status = uint8(sale.status());
        m.startTime = p.startTime;
        m.endTime = p.endTime;
        m.totalRaised = sale.totalRaised();
        m.hardCap = p.hardCap;
        m.contributorCount = sale.contributorCount();
        m.whitelistCount = sale.whitelistCount();
        m.quick = presaleFactory.isQuick(presaleAddr);
        (m.buyTaxBps, m.sellTaxBps) = _tokenTaxes(p.token, tokenFactory.tokenInfo(p.token).tokenType);

        // Scan the activity log from the end backwards in chunks of 50; stop at the first record older than since.
        uint256 n = sale.activityLength();
        uint256 end = n;
        bool done = false;
        while (end > 0 && !done) {
            uint256 start = end > 50 ? end - 50 : 0;
            Presale.Activity[] memory acts = sale.getActivities(start, end - start);
            for (uint256 i = acts.length; i > 0; i--) {
                Presale.Activity memory a = acts[i - 1];
                if (a.timestamp < since) {
                    done = true;
                    break;
                }
                m.activitySince++;
                if (a.kind == uint8(Presale.ActivityKind.Contribute)) m.raisedSince += a.amount;
                else if (a.kind == uint8(Presale.ActivityKind.Exit)) m.exitedSince += a.amount;
            }
            end = start;
        }

        // The participant list is in first-participation order: scan from the end, stop when joinedAt < since.
        uint256 c = sale.contributorsLength();
        uint256 cend = c;
        done = false;
        while (cend > 0 && !done) {
            uint256 cstart = cend > 50 ? cend - 50 : 0;
            address[] memory accounts = sale.getContributors(cstart, cend - cstart);
            for (uint256 i = accounts.length; i > 0; i--) {
                (, , , , uint64 joinedAt) = sale.statsOf(accounts[i - 1]);
                if (joinedAt < since) {
                    done = true;
                    break;
                }
                m.newWalletsSince++;
            }
            cend = cstart;
        }

        if (m.status == uint8(Presale.Status.Finalized)) {
            LaunchView memory lv = launchView(presaleAddr);
            m.multiplierX18 = lv.multiplierX18;
            m.priceAvailable = lv.priceAvailable;
        }
    }

    /// @notice Momentum signals for all presales, paged. Sorting is done in the frontend.
    function momentumViews(uint256 start, uint256 count, uint64 since)
        external
        view
        returns (MomentumView[] memory list, uint256 total)
    {
        total = presaleFactory.allPresalesLength();
        if (start >= total) return (new MomentumView[](0), total);
        uint256 end = start + count > total ? total : start + count;
        list = new MomentumView[](end - start);
        for (uint256 i = start; i < end; i++) {
            list[i - start] = presaleMomentum(presaleFactory.allPresales(i), since);
        }
    }

    // -------------------------------------------------------- post-launch

    function launchView(address presaleAddr) public view returns (LaunchView memory v) {
        Presale sale = Presale(payable(presaleAddr));
        PresaleParams memory p = sale.getParams();
        TokenFactory.TokenInfo memory info = tokenFactory.tokenInfo(p.token);

        v.presale = presaleAddr;
        v.token = p.token;
        v.name = IERC20Metadata(p.token).name();
        v.symbol = IERC20Metadata(p.token).symbol();
        v.tokenType = uint8(info.tokenType);
        v.finalizedAt = sale.finalizedAt();
        v.totalRaised = sale.totalRaised();
        v.lpBurned = uint8(p.liquidityAction) == 1;
        v.factoryToken = tokenFactory.isPlatformToken(p.token);
        v.quick = presaleFactory.isQuick(presaleAddr);
        (v.buyTaxBps, v.sellTaxBps) = _tokenTaxes(p.token, info.tokenType);

        // Listing price: listingRate tokens = 1 ETH  =>  1 token = 1e18 / listingRate wei
        if (p.listingRate > 0) {
            v.listingPriceWei = (WAD * WAD) / p.listingRate;
        }

        (uint256 rToken, uint256 rWeth) = _reserves(p.token);
        v.liquidityWeth = rWeth;
        if (rToken > 0 && rWeth > 0) {
            v.currentPriceWei = (rWeth * WAD) / rToken;
            v.priceAvailable = true;
            if (v.listingPriceWei > 0) {
                v.multiplierX18 = (v.currentPriceWei * WAD) / v.listingPriceWei;
            }
        }
    }

    /// @notice Returns finalized presales (tokens that have launched) in pages.
    ///         The scan runs from newest to oldest.
    function launchViews(uint256 skip, uint256 count)
        external
        view
        returns (LaunchView[] memory list, uint256 totalFinalized)
    {
        uint256 total = presaleFactory.allPresalesLength();
        LaunchView[] memory buffer = new LaunchView[](count);
        uint256 found;
        uint256 n;

        for (uint256 i = total; i > 0; i--) {
            address presaleAddr = presaleFactory.allPresales(i - 1);
            if (uint8(Presale(payable(presaleAddr)).status()) != 5) continue; // 5 = Finalized
            totalFinalized++;
            if (found < skip) {
                found++;
                continue;
            }
            if (n < count) {
                buffer[n++] = launchView(presaleAddr);
            }
        }

        list = new LaunchView[](n);
        for (uint256 i = 0; i < n; i++) list[i] = buffer[i];
    }

    // ------------------------------------------------------------ helpers

    /// @notice Current pool price and reserves of a platform token.
    function tokenPrice(address token)
        external
        view
        returns (uint256 priceWei, uint256 reserveToken, uint256 reserveWeth)
    {
        (reserveToken, reserveWeth) = _reserves(token);
        if (reserveToken > 0) priceWei = (reserveWeth * WAD) / reserveToken;
    }

    function burnedSupply(address token) external view returns (uint256) {
        return IERC20Metadata(token).balanceOf(DEAD);
    }

    /// @dev The owner-set DEX taxes of a factory token by type; the platform tax is not included.
    ///      Non-factory tokens carry the default type (Standard) and report 0.
    function _tokenTaxes(address token, TokenFactory.TokenType tokenType)
        private
        view
        returns (uint16 buyTaxBps, uint16 sellTaxBps)
    {
        if (tokenType == TokenFactory.TokenType.Tax) {
            ITaxTokenView t = ITaxTokenView(token);
            return (t.buyTaxBps(), t.sellTaxBps());
        }
        if (tokenType == TokenFactory.TokenType.Rewards) {
            IRewardsTokenView r = IRewardsTokenView(token);
            return (r.rewardsBuyTaxBps() + r.marketingBuyTaxBps(), r.rewardsSellTaxBps() + r.marketingSellTaxBps());
        }
        return (0, 0);
    }

    function _reserves(address token) private view returns (uint256 reserveToken, uint256 reserveWeth) {
        address weth = router.WETH();
        address pair = IUniswapV2Factory(router.factory()).getPair(token, weth);
        if (pair == address(0)) return (0, 0);
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
        (reserveToken, reserveWeth) = token < weth ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }
}
