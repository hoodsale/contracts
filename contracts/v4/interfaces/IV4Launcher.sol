// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

/// @notice What a launched token needs to know about the launcher that created it.
interface IV4LauncherView {
    function hook() external view returns (address);

    function poolManager() external view returns (address);

    function positionManager() external view returns (address);

    function keeper() external view returns (address);

    function treasury() external view returns (address);
}

/// @notice The presale identity checks the launcher performs before opening a pool.
interface IPresaleFactoryView {
    function isPresale(address account) external view returns (bool);
}

/// @notice Presale's public `params` getter, flattened. Only the first field is used, but the
///         whole tuple has to be named for the return data to decode.
interface IPresaleParamsView {
    function params()
        external
        view
        returns (
            address token,
            uint256 presaleRate,
            uint256 listingRate,
            uint256 softCap,
            uint256 hardCap,
            uint256 minContribution,
            uint256 maxContribution,
            uint64 startTime,
            uint64 endTime,
            uint16 liquidityBps,
            uint8 liquidityAction,
            uint64 lockDuration,
            uint64 launchTime,
            bool whitelistEnabled
        );
}
