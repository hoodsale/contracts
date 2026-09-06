// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {PlatformTaxBase} from "./PlatformTaxBase.sol";

/// @title TaxToken
/// @notice In addition to the platform tax, has an owner-defined buy/sell tax.
///         Taxes accumulate in the contract; on sells, once the threshold is exceeded they are
///         swapped to ETH and distributed pro rata between the marketing wallet and the Treasury.
///         Wallet-to-wallet transfers are tax-free.
///         The total tax (including platform) cannot exceed 10% per direction.
contract TaxToken is PlatformTaxBase {
    address public marketingWallet;
    uint16 public buyTaxBps; // owner tax, excluding the platform share
    uint16 public sellTaxBps;
    /// @notice Marketing tax tokens accumulated in the contract, waiting to be swapped to ETH
    uint256 public pendingMarketingTokens;

    event TaxesUpdated(uint16 buyTaxBps, uint16 sellTaxBps);
    event MarketingWalletUpdated(address wallet);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address tokenFactory_,
        address router_,
        uint16 platformTaxBps_,
        address marketingWallet_,
        uint16 buyTaxBps_,
        uint16 sellTaxBps_
    ) PlatformTaxBase(name_, symbol_, creator_, treasury_, tokenFactory_, router_, platformTaxBps_) {
        require(marketingWallet_ != address(0), "zero marketing");
        _checkTaxes(buyTaxBps_, sellTaxBps_, platformTaxBps_);
        marketingWallet = marketingWallet_;
        buyTaxBps = buyTaxBps_;
        sellTaxBps = sellTaxBps_;
        _mint(creator_, totalSupply_);
    }

    function setTaxes(uint16 buyTaxBps_, uint16 sellTaxBps_) external onlyOwner {
        _checkTaxes(buyTaxBps_, sellTaxBps_, platformTaxBps);
        buyTaxBps = buyTaxBps_;
        sellTaxBps = sellTaxBps_;
        emit TaxesUpdated(buyTaxBps_, sellTaxBps_);
    }

    function setMarketingWallet(address wallet) external onlyOwner {
        require(wallet != address(0), "zero marketing");
        marketingWallet = wallet;
        emit MarketingWalletUpdated(wallet);
    }

    function _checkTaxes(uint16 buy_, uint16 sell_, uint16 platform_) private pure {
        if (buy_ + platform_ > MAX_TOTAL_TAX_BPS || sell_ + platform_ > MAX_TOTAL_TAX_BPS) {
            revert TaxTooHigh();
        }
    }

    function _takeFees(address from, address to, uint256 value) internal override returns (uint256) {
        uint256 fees = super._takeFees(from, to, value); // platform share accumulates in the contract
        uint16 taxBps = isAmmPair[from] ? buyTaxBps : (isAmmPair[to] ? sellTaxBps : 0);
        uint256 creatorFee = (value * taxBps) / BPS;
        if (creatorFee > 0) {
            _rawTransfer(from, address(this), creatorFee);
            pendingMarketingTokens += creatorFee;
        }
        return fees + creatorFee;
    }

    function _pendingSellTokens() internal view override returns (uint256) {
        return pendingPlatformTokens + pendingMarketingTokens;
    }

    function _swapBack() internal override inSwapFlag {
        uint256 platformPortion = pendingPlatformTokens;
        uint256 marketingPortion = pendingMarketingTokens;
        uint256 total = platformPortion + marketingPortion;
        if (total == 0) return;

        (uint256 ethGained, bool ok) = _swapTokensForEth(total);
        if (!ok) return;
        pendingPlatformTokens = 0;
        pendingMarketingTokens = 0;

        uint256 marketingEth = (ethGained * marketingPortion) / total;
        uint256 platformEth = ethGained - marketingEth;
        _sendEth(platformTreasury, platformEth);
        _sendEth(marketingWallet, marketingEth);
        emit SwapBack(total, ethGained);
    }
}
