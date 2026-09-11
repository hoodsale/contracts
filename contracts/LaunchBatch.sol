// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

/// @title LaunchBatch
/// @notice A batch executor meant to be used ONLY as an EIP-7702 delegation target by the wallet
///         that owns a presale, so that the launch and the opening buy-and-burn happen in one
///         transaction and nothing can be sequenced between them.
/// @dev It has no storage, no owner, no privileges and holds no funds of its own. Under EIP-7702
///      this code runs in the delegating wallet's own context, so `address(this)` is that wallet
///      and the self-call check is what keeps anybody else from driving it.
contract LaunchBatch {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    error NotSelf();
    error CallFailed(uint256 index, bytes reason);

    /// @dev Required. Presale._finalize ends by sending the sale owner's ETH share with an empty
    ///      call and checks that it succeeded, so a delegating wallet with no receive() would
    ///      make finalize revert and the launch would be impossible.
    receive() external payable {}

    /// @notice Runs the calls in order, in one transaction. Any failure reverts everything, so a
    ///         launch either happens in full or does not happen at all.
    function run(Call[] calldata calls) external payable {
        if (msg.sender != address(this)) revert NotSelf();
        for (uint256 i = 0; i < calls.length; i += 1) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }
}
