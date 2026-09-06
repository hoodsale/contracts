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

The Solidity sources in `contracts/` and the deployed instances on Robinhood Chain
(chainId 4663) listed in `deployments/robinhood.json` and in `README.md`:

| Contract | Address |
|---|---|
| PresaleFactory | 0x8dcC19e98713C2EC024dd337Edea18BEBC490942 |
| PresaleCode | 0xADe97b179f1dC0776452BC6BBb83A27447A17C14 |
| QuickLaunch | 0xa6aCfa20DC3165e36AdB02BCF1C178C151ed751f |
| TokenFactory | 0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf |
| RewardsTokenDeployer | 0x06286D7e4187cD1D720aC463bd6F00Eb6b93C1fD |
| Treasury | 0x52C4fa5E853e556000429763A50cd9A0cdA971e7 |
| LiquidityLocker | 0xfF7E28d54f1927565Ab02781b635178b9b2683B7 |
| HoodSaleToken (HOODS) | 0xB132C4a0fe6Fa78f494D86bb371CeBE06b91B1A0 |
| HoodSaleLens | 0xD0a952c8AdDd963075D0E1e0e7c2499f8ee1179d |
| TokenMetadataRegistry | 0x29F2BAAA2d0c1858653332C0CA5F9ae1586843e0 |

Also in scope: every Presale the factory creates and every StandardToken, TaxToken and
RewardsToken the token factory creates from these sources, and the keeper scripts in
`scripts/` when a flaw in them puts user funds at risk.

Out of scope: the hoodsale.io website and its hosting, third party contracts the platform
calls (the Uniswap V2 and V3 deployments on Robinhood Chain, the tokenized stock contracts,
WETH), wallets, RPC providers, and issues that need a compromised owner or keeper key.

## Bug bounty

There is no paid bug bounty at the moment. Valid reports are credited in the release notes
if the reporter wants that.

## Deployed versions

The deployed contracts are verified on Sourcify (https://repo.sourcify.dev/4663/<address>).
A report should say which address it refers to when the deployed bytecode and the sources
in this repository differ.
