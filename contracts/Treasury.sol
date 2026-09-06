// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2.sol";

/// @title Treasury
/// @notice Collects all platform revenue:
///         - Presale creation fees, 10% platform shares, 10% early-exit deductions (ETH)
///         - 0.25% buy/sell taxes coming from platform tokens (denominated in tokens)
///         30% of every incoming ETH is set aside as the buyback reserve; the reserve is
///         used to buy HOODSALE from the DEX and send it to the burn address. Token-denominated
///         revenue can be converted to ETH on the DEX (`liquidateToken`) and falls under the same 30% rule.
contract Treasury is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Share of incoming ETH set aside for buyback (default 30%)
    uint16 public buybackBps = 3_000;
    uint256 public buybackReserve;
    uint256 public totalBoughtBack;

    address public hoodsale;
    IUniswapV2Router02 public router;

    event RevenueReceived(address indexed from, uint256 amount, uint256 toBuybackReserve);
    event BuybackExecuted(uint256 ethSpent, uint256 hoodsaleBurned);
    event TokenLiquidated(address indexed token, uint256 amountIn, uint256 ethReceived);
    event BuybackBpsUpdated(uint16 bps);

    constructor(address owner_) Ownable(owner_) {}

    receive() external payable {
        uint256 toReserve = (msg.value * buybackBps) / BPS;
        buybackReserve += toReserve;
        emit RevenueReceived(msg.sender, msg.value, toReserve);
    }

    /// @notice A deposit counted entirely toward the buyback reserve (e.g. the buyback share of the HOODSALE 3% tax).
    function depositBuyback() external payable {
        buybackReserve += msg.value;
        emit RevenueReceived(msg.sender, msg.value, msg.value);
    }

    // ------------------------------------------------------------- admin

    function setBuybackBps(uint16 bps) external onlyOwner {
        require(bps <= BPS, "bps too high");
        buybackBps = bps;
        emit BuybackBpsUpdated(bps);
    }

    function setRouter(address router_) external onlyOwner {
        require(router_ != address(0), "zero router");
        router = IUniswapV2Router02(router_);
    }

    function setHoodsale(address hoodsale_) external onlyOwner {
        require(hoodsale_ != address(0), "zero token");
        hoodsale = hoodsale_;
    }

    // ------------------------------------------------------------- buyback

    /// @notice Buys HOODSALE with the buyback reserve and burns it.
    function executeBuyback(uint256 ethAmount, uint256 amountOutMin) external onlyOwner nonReentrant {
        require(hoodsale != address(0) && address(router) != address(0), "not configured");
        require(ethAmount > 0 && ethAmount <= buybackReserve, "bad amount");
        buybackReserve -= ethAmount;

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = hoodsale;

        uint256 balBefore = IERC20(hoodsale).balanceOf(DEAD);
        router.swapExactETHForTokens{value: ethAmount}(amountOutMin, path, DEAD, block.timestamp);
        uint256 burned = IERC20(hoodsale).balanceOf(DEAD) - balBefore;

        totalBoughtBack += burned;
        emit BuybackExecuted(ethAmount, burned);
    }

    /// @notice Converts platform tokens accumulated as tax into ETH.
    ///         The incoming ETH goes through receive() and falls under the 30% buyback rule.
    function liquidateToken(address token, uint256 amountIn, uint256 amountOutMin)
        external
        onlyOwner
        nonReentrant
    {
        require(address(router) != address(0), "not configured");
        uint256 amount = amountIn == 0 ? IERC20(token).balanceOf(address(this)) : amountIn;
        require(amount > 0, "nothing to sell");

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = router.WETH();

        uint256 ethBefore = address(this).balance;
        IERC20(token).forceApprove(address(router), amount);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amount,
            amountOutMin,
            path,
            address(this),
            block.timestamp
        );
        emit TokenLiquidated(token, amount, address(this).balance - ethBefore);
    }

    // ------------------------------------------------------------- withdrawals

    /// @notice Withdraws the ETH that is outside the buyback reserve (operations share).
    function withdrawEth(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "zero to");
        require(amount <= address(this).balance - buybackReserve, "reserve locked");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth transfer failed");
    }

    /// @notice Withdraws accumulated tokens as-is (instead of liquidating them).
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero to");
        IERC20(token).safeTransfer(to, amount);
    }
}
