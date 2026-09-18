// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

/// @notice The one Permit2 function the launcher needs: an allowance so the PositionManager can
///         pull the launch tokens through Permit2 (PositionManager pays through
///         permit2.transferFrom). Signature-based permits are not used.
interface IAllowanceTransferV4 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
