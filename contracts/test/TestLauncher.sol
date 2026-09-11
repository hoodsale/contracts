// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

interface IPresaleLike {
    function finalize(uint256 minLiquidityTokens, uint256 minLiquidityEth) external;
}

interface IOpeningBuyBurn {
    function openingBuyBurn() external payable returns (uint256 spent, uint256 burned);
}

/// @title TestLauncher
/// @notice Stands in for the EIP-7702 delegation the sale owner uses on mainnet, so a test can
///         exercise the exact call ordering of a launch: finalize, then the opening buy-and-burn,
///         in one transaction with nothing able to land between them.
/// @dev Test support only. On mainnet no such contract is deployed: the owner's own wallet runs
///      LaunchBatch's code under EIP-7702 and stays the sale owner.
contract TestLauncher {
    receive() external payable {}

    function call(address target, uint256 value, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// @notice The launch: finalize the sale, then spend `msg.value` buying and burning.
    function launch(address presale, address token) external payable returns (uint256 spent, uint256 burned) {
        IPresaleLike(presale).finalize(0, 0);
        (spent, burned) = IOpeningBuyBurn(token).openingBuyBurn{value: msg.value}();
    }

    /// @notice The same launch without the buy, to measure the unprotected baseline.
    function launchOnly(address presale) external {
        IPresaleLike(presale).finalize(0, 0);
    }
}
