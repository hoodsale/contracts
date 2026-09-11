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
| QuickLaunch | 0xAFE71e8F922e740087af9d56091913022e3f76Fc |
| TokenFactory | 0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf |
| StandardTokenDeployer | 0x4b2c825EA2d159707DE11cBF58373151bF7f0DDA |
| TaxTokenDeployer | 0x6cf85c050c2C0eC7266e12a95258E921Ca3F34f8 |
| RewardsTokenDeployer | 0x73DA50C43AbAbb486d6cc4d94ac65D3396F1b84a |
| RewardsTokenCode | 0xDC7ec9F5AA960418CcfA5042fc0AF1d2488CAbb9 |
| Treasury | 0x52C4fa5E853e556000429763A50cd9A0cdA971e7 |
| LiquidityLocker | 0xfF7E28d54f1927565Ab02781b635178b9b2683B7 |
| HoodSaleToken (HOODS) | 0x48874aD21dbD7512C0EdC123232898C6eCf34D7E |
| HoodSaleLens | 0xD0a952c8AdDd963075D0E1e0e7c2499f8ee1179d |
| TokenMetadataRegistry | 0x10A6B866EE01407C09a61C709d10AcFd93a8dCA6 |

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
