# Security policy

## Reporting a vulnerability

Send reports to security@hoodsale.io. Do not open a public issue for a vulnerability.

Include what you can of the following: the contract and function concerned, the conditions
under which the issue is reachable, a proof of concept (a Hardhat test against this
repository is ideal), and the impact you expect (funds at risk, who can trigger it, whether
it needs a privileged account).

We aim to respond within a week. We will confirm the report, tell you whether we consider
it valid, and keep you informed while it is fixed. Please give us reasonable time to fix
and, where a deployed contract is affected, to migrate before you publish details.

## Scope

The Solidity sources in `contracts/`, the Uniswap v4 launch mode in `contracts/v4/` included,
and the deployed instances on Robinhood Chain (chainId 4663) listed in
`deployments/robinhood.json` and in `README.md`:

| Contract | Address |
|---|---|
| PresaleFactory | 0x8dcC19e98713C2EC024dd337Edea18BEBC490942 |
| PresaleCode | 0x8a5eEFdfC62A7603FF05131146284E07F737f2De |
| QuickLaunch | 0xAFE71e8F922e740087af9d56091913022e3f76Fc |
| TokenFactory | 0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf |
| StandardTokenDeployerV4 | 0x9Bfda553971163AB5667f987AdD8124fa86FED1E |
| TaxTokenDeployerV4 | 0x65A15D6784E3d154fDDa10B6c40cAeC88cf41226 |
| RewardsTokenDeployerV4 | 0xEc7d7EF2C9b56f019e96dF04E798cAf38E6E4EC3 |
| RewardsTokenCode | 0xDC7ec9F5AA960418CcfA5042fc0AF1d2488CAbb9 |
| RewardsTokenCodeV4 | 0x916A1F2dF2BF90099390DF96E690747EC092Ed57 |
| Treasury | 0x52C4fa5E853e556000429763A50cd9A0cdA971e7 |
| LiquidityLocker | 0xfF7E28d54f1927565Ab02781b635178b9b2683B7 |
| HoodSaleToken (HOODS) | 0x48874aD21dbD7512C0EdC123232898C6eCf34D7E |
| HoodSaleLens | 0x7CC6E927CC45Ce75964E0117883aF2951e8Fe3AE |
| TokenMetadataRegistry | 0x10A6B866EE01407C09a61C709d10AcFd93a8dCA6 |
| LaunchBatch | 0xd3fe8424Bb2Af873500f40e9E4474168E9E7CaB2 |
| V4Launcher | 0x1a12a2781829CBd3268A9e84d621D53e0776b9df |
| HoodSaleV4Hook | 0xd996Bb10EE4C780bD619bC9f3Fb22d62c4bDa0cc |
| V4PositionLocker | 0x755557DF04B6fC2BB48C42C49fbEeB8160bC8035 |
| HoodSaleV4Router | 0x67dBeCD36c4A3ef057Ee7343A5451b53185A5DDa |
| HoodSaleV4Lens | 0xd4734d10311280cF6949Af7796466fbC63Bf7012 |

Also in scope: every Presale the factory creates, every StandardToken, TaxToken and
RewardsToken the token factory creates from these sources, every HoodSaleTokenV4 and
RewardsTokenV4 the V4Launcher creates through it, every Uniswap v4 pool registered with the
hook and every position held by the V4PositionLocker, and the keeper scripts in `scripts/`
when a flaw in them puts user funds at risk.

Out of scope: the hoodsale.io website and its hosting, third party contracts the platform
calls (the Uniswap V2, V3 and v4 deployments on Robinhood Chain, among them the v4
PoolManager, PositionManager, StateView, V4Quoter, Universal Router and Permit2, the tokenized
stock contracts, WETH), Uniswap's routing and hook allowlist, wallets, RPC providers, and
issues that need a compromised owner or keeper key.

## Review status

The contracts have been reviewed internally only. There is no independent third party audit.

- The V2 platform went through an internal multi-agent review. Its findings and fixes are
  listed with regression tests in `test/security.test.js`, and the Slither run with a note on
  every finding is in `docs/security-review.md` (that run predates the v4 mode).
- The Uniswap v4 launch mode went through an internal multi-agent review as well. It found no
  way for an outsider to take funds; its medium findings were places where the contracts allowed
  more than the site promised. The fixes were shipped on mainnet on 18 September 2026: a new
  RewardsTokenCodeV4 and RewardsTokenDeployerV4 (the keeper may only run reward distributions,
  the route answers to the token owner alone and the presale factory may only exclude, the swap
  takes exactly the ETH being distributed, `distributeRewardsPartly` pays out along a thin
  route), a new PresaleCode (a v4 sale opens its pool only with the tax it was created with,
  `v4TermsHash`) and a new HoodSaleV4Lens (a launch is valued by its own position). The hook,
  the launcher, the locker and the router did not change. Tokens and sales created before the
  fixes keep their own code; at that point the only v4 launch was the platform's own first
  launch.

Every deployed platform contract, the v4 contracts included, is verified on Sourcify; see the
table in `README.md`.

## Known limits

What the contracts cannot prevent. `SPEC.md` ("Uniswap v4 Launch Mode", "Known limits") and the
Trust page of the site explain each one.

- Anyone can open another pool for any token, on V2, V3 or on Uniswap v4 without the HoodSale
  hook, and trade there without the tax (unless a V2 token's owner or the platform marks that
  pair as taxed). The launch liquidity stays in the pool the sale opened.
- On Uniswap v4, liquidity placed in a narrow price range works like a limit order when the
  price moves through it; that is not a swap, so the hook takes no tax on it.
- A v4 trade that fixes the amount received (an exact-output trade) pays the tax on the ETH
  before tax, added on top, which is slightly less than the stated rate of the trade's ETH (for
  example 9.09% instead of 10%).
- A v4 buy that names its ETH amount and sets its own price limit pays the tax on the whole
  amount named, even if the swap stops early.
- A v4 token owner who keeps the tax or the wallet unlocked can change them after the launch,
  within the 10% cap.
- Uniswap's fee switch can add a protocol fee of up to 0.1% per trade to any v4 pool; HoodSale
  does not control it.
- The V4Launcher accepts launches only from sales of the presale factory it was deployed with,
  and trusts the sale code that factory's owner sets (`setPresaleCode`) to name its token.
- The platform contracts have a single owner wallet, not a multisig and not a time lock. What
  that wallet can change is listed in `README.md`.

## Bug bounty

There is no paid bug bounty at the moment. Valid reports are credited in the release notes
if the reporter wants that.

## Deployed versions

The deployed platform contracts are verified on Sourcify
(https://repo.sourcify.dev/4663/<address>).
A report should say which address it refers to when the deployed bytecode and the sources
in this repository differ.
