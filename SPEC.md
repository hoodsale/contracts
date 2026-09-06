# HoodSale, Robinhood Chain DeFi Presale Platform

A DeFi presale (launchpad) platform with a simple interface, running on Robinhood Chain (Arbitrum Orbit L2, gas token: ETH).

## Core Rule
Presales can only be run with **token contracts created from the platform's own TokenFactory**. External tokens are not accepted (enforced by the factory registry check).

## Token Types (TokenFactory)
Token creation is **free** (gas only). Instead, **every platform token carries a 0.25% platform tax on buys and sells**; this tax is paid in the token itself directly to the platform Treasury (normal wallet transfers are tax free). The platform tax is fixed per token (adjustable from the factory for new tokens, up to at most 0.5%).

| Type | Description |
|---|---|
| Standard | Plain ERC-20 with only the 0.25% platform tax |
| Tax | Platform tax + owner-defined buy/sell tax (to the marketing wallet) |
| Rewards | Platform tax + distributes dividends to holders in a chosen reward token (e.g. WETH) |
| Stock Rewards | Same contract as Rewards; the reward token is a Robinhood tokenized stock (e.g. tAAPL) |

**Tax cap:** the total buy or sell tax including the platform share is **at most 10%** (hard cap at the contract level, honeypots are prevented). The owner can later change their taxes up to the cap. Recommended default: 0.25% platform + 4% owner.

### Token Owner Powers
In created tokens, the following **never change:** name, symbol, 18 decimals, total supply
(no mint), platform tax and Treasury address, router and main liquidity pair, the 10% tax
cap, swap threshold, token type, and the reward token in Rewards tokens. There is no function
to pause transfers, blacklist, freeze wallets or seize balances.

**What the owner can change:** in a Tax token, the buy/sell tax (up to the cap, at most
9.75% per direction for the owner) and the marketing wallet; in a Rewards token, the reward and
marketing taxes (up to the cap), the marketing wallet, the reward swap route, reward-exempt addresses and
triggering a distribution; in every type, tax-exempt addresses, additional AMM pairs, manually
converting the accumulated tax to ETH, transferring or renouncing ownership. The power to disable the
automatic tax swap has been removed from platform tokens (the swap is already wrapped in try/catch
so that it can never block a transfer).

## Presale
- Creation fee: **none on mainnet**. It is a factory setting (`PresaleFactory.setCreationFee`); the contract default is 0.1 ETH, `scripts/set-fees.js` sets the live value (`CREATION_FEE_ETH=0`) and the frontend reads it from the chain (`creationFee`)
- Platform share: **2.5%** of the ETH raised on mainnet (deducted automatically during finalize). It is a factory setting (`PresaleFactory.setFees`, cap `MAX_FEE_BPS` 20%); the contract default is 10%, `scripts/set-fees.js` sets the live value, every sale keeps the value it was created with and the frontend reads it from the chain
- Parameters: softcap, hardcap, min/max contribution, start/end time, presale rate, listing rate, liquidity percentage (min 51%), liquidity lock duration **or** LP burn (chosen at creation)
- **Early exit:** a participant can leave an active presale with a **10% penalty** (the penalty goes to the platform treasury)
- **Cancel:** the owner can cancel a presale that has not been finalized at any time (especially if the softcap is not reached), participants get a full refund, tokens return to the owner
- **Failure:** time is up + softcap not reached, participants can withdraw a full refund
- **Finalize (launch):** if the softcap is met (or the hardcap is actually filled), the presale is finalized: the platform share is deducted, liquidity is added to the DEX, the LP is locked or burned, the remaining ETH goes to the owner, claim opens
- **Finalize window:** if not finalized within 14 days after the end, participants can claim a full refund (funds are not stuck if the owner disappears)

**Rates in the creation form.** Both rates are tokens per 1 ETH (scaled by 1e18 on chain). The create
page offers two modes. Automatic (the default) derives them from the share of the total supply sold in
the presale (default 40%, above 0 and below 100) and the hard cap: tokens for sale = supply × share,
presale rate = tokens for sale / hard cap, listing rate = presale rate / (1 + premium), where the listing
price is either the same as the presale price or higher by a premium of 0 to 500%. Manual accepts both
rates directly and is prefilled with the last derived values. Both modes write the same two contract
parameters, and step 02 shows a live summary: what 1 ETH buys, the presale and listing price per token,
tokens sold at the hard cap, tokens added to liquidity (the `requiredTokensFor` formula), the total pulled
from the owner wallet with a warning when the balance is short, and the implied market cap at listing.

### Launch Authority: Dev Only
Launch (finalize) and cancel are the right of the dev who created the presale, and nobody else.
Participants or third parties can never trigger the launch under any circumstances. The one
exception is the quick presale below, whose launch is automatic by design.

- **Launch:** once the softcap is met and the sale has ended (or the hardcap is actually filled),
  the owner sets up liquidity with a single button; the platform share is deducted at that moment.
- **Cancel:** the owner can cancel at any moment until the launch happens, even after the sale
  has ended and the softcap has been reached. Everyone gets a full refund, the platform share is not taken.

### Launch Time (optional automation)
A `launchTime` can be set when the presale is created (between the sale end and end + 14
days). A blockchain cannot act on its own; "automatic launch" works like this:
when the time comes, **the platform's launch bot** (`PresaleFactory.launchKeeper`,
a single address chosen by the platform owner) can call finalize on the owner's behalf.
Until then the owner can launch or cancel themselves at any time.
When the bot performs the launch, the result is exactly the same as if the owner had done it;
the platform share and the owner's share do not change. If `launchKeeper` is zero, automation is off.

### Schedule Changes
**Before the sale starts** the dev can change the start, end and optional launch time
(`updateSchedule`; same validations: the start cannot be in the past, the duration is at
most 90 days, the launch time is between the end and end + 14 days). Once the sale has started
the dates are locked; they cannot be changed on a cancelled or finalized sale.

### Whitelist Mode
A presale starts either **public** or **whitelist only** (`whitelistEnabled`). The dev can
switch between the two modes at any time until launch
(`setWhitelistEnabled`) and add/remove wallets in bulk (`addToWhitelist`,
`removeFromWhitelist`); the list is preserved when the mode changes. While the whitelist is on,
a contribution from a wallet not on the list is rejected with `not whitelisted`. Existing contributions,
refunds, early exit and claim are not affected by the mode. The HOODS presale starts with a
whitelist and the dev can switch it to public whenever they want.

### Why the Platform Share Is Taken at Finalize
The platform share is deducted at finalize, not at contribution time. This way participants get a
**full** refund on cancel or softcap failure. If the share were taken up front, the refundable
amount would drop to 90%. The creation fee, where the factory charges one (none on mainnet),
is the platform's only upfront revenue; it stays in the treasury even if the sale is cancelled.

## Quick Presale
A quick presale is a token and a sale created in **one transaction** (`QuickLaunch.launch(QuickParams)`)
with every rule fixed in advance. The creator chooses the name, the symbol, an optional logo and
one line description, the hard cap (presets 2, 5, 10 ETH or 0.5 to 100 ETH), the length (30
minutes, 1 hour, 2 hours or 6 hours), a **creator share of the gross raise** (a whole percent, 0
to 10, default 5) and the **token type** with its taxes and tax wallet. Creation fee: **none on
mainnet** (`PresaleFactory.setQuickCreationFee`, contract default 0.03 ETH, set by
`scripts/set-fees.js` with `QUICK_CREATION_FEE_ETH=0`; the quick page reads `quickCreationFee`
and sends nothing before that read landed).

**Token type.** `QuickParams.tokenType` is 0 Standard, 1 Tax or 2 Rewards. `taxWallet` is the
wallet the token's own tax is paid to; zero means `msg.sender` (the frontend prefills the
connected wallet and lets the creator edit it). The platform tax of the token factory (0.25%)
applies on top of every type and the sale contract is fee exempt, so the liquidity and the token
delivery are untaxed.

- **Standard** (`TokenFactory.createStandardToken`): every tax field and `rewardToken` must be
  zero (`standard token has no tax`, `no reward token for this type`). Only the platform tax
  applies. Ownership is renounced in the launch transaction.
- **Tax** (`TokenFactory.createTaxToken(name, symbol, supply, taxWallet, buyTaxBps, sellTaxBps)`):
  `buyTaxBps` and `sellTaxBps` are the creator tax per side, each at most `MAX_CREATOR_TAX_BPS`
  (500, `creator tax too high`) and at least one above zero (`tax token without tax`); the
  rewards fields and `rewardToken` must be zero. The tax is swapped to ETH by the token and sent
  to the tax wallet on every pool buy and sell (at most 5.25% per side with the platform tax).
  Ownership is renounced in the launch transaction, so `setTaxes` and `setMarketingWallet` have no
  caller.
- **Rewards** (`TokenFactory.createRewardsToken(name, symbol, supply, rewardToken, taxWallet,
  [rewardsBuy, rewardsSell, marketingBuy, marketingSell])`): `rewardsBuyBps` and `rewardsSellBps`
  are the rewards tax per side, at least `MIN_REWARDS_TAX_BPS` (100, `rewards tax too low`);
  `buyTaxBps` and `sellTaxBps` are the optional marketing tax per side, paid to the tax wallet;
  rewards plus marketing stay within 500 per side (`creator tax too high`). `rewardToken` must be
  on the allowlist QuickLaunch keeps (`reward token not allowed`): WETH, USDG and the tokenized
  stocks at deployment, `setRewardTokenAllowed(token, allowed)` by the QuickLaunch owner later,
  `rewardTokens()` lists the current set. The reward swap route is the RewardsToken default
  (token -> WETH, or token -> WETH -> reward token on Uniswap V2) unless the QuickLaunch owner
  stored a route for the reward token: V2 intermediate hops (`setRewardRoute(rewardToken,
  [WETH, ...])`, `rewardRouteOf`) or a packed Uniswap V3 path from WETH to the reward token
  (`setRewardRouteV3(rewardToken, path)`, `rewardRouteV3Of`; on Robinhood Chain the tokenized
  stocks trade on Uniswap V3, so their routes are V3 paths, see "Reward swap route" below).
  Storing one form clears the other; an empty value removes it. `launch` then sets that route
  on the token once, before anything else, and never again (except through
  `repairRewardRoute`, below). `rewardPathOf(rewardToken)` returns the V2 hops a launch would
  use and `isRewardRouteLive(rewardToken)` whether the route a launch would use can pay. On V2
  every pool of it (from WETH to the reward token) must exist on the platform DEX with reserves
  on both sides, and a quote of ten probes (`ROUTE_PROBE_WETH`, 0.01 ETH each) along the route
  must return at least five times the quote of one probe, that is ten probes keep at least half
  the per-probe rate, which no pool holding dust can do. On V3 every pool of the path must exist
  on the factory of the rewards deployer's router with liquidity in its current tick range, and
  the virtual reserve of that range on the input side (x = L * 2^96 / sqrtP for token0, y = L *
  sqrtP / 2^96 for token1) must hold at least eight times the hop's input, the probe carried
  through the hops at the spot price, and the pool must physically hold at least ten times the
  hop's spot output in the output token (`balanceOf(pool)`), because the virtual reserves of a
  narrow concentrated position overstate what it can pay. A route that ends at WETH is always live. A launch whose
  route fails reverts (`reward route has no pool`), so no rewards token is created with rewards
  it cannot pay. `isTokenRouteLive(token)` applies the same rule to the route a launched quick
  Rewards token currently follows (its V3 path when it has one, else its V2 pools after WETH).

**Who owns what.** Standard and Tax tokens have no owner. A Rewards token stays owned by
`QuickLaunch`, because `RewardsToken.distributeRewards` is restricted to the owner or the
platform. `QuickLaunch` makes exactly three kinds of calls into a token it owns, each restricted
to the quick Rewards tokens of its own generation (`not a quick rewards token`) and each bounded
by the contract:

- `distributeRewards(token, amountOutMin)` swaps the accumulated rewards tax and credits the
  holders. Only the QuickLaunch owner or `presaleFactory.launchKeeper()` may call it (`not
  keeper`): the caller sets the swap floor, so an open call let anyone sandwich the reward swap
  with a zero floor (about 45 percent of the holders' rewards taken in the review's reproduction).
  The other two calls are permissionless.
- `registerAmmPair(token, pair)` marks a further pool of the platform DEX that holds the token
  as an AMM pair of that token (`RewardsToken.setAmmPair(pair, true)`), so trades through it are
  taxed like the main pool and the pool earns no rewards (`setAmmPair` excludes the pair from
  rewards and zeroes its shares). The pair must answer `token0`/`token1` with the token on one
  side (`pair without the token`) and be the pair the platform router's factory returns for
  those two tokens (`not a pair of the platform DEX`); a pair is registered once (`already
  registered`) and never unregistered. Event `AmmPairRegistered(token, pair)`.
- `repairRewardRoute(token)` points the token at the route stored on `QuickLaunch` for its
  reward token, only while the token's current route (`isTokenRouteLive`: its V3 path, else its
  `rewardPath` after the token itself) fails the depth rule above (`route still live` otherwise)
  and the stored route passes it (`stored route has no pool` otherwise). With a stored V3 path it
  calls `setRewardRouteV3` on the token (event `RewardRouteV3Repaired(token, path)`); otherwise
  it writes the stored V2 intermediates, or the RewardsToken default `[WETH]` when none are
  stored and the reward token is not WETH, which also clears a V3 path the token held (event
  `RewardRouteRepaired(token, path)`). The route of a token that can still pay never changes.

`QuickLaunch` has no function that touches the rest, so a quick Rewards token is as fixed as a
renounced one. What can never change on a quick token: the name, symbol and supply, the token
type, the reward token, the tax wallet, the rewards and marketing (or creator) taxes, the fee
exclusions, the main pair, the owner (`QuickLaunch` for Rewards, none otherwise), a pair once
registered, and the reward route while it can pay. The owner of `QuickLaunch` (the deployer)
only manages the reward allowlist and the swap routes of future launches (one per reward asset,
V2 hops or a V3 path), which reach a launched token only through `repairRewardRoute`, and has no
other power over launched tokens.

**Reward swap route.** `RewardsToken.distributeRewards` always leaves through the token's own
Uniswap V2 pool. Without a V3 path it follows `rewardPath()` on V2: token, WETH, the stored
intermediates, the reward token (the ETH path plus `WETH.deposit` when the reward token is WETH).
With a V3 path (`rewardRouteV3()`, non-empty) leg 1 swaps token -> ETH on V2 and wraps it, and
leg 2 calls Uniswap V3 SwapRouter02 `exactInput(path, recipient this, amountIn = the token's whole
WETH balance, amountOutMinimum = the caller's amountOutMin)`, so any WETH left over from an earlier
attempt is recovered, and requires the WETH balance to be zero afterwards (`partial fill`), because
SwapRouter02 fills only as far as the route's liquidity reaches. The floor is in units of the reward token and is
enforced on the final leg only (leg 1 runs with a zero floor); since leg 2 consumes all of leg 1's
output, a sandwich on either leg lowers the final output and trips the same floor. The path is packed as token (20 bytes), fee (3
bytes), token, ...: it must start at WETH, end at the reward token, hold at most
`MAX_ROUTE_HOPS + 1` = 4 pools, and every pool must exist on the V3 factory of the router
(`setRewardRouteV3`, owner only; empty clears; `setRewardRoute` with V2 hops clears it as well;
event `RewardRouteV3Updated(path)`). On the token the V3 path takes precedence over the V2 hops,
which stay stored and apply again once the path is cleared; only the QuickLaunch store replaces
one form with the other. The token carries the chain's V3 router and quoter as
immutables (`v3Router`, `v3Quoter`; the quoter is for off-chain quotes only) and takes them from
`RewardsTokenDeployer(factory, v3Router, v3Quoter)`. The deployer also gives every new token the V3
path the platform's QuickLaunch stores for its reward token (`platformRouteV3For(rewardToken)`,
read through `presaleFactory.quickLaunch().rewardRouteV3Of` by staticcall, empty when any link is
missing), so a Rewards token created through `TokenFactory.createRewardsToken` starts on the same
route as a quick launch; its owner can change it afterwards, a quick token's route changes only
through `repairRewardRoute`. Mainnet Uniswap V3: factory
`0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`,
QuoterV2 `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`. The tests use `MockUniswapV3` (factory,
constant product pools per fee tier, SwapRouter02 and QuoterV2 mocks).

**Generations.** A replacement `QuickLaunch` is deployed with the address of the one it replaces
(constructor `previousQuickLaunch`, zero for the first; `scripts/deploy-quicklaunch.js` passes
the current one). `creatorOf(presale)` and `presaleOfToken(token)` answer for this generation
first and fall back to the previous one, so `TokenMetadataRegistry.canEdit`, which follows
`PresaleFactory.quickLaunch()`, keeps every quick creator as the editor of their token profile
across replacements. `quickTokenOf`, `allLaunches` and the three calls above are per generation:
a Rewards token stays owned by the `QuickLaunch` that launched it, which keeps distributing its
rewards, and the new generation refuses it (`not a quick rewards token`). The token as fixed at launch is stored in `QuickLaunch.quickTokenOf(presale)`
(`tokenType, rewardToken, taxWallet, buyTaxBps, sellTaxBps, rewardsBuyBps, rewardsSellBps`,
where `buyTaxBps`/`sellTaxBps` are the creator tax of a Tax token and the marketing tax of a
Rewards token) and emitted in `QuickLaunched` (`tokenType, rewardToken, buyTaxBps, sellTaxBps,
rewardsBuyBps, rewardsSellBps`).

**Locked rules.** Supply 1,000,000,000 (18 decimals), 50% sold (`presaleRate = 500,000,000e18 *
1e18 / hardCap`), listing rate equal to the presale rate, soft cap = hard cap / 4, minimum
contribution = hard cap / 1000, maximum = hard cap / 50 (2% per wallet), LP burned, no whitelist,
start = now, end = start + length, `launchTime = endTime`. The creator gets no token allocation:
everything beyond sale + liquidity is burned at creation, unsold tokens are burned at launch and
the token ownership is renounced right after creation (Standard and Tax) or kept by `QuickLaunch`
with no power beyond distributing rewards, registering further DEX pairs and repairing a dead
reward route (Rewards, see "Who owns what"). The profile (logo, description) and the
tokenomics (Presale 50%, Liquidity, Burned) are written to `TokenMetadataRegistry` in the same
transaction. Quick sales cannot be cancelled. Only the `QuickLaunch` contract may call
`PresaleFactory.createQuickPresale` (`setQuickLaunch`, platform owner), so a sale flagged as
quick always carries these token guarantees.

**Raise split, stated on the gross raise.** Platform share (the normal `platformFeeBps`, 2.5% on mainnet), creator
0 to 10% (chosen, stored on the sale as `creatorShareBps` and shown on the sale page), liquidity
the rest (at least 87.5% at the mainnet fee). On chain the platform fee is taken first and `liquidityBps` applies to
the net raise, so the factory requires `liquidityBps == ceil((10000 - platformFeeBps -
creatorShareBps) * 10000 / (10000 - platformFeeBps))` (`PresaleFactory.quickLiquidityBps`); the
creator receives `netEth - liquidityEth`, sent to `payoutRecipient` (the creator wallet) at launch.

**Automatic launch.** The contribution that fills the hard cap (remaining room below the minimum
contribution) finalizes the sale in the same transaction (`contribute` calls the self-call
`autoFinalize`, wrapped so the contribution never reverts because of the launch). Otherwise, at
`endTime` with the soft cap met the sale is launchable: `finalize` accepts any caller on a quick
sale that `isReadyToFinalize()`, the platform keeper (`scripts/launch-keeper.js`) sends it right
away, the sale page offers a permissionless "Launch now" button and the first `claim()` after the
end triggers it too. A launch that cannot go through (for example the pool price deviation guard)
emits `AutoLaunchDeferred` and leaves the sale launchable. Soft cap missed: normal refunds.

**Automatic token delivery.** `Presale.distribute(maxCount)` is permissionless on any finalized
sale: it walks the contributor list from a stored cursor and sends each unclaimed participant
their tokens (same `Claimed` event as `claim`). Inside the automatic launch of a quick sale up to
20 participants are paid inline; the keeper calls `distribute(100)` until
`distributionComplete()`. `distributionProgress()` returns `(sent, total)` and the sale page shows
it ("Sent to 37 of 52 participants", "All tokens delivered") with a permissionless "Send tokens"
button while incomplete. `claim()` stays as a fallback.

**Reward distribution.** The rewards tax of a quick Rewards token accumulates as
`pendingRewardsTokens`. The launch keeper (`scripts/launch-keeper.js`) watches every quick
Rewards token: once the sale is finalized, the pending amount reaches `swapThreshold()` (or
`REWARDS_MIN_BPS` of the supply when set), `totalShares >= 1e18` and `REWARDS_INTERVAL_SECONDS`
(default 300) have passed since its last send, it calls `QuickLaunch.distributeRewards(token, amountOutMin)`,
which swaps the pending tokens to the reward asset through the route (see "Reward swap route")
and credits the holders per share. The call is restricted to the keeper and the QuickLaunch owner
(the caller sets the floor); the token page shows the pending amount and offers the same call to
those two wallets, everyone else reads that the keeper does it on its own; holders claim
with `RewardsToken.claimRewards()` from the same page. The keeper quotes the swap first: leg 1
(token -> WETH) on the token's V2 router and, for a V3 route, leg 2 (the packed path) on the
chain's QuoterV2 (`RewardsToken.v3Quoter`), the V2 route entirely on the V2 router. `amountOutMin`
is that quote minus `REWARDS_SLIPPAGE_BPS` (default 300), and a pending amount whose price impact
exceeds `REWARDS_MAX_IMPACT_BPS` (default 2000) is skipped and logged once. The token page quotes
the route the same way before an owner's or keeper's manual send and passes 97% of the quote as
the floor; it sends nothing when the route cannot be quoted.

**Frontend.** `/quick` is a single form with a "Token type" control (Standard, Tax, Rewards), the
fields of the chosen type (Tax: buy and sell percent, 0.01 to 5, two decimals, one side may be 0;
Rewards: the reward asset from `QuickLaunch.rewardTokens()` labelled ETH, USDG and the stock
symbols, rewards buy and sell 1 to 5, optional marketing buy and sell up to what is left under the
5% cap, with a live "Total per side" line), a "Tax wallet" address field prefilled with the
connected wallet for Tax and Rewards, a live summary (what 1 ETH buys, presale price, tokens
sold, liquidity tokens, burned tokens, type, taxes, reward asset, tax wallet, total trading tax,
fee) and a raise split bar; the transaction passes the `QuickParams` struct. Sale lists carry a
"Quick" badge and the home page a "Quick" filter; the sale page of a quick sale shows the raise
split with the creator address, the locked rules, the automatic launch note next to the
countdown, the token delivery progress and no owner panel. The locked rules state the type and
the taxes from `quickTokenOf` on the sale's owner (the QuickLaunch that launched it; the token
itself is the fallback for an older generation): "Creator tax 2% buy / 2% sell, paid to
0x1234...abcd", "Rewards in USDG: 3% buy / 3% sell, marketing 1% / 1% to 0x1234...abcd" or "No
creator tax", and the ownership line follows the type. The lists show "Tax 2%/2%" or "Rewards
4%/4%" next to the Quick badge. The token page of a Rewards token has a Rewards panel with the
distributed and pending amounts, a "Distribute rewards" button (the QuickLaunch owner or the
factory's launch keeper for a quick token, through `QuickLaunch.distributeRewards(token, 0)`; the
owner for a normal one; everyone else sees a note that the platform keeper distributes on its own)
and the connected wallet's claim. `HoodSaleLens.PresaleView` carries `quick`, `creator`, `creatorShareBps`, `distributed`,
`participantsTotal`, `tokenType`, `rewardToken`, `buyTaxBps` and `sellTaxBps` (the token's own
tax on top of the platform tax: the creator tax of a Tax token, rewards plus marketing of a
Rewards token, 0 for a Standard token; `LaunchView` and `MomentumView` carry the two tax fields
as well).

## HOODS Presale
HOODS is itself a platform token and its presale goes through the same
`PresaleFactory` flow as every other sale (the creation fee where there is one, the platform share,
liquidity lock or burn, softcap refund included). Since HOODS does not come out of the
`TokenFactory`, it is added to the `PresaleFactory.setTokenAllowed` allowlist; only the platform
owner can add to this list, user tokens must go through the factory. So that the sale contract
can be exempted from tax, the factory is authorized in the HOODS token via `setPresaleFactory`.

## HOODS Token
- Name: HoodSale, Ticker: **HOODS**
- Supply: **100,000,000** (fixed, no mint), 18 decimals
- Tax: **3%** on buy/sell (0 on wallet-to-wallet transfers); half marketing, half buyback reserve
- Utility: future fee discounts / staking

## Revenue & Buyback (Treasury)
All revenue is collected in the Treasury contract:
- The platform share of the raised amount (2.5% on mainnet) + the 10% early exit penalties (ETH); the presale creation fees only when the factory charges them (contract defaults 0.1 and 0.03 ETH, none on mainnet)
- The 0.25% buy/sell tax from all platform tokens (in token terms; the Treasury can swap these to ETH on the DEX)

**30% of every ETH received goes to the buyback reserve**: HOODS is bought on the DEX and **burned**. The remaining 70% is for operations/treasury.

The top bar of the frontend shows the **buyback reserve** (ETH) held in the treasury and the amount of
**HOODS burned** through buybacks, live (`Treasury.buybackReserve`, `Treasury.totalBoughtBack`); clicking it
goes to the buyback explanation on the HOODS page. On narrow screens the same counter sits in the menu drawer.

## Project Information on the Presale Page
Every presale page shows the project itself before the sale numbers:
cover image (optional), logo, name, description and social links
(website, X, Telegram, Discord). Right below, the token contract address and the presale
contract address are shown, copyable and linked to the explorer; the token's buy/sell
tax (platform share, project and reward shares if any, 3% for HOODS) is also shown here.
The information
is read from `TokenMetadataRegistry`; the optional "Project profile" step of the presale
creation flow writes this record (it is a separate transaction, can be done before or
after the sale, and can also be edited from the token page).

## Tokenomics
The project's supply distribution is kept on chain via `TokenMetadataRegistry.setTokenomics`: at most
12 slices (label, bps, short note), totaling exactly 100%; only the token owner, only eligible
tokens. It is shown as a donut chart and a table on the sale page and the token page.

**The Presale and Liquidity slices are derived from the sale, never typed.** Whenever a sale reference
exists (the form values while a presale is being created, the token's active presale afterwards)
the editor fills those two rows from the sale settings (tokens for the sale = hardcap × presale
rate; liquidity = hardcap minus the platform share × liquidity percentage × listing rate, both as a
share of the total supply rounded to 0.01%) and keeps them read-only. The creator adds every other
row (label, percent, note). A computed final row, **Unallocated**, is always shown as 100% minus
everything else ("stays in the owner wallet"); it is written to chain as a real slice (label
`Unallocated`, note `Owner wallet`) only when above 0, so the on-chain sum is always exactly 10000
bps. If the rows go past 100% the save is blocked. When a saved plan is read back, its Unallocated
slice is displayed in the computed row. Templates add rows on top of the sale rows: Fair launch
(none), Community (Community 10, Team 5, Marketing 5), Standard project (Team 15, Marketing 10,
Treasury 10), Custom (none). A token that never had a presale keeps Presale and Liquidity editable.

**Every slice shows whether its tokens are locked.** The card reads the token's locks from
`LiquidityLocker` (`locksOfToken` then `locks(id)`; a lock is active while `withdrawn` is false and
`unlockTime` is ahead). Presale shows "Sold in the sale". Liquidity follows the sale parameters: "LP
locked N days" before finalize, "LP locked until date" after finalize (`Presale.lpLockId` in the
locker) or "LP burned" when the liquidity action is burn. Every other slice, Unallocated included,
is matched to one active lock whose amount is within 1% of the slice amount (closest amount first,
each lock used once) and shows "Locked until date" or "Not locked". A declared Presale or
Liquidity share that disagrees with the sale by more than 1 point still shows a warning.

**The owner can lock a slice from the token page.** Each unlocked non-sale slice has a Lock action:
pick an unlock date (3, 6 or 12 month presets or any future date), see the exact token amount,
then approve the locker and call `LiquidityLocker.lock(token, amount, unlockTime, owner)`. An owner
wallet holding fewer tokens than the slice cannot lock it. Locks cannot be shortened or withdrawn
before the unlock date.

## DexScreener Chart
On the sale page, the token page and the HOODS page of launched tokens, a DexScreener
chart is embedded, and the "Open on DexScreener"
link goes to the pool page (`dexscreener.com/robinhood/<pair>`; the pool address is
the token's `mainPair()` value). DexScreener lists Robinhood Chain under the short
name `robinhood`. The chart only exists on mainnet; so that the layout can be seen on the local
network (31337), the card shows a mainnet sample pool (USDG/WETH) explicitly labelled "Preview",
and on testnet a short note remains.

## Participants and Activity Feed
Every presale contract keeps the participation history on chain: a unique participant
list, per-wallet totals (`statsOf`: contributed, early exit, refund, claim,
first participation time) and an append-only activity log (`getActivities`: Contribute, Exit,
Refund, Claim). `HoodSaleLens.presaleParticipants` returns the participant table (active contribution,
share percentage, tokens owed, status) and `presaleActivity` returns the feed, both paginated; the frontend
shows them below the sale page like the "holders / trades" section on chart sites.
Since it does not depend on RPC log limits, it works consistently on every network.

## Trending
The trending ranking is computed from chain data without an additional server. The Lens
`momentumViews(start, count, since)` view returns, for every presale, the ETH raised since the `since` moment,
early exit refunds, the number of first-time contributing wallets, the activity count
and the post-launch multiplier (it scans the activity log and the participant list from the end).
The frontend uses the last 24 hours and scores with a single formula: for live sales, the 24-hour
contributions, new wallets and fill ratio (early exits lower the score; the wallet count weighs more
than the amount), for launched ones the multiplier relative to the listing price and, on mainnet,
the 24-hour volume taken from DexScreener, for upcoming sales the whitelist size and
the time left until the start. Ended, failed and cancelled sales are not listed.
Display: a fixed trending strip at the top of every page (at most 10 tokens, no marquee;
if it does not fit it is scrolled horizontally by hand). The "Trending" heading in the strip and the "All N" chip at the end
go to the `/trending` page, which lists all ranked sales with their reasons (the sidebar
also has a "Trending" link).

## Real DEX Behavior and Fixed Bugs
The integration tests running against the real Uniswap V2 on a Robinhood mainnet fork
(`npm run test:fork`) revealed three issues that the mock DEX had hidden:

| Issue | Fix |
|---|---|
| In Rewards tokens whose reward token is WETH, distribution always reverted with `INVALID_TO` on the real pool | The ETH path is used for WETH and the incoming ETH is wrapped with `WETH.deposit` |
| Someone minting LP into the pool before launch and shifting the price could extract value | In a pool with LP minted, the price may deviate at most 5% from the listing price (`MAX_POOL_DEVIATION_BPS`), otherwise finalize is rejected; the owner pulls the pool back to the listing price (with the attacker's money, profitably) and retries. `poolPriceDeviationBps()` is for the frontend |
| There is no WETH/stock pool on mainnet for stock rewards | The reward swap route is configurable (`setRewardRoute`, e.g. [WETH, USDG]); the path is read via `rewardPath()` |
| The tokenized stocks trade on Uniswap V3 on mainnet; their V2 pools hold dust | A V3 leg after the token's own V2 pool (`setRewardRouteV3`, a packed path through SwapRouter02; `rewardRouteV3()`), stored per reward asset on QuickLaunch and applied to every new Rewards token |

The mock DEX (`MockDex`) now enforces the `INVALID_TO` rule like the real `UniswapV2Pair.swap`;
the offline suite catches this class of bugs.

## Source Verification
Source verification is an off-chain process run by the platform keeper (`npm run keeper`,
`contracts/scripts/launch-keeper.js`), which also hosts the verification watcher
(`scripts/auto-verify.js`, `AUTO_VERIFY=0` turns it off, `npm run auto-verify` runs it alone).
The watcher follows the TokenFactory's `TokenCreated` events, so every Standard, Tax and Rewards
token, including the tokens QuickLaunch creates through the factory, is verified after
`CONFIRMATIONS` blocks: the constructor arguments are rebuilt from the chain
(`scripts/lib/constructorArgs.js`; for tokens created inside another contract's call the supply
comes from the mint log of the creation receipt), the Standard JSON input is taken from the
Hardhat build-info and submitted to Sourcify (`scripts/lib/sourcify.js`, v2 API, chains 4663 and
46630, the factory transaction as creation tx; an exact runtime match with no creation match is a
success) and the result is logged once with the link `https://repo.sourcify.dev/<chainId>/<address>`.
Blockscout is only the secondary target when its API answers; the mainnet API sits behind a
Cloudflare challenge (403) and its verification service returned 500, neither blocks the loop,
failures are retried with exponential backoff and progress is kept in
`verify-state/<network>.json`. Presale contracts are verified the same way unless
`VERIFY_PRESALES=0`; the platform contracts were verified once by hand (`verify-contract.js`,
Sourcify exact match) and are listed on the Trust page of the site. Details in
`contracts/docs/VERIFY.md`.

## Token Profiles
Every platform token can have an on-chain profile (`TokenMetadataRegistry`):
logo, cover image, description and social media links (website, twitter,
telegram, discord). The token's owner can write its profile, and so can the creator of a
quick sale (its token has no owner), at any time before, during and after the sale
(`canEdit`; the sale page and the token page both carry the editor). Besides factory
tokens, the platform tokens on the PresaleFactory allowlist (HOODS)
can also keep a profile (`isEligible`). The token page in the frontend
shows this information together with the token's actual tax settings and market data.

## Launch Performance
Finalized presales are listed on the "Launches" page. `HoodSaleLens`
compares the listing price (derived from listingRate) with the current pool price
and returns the multiplier (1e18 = 1x); the frontend shows it as "3.21x" or "-42%".

## Fee Visibility
Fees are not lined up on the home page like an advertisement. Every fee is stated where the
action takes place (for example, the presale exit button shows the 10% penalty and the net refund
amount) and all of them are explained together on the Docs page.

## Architecture
```
contracts/
  HoodSaleToken.sol          HOODS ERC-20 (fixed supply, 3% tax)
  Treasury.sol               revenue collection + 30% buyback&burn
  TokenFactory.sol           deploys the 3 token types, keeps the registry
  tokens/StandardToken.sol
  tokens/TaxToken.sol
  tokens/RewardsToken.sol    with dividend tracker (stock rewards = a stock is chosen as the reward token); V2 route or V3 path after WETH
  interfaces/IUniswapV3.sol  the V3 factory, pool, SwapRouter02 and QuoterV2 surface plus the packed path helpers
  PresaleFactory.sol         deploys Presale (factory tokens only) for the creation fee it is set to (none on mainnet)
  Presale.sol                contribution, claim, early exit, cancel, finalize, liquidity
  LiquidityLocker.sol        LP locking / withdrawal after expiry
  TokenMetadataRegistry.sol  token profiles (logo, cover, description, social)
  HoodSaleLens.sol           read-only batched data + launch performance
frontend/                    Vite + React + wagmi/viem
```

DEX: the official Uniswap V2 Router02 on Robinhood Chain (`0x89e5db8b5aa49aa85ac63f691524311aeb649eba`) for every token's own pool; the reward swap's stock leg runs on Uniswap V3 (SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`). Both addresses are configurable at deploy time.
