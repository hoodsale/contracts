// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IUniswapV2Router02, IUniswapV2Factory} from "./interfaces/IUniswapV2.sol";

interface ITreasuryBuyback {
    function depositBuyback() external payable;
}

/// @title HOODS, the HoodSale platform token
/// @notice Fixed supply of 100M. A 3% marketing & buyback tax on buys and sells;
///         wallet-to-wallet transfers are TAX-FREE, and the tax is not distributed
///         at the moment it is taken: it accumulates in the contract as tokens, and on
///         sells, once the accumulated amount exceeds swapThreshold (1/1000 of supply),
///         it is automatically swapped to ETH and split: half to the marketing wallet,
///         half to the Treasury's buyback reserve (the ratio is adjustable by the owner).
contract HoodSaleToken is ERC20, ERC20Burnable, Ownable {
    uint256 public constant BPS = 10_000;
    uint256 public constant TOTAL_SUPPLY = 100_000_000e18;
    /// @notice Buy and sell tax: 3% (fixed, cannot be increased)
    uint16 public constant TAX_BPS = 300;

    IUniswapV2Router02 public immutable router;
    address public immutable mainPair;
    address payable public treasury;
    address payable public marketingWallet;
    /// @notice The platform presale factory; it may call excludeFromFees so that the
    ///         sale contract can be exempted from the tax during the HOODS presale.
    address public presaleFactory;
    /// @notice Marketing share of the ETH after a swap (the remainder goes to the buyback reserve)
    uint16 public marketingShareBps = 5_000;

    bool private inSwap;
    bool public swapEnabled = true;

    mapping(address => bool) public isAmmPair;
    mapping(address => bool) public isExcludedFromFees;

    event AmmPairSet(address indexed pair, bool value);
    event ExcludedFromFees(address indexed account, bool value);
    event SwapBack(uint256 tokensSwapped, uint256 ethReceived, uint256 marketingEth, uint256 buybackEth);
    event MarketingShareUpdated(uint16 bps);
    event PresaleFactorySet(address factory);

    modifier inSwapFlag() {
        inSwap = true;
        _;
        inSwap = false;
    }

    constructor(
        address owner_,
        address router_,
        address payable treasury_,
        address payable marketingWallet_
    ) ERC20("HoodSale", "HOODS") Ownable(owner_) {
        require(router_ != address(0) && treasury_ != address(0) && marketingWallet_ != address(0), "zero addr");
        router = IUniswapV2Router02(router_);
        treasury = treasury_;
        marketingWallet = marketingWallet_;

        address factory_ = IUniswapV2Router02(router_).factory();
        address weth_ = IUniswapV2Router02(router_).WETH();
        address pair = IUniswapV2Factory(factory_).getPair(address(this), weth_);
        if (pair == address(0)) {
            pair = IUniswapV2Factory(factory_).createPair(address(this), weth_);
        }
        mainPair = pair;
        isAmmPair[pair] = true;

        isExcludedFromFees[owner_] = true;
        isExcludedFromFees[address(this)] = true;
        isExcludedFromFees[treasury_] = true;
        // Buyback burns should be tax-free
        isExcludedFromFees[0x000000000000000000000000000000000000dEaD] = true;

        _mint(owner_, TOTAL_SUPPLY);
    }

    receive() external payable {}

    // ------------------------------------------------------------- admin

    function setAmmPair(address pair, bool value) external onlyOwner {
        require(pair != mainPair || value, "main pair locked");
        isAmmPair[pair] = value;
        emit AmmPairSet(pair, value);
    }

    function setPresaleFactory(address factory_) external onlyOwner {
        presaleFactory = factory_;
        emit PresaleFactorySet(factory_);
    }

    function excludeFromFees(address account, bool value) external {
        require(msg.sender == owner() || msg.sender == presaleFactory, "not authorized");
        isExcludedFromFees[account] = value;
        emit ExcludedFromFees(account, value);
    }

    function setMarketingWallet(address payable wallet) external onlyOwner {
        require(wallet != address(0), "zero addr");
        marketingWallet = wallet;
    }

    function setTreasury(address payable treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero addr");
        treasury = treasury_;
    }

    function setMarketingShareBps(uint16 bps) external onlyOwner {
        require(bps <= BPS, "bps too high");
        marketingShareBps = bps;
        emit MarketingShareUpdated(bps);
    }

    function setSwapEnabled(bool enabled) external onlyOwner {
        swapEnabled = enabled;
    }

    function manualSwapBack() external onlyOwner {
        require(!inSwap, "in swap");
        _swapBack();
    }

    // ------------------------------------------------------------ taxes

    /// @notice Automatic swap threshold: 1/1000 of total supply
    function swapThreshold() public view returns (uint256) {
        return totalSupply() / 1_000;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        bool excluded = isExcludedFromFees[from] || isExcludedFromFees[to];

        // On a sell, if the accumulated amount exceeds the threshold, swap-back runs first
        if (!inSwap && swapEnabled && !excluded && isAmmPair[to]) {
            if (balanceOf(address(this)) >= swapThreshold()) {
                _swapBack();
            }
        }

        // Tax only on AMM buys/sells; 0 on transfers
        if (!inSwap && !excluded && (isAmmPair[from] || isAmmPair[to])) {
            uint256 fee = (value * TAX_BPS) / BPS;
            if (fee > 0) {
                super._update(from, address(this), fee);
                value -= fee;
            }
        }

        super._update(from, to, value);
    }

    function _swapBack() internal inSwapFlag {
        uint256 amount = balanceOf(address(this));
        if (amount == 0) return;

        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = router.WETH();

        uint256 ethBefore = address(this).balance;
        _approve(address(this), address(router), amount);
        try
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(
                amount,
                0,
                path,
                address(this),
                block.timestamp
            )
        {} catch {
            return;
        }
        uint256 ethGained = address(this).balance - ethBefore;
        if (ethGained == 0) return;

        uint256 marketingEth = (ethGained * marketingShareBps) / BPS;
        uint256 buybackEth = ethGained - marketingEth;

        if (marketingEth > 0) {
            (bool ok1, ) = marketingWallet.call{value: marketingEth}("");
            ok1; // a failure does not block the transfer
        }
        if (buybackEth > 0) {
            try ITreasuryBuyback(treasury).depositBuyback{value: buybackEth}() {} catch {}
        }
        emit SwapBack(amount, ethGained, marketingEth, buybackEth);
    }
}
