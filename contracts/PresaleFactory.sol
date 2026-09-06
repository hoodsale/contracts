// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Presale, PresaleParams, LiquidityAction} from "./Presale.sol";

interface ITokenFactory {
    function isPlatformToken(address token) external view returns (bool);
}

interface IPlatformToken {
    function excludeFromFees(address account, bool value) external;
    function owner() external view returns (address);
}

interface IRewardsToken {
    function setExcludedFromRewards(address account, bool value) external;
}

interface IPresaleCode {
    function creationCode() external pure returns (bytes memory);
}

/// @title PresaleFactory
/// @notice Creates presales. Rules:
///         - Presales can only be run with tokens created by the platform TokenFactory
///         - The creation fee is 0.1 ETH (goes to Treasury); a quick presale costs 0.03 ETH
///         - 10% of the raised proceeds is the platform fee, the early exit penalty is 10%
///         - The liquidity share is at least 51%; LP is locked (min 30 days) or burned
///         Quick presales (createQuickPresale) run with locked rules: LP burned, listing price
///         equal to the presale price, soft cap at 25% of the hard cap, 30 minutes to 6 hours,
///         launch time equal to the end time, no whitelist, and the creator's share of the raise
///         (0 to 10% of the gross raise) encoded in liquidityBps. The sale launches itself.
contract PresaleFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 2_000; // fee/penalty cap 20%
    uint16 public constant MIN_LIQUIDITY_BPS = 5_100; // min 51% liquidity
    uint64 public constant MIN_LOCK_DURATION = 30 days;
    uint64 public constant MAX_SALE_DURATION = 90 days;
    /// @dev Must be the same as FINALIZE_GRACE_PERIOD in Presale.
    uint64 public constant FINALIZE_GRACE_PERIOD = 14 days;
    /// @notice Quick presale limits
    uint64 public constant MIN_QUICK_DURATION = 30 minutes;
    uint64 public constant MAX_QUICK_DURATION = 6 hours;
    uint16 public constant MAX_CREATOR_SHARE_BPS = 1_000; // 10% of the gross raise

    uint256 public creationFee = 0.1 ether;
    uint256 public quickCreationFee = 0.03 ether;
    uint16 public platformFeeBps = 1_000; // 10%
    uint16 public exitPenaltyBps = 1_000; // 10%

    address payable public treasury;
    ITokenFactory public tokenFactory;
    address public locker;
    address public router;
    /// @notice Holder of Presale's creation code (see PresaleCode).
    IPresaleCode public presaleCode;
    /// @notice The QuickLaunch contract, the only caller of createQuickPresale. Restricting the
    ///         caller is what makes the quick flag mean the full set of guarantees (supply burned
    ///         to sale + liquidity, ownership renounced, profile written), not only the sale rules.
    address public quickLaunch;

    /// @notice Allowlist for tokens that are not from the factory but belong to the platform (e.g. HOODSALE).
    ///         Only the platform owner can add entries; user tokens cannot go through this path.
    mapping(address => bool) public allowedToken;

    /// @notice The platform's launch bot. This is the ONLY address that can call finalize
    ///         on the owner's behalf once a scheduled sale's launch time has arrived.
    ///         If zero, automation is off and only the owner performs the launch.
    address public launchKeeper;

    address[] public allPresales;
    mapping(address => bool) public isPresale;
    mapping(address => address[]) private _presalesOfCreator;
    mapping(address => address) public activePresaleOfToken;
    /// @notice Quick presales and the wallet that created them (their payout recipient).
    mapping(address => bool) public isQuick;
    mapping(address => address) public quickCreatorOf;

    event PresaleCreated(address indexed presale, address indexed token, address indexed creator);
    event QuickPresaleCreated(
        address indexed presale,
        address indexed token,
        address indexed creator,
        uint16 creatorShareBps
    );
    event CreationFeeUpdated(uint256 fee);
    event QuickCreationFeeUpdated(uint256 fee);
    event FeesUpdated(uint16 platformFeeBps, uint16 exitPenaltyBps);
    event TokenAllowed(address indexed token, bool allowed);
    event LaunchKeeperSet(address keeper);
    event PresaleCodeSet(address presaleCode);
    event QuickLaunchSet(address quickLaunch);

    constructor(
        address owner_,
        address payable treasury_,
        address tokenFactory_,
        address locker_,
        address router_
    ) Ownable(owner_) {
        require(
            treasury_ != address(0) && tokenFactory_ != address(0) && locker_ != address(0) && router_ != address(0),
            "zero addr"
        );
        treasury = treasury_;
        tokenFactory = ITokenFactory(tokenFactory_);
        locker = locker_;
        router = router_;
    }

    // ---------------------------------------------------------- creation

    function createPresale(PresaleParams calldata p) external payable nonReentrant returns (address presale) {
        require(msg.value == creationFee, "wrong creation fee");
        presale = _create(p, msg.sender);
    }

    /// @notice Creates a quick presale on behalf of `creator`. Only the QuickLaunch contract may
    ///         call it (it owns the token at that moment); it pays the quick creation fee and
    ///         the sale is switched to quick mode in the same transaction.
    /// @param creatorShareBps The creator's share of the GROSS raise in bps (0..1000). On chain
    ///        the platform fee is taken first and liquidityBps applies to the net raise, so the
    ///        params must carry liquidityBps == quickLiquidityBps(creatorShareBps).
    function createQuickPresale(PresaleParams calldata p, address creator, uint16 creatorShareBps)
        external
        payable
        nonReentrant
        returns (address presale)
    {
        require(msg.sender == quickLaunch, "not quick launch");
        require(msg.value == quickCreationFee, "wrong creation fee");
        require(creator != address(0), "zero creator");
        require(creatorShareBps <= MAX_CREATOR_SHARE_BPS, "share too high");
        require(p.liquidityBps == quickLiquidityBps(creatorShareBps), "liquidity bps mismatch");
        require(p.liquidityAction == LiquidityAction.Burn, "quick sale must burn lp");
        require(p.listingRate == p.presaleRate, "listing rate must equal presale rate");
        require(!p.whitelistEnabled, "quick sale has no whitelist");
        require(p.softCap * 4 == p.hardCap, "softcap must be 25% of hardcap");
        require(p.endTime > p.startTime, "bad times");
        uint64 duration = p.endTime - p.startTime;
        require(duration >= MIN_QUICK_DURATION && duration <= MAX_QUICK_DURATION, "bad quick duration");
        require(p.launchTime == p.endTime, "launch time must equal end time");

        presale = _create(p, creator);
        Presale(payable(presale)).setQuickMode(creator, creatorShareBps);
        isQuick[presale] = true;
        quickCreatorOf[presale] = creator;
        emit QuickPresaleCreated(presale, p.token, creator, creatorShareBps);
    }

    /// @notice liquidityBps a quick sale must carry for a given creator share of the gross raise:
    ///         liquidity takes everything that is left after the platform fee and the creator share,
    ///         rounded up so the creator never receives more than the chosen share.
    function quickLiquidityBps(uint16 creatorShareBps) public view returns (uint16) {
        uint256 net = BPS - platformFeeBps;
        return uint16(((net - creatorShareBps) * BPS + net - 1) / net);
    }

    /// @dev Shared creation path. `creator` is the wallet the sale is listed under; the sale owner
    ///      is always msg.sender (the token owner).
    function _create(PresaleParams calldata p, address creator) private returns (address presale) {
        require(
            tokenFactory.isPlatformToken(p.token) || allowedToken[p.token],
            "not a platform token"
        );
        require(IPlatformToken(p.token).owner() == msg.sender, "not token owner");
        require(activePresaleOfToken[p.token] == address(0), "presale exists");

        require(p.softCap > 0 && p.hardCap >= p.softCap, "bad caps");
        require(p.softCap * 4 >= p.hardCap, "softcap < 25% of hardcap");
        require(p.minContribution > 0 && p.maxContribution >= p.minContribution, "bad limits");
        require(p.maxContribution <= p.hardCap, "max > hardcap");
        require(p.presaleRate > 0 && p.listingRate > 0, "bad rates");
        require(p.listingRate <= p.presaleRate, "listing > presale rate");
        require(p.startTime >= block.timestamp, "start in past");
        require(p.endTime > p.startTime, "bad times");
        require(p.endTime - p.startTime <= MAX_SALE_DURATION, "sale too long");
        require(p.liquidityBps >= MIN_LIQUIDITY_BPS && p.liquidityBps <= BPS, "bad liquidity bps");
        if (p.liquidityAction == LiquidityAction.Lock) {
            require(p.lockDuration >= MIN_LOCK_DURATION, "lock too short");
        }
        // The launch time is optional. If given, it must fall between the sale end and the
        // end of the finalize window, otherwise it can never be triggered.
        if (p.launchTime != 0) {
            require(p.launchTime >= p.endTime, "launch before end");
            require(p.launchTime <= p.endTime + FINALIZE_GRACE_PERIOD, "launch after window");
        }

        presale = _deployPresale(p);

        // The presale contract is exempted from token taxes (for claims and liquidity).
        // Allowlisted tokens may not grant this permission; in that case the token owner
        // sets the exemption, and the tax-free transfer check below still protects.
        try IPlatformToken(p.token).excludeFromFees(presale, true) {} catch {}
        // For the Rewards type the presale must not receive a rewards share; otherwise the rewards
        // accruing to the not-yet-claimed supply get stuck in the presale contract. Other types have no such call.
        try IRewardsToken(p.token).setExcludedFromRewards(presale, true) {} catch {}

        // The required tokens are transferred from the creator to the presale contract
        uint256 required = requiredTokensFor(p);
        IERC20 token = IERC20(p.token);
        uint256 balBefore = token.balanceOf(presale);
        token.safeTransferFrom(msg.sender, presale, required);
        require(token.balanceOf(presale) - balBefore == required, "taxed transfer");

        isPresale[presale] = true;
        allPresales.push(presale);
        _presalesOfCreator[creator].push(presale);
        activePresaleOfToken[p.token] = presale;

        _sendEth(treasury, msg.value);
        emit PresaleCreated(presale, p.token, msg.sender);
    }

    /// @dev Deploys a Presale from the creation code held by PresaleCode. The constructor
    ///      arguments are the same as before; msg.sender inside the constructor is this factory.
    function _deployPresale(PresaleParams calldata p) private returns (address presale) {
        require(address(presaleCode) != address(0), "presale code not set");
        bytes memory initCode = abi.encodePacked(
            presaleCode.creationCode(),
            abi.encode(p, msg.sender, router, locker, treasury, platformFeeBps, exitPenaltyBps)
        );
        assembly ("memory-safe") {
            presale := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(presale != address(0), "presale deploy failed");
    }

    /// @notice Total amount of tokens the creator must deposit for the presale.
    function requiredTokensFor(PresaleParams calldata p) public view returns (uint256) {
        uint256 tokensForSale = (p.hardCap * p.presaleRate) / 1e18;
        uint256 netEth = p.hardCap - (p.hardCap * platformFeeBps) / BPS;
        uint256 liquidityEth = (netEth * p.liquidityBps) / BPS;
        uint256 tokensForLiquidity = (liquidityEth * p.listingRate) / 1e18;
        return tokensForSale + tokensForLiquidity;
    }

    /// @notice Releases a cancelled presale's token so a new presale can be created for it.
    function onPresaleCancelled(address token) external {
        require(isPresale[msg.sender], "not a presale");
        if (activePresaleOfToken[token] == msg.sender) {
            activePresaleOfToken[token] = address(0);
        }
    }

    // ------------------------------------------------------------- admin

    /// @notice Grants presale permission to a token that is not from the factory. Intended for
    ///         platform-owned tokens such as HOODSALE; user tokens must go through the factory.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        require(token != address(0), "zero addr");
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @notice The platform bot that triggers scheduled launches on the owner's behalf.
    function setLaunchKeeper(address keeper) external onlyOwner {
        launchKeeper = keeper;
        emit LaunchKeeperSet(keeper);
    }

    /// @notice The contract that holds Presale's creation code. Must be set before any sale is created.
    function setPresaleCode(address presaleCode_) external onlyOwner {
        require(presaleCode_ != address(0), "zero addr");
        presaleCode = IPresaleCode(presaleCode_);
        emit PresaleCodeSet(presaleCode_);
    }

    function setCreationFee(uint256 fee) external onlyOwner {
        creationFee = fee;
        emit CreationFeeUpdated(fee);
    }

    /// @notice The contract allowed to create quick presales (see quickLaunch).
    function setQuickLaunch(address quickLaunch_) external onlyOwner {
        require(quickLaunch_ != address(0), "zero addr");
        quickLaunch = quickLaunch_;
        emit QuickLaunchSet(quickLaunch_);
    }

    function setQuickCreationFee(uint256 fee) external onlyOwner {
        quickCreationFee = fee;
        emit QuickCreationFeeUpdated(fee);
    }

    function setFees(uint16 platformFeeBps_, uint16 exitPenaltyBps_) external onlyOwner {
        require(platformFeeBps_ <= MAX_FEE_BPS && exitPenaltyBps_ <= MAX_FEE_BPS, "fee too high");
        platformFeeBps = platformFeeBps_;
        exitPenaltyBps = exitPenaltyBps_;
        emit FeesUpdated(platformFeeBps_, exitPenaltyBps_);
    }

    function setTreasury(address payable treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero addr");
        treasury = treasury_;
    }

    function setRouter(address router_) external onlyOwner {
        require(router_ != address(0), "zero addr");
        router = router_;
    }

    function setLocker(address locker_) external onlyOwner {
        require(locker_ != address(0), "zero addr");
        locker = locker_;
    }

    // ------------------------------------------------------------ views

    function allPresalesLength() external view returns (uint256) {
        return allPresales.length;
    }

    function presalesOfCreator(address creator) external view returns (address[] memory) {
        return _presalesOfCreator[creator];
    }

    function getPresales(uint256 start, uint256 count) external view returns (address[] memory list) {
        uint256 len = allPresales.length;
        if (start >= len) return new address[](0);
        uint256 end = start + count > len ? len : start + count;
        list = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            list[i - start] = allPresales[i];
        }
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth transfer failed");
    }
}
