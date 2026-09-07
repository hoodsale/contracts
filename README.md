# HoodSale contracts

Solidity sources, tests and operational scripts of HoodSale, a presale launchpad on
Robinhood Chain (Arbitrum Orbit L2, chainId 4663, gas token ETH). The frontend at
https://hoodsale.io reads everything it shows from these contracts.

Solidity 0.8.26, OpenZeppelin Contracts v5, Hardhat. `SPEC.md` is the functional
specification the contracts implement; `docs/VERIFY.md` describes source verification.

## What the contracts do

| Source | Role |
|---|---|
| `contracts/TokenFactory.sol` | Creates the three token types through three deployer contracts (`StandardTokenDeployer`, `TaxTokenDeployer`, `RewardsTokenDeployer`, the last one deploying from the creation code held by `contracts/tokens/RewardsTokenCode.sol`) and keeps the registry of platform tokens (`isPlatformToken`, `infoOf`, `allTokens`). Creation is free apart from gas. |
| `contracts/tokens/PlatformTaxBase.sol` | Shared base of the created tokens: fixed supply minted to the creator, 18 decimals, a platform tax on pool buys and sells paid in tokens to the Treasury, a hard cap of 10% on the total tax (`MAX_TOTAL_TAX_BPS`), AMM pair and fee exemption management, and the one-way owner locks (`lock`: taxes, tax wallet, fee exemptions, ownership; `renouncedBy`). No mint, pause, blacklist or freeze function. |
| `contracts/tokens/StandardToken.sol` | Platform tax only. |
| `contracts/tokens/TaxToken.sol` | Platform tax plus an owner defined buy and sell tax swapped to ETH and sent to a marketing wallet. |
| `contracts/tokens/RewardsToken.sol` | Platform tax plus a rewards tax distributed to holders in a chosen reward token (WETH, USDG or a tokenized stock) and an optional marketing tax. The reward swap runs on Uniswap V2 from the token's own pool, optionally followed by a Uniswap V3 path (`setRewardRoute`, `setRewardRouteV3`). |
| `contracts/PresaleFactory.sol` | Creates a `Presale` for a factory token (or an allowlisted platform token) with the fees it is set to, keeps the presale registry, the launch keeper address and the `QuickLaunch` address. |
| `contracts/PresaleCode.sol` | Holds the creation code of `Presale`; the factory deploys sales from it with CREATE so that the factory stays under the contract size limit. |
| `contracts/Presale.sol` | One sale: contribute, early exit with a penalty, cancel, refund on a missed soft cap or a missed finalize window, finalize (platform share, liquidity on the DEX, LP lock or burn, owner payout), claim, permissionless token delivery (`distribute`), whitelist mode, schedule changes before the start, an optional launch time the keeper acts on, an on-chain participant list and activity log. |
| `contracts/QuickLaunch.sol` | A token and a sale in one transaction with fixed rules (supply 1,000,000,000, 50% sold, soft cap a quarter of the hard cap, per wallet maximum 2% of the hard cap, LP burned, automatic launch at the hard cap or at the end, ownership renounced for Standard and Tax tokens). Keeps the reward token allowlist and the reward swap routes, and is the only caller of `PresaleFactory.createQuickPresale`. |
| `contracts/Treasury.sol` | Receives all platform revenue. 30% of every incoming ETH (`buybackBps`) is set aside as the buyback reserve, which can only be spent on buying HOODS on the DEX and burning it (`executeBuyback`). Token revenue can be sold for ETH (`liquidateToken`) and falls under the same rule. |
| `contracts/LiquidityLocker.sol` | Locks LP tokens (or any ERC-20) until an unlock time. No owner. A lock can be extended or transferred, never shortened. |
| `contracts/HoodSaleLens.sol` | Read-only batched views for the frontend: sale lists, participants, activity, launch performance, trending inputs. |
| `contracts/TokenMetadataRegistry.sol` | On-chain token profiles (logo, cover, description, links) and tokenomics slices, writable by the token owner or the creator of a quick sale. |
| `contracts/HoodSaleToken.sol` | HOODS, the platform token: 100,000,000 supply, 3% tax on pool buys and sells, split between the marketing wallet and the Treasury buyback reserve. |
| `contracts/interfaces/` | The Uniswap V2 and V3 surface the contracts use. |
| `contracts/test/` | `MockDex` (Uniswap V2 look-alike) and `MockUniswapV3` used by the offline tests. |

The keeper (`scripts/launch-keeper.js`) is the off-chain part: it launches scheduled and
quick sales, delivers tokens, distributes rewards of quick Rewards tokens and verifies
every new factory token on Sourcify. See "Keeper" below.

## Mainnet deployment

Robinhood Chain mainnet, chainId 4663. Addresses are also in `deployments/robinhood.json`.
Sourcify links have the form `https://repo.sourcify.dev/4663/<address>`, Blockscout links
`https://robinhoodchain.blockscout.com/address/<address>`.

| Contract | Address | Sourcify | Blockscout |
|---|---|---|---|
| PresaleFactory | `0x8dcC19e98713C2EC024dd337Edea18BEBC490942` | [exact match](https://repo.sourcify.dev/4663/0x8dcC19e98713C2EC024dd337Edea18BEBC490942) | [address](https://robinhoodchain.blockscout.com/address/0x8dcC19e98713C2EC024dd337Edea18BEBC490942) |
| PresaleCode | `0xADe97b179f1dC0776452BC6BBb83A27447A17C14` | [repository](https://repo.sourcify.dev/4663/0xADe97b179f1dC0776452BC6BBb83A27447A17C14) | [address](https://robinhoodchain.blockscout.com/address/0xADe97b179f1dC0776452BC6BBb83A27447A17C14) |
| QuickLaunch | `0x560576D986df033158f185167E8cdabE0Cf871fD` | [exact match](https://repo.sourcify.dev/4663/0x560576D986df033158f185167E8cdabE0Cf871fD) | [address](https://robinhoodchain.blockscout.com/address/0x560576D986df033158f185167E8cdabE0Cf871fD) |
| TokenFactory | `0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf` | [match](https://repo.sourcify.dev/4663/0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf) | [address](https://robinhoodchain.blockscout.com/address/0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf) |
| RewardsTokenDeployer | `0x06286D7e4187cD1D720aC463bd6F00Eb6b93C1fD` | [exact match](https://repo.sourcify.dev/4663/0x06286D7e4187cD1D720aC463bd6F00Eb6b93C1fD) | [address](https://robinhoodchain.blockscout.com/address/0x06286D7e4187cD1D720aC463bd6F00Eb6b93C1fD) |
| Treasury | `0x52C4fa5E853e556000429763A50cd9A0cdA971e7` | [exact match](https://repo.sourcify.dev/4663/0x52C4fa5E853e556000429763A50cd9A0cdA971e7) | [address](https://robinhoodchain.blockscout.com/address/0x52C4fa5E853e556000429763A50cd9A0cdA971e7) |
| LiquidityLocker | `0xfF7E28d54f1927565Ab02781b635178b9b2683B7` | [exact match](https://repo.sourcify.dev/4663/0xfF7E28d54f1927565Ab02781b635178b9b2683B7) | [address](https://robinhoodchain.blockscout.com/address/0xfF7E28d54f1927565Ab02781b635178b9b2683B7) |
| HoodSaleToken (HOODS) | `0xB132C4a0fe6Fa78f494D86bb371CeBE06b91B1A0` | [repository](https://repo.sourcify.dev/4663/0xB132C4a0fe6Fa78f494D86bb371CeBE06b91B1A0) | [address](https://robinhoodchain.blockscout.com/address/0xB132C4a0fe6Fa78f494D86bb371CeBE06b91B1A0) |
| HoodSaleLens | `0xD0a952c8AdDd963075D0E1e0e7c2499f8ee1179d` | [repository](https://repo.sourcify.dev/4663/0xD0a952c8AdDd963075D0E1e0e7c2499f8ee1179d) | [address](https://robinhoodchain.blockscout.com/address/0xD0a952c8AdDd963075D0E1e0e7c2499f8ee1179d) |
| TokenMetadataRegistry | `0x29F2BAAA2d0c1858653332C0CA5F9ae1586843e0` | [repository](https://repo.sourcify.dev/4663/0x29F2BAAA2d0c1858653332C0CA5F9ae1586843e0) | [address](https://robinhoodchain.blockscout.com/address/0x29F2BAAA2d0c1858653332C0CA5F9ae1586843e0) |

The Sourcify column states the match level at the time of writing for the contracts that
have been verified; "repository" links to the Sourcify entry without a claim. Every token the
factory creates is verified by the keeper automatically; presale contracts are verified by
the keeper as well unless `VERIFY_PRESALES=0`.
HoodSaleToken was redeployed with the HOODS ticker on 2026-09-06; the earlier HOODSALE deployment (0xfd09EA90e92cb0438227994A0d8aC2d3f8c20DF4) is not used by the platform.

Other addresses: owner of the platform contracts (deployer)
`0xeB9845B4D1E068d5A094f1B8E408d072acA99C20`, launch keeper wallet
`0x2643E52064feDE15788DA0cE06ad378DE55caff0`, Uniswap V2 Router02
`0x89e5db8b5aa49aa85ac63f691524311aeb649eba`, Uniswap V3 factory
`0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, SwapRouter02
`0xCaf681a66D020601342297493863E78C959E5cb2`, QuoterV2
`0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`. The `previous*` entries in
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
| Token creation fee | none | none | not present | `TokenFactory` has no fee |
| Platform token tax on pool buys and sells | 0.25% | 0.25% | 0.5% (`MAX_PLATFORM_TAX_BPS`) | `TokenFactory.platformTaxBps`, immutable in each created token; paid in tokens to the Treasury |
| Total token tax (platform plus owner defined) | up to 10% | | 10% (`MAX_TOTAL_TAX_BPS`) | enforced in `PlatformTaxBase` per direction |
| Quick presale creator share of the gross raise | none | | 0 (`QuickLaunch.MAX_CREATOR_SHARE_PERCENT`); the factory cap of 10% (`MAX_CREATOR_SHARE_BPS`) is unreachable because only `QuickLaunch` may create quick sales | stored on the sale as `creatorShareBps`, always 0 for sales created by this generation |
| Quick token creator tax | at most 5% per side | | 5% (`MAX_CREATOR_TAX_BPS`) | `QuickLaunch` |
| HOODS token tax | 3% | 3% | fixed (`TAX_BPS`) | `HoodSaleToken`, split between marketing and the buyback reserve |
| Treasury buyback reserve | 30% of incoming ETH | 30% | 100% | `Treasury.buybackBps` |

Other fixed sale rules in `PresaleFactory`: liquidity at least 51% of the net raise, LP lock
at least 30 days (or burn), sale duration at most 90 days, finalize window 14 days after the
end (after it, participants can claim a full refund), quick sale length between 30 minutes
and 6 hours. `Presale` rejects a finalize while the pool price deviates more than 5% from the
listing price (`MAX_POOL_DEVIATION_BPS`).

## What the owner can change and what is fixed

The platform contracts use OpenZeppelin `Ownable`; the owner is a single externally owned
account (the deployer). The frontend reads every setting below from the chain.

Changeable by the owner:

| Contract | Owner functions | Bounds |
|---|---|---|
| `PresaleFactory` | `setFees(platformFeeBps, exitPenaltyBps)`, `setCreationFee`, `setQuickCreationFee`, `setTokenAllowed` (platform tokens that are not from the factory, HOODS), `setLaunchKeeper`, `setPresaleCode`, `setQuickLaunch`, `setTreasury`, `setRouter`, `setLocker` | fees at most 20%; a change applies to sales created afterwards only |
| `TokenFactory` | `setPlatformTaxBps`, `setDeployers`, `setPresaleFactory`, `setTreasury`, `setRouter` | platform tax at most 0.5%; a change applies to tokens created afterwards only |
| `Treasury` | `setBuybackBps`, `setRouter`, `setHoodsale`, `executeBuyback(ethAmount, amountOutMin)`, `liquidateToken`, `withdrawEth(to, amount)`, `withdrawToken` | `withdrawEth` cannot touch the buyback reserve (`reserve locked`); the reserve leaves only through `executeBuyback`, which burns the HOODS it buys |
| `QuickLaunch` | `setRewardTokenAllowed`, `setRewardRoute`, `setRewardRouteV3` | routes reach an already launched token only through the permissionless `repairRewardRoute`, and only while its current route cannot pay |
| `HoodSaleToken` | `setAmmPair`, `setPresaleFactory`, `excludeFromFees`, `setMarketingWallet`, `setTreasury`, `setMarketingShareBps` | the 3% tax itself, the supply and the main pair are fixed; `setAmmPair` cannot remove the main pair; no swap switch and no manual swap; the presale factory may call `excludeFromFees` for the HOODS sale contract |
| Token owner (`StandardToken`, `TaxToken`, `RewardsToken`) | `setTaxes`, `setMarketingWallet`, `excludeFromFees`, `setAmmPair`, `manualSwapBack`, Rewards: `setRewardRoute`, `setRewardRouteV3`, `setExcludedFromRewards`, `distributeRewards`; `lock(flags)`, `renounceOwnership` | taxes within the 10% cap; `lock` is one way: `LOCK_TAXES`, `LOCK_TAX_WALLET`, `LOCK_FEE_EXEMPTIONS`, `LOCK_OWNERSHIP` (renounces, sets the other three, records `renouncedBy`); a lock survives a change of owner; the presale factory keeps `excludeFromFees` for the presale contracts it creates |
| `TokenMetadataRegistry` | `setPresaleFactory` (callable by the `TokenFactory` owner) | the profile and the tokenomics are written by `controllerOf(token)`: the token owner or, once renounced, `renouncedBy` (plus the quick creator through QuickLaunch for the profile) |

Fixed, no function exists to change it:

- In every created token: name, symbol, decimals, total supply (no mint), the platform tax
  rate and the Treasury address, the router and the main pair, the 10% total tax cap, the
  token type and, for Rewards tokens, the reward token. There is no pause, blacklist, freeze
  or seizure function. Token owners can change their own taxes within the cap, the marketing
  wallet, fee exemptions, additional AMM pairs and (Rewards) the swap route and reward
  exemptions, or renounce ownership; with `lock` they give the tax, the wallet or the
  fee-exempt list up for good, and a Standard token counts its tax and wallet as locked from
  creation.
- In every sale: the parameters given at creation (caps, contribution limits, rates,
  liquidity share, lock or burn, creator share), the fee and penalty rates copied from the
  factory, the router, locker and treasury addresses. Only the sale owner can finalize or
  cancel a normal sale; the launch keeper can finalize on the owner's behalf only after the
  optional launch time. Quick sales cannot be cancelled and are finalized by anyone once
  ready.
- `LiquidityLocker`, `HoodSaleLens` and `PresaleCode` have no owner and no settings.
- The Treasury cannot spend the buyback reserve on anything other than buying and burning
  HOODS.

The platform contracts are not upgradeable. A new generation is deployed next to the old one
(the `previous*` addresses) and the old one keeps serving what it created.

## Running the tests

Node 22 or later and npm.

```bash
npm ci
npx hardhat test
```

The offline suite (376 tests) runs on the in-process Hardhat network with `MockDex` and
`MockUniswapV3`. It covers the token types, presale lifecycle, whitelist and schedule
changes, launch time and keeper, quick presales, treasury and locker, lens, registry,
trending inputs, security cases, the verification scripts (against a mocked Sourcify
server on a random port) and the keeper loop.

The fork suite runs the same platform against the real Uniswap V2 and V3 deployments on a
Robinhood Chain mainnet fork:

```bash
npm run test:fork
# or, pinning the block yourself
FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK=<recent block> \
  npx hardhat test test/fork/robinhood-uniswap.test.js
```

`hardhat.config.js` enables forking only when `FORK_URL` is set. The fork suite needs an RPC
that serves historical state for the chosen block.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/deploy.js` | Deploys the whole platform (`DEPLOYER_KEY` in the environment, see `.env.example`) and writes `deployments/<network>.json`. |
| `scripts/deploy-hoodsale-token.js`, `deploy-quicklaunch.js`, `deploy-token-deployers.js`, `deploy-lens.js`, `deploy-registry.js`, `deploy-quick.js` | Deploy or replace single components of an existing deployment. |
| `scripts/set-fees.js`, `scripts/set-launch-keeper.js` | Owner settings on the factory. |
| `scripts/seed.js` | Test data on a local network. |
| `scripts/check-deployment.js` | Reads a deployment back and checks the wiring. |
| `scripts/extract-abi.js` | Writes the ABIs the frontend imports. |
| `scripts/launch-keeper.js` | The keeper, see below. |
| `scripts/auto-verify.js`, `verify-contract.js`, `verify-platform.js`, `verify-standard-json.js`, `scripts/lib/` | Source verification on Sourcify and Blockscout, documented in `docs/VERIFY.md`. |

Private keys are passed through environment variables only (`DEPLOYER_KEY`, `KEEPER_KEY`)
and are never written to a file in this repository.

## Keeper

`scripts/launch-keeper.js` is the platform bot. It polls the factory every `POLL_SECONDS`
(default 15) and

- finalizes quick sales that are ready (any address may do this),
- finalizes normal sales whose launch time has arrived, when its wallet is the factory's
  `launchKeeper` (the only address allowed to launch on the owner's behalf),
- calls `distribute(100)` on finalized sales until every participant has received tokens,
- calls `QuickLaunch.distributeRewards(token, amountOutMin)` for the Rewards tokens of
  quick sales once enough rewards tax has accumulated, after quoting the swap and skipping it
  when the price impact exceeds `REWARDS_MAX_IMPACT_BPS`,
- runs the verification watcher (`scripts/auto-verify.js`) that submits every new factory
  token to Sourcify (`AUTO_VERIFY=0` turns it off, `VERIFY_PRESALES=1` includes presales).

```bash
KEEPER_KEY=<keeper wallet private key> npm run keeper -- --network robinhood
```

The keeper cannot change any sale outcome: a keeper launch produces exactly the result an
owner launch would, and the keeper never holds user funds. `keeper/` contains a systemd
unit and an installation script for running it as a service.

## Security

See `SECURITY.md`. Reports go to security@hoodsale.io.

## License

The sources in this repository are licensed under the Business Source License 1.1, see
`LICENSE` (Licensor HoodSale, Change Date 2030-09-06, Change License MIT). The Solidity
files carry `SPDX-License-Identifier: BUSL-1.1`. The OpenZeppelin contracts pulled in
through npm keep their own MIT license.
