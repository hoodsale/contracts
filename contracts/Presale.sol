// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV2Router02, IUniswapV2Factory, IUniswapV2Pair, IWETH} from "./interfaces/IUniswapV2.sol";
import {LiquidityLocker} from "./LiquidityLocker.sol";

enum LiquidityAction {
    Lock,
    Burn
}

struct PresaleParams {
    address token;
    uint256 presaleRate; // tokens given per 1 ETH (in token wei)
    uint256 listingRate; // tokens per 1 ETH when liquidity is added
    uint256 softCap; // wei
    uint256 hardCap; // wei
    uint256 minContribution; // wei
    uint256 maxContribution; // wei (per wallet)
    uint64 startTime;
    uint64 endTime;
    uint16 liquidityBps; // share of net ETH (after the platform fee) that goes to liquidity, min 5100
    LiquidityAction liquidityAction;
    uint64 lockDuration; // lock duration in seconds if Lock is selected
    /// @notice Scheduled launch. If 0, only the owner can finalize.
    ///         If greater than 0, after this time the platform's launch bot (keeper) may
    ///         also call finalize on the owner's behalf; the owner can always do it themselves.
    uint64 launchTime;
    /// @notice Whether whitelist mode is enabled at the start. The owner can later switch
    ///         between whitelist and public at any time.
    bool whitelistEnabled;
}

interface IPresaleFactoryCallback {
    function onPresaleCancelled(address token) external;
    function launchKeeper() external view returns (address);
}

/// @title Presale
/// @notice The full lifecycle of a single presale:
///         - contribute: participate with ETH (within the min/max and hardcap limits)
///         - emergencyWithdraw: exit while the sale is running with a 10% penalty (penalty goes to Treasury)
///         - cancel: the owner can cancel at any time before finalize: everyone gets a full refund
///         - if the softcap is not reached: everyone gets a full refund
///         - finalize: the 10% platform fee is taken, liquidity is added to the DEX, LP is locked
///           or burned, remaining ETH goes to the owner, claim opens
///         - distribute: after finalize anyone can push the tokens to the participants in batches
///
///         Quick mode (autoLaunch, set by the factory right after creation): the sale launches
///         itself when the hard cap fills or, once it has ended with the soft cap met, on the
///         first claim(); anyone may also call finalize at that point. There is no cancel, the
///         creator's ETH share goes to payoutRecipient, leftover tokens are burned and the first
///         participants receive their tokens inside the launch transaction.
contract Presale is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        Active,
        Cancelled,
        Finalized
    }

    /// Derived status for the frontend
    enum Status {
        Upcoming,
        Live,
        Ended, // softcap reached, waiting for finalize
        Failed, // time is up, softcap not reached
        Cancelled,
        Finalized
    }

    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice If LP was minted into the pool before launch, the maximum ratio by which the
    ///         pool price may deviate from the listing price. If exceeded, finalize is rejected; the
    ///         owner moves the pool back to the listing price (cheap, using the attacker's money) and retries.
    uint256 public constant MAX_POOL_DEVIATION_BPS = 500;
    /// @notice Window after the end during which the owner can finalize; once it passes,
    ///         contributors can take a full refund (funds are not locked if the owner disappears).
    uint64 public constant FINALIZE_GRACE_PERIOD = 14 days;
    /// @notice Upper bound on the sale duration (same as PresaleFactory); used when updating the schedule.
    uint64 public constant MAX_SALE_DURATION = 90 days;
    /// @notice Upper bound on the creator share of a quick sale (10% of the gross raise).
    uint16 public constant MAX_CREATOR_SHARE_BPS = 1_000;
    /// @notice Participants paid inside the launch transaction of a quick sale; the rest is
    ///         delivered through distribute().
    uint256 public constant INLINE_DISTRIBUTION_MAX = 20;
    /// @notice Gas reserved per inline delivery (about 100k is used): the inline loop stops when
    ///         less is left, so a launch never runs out of gas because of the delivery.
    uint256 public constant INLINE_DELIVERY_GAS = 150_000;
    /// @notice Gas a launch needs without any delivery (about 430k on the mock DEX, more on the
    ///         real router), with margin. See autoLaunchGas().
    uint256 public constant LAUNCH_BASE_GAS = 600_000;

    PresaleParams public params;
    address public immutable saleOwner;
    address public immutable factory;
    IUniswapV2Router02 public immutable router;
    LiquidityLocker public immutable locker;
    address public immutable treasury;
    uint16 public immutable platformFeeBps; // platform fee taken from the raised ETH (10%)
    uint16 public immutable exitPenaltyBps; // early exit penalty (10%)

    State public state;
    uint256 public totalRaised;
    uint256 public contributorCount;
    uint64 public finalizedAt;
    uint256 public lpLockId;
    uint256 public lpAmount;
    mapping(address => uint256) public contributionOf;

    /// @notice Quick mode: automatic launch, no cancel, leftover tokens burned, inline delivery.
    bool public autoLaunch;
    /// @notice Receives the ETH left after the platform fee and liquidity (the sale owner for
    ///         normal sales, the creator wallet for quick sales).
    address public payoutRecipient;
    /// @notice Quick sales only, informational: the creator's share of the gross raise in bps.
    ///         The on-chain split is expressed through liquidityBps; this value is what the
    ///         creator picked and what the sale page shows.
    uint16 public creatorShareBps;
    /// @notice Next index of the contributor list that distribute() will look at.
    uint256 public distributionCursor;
    /// @notice Wallets that have received their tokens (through claim or distribute).
    uint256 public claimedCount;

    /// @notice On-chain participation history (for the "activity" feed in the UI).
    enum ActivityKind {
        Contribute,
        Exit,
        Refund,
        Claim
    }

    struct Activity {
        address account;
        uint8 kind; // ActivityKind
        uint64 timestamp;
        uint256 amount; // Contribute/Exit/Refund: wei, Claim: token
    }

    /// @notice Per-wallet cumulative totals; the participant table is derived from these.
    struct ParticipantStats {
        uint256 contributed; // total deposited (including exits)
        uint256 exited; // gross contribution taken back through early exit
        uint256 refunded; // cancellation/failure refund
        uint256 claimedTokens;
        uint64 joinedAt;
    }

    Activity[] private _activities;
    address[] private _contributors; // unique, in order of participation
    mapping(address => ParticipantStats) public statsOf;

    /// @notice If enabled, only whitelisted wallets can contribute
    bool public whitelistEnabled;
    mapping(address => bool) public isWhitelisted;
    uint256 public whitelistCount;

    event Contributed(address indexed account, uint256 amount, uint256 totalRaised);
    event EmergencyWithdrawn(address indexed account, uint256 refunded, uint256 penalty);
    event Cancelled();
    event ScheduleUpdated(uint64 startTime, uint64 endTime, uint64 launchTime);
    event Finalized(uint256 platformFee, uint256 liquidityEth, uint256 liquidityTokens, uint256 lpAmount);
    event Claimed(address indexed account, uint256 tokenAmount);
    event Refunded(address indexed account, uint256 amount);
    event WhitelistModeSet(bool enabled);
    event WhitelistUpdated(address indexed account, bool allowed);
    event QuickModeSet(address recipient, uint16 creatorShareBps);
    event AutoLaunched(uint256 raised);
    event AutoLaunchDeferred(bytes reason);
    event Distributed(uint256 count);

    /// @dev Raised when a quick launch is attempted with less gas than autoLaunchGas(): the
    ///      transaction reverts instead of deferring, so that gas estimates rise to a value at which
    ///      the launch and its inline delivery really fit.
    error InsufficientGasForLaunch();

    modifier onlySaleOwner() {
        require(msg.sender == saleOwner, "not sale owner");
        _;
    }

    /// @notice A plain ETH transfer to the sale is treated as a contribution, on exactly the
    ///         terms contribute() applies: the sale has to be running, the sender has to be on
    ///         the whitelist when there is one, and the amount has to sit inside the per wallet
    ///         limits and under the hard cap. Anything else reverts and the sender keeps the ETH.
    ///         Before this, such a transfer was accepted and recorded nowhere, so the sender lost
    ///         it: no tokens, no refund.
    /// @dev The one exception is the router, which refunds leftover ETH while liquidity is being
    ///      added. That refund must never revert or finalize would fail and the sale would be
    ///      stuck; it is forwarded to the payout recipient at the end of finalize.
    receive() external payable {
        if (msg.sender == address(router)) return;
        _contribute();
    }

    constructor(
        PresaleParams memory params_,
        address saleOwner_,
        address router_,
        address locker_,
        address treasury_,
        uint16 platformFeeBps_,
        uint16 exitPenaltyBps_
    ) {
        params = params_;
        saleOwner = saleOwner_;
        payoutRecipient = saleOwner_;
        factory = msg.sender;
        router = IUniswapV2Router02(router_);
        locker = LiquidityLocker(locker_);
        treasury = treasury_;
        platformFeeBps = platformFeeBps_;
        exitPenaltyBps = exitPenaltyBps_;
        whitelistEnabled = params_.whitelistEnabled;
    }

    /// @notice Switches the sale to quick mode. Only the factory can call it, and only while
    ///         nobody has contributed yet (the factory does it in the creation transaction).
    function setQuickMode(address recipient, uint16 creatorShareBps_) external {
        require(msg.sender == factory, "not factory");
        require(state == State.Active && _contributors.length == 0, "already has contributions");
        require(recipient != address(0), "zero recipient");
        require(creatorShareBps_ <= MAX_CREATOR_SHARE_BPS, "share too high");
        autoLaunch = true;
        payoutRecipient = recipient;
        creatorShareBps = creatorShareBps_;
        emit QuickModeSet(recipient, creatorShareBps_);
    }

    // ------------------------------------------------------------- contribution

    function contribute() external payable {
        _contribute();
    }

    /// @dev The contribution itself, shared by contribute() and by a plain transfer. The guard
    ///      sits here rather than on the entry points: the router's refund reaches receive()
    ///      from inside finalize, where the guard is already held, and it returns before this.
    function _contribute() private nonReentrant {
        require(state == State.Active, "not active");
        require(block.timestamp >= params.startTime, "not started");
        require(block.timestamp <= params.endTime, "ended");
        require(msg.value > 0, "zero value");
        if (whitelistEnabled) require(isWhitelisted[msg.sender], "not whitelisted");
        require(totalRaised + msg.value <= params.hardCap, "hardcap exceeded");

        uint256 newContribution = contributionOf[msg.sender] + msg.value;
        require(newContribution >= params.minContribution, "below min");
        require(newContribution <= params.maxContribution, "above max");

        if (contributionOf[msg.sender] == 0) contributorCount++;
        contributionOf[msg.sender] = newContribution;
        totalRaised += msg.value;

        ParticipantStats storage st = statsOf[msg.sender];
        if (st.joinedAt == 0) {
            st.joinedAt = uint64(block.timestamp);
            _contributors.push(msg.sender);
        }
        st.contributed += msg.value;
        _record(msg.sender, ActivityKind.Contribute, msg.value);
        emit Contributed(msg.sender, msg.value, totalRaised);

        // Quick sale: the contribution that fills the hard cap launches the sale in the same
        // transaction. A failed launch never reverts the contribution.
        if (autoLaunch && params.hardCap - totalRaised < params.minContribution) {
            _tryAutoFinalize();
        }
    }

    /// @notice Exit the presale while the sale is running with a 10% penalty. The penalty goes to Treasury.
    function emergencyWithdraw() external nonReentrant {
        require(state == State.Active, "not active");
        require(block.timestamp <= params.endTime, "sale ended");
        uint256 contribution = contributionOf[msg.sender];
        require(contribution > 0, "no contribution");

        contributionOf[msg.sender] = 0;
        totalRaised -= contribution;
        contributorCount--;

        uint256 penalty = (contribution * exitPenaltyBps) / BPS;
        uint256 refund = contribution - penalty;
        statsOf[msg.sender].exited += contribution;
        _record(msg.sender, ActivityKind.Exit, refund);

        _sendEth(treasury, penalty);
        _sendEth(msg.sender, refund);
        emit EmergencyWithdrawn(msg.sender, refund, penalty);
    }

    // ------------------------------------------------------------ whitelist

    /// @notice Enables/disables whitelist mode. The owner can switch between
    ///         whitelist and public as many times as they like during the sale.
    function setWhitelistEnabled(bool enabled) external onlySaleOwner {
        require(state == State.Active, "not active");
        whitelistEnabled = enabled;
        emit WhitelistModeSet(enabled);
    }

    function addToWhitelist(address[] calldata accounts) external onlySaleOwner {
        require(state == State.Active, "not active");
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            if (a == address(0) || isWhitelisted[a]) continue;
            isWhitelisted[a] = true;
            whitelistCount++;
            emit WhitelistUpdated(a, true);
        }
    }

    function removeFromWhitelist(address[] calldata accounts) external onlySaleOwner {
        require(state == State.Active, "not active");
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            if (!isWhitelisted[a]) continue;
            isWhitelisted[a] = false;
            whitelistCount--;
            emit WhitelistUpdated(a, false);
        }
    }

    // -------------------------------------------------------- owner operations

    /// @notice BEFORE the sale starts, the owner can change the schedule: start, end and
    ///         the optional launch time. Once the sale has started, the dates are locked.
    function updateSchedule(uint64 newStart, uint64 newEnd, uint64 newLaunchTime)
        external
        onlySaleOwner
    {
        require(state == State.Active, "not active");
        require(block.timestamp < params.startTime, "sale already started");
        require(newStart >= block.timestamp, "start in past");
        require(newEnd > newStart, "bad times");
        require(newEnd - newStart <= MAX_SALE_DURATION, "sale too long");
        if (newLaunchTime != 0) {
            require(newLaunchTime >= newEnd, "launch before end");
            require(newLaunchTime <= newEnd + FINALIZE_GRACE_PERIOD, "launch after window");
        }
        params.startTime = newStart;
        params.endTime = newEnd;
        params.launchTime = newLaunchTime;
        emit ScheduleUpdated(newStart, newEnd, newLaunchTime);
    }

    /// @notice The owner can cancel a presale that has not been finalized at any time (even
    ///         after the sale has ended). Tokens return to the owner, contributors get a FULL
    ///         refund through claimRefund; no platform fee is taken on cancellation.
    ///         Quick sales cannot be cancelled.
    function cancel() external onlySaleOwner nonReentrant {
        require(!autoLaunch, "quick sale cannot be cancelled");
        require(state == State.Active, "not active");
        state = State.Cancelled;

        IERC20 token = IERC20(params.token);
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) token.safeTransfer(saleOwner, bal);

        IPresaleFactoryCallback(factory).onPresaleCancelled(params.token);
        emit Cancelled();
    }

    /// @notice Concludes the sale (launch): takes the platform fee, sets up liquidity,
    ///         opens claims. The owner can call it. If the owner has set a launch time, once
    ///         that time arrives the platform's launch bot may also call it on the owner's
    ///         behalf, so the launch does not depend on the owner being online. On a quick
    ///         sale anyone can call it as soon as the sale is ready to be finalized.
    function finalize(uint256 minLiquidityTokens, uint256 minLiquidityEth) external nonReentrant {
        require(
            msg.sender == saleOwner || _isKeeperLaunch() || (autoLaunch && isReadyToFinalize()),
            "not authorized to launch"
        );
        // A quick launch brings its inline delivery along; ask for the gas that fits it.
        if (autoLaunch && gasleft() < autoLaunchGas()) revert InsufficientGasForLaunch();
        _finalize(minLiquidityTokens, minLiquidityEth);
    }

    /// @notice Self-call target of the automatic launch. Only this contract can call it.
    /// @dev Reentrancy: contribute() and claim() hold the nonReentrant lock while they make
    ///      this self-call, so autoFinalize() cannot carry the guard itself (it would revert).
    ///      It is protected by the msg.sender check instead, which no outside party can pass:
    ///      the contract makes exactly two self-calls, both from inside guarded functions.
    ///      Every other state-changing entry point (contribute, emergencyWithdraw, finalize,
    ///      claim, claimRefund, distribute, cancel) is nonReentrant, so nothing reached during
    ///      the launch's external calls (router, pair, treasury, token) can re-enter into
    ///      state-changing code while the lock is held.
    function autoFinalize() external {
        require(msg.sender == address(this), "only self");
        // The pool guard is the one condition that defers a launch in practice. It is checked
        // first so a deferral stays cheap and is never confused with a gas shortage.
        if (_poolBlocksLaunch()) revert("pool price off listing");
        if (gasleft() < autoLaunchGas()) revert InsufficientGasForLaunch();
        _finalize(0, 0);
    }

    /// @dev Attempts the automatic launch. A failed launch is reported through AutoLaunchDeferred
    ///      and never reverts the triggering transaction; the sale stays launchable. The one
    ///      exception is a gas shortage (an empty reason means the inner call ran out of gas):
    ///      then the transaction reverts, otherwise a wallet's gas estimate could settle on a
    ///      value at which the launch is silently deferred although it was possible.
    function _tryAutoFinalize() private {
        try this.autoFinalize() {
            emit AutoLaunched(totalRaised);
        } catch (bytes memory reason) {
            if (reason.length == 0 || bytes4(reason) == InsufficientGasForLaunch.selector) {
                revert InsufficientGasForLaunch();
            }
            emit AutoLaunchDeferred(reason);
        }
    }

    function _finalize(uint256 minLiquidityTokens, uint256 minLiquidityEth) private {
        require(state == State.Active, "not active");
        require(totalRaised >= params.softCap, "softcap not met");
        require(
            block.timestamp > params.endTime || params.hardCap - totalRaised < params.minContribution,
            "sale still running"
        );
        require(block.timestamp <= params.endTime + FINALIZE_GRACE_PERIOD, "finalize window passed");

        state = State.Finalized;
        finalizedAt = uint64(block.timestamp);

        uint256 platformFee = (totalRaised * platformFeeBps) / BPS;
        uint256 netEth = totalRaised - platformFee;
        uint256 liquidityEth = (netEth * params.liquidityBps) / BPS;
        uint256 liquidityTokens = (liquidityEth * params.listingRate) / 1e18;
        require(liquidityTokens > 0, "no liquidity tokens");

        _sendEth(treasury, platformFee);

        address pair = _addLiquidity(liquidityTokens, liquidityEth, minLiquidityTokens, minLiquidityEth);
        uint256 lpBal = IUniswapV2Pair(pair).balanceOf(address(this));
        require(lpBal > 0, "no lp");
        lpAmount = lpBal;

        IERC20 token = IERC20(params.token);

        if (params.liquidityAction == LiquidityAction.Burn) {
            IERC20(pair).safeTransfer(DEAD, lpBal);
        } else {
            IERC20(pair).forceApprove(address(locker), lpBal);
            lpLockId = locker.lock(pair, lpBal, uint64(block.timestamp) + params.lockDuration, saleOwner);
        }

        // Tokens needed for claims stay in the contract; leftover tokens return to the owner,
        // or are burned on a quick sale.
        uint256 tokensForClaims = (totalRaised * params.presaleRate) / 1e18;
        uint256 tokenBal = token.balanceOf(address(this));
        require(tokenBal >= tokensForClaims, "insufficient claim tokens");
        uint256 leftoverTokens = tokenBal - tokensForClaims;
        if (leftoverTokens > 0) token.safeTransfer(autoLaunch ? DEAD : saleOwner, leftoverTokens);

        // Remaining ETH (the share left after liquidity + any router refund) goes to the payout
        // recipient: the owner, or the creator wallet of a quick sale.
        uint256 ethLeft = address(this).balance;
        if (ethLeft > 0) _sendEth(payoutRecipient, ethLeft);

        emit Finalized(platformFee, liquidityEth, liquidityTokens, lpBal);

        // Quick sale: the first participants get their tokens right away, within the gas the
        // launch has left. The rest is delivered by distribute().
        if (autoLaunch) _distribute(INLINE_DISTRIBUTION_MAX, INLINE_DELIVERY_GAS);
    }

    /// @dev Adds liquidity and returns the pair address.
    ///      If the pair is empty, the standard router path is used (the requested listing rate is set exactly).
    ///      If the pair was pre-funded (third-party griefing), the router's rate correction and
    ///      ETH refund could make finalize revert, so the low-level pair mint is used instead.
    function _addLiquidity(
        uint256 liquidityTokens,
        uint256 liquidityEth,
        uint256 minLiquidityTokens,
        uint256 minLiquidityEth
    ) private returns (address pair) {
        address weth = router.WETH();
        IUniswapV2Factory dexFactory = IUniswapV2Factory(router.factory());
        pair = dexFactory.getPair(params.token, weth);
        if (pair == address(0)) {
            pair = dexFactory.createPair(params.token, weth);
        }

        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
        IERC20 token = IERC20(params.token);

        if (r0 == 0 && r1 == 0) {
            token.forceApprove(address(router), liquidityTokens);
            router.addLiquidityETH{value: liquidityEth}(
                params.token,
                liquidityTokens,
                minLiquidityTokens == 0 ? (liquidityTokens * 9_500) / BPS : minLiquidityTokens,
                minLiquidityEth == 0 ? (liquidityEth * 9_500) / BPS : minLiquidityEth,
                address(this),
                block.timestamp
            );
        } else {
            // Only a donation (no LP minted) is harmless: the first mint folds the donation into
            // the locked LP as well. In a pool where LP has been minted, mint uses the pool price; if
            // the price has deviated from the listing, value leaks, so it is rejected.
            if (IUniswapV2Pair(pair).totalSupply() > 0) {
                require(poolPriceDeviationBps() <= MAX_POOL_DEVIATION_BPS, "pool price off listing");
            }
            IWETH(weth).deposit{value: liquidityEth}();
            IWETH(weth).transfer(pair, liquidityEth);
            token.safeTransfer(pair, liquidityTokens);
            IUniswapV2Pair(pair).mint(address(this));
        }
    }

    // ------------------------------------------------------- claim / refund

    /// @notice Takes the tokens of the caller's contribution. On a quick sale that has ended
    ///         with its soft cap met, the first claim() also performs the launch.
    function claim() external nonReentrant {
        if (autoLaunch && state == State.Active && isReadyToFinalize()) {
            _tryAutoFinalize();
            // The launch was deferred (see AutoLaunchDeferred): nothing to claim yet, the
            // transaction itself does not revert.
            if (state != State.Finalized) return;
            // The launch's inline delivery may already have paid this wallet.
            if (contributionOf[msg.sender] == 0 && statsOf[msg.sender].claimedTokens > 0) return;
        }
        require(state == State.Finalized, "not finalized");
        require(contributionOf[msg.sender] > 0, "nothing to claim");
        require(_payOut(msg.sender), "token transfer failed");
    }

    /// @notice Pushes their tokens to participants that have not claimed yet, walking the
    ///         contributor list from the stored cursor. Anyone can call it on a finalized sale;
    ///         it looks at up to maxCount list entries per call and stops at the end.
    function distribute(uint256 maxCount) external nonReentrant returns (uint256 count) {
        require(state == State.Finalized, "not finalized");
        count = _distribute(maxCount, 0);
    }

    /// @dev Visits at most maxCount entries of the contributor list starting at the cursor and pays
    ///      every wallet that still holds an unclaimed contribution. With gasReserve > 0 (the inline
    ///      delivery of the automatic launch) it also stops as soon as less gas than that is left.
    ///      A failed token transfer is skipped: the wallet keeps its contribution and can claim().
    function _distribute(uint256 maxCount, uint256 gasReserve) private returns (uint256 count) {
        uint256 len = _contributors.length;
        uint256 i = distributionCursor;
        uint256 visited;
        while (i < len && visited < maxCount) {
            if (gasReserve != 0 && gasleft() < gasReserve) break;
            address account = _contributors[i];
            if (contributionOf[account] > 0 && _payOut(account)) count++;
            i++;
            visited++;
        }
        distributionCursor = i;
        if (count > 0) emit Distributed(count);
    }

    /// @dev Sends a participant the tokens of their contribution. Returns false, with the
    ///      contribution left in place, if the token transfer fails.
    function _payOut(address account) private returns (bool) {
        uint256 contribution = contributionOf[account];
        uint256 tokenAmount = (contribution * params.presaleRate) / 1e18;
        contributionOf[account] = 0;
        if (!_tryTransfer(params.token, account, tokenAmount)) {
            contributionOf[account] = contribution;
            return false;
        }
        claimedCount++;
        statsOf[account].claimedTokens += tokenAmount;
        _record(account, ActivityKind.Claim, tokenAmount);
        emit Claimed(account, tokenAmount);
        return true;
    }

    /// @notice Full refund if the sale was cancelled, the softcap was not reached, or the
    ///         owner missed the finalize window.
    function claimRefund() external nonReentrant {
        bool cancelled = state == State.Cancelled;
        bool failed = state == State.Active &&
            block.timestamp > params.endTime &&
            (totalRaised < params.softCap ||
                block.timestamp > params.endTime + FINALIZE_GRACE_PERIOD);
        require(cancelled || failed, "refund not available");

        uint256 contribution = contributionOf[msg.sender];
        require(contribution > 0, "nothing to refund");
        contributionOf[msg.sender] = 0;
        statsOf[msg.sender].refunded += contribution;
        _record(msg.sender, ActivityKind.Refund, contribution);

        _sendEth(msg.sender, contribution);
        emit Refunded(msg.sender, contribution);
    }

    // ------------------------------------------------------------ views

    /// @notice True if a launch time is set and has arrived. From this moment the platform's
    ///         launch bot can call finalize on the owner's behalf.
    function isLaunchDue() public view returns (bool) {
        return params.launchTime != 0 && block.timestamp >= params.launchTime;
    }

    /// @notice Whether this wallet can contribute right now (with respect to the whitelist rule).
    function canContribute(address account) external view returns (bool) {
        return !whitelistEnabled || isWhitelisted[account];
    }

    /// @dev Whether the caller is the platform's keeper for a sale whose launch time has arrived.
    function _isKeeperLaunch() private view returns (bool) {
        if (!isLaunchDue()) return false;
        address keeper = IPresaleFactoryCallback(factory).launchKeeper();
        return keeper != address(0) && msg.sender == keeper;
    }

    /// @notice Whether the sale can be finalized right now (state and time conditions).
    function isReadyToFinalize() public view returns (bool) {
        if (state != State.Active) return false;
        if (totalRaised < params.softCap) return false;
        if (
            block.timestamp <= params.endTime &&
            params.hardCap - totalRaised >= params.minContribution
        ) return false;
        return block.timestamp <= params.endTime + FINALIZE_GRACE_PERIOD;
    }

    /// @notice Gas a quick launch must have available: the launch itself plus one reserve per
    ///         participant paid inline (at most INLINE_DISTRIBUTION_MAX).
    function autoLaunchGas() public view returns (uint256) {
        uint256 n = contributorCount < INLINE_DISTRIBUTION_MAX ? contributorCount : INLINE_DISTRIBUTION_MAX;
        return LAUNCH_BASE_GAS + n * INLINE_DELIVERY_GAS;
    }

    /// @dev Mirrors the guard in _addLiquidity: a pool with LP minted whose price is off the listing.
    function _poolBlocksLaunch() private view returns (bool) {
        address weth = router.WETH();
        address pair = IUniswapV2Factory(router.factory()).getPair(params.token, weth);
        if (pair == address(0) || IUniswapV2Pair(pair).totalSupply() == 0) return false;
        return poolPriceDeviationBps() > MAX_POOL_DEVIATION_BPS;
    }

    /// @notice Token delivery progress: wallets paid so far and wallets with a contribution.
    function distributionProgress() external view returns (uint256 sent, uint256 total) {
        return (claimedCount, contributorCount);
    }

    /// @notice True once every participant has been paid, or once distribute() has walked the
    ///         whole list (a wallet whose transfer failed can still claim() itself).
    function distributionComplete() external view returns (bool) {
        if (state != State.Finalized) return false;
        return claimedCount >= contributorCount || distributionCursor >= _contributors.length;
    }

    /// @notice Deviation of the pool price from the listing price (bps). Returns 0 if there is
    ///         no pool, it is empty, or it is one-sided (the protection does not kick in).
    function poolPriceDeviationBps() public view returns (uint256) {
        address weth = router.WETH();
        address pair = IUniswapV2Factory(router.factory()).getPair(params.token, weth);
        if (pair == address(0)) return 0;
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
        (uint256 rToken, uint256 rWeth) = params.token < weth ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rToken == 0 || rWeth == 0) return 0;
        uint256 poolRate = (rToken * 1e18) / rWeth; // tokens per 1 ETH
        uint256 listing = params.listingRate;
        uint256 diff = poolRate > listing ? poolRate - listing : listing - poolRate;
        return (diff * BPS) / listing;
    }

    // -------------------------------------------------- participation history

    function activityLength() external view returns (uint256) {
        return _activities.length;
    }

    function contributorsLength() external view returns (uint256) {
        return _contributors.length;
    }

    /// @notice Returns activity records in pages (oldest to newest).
    function getActivities(uint256 start, uint256 count) external view returns (Activity[] memory list) {
        uint256 len = _activities.length;
        if (start >= len) return new Activity[](0);
        uint256 end = start + count > len ? len : start + count;
        list = new Activity[](end - start);
        for (uint256 i = start; i < end; i++) list[i - start] = _activities[i];
    }

    /// @notice Returns contributor addresses in pages (in order of first contribution).
    function getContributors(uint256 start, uint256 count) external view returns (address[] memory list) {
        uint256 len = _contributors.length;
        if (start >= len) return new address[](0);
        uint256 end = start + count > len ? len : start + count;
        list = new address[](end - start);
        for (uint256 i = start; i < end; i++) list[i - start] = _contributors[i];
    }

    function _record(address account, ActivityKind kind, uint256 amount) private {
        _activities.push(
            Activity({account: account, kind: uint8(kind), timestamp: uint64(block.timestamp), amount: amount})
        );
    }

    function status() external view returns (Status) {
        if (state == State.Cancelled) return Status.Cancelled;
        if (state == State.Finalized) return Status.Finalized;
        if (block.timestamp < params.startTime) return Status.Upcoming;
        if (block.timestamp <= params.endTime) {
            if (params.hardCap - totalRaised < params.minContribution) return Status.Ended;
            return Status.Live;
        }
        if (totalRaised < params.softCap) return Status.Failed;
        if (block.timestamp > params.endTime + FINALIZE_GRACE_PERIOD) return Status.Failed;
        return Status.Ended;
    }

    function getParams() external view returns (PresaleParams memory) {
        return params;
    }

    function claimableTokensOf(address account) external view returns (uint256) {
        if (state != State.Finalized) return 0;
        return (contributionOf[account] * params.presaleRate) / 1e18;
    }

    function _sendEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth transfer failed");
    }

    /// @dev ERC-20 transfer that reports failure instead of reverting (used by the delivery path).
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (data.length == 0) return token.code.length > 0;
        if (data.length < 32) return false;
        return abi.decode(data, (bool));
    }
}
