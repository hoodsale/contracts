// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {PlatformTaxBase} from "./PlatformTaxBase.sol";

/// @title StandardToken
/// @notice Plain ERC-20: only the 0.25% platform tax (buy/sell), no other tax.
contract StandardToken is PlatformTaxBase {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address tokenFactory_,
        address router_,
        uint16 platformTaxBps_
    ) PlatformTaxBase(name_, symbol_, creator_, treasury_, tokenFactory_, router_, platformTaxBps_) {
        _mint(creator_, totalSupply_);
    }
}
