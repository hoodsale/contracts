// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev FOR TESTS ONLY: a minimal UniswapV2-like AMM (WETH + Factory + Pair + Router).
///      In production the official Uniswap V2 contracts on Robinhood Chain are used.

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "weth: eth send failed");
    }

    receive() external payable {
        deposit();
    }
}

/// @dev A plain ERC20 with a chosen number of decimals, the supply minted to the deployer. Stands in
///      for a foreign reward token such as USDG on the local network.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _mint(msg.sender, supply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

contract MockPair is ERC20 {
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;

    constructor(address token0_, address token1_) ERC20("Mock LP", "MLP") {
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
    }

    modifier onlyRouter() {
        require(msg.sender == MockFactory(factory).router(), "pair: only router");
        _;
    }

    function getReserves() public view returns (uint112 r0, uint112 r1, uint32 ts) {
        r0 = reserve0;
        r1 = reserve1;
        ts = uint32(block.timestamp);
    }

    function sync() public {
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    /// @dev UniswapV2Pair.mint semantics: mints LP from tokens previously transferred to the pair.
    function mint(address to) external returns (uint256 liquidity) {
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = bal0 - reserve0;
        uint256 amount1 = bal1 - reserve1;

        uint256 ts = totalSupply();
        if (ts == 0) {
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(1), MINIMUM_LIQUIDITY); // permanent lock
        } else {
            uint256 l0 = (amount0 * ts) / reserve0;
            uint256 l1 = (amount1 * ts) / reserve1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        require(liquidity > 0, "pair: insufficient liquidity minted");
        _mint(to, liquidity);
        sync();
    }

    /// @dev UniswapV2Pair.burn semantics: burns the LP previously transferred to the pair and sends
    ///      the matching share of both reserves to `to`. Lets a test remove a pool's liquidity.
    function burn(address to) external returns (uint256 amount0, uint256 amount1) {
        uint256 liquidity = balanceOf(address(this));
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));
        uint256 ts = totalSupply();
        amount0 = (liquidity * bal0) / ts;
        amount1 = (liquidity * bal1) / ts;
        require(amount0 > 0 && amount1 > 0, "pair: insufficient liquidity burned");
        _burn(address(this), liquidity);
        SafeERC20.safeTransfer(IERC20(token0), to, amount0);
        SafeERC20.safeTransfer(IERC20(token1), to, amount1);
        sync();
    }

    function mintLP(address to, uint256 liquidity) external onlyRouter {
        _mint(to, liquidity);
        sync();
    }

    function transferOut(address token, address to, uint256 amount) external onlyRouter {
        SafeERC20.safeTransfer(IERC20(token), to, amount);
        sync();
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

contract MockFactory {
    address public router;
    address public deployer;
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    constructor() {
        deployer = msg.sender;
    }

    function setRouter(address router_) external {
        require(msg.sender == deployer && router == address(0), "factory: router set");
        router = router_;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "factory: identical");
        require(getPair[tokenA][tokenB] == address(0), "factory: exists");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pair = address(new MockPair(t0, t1));
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
        allPairs.push(pair);
    }
}

contract MockRouter {
    using SafeERC20 for IERC20;

    MockFactory public immutable factoryContract;
    MockWETH public immutable wethContract;

    constructor(address factory_, address payable weth_) {
        factoryContract = MockFactory(factory_);
        wethContract = MockWETH(weth_);
    }

    receive() external payable {}

    function factory() external view returns (address) {
        return address(factoryContract);
    }

    function WETH() external view returns (address) {
        return address(wethContract);
    }

    // ------------------------------------------------------------ liquidity

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(deadline >= block.timestamp, "router: expired");
        address pair = _pairFor(token, address(wethContract));
        // Like the real UniswapV2Router02, this uses the stored reserves (not the balances).
        (uint112 res0, uint112 res1, ) = MockPair(pair).getReserves();
        (uint256 rToken, uint256 rWeth) = token < address(wethContract)
            ? (uint256(res0), uint256(res1))
            : (uint256(res1), uint256(res0));

        if (rToken == 0 && rWeth == 0) {
            (amountToken, amountETH) = (amountTokenDesired, msg.value);
        } else {
            uint256 ethOptimal = (amountTokenDesired * rWeth) / rToken;
            if (ethOptimal <= msg.value) {
                (amountToken, amountETH) = (amountTokenDesired, ethOptimal);
            } else {
                uint256 tokenOptimal = (msg.value * rToken) / rWeth;
                (amountToken, amountETH) = (tokenOptimal, msg.value);
            }
        }
        require(amountToken >= amountTokenMin, "router: token min");
        require(amountETH >= amountETHMin, "router: eth min");

        IERC20(token).safeTransferFrom(msg.sender, pair, amountToken);
        wethContract.deposit{value: amountETH}();
        IERC20(address(wethContract)).safeTransfer(pair, amountETH);

        uint256 ts = MockPair(pair).totalSupply();
        if (ts == 0) {
            liquidity = _sqrt(amountToken * amountETH);
        } else {
            uint256 l0 = (amountToken * ts) / rToken;
            uint256 l1 = (amountETH * ts) / rWeth;
            liquidity = l0 < l1 ? l0 : l1;
        }
        require(liquidity > 0, "router: zero liquidity");
        MockPair(pair).mintLP(to, liquidity);

        if (msg.value > amountETH) {
            (bool ok, ) = msg.sender.call{value: msg.value - amountETH}("");
            require(ok, "router: refund failed");
        }
    }

    // ---------------------------------------------------------------- swaps

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "router: expired");
        require(path[0] == address(wethContract), "router: path0 not weth");
        wethContract.deposit{value: msg.value}();
        uint256 out = _swapAlongPath(path, msg.value, to);
        require(out >= amountOutMin, "router: insufficient output");
        amounts = new uint256[](path.length);
        amounts[0] = msg.value;
        amounts[path.length - 1] = out;
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(deadline >= block.timestamp, "router: expired");
        address pair0 = _pairFor(path[0], path[1]);
        uint256 balBefore = IERC20(path[0]).balanceOf(pair0);
        IERC20(path[0]).safeTransferFrom(msg.sender, pair0, amountIn);
        uint256 actualIn = IERC20(path[0]).balanceOf(pair0) - balBefore;

        uint256 outBalBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapAlongPathTransferred(path, actualIn, to);
        uint256 received = IERC20(path[path.length - 1]).balanceOf(to) - outBalBefore;
        require(received >= amountOutMin, "router: insufficient output");
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(deadline >= block.timestamp, "router: expired");
        require(path[path.length - 1] == address(wethContract), "router: last not weth");
        address pair0 = _pairFor(path[0], path[1]);
        uint256 balBefore = IERC20(path[0]).balanceOf(pair0);
        IERC20(path[0]).safeTransferFrom(msg.sender, pair0, amountIn);
        uint256 actualIn = IERC20(path[0]).balanceOf(pair0) - balBefore;

        uint256 out = _swapAlongPathTransferred(path, actualIn, address(this));
        require(out >= amountOutMin, "router: insufficient output");
        wethContract.withdraw(out);
        (bool ok, ) = to.call{value: out}("");
        require(ok, "router: eth send failed");
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = _pairFor(path[i], path[i + 1]);
            uint256 rIn = IERC20(path[i]).balanceOf(pair);
            uint256 rOut = IERC20(path[i + 1]).balanceOf(pair);
            amounts[i + 1] = _getAmountOut(amounts[i], rIn, rOut);
        }
    }

    // ------------------------------------------------------------- internal

    /// @dev Called while the first-hop input has NOT yet been transferred to the pair (WETH scenario).
    function _swapAlongPath(address[] calldata path, uint256 amountIn, address to)
        private
        returns (uint256)
    {
        address pair0 = _pairFor(path[0], path[1]);
        uint256 balBefore = IERC20(path[0]).balanceOf(pair0);
        IERC20(path[0]).safeTransfer(pair0, amountIn);
        uint256 actualIn = IERC20(path[0]).balanceOf(pair0) - balBefore;
        return _swapAlongPathTransferred(path, actualIn, to);
    }

    /// @dev The first-hop input has already been transferred to the pair; swaps hop by hop.
    function _swapAlongPathTransferred(address[] calldata path, uint256 amountIn, address to)
        private
        returns (uint256 amountOut)
    {
        uint256 currentIn = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = _pairFor(path[i], path[i + 1]);
            // reserves: balance AFTER the input was transferred - input = previous reserve
            uint256 rIn = IERC20(path[i]).balanceOf(pair) - currentIn;
            uint256 rOut = IERC20(path[i + 1]).balanceOf(pair);
            uint256 out = _getAmountOut(currentIn, rIn, rOut);
            address recipient = i == path.length - 2 ? to : _pairFor(path[i + 1], path[i + 2]);
            // Real UniswapV2Pair.swap: output cannot be sent to the pool's own tokens
            require(recipient != path[i] && recipient != path[i + 1], "UniswapV2: INVALID_TO");
            uint256 recBefore = IERC20(path[i + 1]).balanceOf(recipient);
            MockPair(pair).transferOut(path[i + 1], recipient, out);
            currentIn = IERC20(path[i + 1]).balanceOf(recipient) - recBefore;
        }
        amountOut = currentIn;
    }

    function _getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) private pure returns (uint256) {
        require(rIn > 0 && rOut > 0, "router: no liquidity");
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * rOut) / (rIn * 1000 + amountInWithFee);
    }

    function _pairFor(address a, address b) private view returns (address pair) {
        pair = factoryContract.getPair(a, b);
        require(pair != address(0), "router: no pair");
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
