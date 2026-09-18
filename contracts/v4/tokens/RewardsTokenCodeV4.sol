// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {RewardsTokenV4} from "./RewardsTokenV4.sol";

/// @title RewardsTokenCodeV4
/// @notice Holds the creation code of RewardsTokenV4, the way RewardsTokenCode does for the V2
///         token: the deployer has to carry both the V2 and the V4 rewards token, which together
///         would not fit under the 24KB contract size limit.
contract RewardsTokenCodeV4 {
    function creationCode() external pure returns (bytes memory) {
        return type(RewardsTokenV4).creationCode;
    }
}
