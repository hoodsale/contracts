// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {RewardsToken} from "./RewardsToken.sol";

/// @title RewardsTokenCode
/// @notice Holds the creation code of RewardsToken. RewardsTokenDeployer used to embed it, which
///         pushed the deployer past the 24KB contract size limit once the one-way owner locks were
///         added to every token. The deployer fetches the code from here and deploys with CREATE,
///         so the token's constructor and its arguments stay exactly as they were.
contract RewardsTokenCode {
    function creationCode() external pure returns (bytes memory) {
        return type(RewardsToken).creationCode;
    }
}
