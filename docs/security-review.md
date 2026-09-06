# Security review

This document records the static analysis run and the review history of the HoodSale contracts.
Security contact: security@hoodsale.io.

## Static analysis with Slither, September 2026

Tool: Slither 0.11.4 (crytic-compile 0.3.11) with solc 0.8.26, run through the Hardhat build of
this repository (optimizer on, 200 runs, viaIR). Command, from the `contracts` directory:

```
slither . --filter-paths "node_modules|contracts/test" --exclude-dependencies
```

Result: 71 contracts analysed with 100 detectors, 229 results. The raw output is in
`docs/slither-report.txt`. Counts per severity:

| Severity | Findings |
|---|---|
| High | 6 |
| Medium | 32 |
| Low | 152 |
| Informational | 35 |
| Optimization | 4 |

Every finding was read against the source. None of them is an open issue; the notes below say
for each detector why the pattern is accepted. Findings that would be cheap to harden are marked
as such.

### High (6)

- `arbitrary-send-eth`, `HoodSaleToken._swapBack` (2 calls): the swapped tax goes to
  `marketingWallet` and to `Treasury.depositBuyback`. Both addresses are set by the token owner
  through `onlyOwner` setters that reject the zero address; the amounts are the contract's own
  tax proceeds, not user funds. Accepted.
- `arbitrary-send-eth`, `Presale._addLiquidity`: the call is `WETH.deposit`, with the WETH
  address read from the router the factory fixed at deployment. Accepted.
- `arbitrary-send-eth`, `Presale._sendEth`: the recipients are the treasury (fixed by the
  factory), `msg.sender` receiving its own refund or exit amount, and `payoutRecipient`, which
  is the sale owner or the quick sale creator set at creation. Every caller is `nonReentrant`
  and updates state before sending. Accepted.
- `encode-packed-collision`, `PresaleFactory._deployPresale`: `abi.encodePacked` concatenates
  the Presale creation code with the abi encoded constructor arguments to form the init code
  for `create`. The bytes are executed, never hashed or compared, so a collision has no meaning
  here. Accepted, false positive.
- `reentrancy-eth`, `RewardsToken.distributeRewards`: the function is restricted to the owner
  (for a quick token QuickLaunch, which in turn admits only its owner and the launch keeper) or
  the platform,
  carries `nonReentrant`, requires `!inSwap`, and zeroes `pendingRewardsTokens` before the
  swaps. The state write after the calls is the reset of the `inSwap` flag. Accepted.
- `unchecked-transfer`, `IWETH(weth).transfer(pair, liquidityEth)` in `Presale._addLiquidity`:
  the canonical WETH9 `transfer` reverts on insufficient balance and returns true. If the WETH
  did not reach the pair, the following `pair.mint` and the `require(lpBal > 0, "no lp")` in
  `_finalize` revert the launch. Accepted; `safeTransfer` would be a defensive alternative.

### Medium (32)

- `divide-before-multiply` (2), `Presale._finalize` and `PresaleFactory.requiredTokensFor`:
  `liquidityEth` is computed in wei and then multiplied by the listing rate; the rounding loss is
  below one token unit. The same formula is used in both places, so the deposit the factory
  requires matches what finalize consumes. Accepted.
- `incorrect-equality` (5): the `balanceOf(presale) - balBefore == required` check in
  `PresaleFactory._create` is the intended rejection of a fee on transfer; the `amount == 0` and
  `ethGained == 0` comparisons are early returns; `IERC20(weth).balanceOf(this) == 0` after the
  V3 leg is the partial fill check, exact by design because the whole WETH balance was passed as
  `amountIn`. Accepted.
- `reentrancy-no-eth` (5): the three `_swapBack` variants run under the `inSwapFlag` modifier and
  `_update` takes no fees while `inSwap` is set, so the pending counters cannot change during the
  swap and zeroing them afterwards is safe. `PresaleFactory._create` is reached only through
  `nonReentrant` entry points, the token is a platform token or one allowlisted by the owner, and
  `activePresaleOfToken` is checked before any call. `Presale._distribute` is reached through
  `nonReentrant` functions and `_payOut` zeroes the contribution before the transfer. Accepted.
- `uninitialized-local` (9): counters and indices (`n`, `j`, `m`, `count`, `total`, `found`) that
  rely on the zero default. Accepted.
- `unused-return` (11): `addLiquidityETH` and `pair.mint` return values are ignored, but the code
  reads the LP balance afterwards and requires it to be positive; `exactInput` and
  `swapExactETHForTokens` outputs are measured as balance deltas (`received > 0`, burned amount);
  `getReserves` and `slot0` are destructured for the fields in use; `statsOf` is read for
  `joinedAt` only. Accepted.

### Low (152)

- `calls-loop` (99): external calls inside loops in the lens views (`HoodSaleLens`) and the
  QuickLaunch route liveness checks. All are `view` functions with paged input or a route bounded
  by `MAX_ROUTE_HOPS`; they are not called by state changing code. Accepted.
- `missing-zero-check` (12): constructor arguments of the deployers, the Presale constructor
  (called by the factory, which validates its own configuration), `HoodSaleToken.setPresaleFactory`
  and `PresaleFactory.setLaunchKeeper` (a zero keeper disables keeper triggered launches), and a
  view argument. Accepted; explicit zero checks would be a cheap hardening.
- `reentrancy-benign` (12) and `reentrancy-events` (11): state writes and events after external
  calls in functions guarded by `nonReentrant` or the `inSwap` flag. Accepted.
- `timestamp` (18): sale schedules, the finalize window and lock durations are measured in
  `block.timestamp` by design, with windows of hours to days. Accepted.

### Informational (35)

- `assembly` (3): the packed V3 path readers and the `create` call in `_deployPresale`.
- `low-level-calls` (9): ETH sends with explicit result handling, `_tryTransfer`, and try style
  reads of optional interfaces.
- `missing-inheritance` (7): minimal interfaces declared next to the contract that consumes them.
- `naming-convention` (2): `WETH()` and `WETH9()` are the Uniswap names.
- `redundant-statements` (2): explicit discarding of a call result.
- `too-many-digits` (1): the Presale creation bytecode literal in `PresaleCode`.
- `unindexed-event-address` (8): single address setter events.
- `costly-loop` (2): whitelist batch writes, owner only.
- `cyclomatic-complexity` (1): `HoodSaleLens.presaleMomentum`, a view.

All accepted.

### Optimization (4)

- `cache-array-length` (3): loops over `_rewardTokens` in QuickLaunch views.
- `immutable-states` (1): `PresaleFactory.tokenFactory` could be immutable.

Gas only, no security effect. Accepted.

## Review history, September 2026

The contracts went through several review rounds before the current deployment. The rounds and
their outcomes:

- Internal multi-agent audit of the presale, token and locker contracts. The issues found are
  listed with their fixes in the README (section "Security Notes") and have regression tests in
  `test/security.test.js`. They include a pair created up front to block token creation, a
  pre-funded pair making finalize revert, reward shares stuck in the presale or in secondary
  pools, an int256 wraparound in reward accounting, unbounded lock lists, the `INVALID_TO`
  failure of WETH rewards on the real pool, and launch price manipulation through LP minted
  before launch.
- Reward route liveness for quick launches. A launch with a Rewards token requires every pool of
  the reward route to hold real depth: ten probes of 0.01 WETH must keep at least half the per
  probe rate, so a route through a dust pool is refused instead of producing a token whose
  rewards cannot be paid.
- Wrong chain transaction guard in the frontend. Every transaction is sent with the page's
  chainId; a wallet connected to another chain sees a banner with a switch button while the
  primary buttons stay disabled.
- Adversarial review of the Uniswap V3 reward route change. It found three issues, all closed in
  the same change:
  - The reward distribution call was open to anyone and the caller sets the swap floor, so
    anyone could sandwich the reward swap with a zero floor (about 45 percent of the holders'
    rewards were taken in the review's reproduction). `distributeRewards` is now restricted to
    the QuickLaunch owner and the factory's launch keeper.
  - The V3 depth rule read the virtual reserves of the current tick range, which a narrow
    position overstates. The rule now also requires the pool to really hold the output of ten
    probes (`_v3RouteLive` checks `balanceOf(pool)`).
  - A partial fill of the V3 leg left WETH stranded in the token. The whole WETH balance is now
    passed to `exactInput` and the call reverts if any WETH remains, restoring the pending amount.
- The change was rehearsed on a mainnet fork against the real Uniswap V3 (TSLA rewards through
  WETH, USDG and TSLA, keeper signed distribution, a stranger refused). The offline test suite
  recorded with that change has 376 passing tests.

No independent third party audit has been completed. The platform is live on mainnet; the
README and the Trust page of the site say so, and users should size their exposure accordingly.
