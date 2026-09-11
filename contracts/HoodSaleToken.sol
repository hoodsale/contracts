// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IUniswapV2Router02, IUniswapV2Factory, IUniswapV2Pair} from "./interfaces/IUniswapV2.sol";

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
///         The swap has no switch and no manual trigger. Next to the owner, only the platform
///         presale factory may act on this token, and only to exempt the HOODS sale contract
///         from the tax so that the listing at launch is untaxed; the tax rate itself is a
///         constant.
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
    /// @notice Block in which the pool first received tokens, which is the listing transfer
    ///         inside Presale.finalize. 0 until then. Packed with inSwap and presaleFactory,
    ///         so _update reads it without paying for another storage slot.
    uint64 public poolOpenedBlock;
    /// @notice One-shot latch for openingBuyBurn.
    bool public openingDone;

    mapping(address => bool) public isAmmPair;
    mapping(address => bool) public isExcludedFromFees;

    event AmmPairSet(address indexed pair, bool value);
    event ExcludedFromFees(address indexed account, bool value);
    event SwapBack(uint256 tokensSwapped, uint256 ethReceived, uint256 marketingEth, uint256 buybackEth);
    event MarketingShareUpdated(uint16 bps);
    event PresaleFactorySet(address factory);
    event OpeningBuyBurn(uint256 ethSpent, uint256 tokensBurned);

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

    /// @notice Exempts a wallet or contract from the tax, or removes an exemption. The presale
    ///         factory uses it for the HOODS sale contract when the sale is created.
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

        // Arms the opening buy. The first time tokens ever move INTO the main pair is the
        // listing transfer inside Presale.finalize -> router.addLiquidityETH, which lands
        // before pair.mint() and therefore before any trade against the pool is possible.
        // Two comparisons and, once ever, one write into a slot that is already loaded.
        // Nothing here can revert.
        if (poolOpenedBlock == 0 && to == mainPair && value > 0) {
            poolOpenedBlock = uint64(block.number);
        }

        bool excluded = isExcludedFromFees[from] || isExcludedFromFees[to];

        // On a sell, if the accumulated amount exceeds the threshold, swap-back runs first
        if (!inSwap && !excluded && isAmmPair[to]) {
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

    // --------------------------------------------- opening buy and burn (one shot, listing block)

    /// @notice Ceiling on the opening buy, as a share of the pool's ETH reserve read at the
    ///         moment it runs: 15_000 is 150% of that reserve. The point of tying it to the
    ///         reserve rather than to a fixed amount is that it scales with whatever the sale
    ///         actually raised, so a small raise cannot be overpaid into. A compile-time
    ///         constant; nobody, the owner included, can change it.
    uint256 private constant OPEN_MAX_RESERVE_BPS = 15_000;
    address private constant DEAD_ADDR = 0x000000000000000000000000000000000000dEaD;

    /// @notice Spends the ETH sent WITH THIS CALL buying HOODS from the pool and burns every
    ///         token it buys. Permissionless, once, and only in the same block as the listing,
    ///         so the only transaction that can reach it is the one that opened the pool.
    ///         Whatever is not spent goes back to the caller, so the contract never holds a
    ///         balance: there is no pot for anyone to spend later and nothing to strand.
    /// @dev    An ordinary external call, never reached from inside a transfer, so it is allowed
    ///         to revert. A revert rolls back the launch transaction and the sale stays
    ///         finalizable, which is why no failure here can quietly consume the shot. The pair
    ///         is unlocked at this point because addLiquidityETH's pair.mint() returned before
    ///         Presale.finalize() returned.
    function openingBuyBurn() external payable returns (uint256 spent, uint256 burned) {
        require(!openingDone, "opening done");
        require(poolOpenedBlock == block.number, "not the listing block");
        openingDone = true;

        (uint256 rEth, uint256 rTok) = _mainReserves();
        require(rEth > 0 && rTok > 0, "no reserves");

        uint256 cap = (rEth * OPEN_MAX_RESERVE_BPS) / BPS;
        spent = msg.value < cap ? msg.value : cap;
        require(spent > 0, "nothing to spend");

        // UniswapV2Pair.swap refuses to pay out to either of its own tokens, so this contract
        // can never receive its own buy. The purchase goes to the burn address, which the
        // constructor exempts from the tax, and is destroyed from there: a real totalSupply
        // reduction rather than tokens parked in a dead wallet.
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(this);

        uint256 expected = (spent * 997 * rTok) / (rEth * 1000 + spent * 997);
        uint256 before = balanceOf(DEAD_ADDR);
        router.swapExactETHForTokens{value: spent}(
            (expected * 9_900) / BPS, path, DEAD_ADDR, block.timestamp
        );
        burned = balanceOf(DEAD_ADDR) - before;
        require(burned > 0, "bought nothing");
        _burn(DEAD_ADDR, burned);

        uint256 refund = msg.value - spent;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
        emit OpeningBuyBurn(spent, burned);
    }

    function _mainReserves() private view returns (uint256 rEth, uint256 rTok) {
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(mainPair).getReserves();
        return IUniswapV2Pair(mainPair).token0() == address(this)
            ? (uint256(r1), uint256(r0))
            : (uint256(r0), uint256(r1));
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
