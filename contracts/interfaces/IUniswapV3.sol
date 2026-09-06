// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

/// @dev The Uniswap V3 surface the platform touches: the factory (pool lookup), a pool (depth and
///      price for the route check), SwapRouter02 (the reward swap's V3 leg) and QuoterV2 (off-chain
///      quotes by the keeper and the deploy scripts; it is not a view and is never called on chain).

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @dev swap-router-contracts SwapRouter02: exactInput has no deadline of its own (deadlines go
///      through its multicall), the path is packed as token (20 bytes), fee (3 bytes), token, ...
interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function factory() external view returns (address);
    function WETH9() external view returns (address);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    function factory() external view returns (address);
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

/// @dev Helpers shared by the token, QuickLaunch and the mocks for the packed V3 path
library V3Path {
    uint256 internal constant ADDR_SIZE = 20;
    uint256 internal constant FEE_SIZE = 3;
    uint256 internal constant HOP_SIZE = ADDR_SIZE + FEE_SIZE;

    /// @dev True when `path` has the shape token (fee token)+ with at least one pool
    function isWellFormed(bytes memory path) internal pure returns (bool) {
        return path.length >= ADDR_SIZE + HOP_SIZE && (path.length - ADDR_SIZE) % HOP_SIZE == 0;
    }

    function poolCount(bytes memory path) internal pure returns (uint256) {
        return (path.length - ADDR_SIZE) / HOP_SIZE;
    }

    /// @dev The i-th pool of the path: its two tokens and its fee
    function hop(bytes memory path, uint256 i) internal pure returns (address tokenIn, uint24 fee, address tokenOut) {
        uint256 o = i * HOP_SIZE;
        tokenIn = _addr(path, o);
        fee = _fee(path, o + ADDR_SIZE);
        tokenOut = _addr(path, o + HOP_SIZE);
    }

    function firstToken(bytes memory path) internal pure returns (address) {
        return _addr(path, 0);
    }

    function lastToken(bytes memory path) internal pure returns (address) {
        return _addr(path, path.length - ADDR_SIZE);
    }

    function _addr(bytes memory path, uint256 offset) private pure returns (address a) {
        assembly {
            a := shr(96, mload(add(add(path, 32), offset)))
        }
    }

    function _fee(bytes memory path, uint256 offset) private pure returns (uint24 f) {
        assembly {
            f := shr(232, mload(add(add(path, 32), offset)))
        }
    }
}
