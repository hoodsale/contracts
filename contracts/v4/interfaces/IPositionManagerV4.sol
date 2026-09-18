// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice The slice of Uniswap v4's PositionManager that HoodSale uses. The periphery's own
///         IPositionManager pulls in Permit2 sources that Hardhat cannot resolve, so the few
///         functions needed are declared here with their exact signatures.
interface IPositionManagerV4 {
    /// @notice Runs a batch of encoded actions (mint, settle, sweep, decrease, take) inside one
    ///         PoolManager unlock. `unlockData` is abi.encode(bytes actions, bytes[] params).
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    /// @notice The id the next minted position receives.
    function nextTokenId() external view returns (uint256);

    function ownerOf(uint256 tokenId) external view returns (address);

    function transferFrom(address from, address to, uint256 tokenId) external;

    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);

    /// @notice The pool key and the packed PositionInfo (ticks, pool id hash) of a position.
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory poolKey, uint256 info);

    function poolManager() external view returns (address);
}
