// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IUniswapV2Router02, IUniswapV2Factory} from "../interfaces/IUniswapV2.sol";

interface ITokenFactoryView {
    function presaleFactory() external view returns (address);
}

/// @title PlatformTaxBase
/// @notice Common base of all HoodSale platform tokens.
///         Tax model:
///         - Tax is charged only on AMM buys and sells; wallet-to-wallet transfers are TAX-FREE.
///         - Taxes are not distributed immediately: they accumulate in the contract as tokens.
///         - During a SELL, if the accumulation exceeds swapThreshold (1/1000 of supply),
///           the contract swaps the accumulation to ETH on the DEX and distributes it (platform share to Treasury).
///         - If the swap fails, the transfer is not blocked (try/catch).
abstract contract PlatformTaxBase is ERC20, Ownable {
    uint256 public constant BPS = 10_000;
    /// @notice Total tax cap per direction (buy or sell), 10% including the platform share
    uint256 public constant MAX_TOTAL_TAX_BPS = 1_000;

    address public immutable platformTreasury;
    address public immutable tokenFactory;
    IUniswapV2Router02 public immutable router;
    /// @notice Main liquidity pair (token/WETH), created at deployment
    address public immutable mainPair;
    /// @notice Platform tax (bps) sent to the Treasury on every buy and sell
    uint16 public immutable platformTaxBps;

    bool internal inSwap;
    /// @notice Platform tax tokens accumulated in the contract, waiting to be swapped to ETH
    uint256 public pendingPlatformTokens;

    mapping(address => bool) public isAmmPair;
    mapping(address => bool) public isExcludedFromFees;

    event AmmPairSet(address indexed pair, bool value);
    event ExcludedFromFees(address indexed account, bool value);
    event SwapBack(uint256 tokensSwapped, uint256 ethReceived);

    error NotAuthorized();
    error TaxTooHigh();

    modifier inSwapFlag() {
        inSwap = true;
        _;
        inSwap = false;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address creator_,
        address treasury_,
        address tokenFactory_,
        address router_,
        uint16 platformTaxBps_
    ) ERC20(name_, symbol_) Ownable(creator_) {
        require(treasury_ != address(0) && router_ != address(0), "zero addr");
        platformTreasury = treasury_;
        tokenFactory = tokenFactory_;
        router = IUniswapV2Router02(router_);
        platformTaxBps = platformTaxBps_;

        // If the pair already exists (griefing or coincidence) createPair reverts;
        // use the existing one so token creation cannot be bricked.
        address factory_ = IUniswapV2Router02(router_).factory();
        address weth_ = IUniswapV2Router02(router_).WETH();
        address pair = IUniswapV2Factory(factory_).getPair(address(this), weth_);
        if (pair == address(0)) {
            pair = IUniswapV2Factory(factory_).createPair(address(this), weth_);
        }
        mainPair = pair;
        isAmmPair[pair] = true;

        isExcludedFromFees[creator_] = true;
        isExcludedFromFees[address(this)] = true;
        isExcludedFromFees[treasury_] = true;
    }

    receive() external payable {}

    // ------------------------------------------------------------- admin

    /// @dev The token owner or the platform (TokenFactory / PresaleFactory) can manage this.
    modifier onlyOwnerOrPlatform() {
        if (
            msg.sender != owner() &&
            msg.sender != tokenFactory &&
            msg.sender != ITokenFactoryView(tokenFactory).presaleFactory()
        ) revert NotAuthorized();
        _;
    }

    function setAmmPair(address pair, bool value) external onlyOwnerOrPlatform {
        require(pair != mainPair || value, "main pair locked");
        isAmmPair[pair] = value;
        _afterAmmPairSet(pair, value);
        emit AmmPairSet(pair, value);
    }

    /// @dev Subclasses can hook extra bookkeeping into AMM pair registration (e.g. reward exclusion).
    function _afterAmmPairSet(address pair, bool value) internal virtual {}

    function excludeFromFees(address account, bool value) external onlyOwnerOrPlatform {
        isExcludedFromFees[account] = value;
        emit ExcludedFromFees(account, value);
    }

    /// @notice Manually swaps the accumulated taxes to ETH (without waiting for the threshold).
    function manualSwapBack() external onlyOwnerOrPlatform {
        require(!inSwap, "in swap");
        _swapBack();
    }

    // ------------------------------------------------------------ taxes

    /// @notice Automatic swap threshold: 1/1000 of total supply
    function swapThreshold() public view returns (uint256) {
        return totalSupply() / 1_000;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        bool excluded = isExcludedFromFees[from] || isExcludedFromFees[to];

        // On a sell, if the accumulation exceeds the threshold, swap-back runs first
        if (!inSwap && !excluded && isAmmPair[to]) {
            if (_pendingSellTokens() >= swapThreshold()) {
                _swapBack();
            }
        }

        if (!inSwap && !excluded && (isAmmPair[from] || isAmmPair[to])) {
            uint256 fees = _takeFees(from, to, value);
            value -= fees;
        }

        super._update(from, to, value);
    }

    /// @dev Accumulates the taxes in the contract and returns the total amount charged.
    ///      Subclasses call super first and then add their own taxes.
    function _takeFees(address from, address, uint256 value) internal virtual returns (uint256) {
        uint256 platformFee = (value * platformTaxBps) / BPS;
        if (platformFee > 0) {
            _rawTransfer(from, address(this), platformFee);
            pendingPlatformTokens += platformFee;
        }
        return platformFee;
    }

    /// @dev Accumulation to be swapped to ETH (EXCLUDING the rewards share, which is swapped to the reward token).
    function _pendingSellTokens() internal view virtual returns (uint256) {
        return pendingPlatformTokens;
    }

    /// @dev Swaps the accumulation to ETH and distributes it. Base version: all of it is the platform share, sent to the Treasury.
    function _swapBack() internal virtual inSwapFlag {
        uint256 amount = pendingPlatformTokens;
        if (amount == 0) return;
        (uint256 ethGained, bool ok) = _swapTokensForEth(amount);
        if (!ok) return;
        pendingPlatformTokens = 0;
        _sendEth(platformTreasury, ethGained);
        emit SwapBack(amount, ethGained);
    }

    // ------------------------------------------------------------ helpers

    function _swapTokensForEth(uint256 amount) internal returns (uint256 ethGained, bool ok) {
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
        {
            ethGained = address(this).balance - ethBefore;
            ok = true;
        } catch {
            ok = false;
        }
    }

    /// @dev A failed ETH send does not block the transfer; the ETH stays in the contract.
    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool success, ) = to.call{value: amount}("");
        success; // intentionally ignored
    }

    /// @dev Moves balances directly, bypassing the tax logic.
    function _rawTransfer(address from, address to, uint256 amount) internal {
        super._update(from, to, amount);
    }
}
