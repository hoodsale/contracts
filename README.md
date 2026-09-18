# HoodSale contracts

Solidity sources, tests and operational scripts of HoodSale, a presale launchpad on
Robinhood Chain (Arbitrum Orbit L2, chainId 4663, gas token ETH). The frontend at
https://hoodsale.io reads everything it shows from these contracts.

A sale lists its token in one of two modes. In the Uniswap V2 mode, the original one, the token
carries its own tax and the launch liquidity goes into a V2 pair. In the Uniswap v4 mode, live
since 18 September 2026, the token is a plain ERC-20 and the tax is charged by the pool's hook;
its sources are under `contracts/v4/`. Both modes share the same TokenFactory, PresaleFactory,
Presale, Treasury and sale fees; the platform share of a v4 trade is a constant of the hook, not
the TokenFactory's tax setting.

Solidity 0.8.26, OpenZeppelin Contracts v5, Hardhat, and Uniswap `v4-core` and `v4-periphery`
(npm) for the v4 mode. `SPEC.md` is the functional specification the contracts implement;
`docs/VERIFY.md` describes source verification.

## What the contracts do

| Source | Role |
|---|---|
| `contracts/TokenFactory.sol` | Creates the three token types through three deployer contracts and keeps the registry of platform tokens (`isPlatformToken`, `infoOf`, `allTokens`) for both modes. The deployers it uses today are `StandardTokenDeployerV4`, `TaxTokenDeployerV4` and `RewardsTokenDeployerV4` (`contracts/v4/deployers/`): for every creator except the V4Launcher they deploy the same V2 token as before (the Rewards token from the creation code held by `contracts/tokens/RewardsTokenCode.sol`), for the V4Launcher a tax-free v4 token. Creation is free apart from gas. |
| `contracts/tokens/PlatformTaxBase.sol` | Shared base of the V2 tokens: fixed supply minted to the creator, 18 decimals, a platform tax on pool buys and sells paid in tokens to the Treasury, a hard cap of 10% on the total tax (`MAX_TOTAL_TAX_BPS`), AMM pair and fee exemption management, and the one-way owner locks (`lock`: taxes, tax wallet, fee exemptions, ownership; `renouncedBy`). No mint, pause, blacklist or freeze function. |
| `contracts/tokens/StandardToken.sol` | Platform tax only. |
| `contracts/tokens/TaxToken.sol` | Platform tax plus an owner defined buy and sell tax swapped to ETH and sent to a marketing wallet. |
| `contracts/tokens/RewardsToken.sol` | Platform tax plus a rewards tax distributed to holders in a chosen reward token (WETH, USDG or a tokenized stock) and an optional marketing tax. The reward swap runs on Uniswap V2 from the token's own pool, optionally followed by a Uniswap V3 path (`setRewardRoute`, `setRewardRouteV3`). |
| `contracts/PresaleFactory.sol` | Creates a `Presale` for a factory token (or an allowlisted platform token) with the fees it is set to, keeps the presale registry, the launch keeper address and the `QuickLaunch` address. |
| `contracts/PresaleCode.sol` | Holds the creation code of `Presale`; the factory deploys sales from it with CREATE so that the factory stays under the contract size limit. |
| `contracts/Presale.sol` | One sale: contribute, early exit with a penalty, cancel, refund on a missed soft cap or a missed finalize window, finalize (platform share, liquidity on Uniswap V2 or, for a v4 token, a Uniswap v4 pool opened through the V4Launcher, LP or position lock or burn, owner payout), claim, permissionless token delivery (`distribute`), whitelist mode, schedule changes before the start, an optional launch time the keeper acts on, an on-chain participant list and activity log. A v4 sale records a hash of its token's pending v4 tax when it is created and opens the pool only with that tax (`v4TermsHash`, `v4TermsHold`). |
| `contracts/QuickLaunch.sol` | A token and a sale in one transaction with fixed rules (supply 1,000,000,000, 50% sold, soft cap a quarter of the hard cap, per wallet maximum 2% of the hard cap, LP burned, automatic launch at the hard cap or at the end, ownership renounced for Standard and Tax tokens). Keeps the reward token allowlist and the reward swap routes, and is the only caller of `PresaleFactory.createQuickPresale`. Quick sales always list on Uniswap V2. |
| `contracts/Treasury.sol` | Receives all platform revenue. 30% of every incoming ETH (`buybackBps`) is set aside as the buyback reserve, which leaves the Treasury only through `executeBuyback`: a buy on the DEX sent to the burn address, of the token and through the router the owner sets (`setHoodsale`, `setRouter`; HOODS and Uniswap V2 today). Token revenue can be sold for ETH (`liquidateToken`) and falls under the same rule, and so does the ETH the v4 hook pays in. |
| `contracts/LiquidityLocker.sol` | Locks LP tokens (or any ERC-20) until an unlock time. No owner. A lock can be extended or transferred, never shortened. |
| `contracts/HoodSaleLens.sol` | Read-only batched views for the frontend: sale lists, participants, activity, launch performance, trending inputs. Reports where each token trades (`poolKind`: 0 Uniswap V2, 1 Uniswap v4) and reads the price, liquidity and taxes of a v4 launch through the HoodSaleV4Lens its launcher names. |
| `contracts/TokenMetadataRegistry.sol` | On-chain token profiles (logo, cover, description, links) and tokenomics slices, writable by the token owner or the creator of a quick sale. |
| `contracts/HoodSaleToken.sol` | HOODS, the platform token: 100,000,000 supply, 3% tax on pool buys and sells, split between the marketing wallet and the Treasury buyback reserve. |
| `contracts/LaunchBatch.sol` | A batch executor used only as an EIP-7702 delegation target by the wallet that owns a sale, so that the launch and an opening buy and burn run in one transaction. No storage, no owner; only the delegating wallet itself can drive it. |
| `contracts/interfaces/` | The Uniswap V2 and V3 surface the contracts use. |
| `contracts/test/` | `MockDex` (Uniswap V2 look-alike) and `MockUniswapV3` used by the offline tests, `V4TestSwapper` and `V4Mocks` for the v4 tests, `TestLauncher` (stands in for the EIP-7702 launch) and `HoodSaleRehearsalToken`. |

The Uniswap v4 launch mode, `contracts/v4/`:

| Source | Role |
|---|---|
| `contracts/v4/V4Launcher.sol` | Creates tokens for a v4 launch through the TokenFactory (`createToken`), holds each token's tax settings until its pool opens (`pendingConfig`; `setTaxConfig` by the token owner) and opens the pool when a sale finalizes (`launch`, accepted only from a presale of its PresaleFactory): the pool at the listing price, the launch liquidity as one full-range position, locked in the V4PositionLocker or sent to the burn address. |
| `contracts/v4/HoodSaleV4Hook.sol` | The hook every HoodSale v4 pool uses. Takes the platform share (a constant 0.25%) and the creator tax (a project share and, on a Rewards token, a holder share) in ETH on each swap, at most 10% per side in total; the LP fee is a constant 0.05%. The collected ETH waits in the hook until `flush` and `flushPlatform`, which anyone may call, send it on. No owner: each pool's tax, wallet and locks answer to that token's owner. |
| `contracts/v4/V4PositionLocker.sol` | Holds locked v4 launch positions (PositionManager NFTs) until their unlock time. The lock owner can extend or transfer a lock and collect the position's trading fees without touching the liquidity. |
| `contracts/v4/HoodSaleV4Router.sol` | Exact-input buys and sells in a launch's own pool (the pool key the launcher recorded), behind the trade box on the site. Holds nothing between calls. |
| `contracts/v4/HoodSaleV4Lens.sol` | Read-only views of v4 launches: price, the launch position's amounts, lock state, the pool's tax and the fees waiting in the hook. |
| `contracts/v4/tokens/HoodSaleTokenV4.sol` | The token of a Standard or Tax launch on v4: fixed supply, 18 decimals, no transfer tax, no mint, `poolVersion()` returns 4. |
| `contracts/v4/tokens/RewardsTokenV4.sol`, `RewardsTokenCodeV4.sol` | The token of a Rewards launch on v4: no transfer tax; receives the holders' share in ETH from the hook, turns it into the reward token (`distributeRewards`, `distributeRewardsPartly`: a WETH reward is only wrapped, USDG or a tokenized stock is bought along a Uniswap V3 path), credits it per share and pays it out with `claimRewards`. The code contract holds its creation code for the deployer. |
| `contracts/v4/deployers/TokenDeployersV4.sol` | The three deployers the TokenFactory uses today, see above. |
| `contracts/v4/interfaces/` | The PositionManager and Permit2 surface, the launcher views the v4 tokens read, and the presale and factory views the launcher reads. |

The keeper (`scripts/launch-keeper.js`) is the off-chain part: it launches scheduled and
quick sales, delivers tokens, distributes rewards of quick Rewards tokens, sends the tax the v4
hook collects on to its recipients, distributes rewards of v4 Rewards tokens and verifies every
new V2 factory token on Sourcify. See "Keeper" below.

## Mainnet deployment

Robinhood Chain mainnet, chainId 4663. Addresses are also in `deployments/robinhood.json`.
Sourcify links have the form `https://repo.sourcify.dev/4663/<address>`, Blockscout links
`https://robinhoodchain.blockscout.com/address/<address>`.

| Contract | Address | Sourcify | Blockscout |
|---|---|---|---|
| PresaleFactory | `0x8dcC19e98713C2EC024dd337Edea18BEBC490942` | [exact match](https://repo.sourcify.dev/4663/0x8dcC19e98713C2EC024dd337Edea18BEBC490942) | [address](https://robinhoodchain.blockscout.com/address/0x8dcC19e98713C2EC024dd337Edea18BEBC490942) |
| PresaleCode | `0x8a5eEFdfC62A7603FF05131146284E07F737f2De` | [exact match](https://repo.sourcify.dev/4663/0x8a5eEFdfC62A7603FF05131146284E07F737f2De) | [address](https://robinhoodchain.blockscout.com/address/0x8a5eEFdfC62A7603FF05131146284E07F737f2De) |
| QuickLaunch | `0xAFE71e8F922e740087af9d56091913022e3f76Fc` | [exact match](https://repo.sourcify.dev/4663/0xAFE71e8F922e740087af9d56091913022e3f76Fc) | [address](https://robinhoodchain.blockscout.com/address/0xAFE71e8F922e740087af9d56091913022e3f76Fc) |
| TokenFactory | `0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf` | [match](https://repo.sourcify.dev/4663/0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf) | [address](https://robinhoodchain.blockscout.com/address/0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf) |
| StandardTokenDeployerV4 | `0x9Bfda553971163AB5667f987AdD8124fa86FED1E` | [exact match](https://repo.sourcify.dev/4663/0x9Bfda553971163AB5667f987AdD8124fa86FED1E) | [address](https://robinhoodchain.blockscout.com/address/0x9Bfda553971163AB5667f987AdD8124fa86FED1E) |
| TaxTokenDeployerV4 | `0x65A15D6784E3d154fDDa10B6c40cAeC88cf41226` | [exact match](https://repo.sourcify.dev/4663/0x65A15D6784E3d154fDDa10B6c40cAeC88cf41226) | [address](https://robinhoodchain.blockscout.com/address/0x65A15D6784E3d154fDDa10B6c40cAeC88cf41226) |
| RewardsTokenDeployerV4 | `0xEc7d7EF2C9b56f019e96dF04E798cAf38E6E4EC3` | [exact match](https://repo.sourcify.dev/4663/0xEc7d7EF2C9b56f019e96dF04E798cAf38E6E4EC3) | [address](https://robinhoodchain.blockscout.com/address/0xEc7d7EF2C9b56f019e96dF04E798cAf38E6E4EC3) |
| RewardsTokenCode | `0xDC7ec9F5AA960418CcfA5042fc0AF1d2488CAbb9` | [exact match](https://repo.sourcify.dev/4663/0xDC7ec9F5AA960418CcfA5042fc0AF1d2488CAbb9) | [address](https://robinhoodchain.blockscout.com/address/0xDC7ec9F5AA960418CcfA5042fc0AF1d2488CAbb9) |
| RewardsTokenCodeV4 | `0x916A1F2dF2BF90099390DF96E690747EC092Ed57` | [exact match](https://repo.sourcify.dev/4663/0x916A1F2dF2BF90099390DF96E690747EC092Ed57) | [address](https://robinhoodchain.blockscout.com/address/0x916A1F2dF2BF90099390DF96E690747EC092Ed57) |
| Treasury | `0x52C4fa5E853e556000429763A50cd9A0cdA971e7` | [exact match](https://repo.sourcify.dev/4663/0x52C4fa5E853e556000429763A50cd9A0cdA971e7) | [address](https://robinhoodchain.blockscout.com/address/0x52C4fa5E853e556000429763A50cd9A0cdA971e7) |
| LiquidityLocker | `0xfF7E28d54f1927565Ab02781b635178b9b2683B7` | [exact match](https://repo.sourcify.dev/4663/0xfF7E28d54f1927565Ab02781b635178b9b2683B7) | [address](https://robinhoodchain.blockscout.com/address/0xfF7E28d54f1927565Ab02781b635178b9b2683B7) |
| HoodSaleToken (HOODS) | `0x48874aD21dbD7512C0EdC123232898C6eCf34D7E` | [exact match](https://repo.sourcify.dev/4663/0x48874aD21dbD7512C0EdC123232898C6eCf34D7E) | [address](https://robinhoodchain.blockscout.com/address/0x48874aD21dbD7512C0EdC123232898C6eCf34D7E) |
| HoodSaleLens | `0x7CC6E927CC45Ce75964E0117883aF2951e8Fe3AE` | [exact match](https://repo.sourcify.dev/4663/0x7CC6E927CC45Ce75964E0117883aF2951e8Fe3AE) | [address](https://robinhoodchain.blockscout.com/address/0x7CC6E927CC45Ce75964E0117883aF2951e8Fe3AE) |
| TokenMetadataRegistry | `0x10A6B866EE01407C09a61C709d10AcFd93a8dCA6` | [exact match](https://repo.sourcify.dev/4663/0x10A6B866EE01407C09a61C709d10AcFd93a8dCA6) | [address](https://robinhoodchain.blockscout.com/address/0x10A6B866EE01407C09a61C709d10AcFd93a8dCA6) |
| LaunchBatch | `0xd3fe8424Bb2Af873500f40e9E4474168E9E7CaB2` | [exact match](https://repo.sourcify.dev/4663/0xd3fe8424Bb2Af873500f40e9E4474168E9E7CaB2) | [address](https://robinhoodchain.blockscout.com/address/0xd3fe8424Bb2Af873500f40e9E4474168E9E7CaB2) |
| V4Launcher | `0x1a12a2781829CBd3268A9e84d621D53e0776b9df` | [exact match](https://repo.sourcify.dev/4663/0x1a12a2781829CBd3268A9e84d621D53e0776b9df) | [address](https://robinhoodchain.blockscout.com/address/0x1a12a2781829CBd3268A9e84d621D53e0776b9df) |
| HoodSaleV4Hook | `0xd996Bb10EE4C780bD619bC9f3Fb22d62c4bDa0cc` | [exact match](https://repo.sourcify.dev/4663/0xd996Bb10EE4C780bD619bC9f3Fb22d62c4bDa0cc) | [address](https://robinhoodchain.blockscout.com/address/0xd996Bb10EE4C780bD619bC9f3Fb22d62c4bDa0cc) |
| V4PositionLocker | `0x755557DF04B6fC2BB48C42C49fbEeB8160bC8035` | [exact match](https://repo.sourcify.dev/4663/0x755557DF04B6fC2BB48C42C49fbEeB8160bC8035) | [address](https://robinhoodchain.blockscout.com/address/0x755557DF04B6fC2BB48C42C49fbEeB8160bC8035) |
| HoodSaleV4Router | `0x67dBeCD36c4A3ef057Ee7343A5451b53185A5DDa` | [exact match](https://repo.sourcify.dev/4663/0x67dBeCD36c4A3ef057Ee7343A5451b53185A5DDa) | [address](https://robinhoodchain.blockscout.com/address/0x67dBeCD36c4A3ef057Ee7343A5451b53185A5DDa) |
| HoodSaleV4Lens | `0xd4734d10311280cF6949Af7796466fbC63Bf7012` | [exact match](https://repo.sourcify.dev/4663/0xd4734d10311280cF6949Af7796466fbC63Bf7012) | [address](https://robinhoodchain.blockscout.com/address/0xd4734d10311280cF6949Af7796466fbC63Bf7012) |

The Sourcify column states the match level on 18 September 2026. Every token the factory
creates, for a V2 or a Uniswap v4 pool, is verified by the keeper automatically, and it submits
presale contracts as well unless `VERIFY_PRESALES=0`. A presale created from an earlier
`Presale.sol` has to be submitted with the source it was built from, which is in the git
history.

The current HoodSaleToken was deployed on 2026-09-11 (with `openingBuyBurn`, without the swap
switch and the manual swap). The earlier HOODS deployments, 0xFa00A62D38c5C4fe9BEc719c24A4D5E97D98f28e
of 2026-09-07 (`previousHoodsale`) and 0xB132C4a0fe6Fa78f494D86bb371CeBE06b91B1A0 of 2026-09-06,
and the earlier HOODSALE deployment (0xfd09EA90e92cb0438227994A0d8aC2d3f8c20DF4) are not used by
the platform.

HoodSaleV4Hook sits at a mined address. Uniswap v4 reads a hook's permissions from the low 14
bits of its address, so the hook was deployed through the canonical CREATE2 proxy
`0x4e59b44847b379578588920cA78FbF26c0B4956C` with the salt
`0x0000000000000000000000000000000000000000000000000000000000001bf0` (`v4HookSalt`), found by
`scripts/lib/hook-miner.js`. Its low 14 bits are `0x20cc`: beforeInitialize, beforeSwap,
afterSwap, beforeSwapReturnDelta and afterSwapReturnDelta, and nothing else. The v4 mode was
deployed by `scripts/deploy-v4.js`, followed by `scripts/upgrade-presale-code.js` and
`scripts/deploy-lens.js`, and the fixes of its review by `scripts/deploy-v4-fixes.js` (the
current RewardsTokenDeployerV4, RewardsTokenCodeV4, PresaleCode and HoodSaleV4Lens).

Other addresses: owner of the platform contracts (deployer)
`0xeB9845B4D1E068d5A094f1B8E408d072acA99C20`, launch keeper wallet
`0x2643E52064feDE15788DA0cE06ad378DE55caff0` (also `V4Launcher.keeper`), the HOODS sale
`0x51648C7ffE8B2fF44CB347f6Ef9D0cA5b88142d8`, Uniswap V2 Router02
`0x89e5db8b5aa49aa85ac63f691524311aeb649eba`, Uniswap V3 factory
`0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, SwapRouter02
`0xCaf681a66D020601342297493863E78C959E5cb2`, QuoterV2
`0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`. Uniswap v4 (Uniswap's own deployment): PoolManager
`0x8366a39cc670b4001a1121b8f6a443a643e40951`, PositionManager
`0x58daec3116aae6d93017baaea7749052e8a04fa7`, StateView
`0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, V4Quoter
`0x8dc178efb8111bb0973dd9d722ebeff267c98f94`, Universal Router
`0x8876789976decbfcbbbe364623c63652db8c0904`, Permit2
`0x000000000022D473030F116dDEE9F6B43aC78BA3`. The `previous*` entries in
`deployments/robinhood.json` are the contracts the current generation replaced; sales and
tokens created through them keep working with them.

## Fee schedule

Live values are read from the chain by the frontend; the contract defaults differ from
the live settings and are listed for completeness.

| Fee | Live on mainnet | Contract default | Cap | Where |
|---|---|---|---|---|
| Platform share of a completed raise | 2.5% | 10% | 20% (`MAX_FEE_BPS`) | `PresaleFactory.platformFeeBps`, copied into each sale at creation and immutable there; taken at finalize, so a cancelled or failed sale refunds 100% |
| Early exit penalty | 10% | 10% | 20% (`MAX_FEE_BPS`) | `PresaleFactory.exitPenaltyBps`, immutable per sale; paid to the Treasury |
| Presale creation fee | none | 0.1 ETH | no cap | `PresaleFactory.creationFee` |
| Quick presale creation fee | none | 0.03 ETH | no cap | `PresaleFactory.quickCreationFee` |
| Token creation fee | none | none | not present | `TokenFactory` and `V4Launcher` have no fee |
| Platform token tax on V2 pool buys and sells | 0.25% | 0.25% | 0.5% (`MAX_PLATFORM_TAX_BPS`) | `TokenFactory.platformTaxBps`, immutable in each created V2 token; paid in tokens to the Treasury |
| Total V2 token tax (platform plus owner defined) | up to 10% | | 10% (`MAX_TOTAL_TAX_BPS`) | enforced in `PlatformTaxBase` per direction |
| Platform share of a v4 pool buy or sell | 0.25% of the ETH side | | fixed (`HoodSaleV4Hook.PLATFORM_TAX_BPS`, a constant) | taken in ETH by the hook, sent to the Treasury by `flushPlatform`; `TokenFactory.setPlatformTaxBps` does not reach it |
| Total v4 tax (platform plus creator) | up to 10% of the ETH side | | 10% (`HoodSaleV4Hook.MAX_TOTAL_TAX_BPS`) | per direction; checked by `V4Launcher` at creation and on `setTaxConfig`, and by the hook when the pool is registered and on `setTaxes` |
| v4 pool LP fee | 0.05% | | fixed (`HoodSaleV4Hook.LP_FEE`) | earned by the pool's liquidity, the launch position included; the owner of a lock collects the launch position's share with `V4PositionLocker.collectFees`, a burned position's fees cannot be collected |
| Quick presale creator share of the gross raise | none | | 0 (`QuickLaunch.MAX_CREATOR_SHARE_PERCENT`); the factory cap of 10% (`MAX_CREATOR_SHARE_BPS`) is unreachable because only `QuickLaunch` may create quick sales | stored on the sale as `creatorShareBps`, always 0 for sales created by this generation |
| Quick token creator tax | at most 5% per side | | 5% (`MAX_CREATOR_TAX_BPS`) | `QuickLaunch` |
| HOODS token tax | 3% | 3% | fixed (`TAX_BPS`) | `HoodSaleToken`, split between marketing and the buyback reserve |
| Treasury buyback reserve | 30% of incoming ETH | 30% | 100% | `Treasury.buybackBps` |

Other fixed sale rules in `PresaleFactory`: liquidity at least 51% of the net raise, LP lock
at least 30 days (or burn), sale duration at most 90 days, finalize window 14 days after the
end (after it, participants can claim a full refund), quick sale length between 30 minutes
and 6 hours. These apply to v4 sales in the same way, the v4 position taking the place of the
LP tokens. On a V2 sale `Presale` rejects a finalize while the pool price deviates more than 5%
from the listing price (`MAX_POOL_DEVIATION_BPS`); a v4 launch pool cannot exist before the
launch, because only the V4Launcher can open a pool with the HoodSale hook, once per token.

## What the owner can change and what is fixed

The platform contracts use OpenZeppelin `Ownable`; the owner is a single externally owned
account (the deployer), not a multisig and not a time lock. It owns PresaleFactory,
TokenFactory, QuickLaunch, Treasury, V4Launcher and V4PositionLocker. The frontend reads every
setting below from the chain.

Changeable by the owner:

| Contract | Owner functions | Bounds |
|---|---|---|
| `PresaleFactory` | `setFees(platformFeeBps, exitPenaltyBps)`, `setCreationFee`, `setQuickCreationFee`, `setTokenAllowed` (platform tokens that are not from the factory, HOODS), `setLaunchKeeper`, `setPresaleCode`, `setQuickLaunch`, `setTreasury`, `setRouter`, `setLocker` | fees at most 20%; a change applies to sales created afterwards only. The V4Launcher accepts a launch from any contract this factory created and trusts it to name its token, so `setPresaleCode` also decides what may open a v4 pool |
| `TokenFactory` | `setPlatformTaxBps`, `setDeployers`, `setPresaleFactory`, `setTreasury`, `setRouter` | platform tax at most 0.5%; a change applies to V2 tokens created afterwards only, a v4 pool's platform share is the hook's constant. Every existing V2 token reads the presale factory address live (fee exemptions, AMM pairs, manual swap, reward exclusions and distributions); a v4 Rewards token reads it from the V4Launcher instead, where it is fixed |
| `Treasury` | `setBuybackBps`, `setRouter`, `setHoodsale`, `executeBuyback(ethAmount, amountOutMin)`, `liquidateToken`, `withdrawEth(to, amount)`, `withdrawToken` | `withdrawEth` cannot touch the buyback reserve (`reserve locked`); the reserve leaves only through `executeBuyback`, which sends what it buys to the burn address; which token it buys (`setHoodsale`, HOODS today) and the router it buys through (`setRouter`) are owner settings |
| `QuickLaunch` | `setRewardTokenAllowed`, `setRewardRoute`, `setRewardRouteV3` | routes reach an already launched token only through the permissionless `repairRewardRoute`, and only while its current route cannot pay. The stored V3 route of a reward asset is also the route a new v4 Rewards token starts on |
| `V4Launcher` | `setLens`, `setKeeper`, `setHook` | `setHook` was done once at deployment and is refused afterwards; the PresaleFactory, TokenFactory, Treasury, Uniswap contracts and locker are immutable. The keeper it names may run v4 reward distributions |
| `V4PositionLocker` | `setLauncher(launcher, allowed)` | no power over existing locks; removing the V4Launcher stops every v4 sale that locks its liquidity from launching until it is allowed again, and a sale that cannot launch within 14 days of its end turns refundable |
| `HoodSaleToken` | none since ownership was renounced on 14 September 2026 (the owner functions were `setAmmPair`, `setPresaleFactory`, `excludeFromFees`, `setMarketingWallet`, `setTreasury`, `setMarketingShareBps`) | the tax split, the wallets, the taxed pairs and the presale factory stay as they were; the 3% tax itself, the supply and the main pair are fixed; no swap switch and no manual swap; the presale factory may still call `excludeFromFees`, which it does for the HOODS sale contract |
| Token owner on a V2 pool (`StandardToken`, `TaxToken`, `RewardsToken`) | `setTaxes`, `setMarketingWallet`, `excludeFromFees`, `setAmmPair`, `manualSwapBack`, Rewards: `setRewardRoute`, `setRewardRouteV3`, `setExcludedFromRewards`, `distributeRewards`; `lock(flags)`, `renounceOwnership` | taxes within the 10% cap; `lock` is one way: `LOCK_TAXES`, `LOCK_TAX_WALLET`, `LOCK_FEE_EXEMPTIONS`, `LOCK_OWNERSHIP` (renounces, sets the other three, records `renouncedBy`); a lock survives a change of owner; the presale factory keeps `excludeFromFees` for the presale contracts it creates |
| Token owner on a v4 pool (`HoodSaleTokenV4`, `RewardsTokenV4`) | before the pool opens `V4Launcher.setTaxConfig`; afterwards on the hook `setTaxes(poolId, ...)`, `setMarketingWallet`, `lockTaxes`, `lockMarketingWallet`; Rewards: `setRewardRouteV3`, `setExcludedFromRewards`, `distributeRewards`, `distributeRewardsPartly`; `transferOwnership`, `renounceOwnership` | the creator tax plus the 0.25% platform share at most 10% per side; a holder share only on a Rewards token launched with one; a change to the pending tax after a v4 sale was created stops that sale from launching; `lockTaxes` and `lockMarketingWallet` are one way; renouncing freezes the tax, the wallet, the reward route and the reward exclusions. Distributions are also open to the platform factories and the V4Launcher keeper; the route is owner only, and the presale factory may only take its own sale contracts out of the rewards |
| `TokenMetadataRegistry` | `setPresaleFactory` (callable by the `TokenFactory` owner) | the profile and the tokenomics are written by `controllerOf(token)`: the token owner or, once renounced, `renouncedBy` (plus the quick creator through QuickLaunch for the profile) |

Fixed, no function exists to change it:

- In every V2 token the factory creates: name, symbol, decimals, total supply (no mint), the
  platform tax rate and the Treasury address, the router and the main pair, the 10% total tax
  cap, the token type and, for Rewards tokens, the reward token. There is no pause, blacklist,
  freeze or seizure function. Token owners can change their own taxes within the cap, the
  marketing wallet, fee exemptions, additional AMM pairs and (Rewards) the swap route and reward
  exemptions, or renounce ownership; with `lock` they give the tax, the wallet or the
  fee-exempt list up for good, and a Standard token counts its tax and wallet as locked from
  creation.
- In every v4 token: name, symbol, decimals, total supply (no mint), the launcher, the token
  type and, for Rewards tokens, the reward token and the addresses that never earn rewards (the
  token itself, the burn address, the launcher, the hook, the PoolManager, the PositionManager
  and the Treasury). The token has no transfer tax, no pause, blacklist, freeze or seizure
  function. In every v4 pool: the hook, the 0.25% platform share, the 10% cap, the 0.05% LP fee
  and the pool key (native ETH and the token, tick spacing 10).
- In every sale: the parameters given at creation (caps, contribution limits, rates,
  liquidity share, lock or burn, creator share), the fee and penalty rates copied from the
  factory, the router, locker and treasury addresses and, for a v4 sale, the launcher and the
  hash of the tax it was created with. Only the sale owner can finalize or
  cancel a normal sale; the launch keeper can finalize on the owner's behalf only after the
  optional launch time. Quick sales cannot be cancelled and are finalized by anyone once
  ready.
- `LiquidityLocker`, `HoodSaleLens`, `PresaleCode`, `LaunchBatch`, `HoodSaleV4Hook`,
  `HoodSaleV4Router`, `HoodSaleV4Lens`, `RewardsTokenCode`, `RewardsTokenCodeV4` and the token
  deployers have no owner and no settings.
- The buyback reserve can leave the Treasury only through `executeBuyback`, which sends what it
  buys to the burn address. The token it buys and the router are owner settings (see the
  Treasury row above).

The platform contracts are not upgradeable. A new generation is deployed next to the old one
(the `previous*` addresses) and the old one keeps serving what it created. The v4 mode was
added the same way: no V2 contract moved, and only the token deployers, the PresaleCode and the
HoodSaleLens were replaced.

## Running the tests

Node 22 or later and npm.

```bash
npm ci
npx hardhat test
```

The offline suite (506 tests at the time of writing: 435 in `test/*.test.js` and 71 in
`test/v4/*.test.js`) runs on the in-process Hardhat network. The V2 tests use `MockDex` and
`MockUniswapV3`. They cover the token types, presale lifecycle, whitelist and schedule
changes, launch time and keeper, quick presales, treasury and locker, lens, registry,
trending inputs, security cases, the verification scripts (against a mocked Sourcify
server on a random port) and the keeper loop.

The v4 tests run against Uniswap v4 itself. Hardhat compiles only the parts of `v4-core` and
`v4-periphery` the HoodSale contracts import; the PoolManager, PositionManager, StateView and
V4Quoter are deployed from the artifacts the `@uniswap/v4-core` and `@uniswap/v4-periphery`
packages ship (development dependencies, installed by `npm ci`), Uniswap's published build (the
harness checks their runtime sizes against the mainnet ones recorded in
`test/v4/fixtures/mainnet-v4.json`), and Permit2 and the CREATE2 proxy are planted at their
canonical addresses with the mainnet runtime code. They cover the hook's fee in all four
swap shapes, the payouts, who may change what, the launch and the locked position, the sale's
tax rule, the rewards token (a tokenized stock reward and a thin route included), the router,
the lens, the keeper and the launch gas. `npx hardhat test` also loads the fork suites below,
which skip themselves when `FORK_URL` is not set.

The fork suites run the platform against the real Uniswap deployments on a Robinhood Chain
mainnet fork: `test/fork/robinhood-uniswap.test.js` against Uniswap V2 and V3, and
`test/fork/v4.test.js` against Uniswap v4 (a launch opens a real pool at the listing price,
Uniswap's own Universal Router buys and sells through the hook, the V4Quoter quotes with the fee
included, the site's router pays the Treasury):

```bash
npm run test:fork      # Uniswap V2 and V3
npm run test:fork:v4   # Uniswap v4
# or, pinning the block yourself
FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK=<recent block> \
  npx hardhat test test/fork/robinhood-uniswap.test.js
```

`hardhat.config.js` enables forking only when `FORK_URL` is set. Both npm scripts fork 200
blocks behind the head unless `FORK_BLOCK` is given. The fork suites need an RPC that serves
historical state for the chosen block.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/deploy.js` | Deploys the whole platform (`DEPLOYER_KEY` in the environment, see `.env.example`) and writes `deployments/<network>.json`. |
| `scripts/deploy-hoodsale-token.js`, `deploy-quicklaunch.js`, `deploy-token-deployers.js`, `deploy-lens.js`, `deploy-registry.js`, `deploy-quick.js`, `upgrade-presale-code.js` | Deploy or replace single components of an existing deployment. |
| `scripts/deploy-v4.js` | Adds the Uniswap v4 mode to an existing deployment: V4PositionLocker, V4Launcher, the hook at its mined address (`scripts/lib/hook-miner.js`), HoodSaleV4Lens, HoodSaleV4Router, RewardsTokenCodeV4 and the V4 token deployers (`TokenFactory.setDeployers`). Nothing already deployed moves. `upgrade-presale-code.js` and `deploy-lens.js` follow it, so that new sales can finalize into a v4 pool and the lens reports `poolKind`. |
| `scripts/deploy-v4-fixes.js` | Ships the fixes of the v4 review: a new RewardsTokenCodeV4 and RewardsTokenDeployerV4, a new PresaleCode and a new HoodSaleV4Lens. The hook, the launcher, the locker and the router stay. |
| `scripts/deploy-v4-uniswap-local.js` | Puts Uniswap v4 on a local node, so the v4 mode can be tried end to end there. |
| `scripts/test-v4-launch.js` | The first mainnet v4 launch, end to end from the deployer wallet: a small Tax token, its sale, the finalize that opens the pool, a test buy through the router and the payouts. |
| `scripts/set-fees.js`, `scripts/set-launch-keeper.js` | Owner settings on the factory. |
| `scripts/seed.js` | Test data on a local network. |
| `scripts/check-deployment.js` | Reads a deployment back and checks the wiring. |
| `scripts/extract-abi.js` | Writes the ABIs the frontend imports. |
| `scripts/launch-keeper.js` | The keeper, see below. |
| `scripts/auto-verify.js`, `verify-contract.js`, `verify-platform.js`, `verify-standard-json.js`, `scripts/lib/constructorArgs.js`, `scripts/lib/sourcify.js` | Source verification on Sourcify and Blockscout, documented in `docs/VERIFY.md`. |

Private keys are passed through environment variables only (`DEPLOYER_KEY`, `KEEPER_KEY`)
and are never written to a file in this repository.

## Keeper

`scripts/launch-keeper.js` is the platform bot. It polls the factory every `POLL_SECONDS`
(default 15) and

- finalizes quick sales that are ready (any address may do this),
- finalizes normal sales whose launch time has arrived, when its wallet is the factory's
  `launchKeeper` (the only address allowed to launch on the owner's behalf), whether the sale
  lists on V2 or on v4,
- calls `distribute(100)` on finalized sales until every participant has received tokens,
- calls `QuickLaunch.distributeRewards(token, amountOutMin)` for the Rewards tokens of
  quick sales once enough rewards tax has accumulated, after quoting the swap and skipping it
  when the price impact exceeds `REWARDS_MAX_IMPACT_BPS`,
- for every finalized v4 sale of the platform's launcher, calls `HoodSaleV4Hook.flush(poolId)`
  once the pool's pending project and holder shares reach 0.005 ETH, and `flushPlatform()` once
  the platform share waiting across all pools does (any address may send both),
- calls `distributeRewards(amountOutMin)` on v4 Rewards tokens once their pending ETH reaches
  0.005 ETH and `REWARDS_INTERVAL_SECONDS` have passed, after quoting the V3 route on QuoterV2
  with the same price impact guard; when the route is too thin for everything pending it halves
  the amount (at most six times) and sends `distributeRewardsPartly(amount, amountOutMin)`. For
  this its wallet must be `V4Launcher.keeper`,
- runs the verification watcher (`scripts/auto-verify.js`) that submits every new factory
  token, V2 or v4, and every new presale to Sourcify (`AUTO_VERIFY=0` turns it off, `VERIFY_PRESALES=0`
  leaves presales out).

```bash
KEEPER_KEY=<keeper wallet private key> npm run keeper -- --network robinhood
```

The keeper cannot change any sale outcome: a keeper launch produces exactly the result an
owner launch would, and the keeper never holds user funds. On a reward distribution it sets the
swap floor and, on a v4 Rewards token, how much of the collected ETH is swapped; it cannot change
the route or who earns rewards. `keeper/` contains a systemd unit and an installation script for
running it as a service.

## Security

See `SECURITY.md`. Reports go to security@hoodsale.io. The contracts have been reviewed
internally only; there is no independent audit.

## License

The sources in this repository are licensed under the Business Source License 1.1, see
`LICENSE` (Licensor HoodSale, Change Date 2030-09-06, Change License MIT). The Solidity
files carry `SPDX-License-Identifier: BUSL-1.1`. The OpenZeppelin contracts and the Uniswap
v4 packages pulled in through npm keep their own licenses.
