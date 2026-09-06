// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PresaleParams, LiquidityAction} from "./Presale.sol";
import {PresaleFactory} from "./PresaleFactory.sol";
import {TokenFactory} from "./TokenFactory.sol";
import {TokenMetadataRegistry} from "./TokenMetadataRegistry.sol";
import {IUniswapV2Factory, IUniswapV2Router02, IUniswapV2Pair} from "./interfaces/IUniswapV2.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IV3SwapRouter, V3Path} from "./interfaces/IUniswapV3.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev The only calls this contract ever makes into a rewards token it owns: the reward route
///      once at launch (when the reward token needs an intermediate hop) and again only through
///      repairRewardRoute, the distribution any time, and the registration of extra DEX pairs.
interface IQuickRewardsToken {
    function distributeRewards(uint256 amountOutMin) external;
    function setRewardRoute(address[] calldata intermediates) external;
    function setRewardRouteV3(bytes calldata path) external;
    function setAmmPair(address pair, bool value) external;
    function isAmmPair(address pair) external view returns (bool);
    function rewardPath() external view returns (address[] memory);
    function rewardRouteV3() external view returns (bytes memory);
}

/// @dev The rewards deployer of the token factory carries the chain's Uniswap V3 router
interface IRewardsDeployerV3 {
    function v3Router() external view returns (address);
}

/// @dev The views of an earlier QuickLaunch generation this one answers for (see previousQuickLaunch)
interface IQuickLaunchPrevious {
    function creatorOf(address presale) external view returns (address);
    function presaleOfToken(address token) external view returns (address);
}

/// @title QuickLaunch
/// @notice One transaction that creates a token and its quick presale with locked rules:
///         - total supply 1,000,000,000 (18 decimals), 50% sold in the sale
///         - listing price equal to the presale price, LP burned, unsold tokens burned at launch
///         - soft cap 25% of the hard cap, 0.1% minimum and 2% maximum per wallet
///         - 30 minutes, 1 hour, 2 hours or 6 hours; launch time equal to the end time
///         - the creator picks a share of the raise (0 to 10% of the gross raise); the platform
///           takes the factory's platform share (PresaleFactory.platformFeeBps, 2.5% on mainnet);
///           liquidity takes the rest
///         - every token beyond sale + liquidity is burned at creation
///         The creator picks the token type (QuickParams.tokenType):
///         - 0 Standard: no tax of its own, only the platform tax on DEX trades
///         - 1 Tax: a creator tax on DEX buys and sells (0 to 5% per side, at least one side
///           above zero) paid to the tax wallet
///         - 2 Rewards: holders earn rewards in an allowlisted reward token (WETH, USDG or a
///           tokenized stock), 1% to 5% per side, plus an optional marketing tax to the tax wallet;
///           rewards and marketing together stay within 5% per side
///         The tax wallet defaults to the creator (msg.sender) when left at zero. The platform tax
///         of the token factory applies on top of every type.
///
///         Ownership. Standard and Tax tokens are renounced at launch, so their taxes and wallet
///         can never change. A Rewards token launched here stays owned by this contract, because
///         RewardsToken.distributeRewards is restricted to the owner or the platform. After the
///         launch this contract makes three kinds of calls into a token it owns, each bounded by
///         the contract: distributeRewards(token, amountOutMin) swaps the accumulated rewards tax
///         and credits the holders, and only the owner of this contract or the platform keeper
///         (PresaleFactory.launchKeeper) may send it, because the caller sets the swap floor and
///         an open call would let anyone sandwich the swap with a zero floor; the two calls below
///         are open to anyone: registerAmmPair(token, pair) marks
///         a further pool of the platform DEX that holds the token as an AMM pair, so trades through
///         it are taxed like the main pool and the pool earns no rewards (never the reverse);
///         repairRewardRoute(token) points the token at the route stored here for its reward token,
///         only while the token's current route can no longer pay (a pool of it is gone or down to
///         dust) and the stored one can. It has no function that touches taxes, the wallet or fee
///         exclusions of a launched token, so a rewards token launched here is as fixed as a
///         renounced one. The owner of this contract only manages the reward token allowlist and
///         the swap routes (which reach a launched token only through repairRewardRoute), and has
///         no other power over launched tokens.
///
///         The reward swap route is the RewardsToken default, token -> WETH -> reward token (just
///         token -> WETH for WETH), unless the owner stored a route for the reward token: either
///         Uniswap V2 intermediate hops (setRewardRoute, for example [WETH, USDG]) or a packed
///         Uniswap V3 path from WETH to the reward token (setRewardRouteV3; on Robinhood Chain the
///         tokenized stocks trade on V3). Then launch sets that route on the token once, before
///         anything else. A launch requires every pool of the route to exist with real depth
///         (isRewardRouteLive: a swap of ten probes keeps at least half the rate of one probe,
///         ROUTE_PROBE_WETH; on V3 the liquidity of the current tick range decides), so a rewards
///         token is never created with rewards it cannot pay.
///
///         A replacement generation of this contract names the one before it (previousQuickLaunch):
///         creatorOf and presaleOfToken then answer for the sales of every generation, so the
///         registry keeps letting every quick creator edit their token profile.
///         The token profile (logo, description) and the tokenomics are written on chain.
///         This contract holds no ETH and no tokens between transactions.
contract QuickLaunch is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant SALE_SUPPLY = TOTAL_SUPPLY / 2; // 50% of the supply is sold
    uint256 public constant MIN_HARD_CAP = 0.5 ether;
    uint256 public constant MAX_HARD_CAP = 100 ether;
    uint8 public constant MAX_CREATOR_SHARE_PERCENT = 10;
    /// @notice Cap per side (5%) on the token's own tax: the creator tax of a Tax token, rewards
    ///         plus marketing of a Rewards token. The platform tax of the token factory applies on top.
    uint16 public constant MAX_CREATOR_TAX_BPS = 500;
    /// @notice A Rewards token pays at least 1% per side in rewards
    uint16 public constant MIN_REWARDS_TAX_BPS = 100;
    uint8 public constant TYPE_STANDARD = 0;
    uint8 public constant TYPE_TAX = 1;
    uint8 public constant TYPE_REWARDS = 2;
    /// @notice RewardsToken.MAX_ROUTE_HOPS: the most intermediate hops a reward route may have
    uint256 public constant MAX_ROUTE_HOPS = 3;
    /// @notice The WETH amount isRewardRouteLive quotes along a route: a swap of ten probes must
    ///         keep at least half the per-probe output, which no pool holding dust can do.
    uint256 public constant ROUTE_PROBE_WETH = 0.01 ether;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    TokenFactory public immutable tokenFactory;
    PresaleFactory public immutable presaleFactory;
    TokenMetadataRegistry public immutable metadataRegistry;
    /// @notice Length of the allowlist the constructor received (the first entries of the list)
    uint256 public immutable initialRewardTokenCount;
    /// @notice The generation this one replaced (zero for the first): its sales answer through
    ///         creatorOf and presaleOfToken here
    address public immutable previousQuickLaunch;

    /// @notice Everything a launch takes. Strings first, then the sale, then the token.
    struct QuickParams {
        string name;
        string symbol;
        uint256 hardCap;
        /// @dev 0 = 30 minutes, 1 = 1 hour, 2 = 2 hours, 3 = 6 hours
        uint8 durationOption;
        /// @dev integer percent of the gross raise for the creator, 0 to 10
        uint8 creatorSharePercent;
        /// @dev 0 Standard, 1 Tax, 2 Rewards
        uint8 tokenType;
        /// @dev Rewards only: an allowlisted reward token (WETH, USDG or a tokenized stock); zero otherwise
        address rewardToken;
        /// @dev Tax and Rewards: the wallet the tax is paid to; zero means msg.sender
        address taxWallet;
        /// @dev Tax: the creator tax per side; Rewards: the marketing tax per side; zero for Standard
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        /// @dev Rewards only: the rewards tax per side, MIN_REWARDS_TAX_BPS or more
        uint16 rewardsBuyBps;
        uint16 rewardsSellBps;
        string logoURI;
        string description;
    }

    /// @notice The token of a quick sale as it was fixed at launch: nothing here can change.
    ///         buyTaxBps / sellTaxBps are the creator tax of a Tax token and the marketing tax of
    ///         a Rewards token; the rewards taxes are separate. All zero for a Standard token.
    struct QuickToken {
        uint8 tokenType;
        address rewardToken;
        address taxWallet;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 rewardsBuyBps;
        uint16 rewardsSellBps;
    }

    /// @dev presale => creator wallet, this generation only (see creatorOf)
    mapping(address => address) private _creatorOf;
    /// @notice presale => the token as fixed at launch (see quickTokenOf)
    mapping(address => QuickToken) private _quickTokenOf;
    /// @dev token => presale, this generation only (see presaleOfToken)
    mapping(address => address) private _presaleOfToken;
    address[] public allLaunches;

    /// @notice Reward tokens a Rewards launch may pick. Managed by the owner of this contract.
    mapping(address => bool) public isRewardTokenAllowed;
    /// @dev Every token ever allowed, in the order it was first allowed (the constructor list first)
    address[] private _rewardTokens;
    /// @notice reward token => intermediate hops (WETH first) the tokens launched with it swap
    ///         through; empty means the RewardsToken default. Applies to future launches only.
    mapping(address => address[]) private _rewardRouteOf;
    /// @notice reward token => packed Uniswap V3 path (WETH first, the reward token last) the
    ///         tokens launched with it swap through; empty means the V2 route above applies.
    mapping(address => bytes) private _rewardRouteV3Of;

    event QuickLaunched(
        address indexed token,
        address indexed presale,
        address indexed creator,
        uint256 hardCap,
        uint64 endTime,
        uint16 creatorShareBps,
        uint8 tokenType,
        address rewardToken,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        uint16 rewardsBuyBps,
        uint16 rewardsSellBps
    );
    event LeftoversBurned(address indexed token, uint256 amount);
    event RewardTokenAllowed(address indexed token, bool allowed);
    event RewardRouteSet(address indexed rewardToken, address[] intermediates);
    event RewardRouteV3Set(address indexed rewardToken, bytes path);
    event AmmPairRegistered(address indexed token, address indexed pair);
    event RewardRouteRepaired(address indexed token, address[] path);
    event RewardRouteV3Repaired(address indexed token, bytes path);

    /// @param rewardTokens_ the initial reward allowlist: WETH, USDG and the tokenized stocks
    /// @param previousQuickLaunch_ the generation this one replaces, zero for the first
    constructor(
        address tokenFactory_,
        address presaleFactory_,
        address metadataRegistry_,
        address[] memory rewardTokens_,
        address previousQuickLaunch_
    ) Ownable(msg.sender) {
        require(previousQuickLaunch_ != address(this), "bad previous");
        require(
            tokenFactory_ != address(0) && presaleFactory_ != address(0) && metadataRegistry_ != address(0),
            "zero addr"
        );
        tokenFactory = TokenFactory(tokenFactory_);
        presaleFactory = PresaleFactory(presaleFactory_);
        metadataRegistry = TokenMetadataRegistry(metadataRegistry_);
        for (uint256 i = 0; i < rewardTokens_.length; i++) {
            require(!isRewardTokenAllowed[rewardTokens_[i]], "duplicate reward token");
            _setRewardTokenAllowed(rewardTokens_[i], true);
        }
        initialRewardTokenCount = rewardTokens_.length;
        previousQuickLaunch = previousQuickLaunch_;
    }

    // ------------------------------------------------------------ launch

    /// @notice Creates the token and its quick presale. See QuickParams for the inputs and the
    ///         contract notice for the rules of each token type.
    function launch(QuickParams calldata q) external payable nonReentrant returns (address token, address presale) {
        require(msg.value == presaleFactory.quickCreationFee(), "wrong creation fee");
        require(q.hardCap >= MIN_HARD_CAP && q.hardCap <= MAX_HARD_CAP, "hard cap out of range");
        require(q.hardCap % 4 == 0, "hard cap not divisible by 4");
        require(q.creatorSharePercent <= MAX_CREATOR_SHARE_PERCENT, "share too high");
        QuickToken memory t = _tokenSpec(q);
        uint16 creatorShareBps = uint16(q.creatorSharePercent) * 100;

        // The token: this contract is its owner and holds the whole supply for a moment.
        token = _createToken(q.name, q.symbol, t);
        if (t.tokenType == TYPE_REWARDS) {
            // Set once, before anything else, while this contract owns the token (the deployer
            // already applies the stored V3 path; the V2 hops are applied here).
            if (_rewardRouteV3Of[t.rewardToken].length > 0) {
                IQuickRewardsToken(token).setRewardRouteV3(_rewardRouteV3Of[t.rewardToken]);
            } else if (_rewardRouteOf[t.rewardToken].length > 0) {
                IQuickRewardsToken(token).setRewardRoute(_rewardRouteOf[t.rewardToken]);
            }
        }

        PresaleParams memory p = quickParams(token, q.hardCap, q.durationOption, creatorShareBps);
        uint256 required = presaleFactory.requiredTokensFor(p);
        IERC20(token).forceApprove(address(presaleFactory), required);
        presale = presaleFactory.createQuickPresale{value: msg.value}(p, msg.sender, creatorShareBps);

        // Profile and tokenomics, written while this contract owns the token.
        if (bytes(q.logoURI).length > 0 || bytes(q.description).length > 0) {
            TokenMetadataRegistry.Metadata memory m;
            m.logoURI = q.logoURI;
            m.description = q.description;
            metadataRegistry.setMetadata(token, m);
        }
        metadataRegistry.setTokenomics(token, _tokenomics(required - _tokensForSale(q.hardCap, p.presaleRate)));

        // Everything beyond sale + liquidity is burned. Standard and Tax tokens are renounced;
        // a Rewards token stays owned by this contract (see the contract notice).
        _burnBalance(token);
        if (t.tokenType != TYPE_REWARDS) Ownable(token).renounceOwnership();

        _creatorOf[presale] = msg.sender;
        _quickTokenOf[presale] = t;
        _presaleOfToken[token] = presale;
        allLaunches.push(presale);
        emit QuickLaunched(
            token,
            presale,
            msg.sender,
            q.hardCap,
            p.endTime,
            creatorShareBps,
            t.tokenType,
            t.rewardToken,
            t.buyTaxBps,
            t.sellTaxBps,
            t.rewardsBuyBps,
            t.rewardsSellBps
        );
    }

    /// @notice Swaps the rewards tax a quick Rewards token has accumulated into its reward token
    ///         and credits the holders (RewardsToken.distributeRewards). Only the owner of this
    ///         contract or the platform keeper (PresaleFactory.launchKeeper) may call it: the
    ///         caller sets the swap floor, so an open call would let anyone sandwich the swap. The
    ///         keeper sends it whenever the accumulation reaches the token's swap threshold. `amountOutMin` guards the swap; the keeper passes a floor taken from
    ///         its own quote of the route and skips the send while the route cannot hold its rate.
    function distributeRewards(address token, uint256 amountOutMin) external nonReentrant {
        require(msg.sender == owner() || msg.sender == presaleFactory.launchKeeper(), "not keeper");
        require(_isQuickRewards(token), "not a quick rewards token");
        IQuickRewardsToken(token).distributeRewards(amountOutMin);
    }

    /// @notice Marks a further pool of the platform DEX that holds a quick Rewards token launched
    ///         here as an AMM pair of that token, so trades through it are taxed like the main pool
    ///         and the pool itself earns no rewards. Anyone may call it for any Uniswap V2 pair of
    ///         the platform DEX that holds the token; a pair is never unregistered.
    function registerAmmPair(address token, address pair) external nonReentrant {
        require(_isQuickRewards(token), "not a quick rewards token");
        require(pair != address(0), "zero addr");
        address t0 = IUniswapV2Pair(pair).token0();
        address t1 = IUniswapV2Pair(pair).token1();
        require(t0 == token || t1 == token, "pair without the token");
        require(_dex().getPair(t0, t1) == pair, "not a pair of the platform DEX");
        require(!IQuickRewardsToken(token).isAmmPair(pair), "already registered");
        IQuickRewardsToken(token).setAmmPair(pair, true);
        emit AmmPairRegistered(token, pair);
    }

    /// @notice Points a quick Rewards token launched here at the route stored for its reward token
    ///         (rewardPathOf), only while the token's current route can no longer pay its rewards
    ///         (a pool of it is gone or down to dust) and the stored route can. Anyone may call it.
    ///         The route of a token that can still pay never changes.
    function repairRewardRoute(address token) external nonReentrant {
        require(_isQuickRewards(token), "not a quick rewards token");
        require(!_tokenRouteLive(token), "route still live");
        address rewardToken = _quickTokenOf[_presaleOfToken[token]].rewardToken;
        bytes memory storedV3 = _rewardRouteV3Of[rewardToken];
        if (storedV3.length > 0) {
            require(_v3RouteLive(storedV3), "stored route has no pool");
            IQuickRewardsToken(token).setRewardRouteV3(storedV3);
            emit RewardRouteV3Repaired(token, storedV3);
            return;
        }
        address[] memory stored = rewardPathOf(rewardToken);
        require(_routeLive(stored), "stored route has no pool");
        // Setting the V2 hops on the token also clears a V3 path it may hold
        IQuickRewardsToken(token).setRewardRoute(_intermediatesFor(rewardToken));
        emit RewardRouteRepaired(token, stored);
    }

    /// @notice Burns any balance of `token` this contract holds. It never holds tokens after a
    ///         launch, so this only matters for tokens sent here by mistake.
    function burnLeftovers(address token) external nonReentrant {
        require(_burnBalance(token) > 0, "nothing to burn");
    }

    // ------------------------------------------------------------- admin

    /// @notice Adds a reward token to the allowlist or removes it. Removing one does not touch
    ///         the tokens already launched with it.
    function setRewardTokenAllowed(address token, bool allowed) external onlyOwner {
        require(token != address(0), "zero addr");
        if (isRewardTokenAllowed[token] == allowed) return;
        _setRewardTokenAllowed(token, allowed);
    }

    /// @notice Stores the intermediate hops the tokens launched with `rewardToken` from now on
    ///         swap through (RewardsToken.setRewardRoute rules: at most MAX_ROUTE_HOPS, WETH first,
    ///         no zero address and not the reward token itself). An empty list restores the
    ///         RewardsToken default. Tokens already launched keep the route they were launched with.
    function setRewardRoute(address rewardToken, address[] calldata intermediates) external onlyOwner {
        require(rewardToken != address(0), "zero addr");
        require(intermediates.length <= MAX_ROUTE_HOPS, "route too long");
        for (uint256 i = 0; i < intermediates.length; i++) {
            require(intermediates[i] != address(0) && intermediates[i] != rewardToken, "bad hop");
        }
        if (intermediates.length > 0) require(intermediates[0] == _weth(), "route must start at WETH");
        delete _rewardRouteOf[rewardToken];
        for (uint256 i = 0; i < intermediates.length; i++) _rewardRouteOf[rewardToken].push(intermediates[i]);
        if (_rewardRouteV3Of[rewardToken].length > 0) {
            delete _rewardRouteV3Of[rewardToken];
            emit RewardRouteV3Set(rewardToken, "");
        }
        emit RewardRouteSet(rewardToken, intermediates);
    }

    /// @notice Stores the packed Uniswap V3 path (WETH first, `rewardToken` last, token-fee-token
    ///         ...) the tokens launched with `rewardToken` from now on swap through after their own
    ///         WETH pool, replacing any V2 hops. Every pool of the path must exist on the V3 factory
    ///         of the rewards deployer's router. An empty path removes it (the V2 route applies
    ///         again). Tokens already launched keep the route they were launched with.
    function setRewardRouteV3(address rewardToken, bytes calldata path) external onlyOwner {
        require(rewardToken != address(0), "zero addr");
        if (path.length == 0) {
            delete _rewardRouteV3Of[rewardToken];
            emit RewardRouteV3Set(rewardToken, path);
            return;
        }
        address weth = _weth();
        require(rewardToken != weth, "no V3 route for WETH");
        require(V3Path.isWellFormed(path), "bad V3 path");
        require(V3Path.poolCount(path) <= MAX_ROUTE_HOPS + 1, "route too long");
        require(V3Path.firstToken(path) == weth, "route must start at WETH");
        require(V3Path.lastToken(path) == rewardToken, "route must end at reward");
        IUniswapV3Factory v3Factory = _v3Factory();
        require(address(v3Factory) != address(0), "no V3 router");
        for (uint256 i = 0; i < V3Path.poolCount(path); i++) {
            (address a, uint24 fee, address b) = V3Path.hop(path, i);
            require(a != address(0) && b != address(0) && a != b, "bad hop");
            require(v3Factory.getPool(a, b, fee) != address(0), "no V3 pool");
        }
        if (_rewardRouteOf[rewardToken].length > 0) {
            delete _rewardRouteOf[rewardToken];
            emit RewardRouteSet(rewardToken, new address[](0));
        }
        _rewardRouteV3Of[rewardToken] = path;
        emit RewardRouteV3Set(rewardToken, path);
    }

    // ------------------------------------------------------------- views

    /// @notice The token of a quick sale as fixed at launch (all zero for an unknown presale).
    function quickTokenOf(address presale) external view returns (QuickToken memory) {
        return _quickTokenOf[presale];
    }

    /// @notice The wallet that launched a quick sale, of this generation or an earlier one
    ///         (zero for an unknown presale).
    function creatorOf(address presale) public view returns (address creator) {
        creator = _creatorOf[presale];
        if (creator == address(0) && previousQuickLaunch != address(0)) {
            creator = IQuickLaunchPrevious(previousQuickLaunch).creatorOf(presale);
        }
    }

    /// @notice The quick sale of a token launched by this generation or an earlier one
    ///         (zero for an unknown token).
    function presaleOfToken(address token) public view returns (address presale) {
        presale = _presaleOfToken[token];
        if (presale == address(0) && previousQuickLaunch != address(0)) {
            presale = IQuickLaunchPrevious(previousQuickLaunch).presaleOfToken(token);
        }
    }

    /// @notice The reward tokens a Rewards launch may pick right now.
    function rewardTokens() external view returns (address[] memory list) {
        uint256 n;
        for (uint256 i = 0; i < _rewardTokens.length; i++) {
            if (isRewardTokenAllowed[_rewardTokens[i]]) n++;
        }
        list = new address[](n);
        uint256 j;
        for (uint256 i = 0; i < _rewardTokens.length; i++) {
            if (isRewardTokenAllowed[_rewardTokens[i]]) list[j++] = _rewardTokens[i];
        }
    }

    /// @notice The intermediate hops stored for a reward token (empty: the RewardsToken default).
    function rewardRouteOf(address rewardToken) external view returns (address[] memory) {
        return _rewardRouteOf[rewardToken];
    }

    /// @notice The packed Uniswap V3 path stored for a reward token (empty: the V2 route applies).
    function rewardRouteV3Of(address rewardToken) external view returns (bytes memory) {
        return _rewardRouteV3Of[rewardToken];
    }

    /// @notice True while the route a launched quick Rewards token currently follows can pay its
    ///         rewards (see isRewardRouteLive for the rule); false for any other token.
    function isTokenRouteLive(address token) external view returns (bool) {
        if (!_isQuickRewards(token)) return false;
        return _tokenRouteLive(token);
    }

    /// @notice The hops a token launched now with `rewardToken` swaps through after itself:
    ///         [WETH, ...intermediates, rewardToken], or just [WETH] when the reward token is WETH.
    function rewardPathOf(address rewardToken) public view returns (address[] memory path) {
        address weth = _weth();
        if (rewardToken == weth) {
            path = new address[](1);
            path[0] = weth;
            return path;
        }
        address[] storage hops = _rewardRouteOf[rewardToken];
        uint256 n = hops.length == 0 ? 1 : hops.length;
        path = new address[](n + 1);
        if (hops.length == 0) path[0] = weth;
        for (uint256 i = 0; i < hops.length; i++) path[i] = hops[i];
        path[n] = rewardToken;
    }

    /// @notice True when every pool the reward swap crosses after the token's own WETH pool exists
    ///         on the DEX with real depth, so a token launched now could pay its rewards: a swap of
    ///         ten probes (ROUTE_PROBE_WETH) along the route keeps at least half the per-probe
    ///         output of a single probe. A route that ends at WETH is always live.
    function isRewardRouteLive(address rewardToken) public view returns (bool) {
        bytes memory v3 = _rewardRouteV3Of[rewardToken];
        if (v3.length > 0) return _v3RouteLive(v3);
        return _routeLive(rewardPathOf(rewardToken));
    }

    /// @notice The allowlist the constructor received, in order (the constructor argument).
    function initialRewardTokens() external view returns (address[] memory list) {
        list = new address[](initialRewardTokenCount);
        for (uint256 i = 0; i < initialRewardTokenCount; i++) list[i] = _rewardTokens[i];
    }

    function allLaunchesLength() external view returns (uint256) {
        return allLaunches.length;
    }

    /// @notice Sale length for a duration option.
    function durationOf(uint8 option) public pure returns (uint64) {
        if (option == 0) return 30 minutes;
        if (option == 1) return 1 hours;
        if (option == 2) return 2 hours;
        if (option == 3) return 6 hours;
        revert("bad duration option");
    }

    /// @notice Tokens per 1 ETH for a hard cap: half the supply spread over the hard cap.
    function presaleRateFor(uint256 hardCap) public pure returns (uint256) {
        return (SALE_SUPPLY * 1e18) / hardCap;
    }

    /// @notice The exact presale parameters a launch writes (start time = now). Also useful for
    ///         previews: requiredTokensFor(quickParams(...)) is the number of tokens kept for the sale
    ///         and the liquidity, the rest of the supply is burned.
    function quickParams(address token, uint256 hardCap, uint8 durationOption, uint16 creatorShareBps)
        public
        view
        returns (PresaleParams memory p)
    {
        uint64 start = uint64(block.timestamp);
        uint64 end = start + durationOf(durationOption);
        uint256 rate = presaleRateFor(hardCap);
        p = PresaleParams({
            token: token,
            presaleRate: rate,
            listingRate: rate,
            softCap: hardCap / 4,
            hardCap: hardCap,
            minContribution: hardCap / 1000,
            maxContribution: hardCap / 50,
            startTime: start,
            endTime: end,
            liquidityBps: presaleFactory.quickLiquidityBps(creatorShareBps),
            liquidityAction: LiquidityAction.Burn,
            lockDuration: 0,
            launchTime: end,
            whitelistEnabled: false
        });
    }

    // ----------------------------------------------------------- internal

    /// @dev Validates the token part of the params and turns it into the record kept per sale.
    function _tokenSpec(QuickParams calldata q) private view returns (QuickToken memory t) {
        require(q.tokenType <= TYPE_REWARDS, "bad token type");
        t.tokenType = q.tokenType;
        if (q.tokenType == TYPE_STANDARD) {
            require(
                q.buyTaxBps == 0 && q.sellTaxBps == 0 && q.rewardsBuyBps == 0 && q.rewardsSellBps == 0,
                "standard token has no tax"
            );
            require(q.rewardToken == address(0), "no reward token for this type");
            return t;
        }
        t.taxWallet = q.taxWallet == address(0) ? msg.sender : q.taxWallet;
        t.buyTaxBps = q.buyTaxBps;
        t.sellTaxBps = q.sellTaxBps;
        if (q.tokenType == TYPE_TAX) {
            require(q.rewardsBuyBps == 0 && q.rewardsSellBps == 0, "rewards tax on a tax token");
            require(q.rewardToken == address(0), "no reward token for this type");
            require(q.buyTaxBps > 0 || q.sellTaxBps > 0, "tax token without tax");
            require(q.buyTaxBps <= MAX_CREATOR_TAX_BPS && q.sellTaxBps <= MAX_CREATOR_TAX_BPS, "creator tax too high");
            return t;
        }
        require(isRewardTokenAllowed[q.rewardToken], "reward token not allowed");
        require(isRewardRouteLive(q.rewardToken), "reward route has no pool");
        require(q.rewardsBuyBps >= MIN_REWARDS_TAX_BPS && q.rewardsSellBps >= MIN_REWARDS_TAX_BPS, "rewards tax too low");
        require(
            uint256(q.rewardsBuyBps) + q.buyTaxBps <= MAX_CREATOR_TAX_BPS &&
                uint256(q.rewardsSellBps) + q.sellTaxBps <= MAX_CREATOR_TAX_BPS,
            "creator tax too high"
        );
        t.rewardToken = q.rewardToken;
        t.rewardsBuyBps = q.rewardsBuyBps;
        t.rewardsSellBps = q.rewardsSellBps;
    }

    function _createToken(string calldata name, string calldata symbol, QuickToken memory t) private returns (address) {
        if (t.tokenType == TYPE_STANDARD) return tokenFactory.createStandardToken(name, symbol, TOTAL_SUPPLY);
        if (t.tokenType == TYPE_TAX) {
            return tokenFactory.createTaxToken(name, symbol, TOTAL_SUPPLY, t.taxWallet, t.buyTaxBps, t.sellTaxBps);
        }
        return tokenFactory.createRewardsToken(
            name,
            symbol,
            TOTAL_SUPPLY,
            t.rewardToken,
            t.taxWallet,
            [t.rewardsBuyBps, t.rewardsSellBps, t.buyTaxBps, t.sellTaxBps]
        );
    }

    function _weth() private view returns (address) {
        return IUniswapV2Router02(tokenFactory.router()).WETH();
    }

    function _dex() private view returns (IUniswapV2Factory) {
        return IUniswapV2Factory(IUniswapV2Router02(tokenFactory.router()).factory());
    }

    /// @dev The Uniswap V3 factory behind the rewards deployer's router, zero when the deployer
    ///      has no V3 leg (an earlier deployer generation, or a chain without V3)
    function _v3Factory() private view returns (IUniswapV3Factory) {
        (bool ok, bytes memory data) = address(tokenFactory.rewardsDeployer()).staticcall(
            abi.encodeCall(IRewardsDeployerV3.v3Router, ())
        );
        if (!ok || data.length < 32) return IUniswapV3Factory(address(0));
        address v3Router = abi.decode(data, (address));
        if (v3Router == address(0)) return IUniswapV3Factory(address(0));
        return IUniswapV3Factory(IV3SwapRouter(v3Router).factory());
    }

    /// @dev Whether the route a launched Rewards token follows right now can pay: its V3 path when
    ///      it has one, else the pools after its own WETH pool on V2
    function _tokenRouteLive(address token) private view returns (bool) {
        bytes memory v3 = IQuickRewardsToken(token).rewardRouteV3();
        if (v3.length > 0) return _v3RouteLive(v3);
        address[] memory current = IQuickRewardsToken(token).rewardPath();
        // RewardsToken.rewardPath starts with the token itself
        address[] memory afterWeth = new address[](current.length - 1);
        for (uint256 i = 1; i < current.length; i++) afterWeth[i - 1] = current[i];
        return _routeLive(afterWeth);
    }

    /// @dev The V3 counterpart of _routeLive for a packed path from WETH: every pool must exist
    ///      with liquidity in its current tick range, the virtual reserves of that range must hold
    ///      at least eight probes of the hop's input (the same bound the ten-probe rule puts on a
    ///      constant product pool), and the pool must really hold the output of ten probes, since
    ///      the virtual reserves of a narrow position overstate what it can pay. The probe is
    ///      carried through the hops at the spot price.
    function _v3RouteLive(bytes memory path) private view returns (bool) {
        if (!V3Path.isWellFormed(path)) return false;
        IUniswapV3Factory v3Factory = _v3Factory();
        if (address(v3Factory) == address(0)) return false;
        uint256 amountIn = ROUTE_PROBE_WETH;
        uint256 pools = V3Path.poolCount(path);
        for (uint256 i = 0; i < pools; i++) {
            (address a, uint24 fee, address b) = V3Path.hop(path, i);
            address pool = v3Factory.getPool(a, b, fee);
            if (pool == address(0)) return false;
            uint128 liquidity = IUniswapV3Pool(pool).liquidity();
            (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
            if (liquidity == 0 || sqrtPriceX96 == 0) return false;
            // Virtual reserves of the current range: x = L * 2^96 / sqrtP (token0), y = L * sqrtP / 2^96 (token1)
            uint256 x = Math.mulDiv(liquidity, 2 ** 96, sqrtPriceX96);
            uint256 y = Math.mulDiv(liquidity, sqrtPriceX96, 2 ** 96);
            bool zeroForOne = a < b;
            uint256 reserveIn = zeroForOne ? x : y;
            if (reserveIn < 8 * amountIn) return false;
            uint256 spotOut = zeroForOne ? Math.mulDiv(amountIn, y, x) : Math.mulDiv(amountIn, x, y);
            if (spotOut == 0) return false;
            if (IERC20(b).balanceOf(pool) < 10 * spotOut) return false;
            amountIn = spotOut;
        }
        return true;
    }

    /// @dev A Rewards token launched by this generation (the only ones this contract owns)
    function _isQuickRewards(address token) private view returns (bool) {
        address presale = _presaleOfToken[token];
        return presale != address(0) && _quickTokenOf[presale].tokenType == TYPE_REWARDS;
    }

    /// @dev The intermediate hops a token launched with `rewardToken` gets: the stored route, else
    ///      the RewardsToken default ([WETH], or none when the reward token is WETH)
    function _intermediatesFor(address rewardToken) private view returns (address[] memory hops) {
        hops = _rewardRouteOf[rewardToken];
        if (hops.length == 0 && rewardToken != _weth()) {
            hops = new address[](1);
            hops[0] = _weth();
        }
    }

    /// @dev `path` runs from WETH to the reward token (see rewardPathOf). Every pool along it must
    ///      exist with reserves on both sides, and the route must hold its rate for ten probes.
    function _routeLive(address[] memory path) private view returns (bool) {
        if (path.length < 2) return true;
        IUniswapV2Router02 router = IUniswapV2Router02(tokenFactory.router());
        IUniswapV2Factory dex = IUniswapV2Factory(router.factory());
        for (uint256 i = 0; i + 1 < path.length; i++) {
            address pair = dex.getPair(path[i], path[i + 1]);
            if (pair == address(0)) return false;
            (uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
            if (r0 == 0 || r1 == 0) return false;
        }
        uint256[] memory one = router.getAmountsOut(ROUTE_PROBE_WETH, path);
        uint256[] memory ten = router.getAmountsOut(ROUTE_PROBE_WETH * 10, path);
        uint256 outOne = one[one.length - 1];
        return outOne > 0 && ten[ten.length - 1] >= outOne * 5;
    }

    function _setRewardTokenAllowed(address token, bool allowed) private {
        require(token != address(0), "zero addr");
        if (allowed && !_everAllowed(token)) _rewardTokens.push(token);
        isRewardTokenAllowed[token] = allowed;
        emit RewardTokenAllowed(token, allowed);
    }

    function _everAllowed(address token) private view returns (bool) {
        for (uint256 i = 0; i < _rewardTokens.length; i++) {
            if (_rewardTokens[i] == token) return true;
        }
        return false;
    }

    function _tokensForSale(uint256 hardCap, uint256 rate) private pure returns (uint256) {
        return (hardCap * rate) / 1e18;
    }

    /// @dev Presale 50%, Liquidity in bps of the supply rounded half up, Burned the rest.
    function _tokenomics(uint256 liquidityTokens)
        private
        pure
        returns (TokenMetadataRegistry.Allocation[] memory slices)
    {
        uint16 liquidityBps = uint16((liquidityTokens * BPS * 2 + TOTAL_SUPPLY) / (2 * TOTAL_SUPPLY));
        uint16 presaleBps = uint16(BPS / 2);
        slices = new TokenMetadataRegistry.Allocation[](3);
        slices[0] = TokenMetadataRegistry.Allocation({label: "Presale", bps: presaleBps, note: ""});
        slices[1] = TokenMetadataRegistry.Allocation({label: "Liquidity", bps: liquidityBps, note: "LP burned at launch"});
        slices[2] = TokenMetadataRegistry.Allocation({
            label: "Burned",
            bps: uint16(BPS) - presaleBps - liquidityBps,
            note: "Burned at creation"
        });
    }

    function _burnBalance(address token) private returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) {
            IERC20(token).safeTransfer(DEAD, amount);
            emit LeftoversBurned(token, amount);
        }
    }
}
