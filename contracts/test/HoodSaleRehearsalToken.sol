// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {HoodSaleToken} from "../HoodSaleToken.sol";

/// @title HoodSaleRehearsalToken
/// @notice A stand-in for rehearsing the HOODS presale on a live chain: the same code and the
///         same constructor as HoodSaleToken (3% tax, swap on sells, presale factory hook,
///         Treasury buyback deposit), only the name and the symbol differ, so the rehearsal pool
///         can never be mistaken for HOODS on an explorer or a DEX listing. It is not a platform
///         contract: the deployer allowlists it for one sale and removes it afterwards
///         (scripts/rehearse-hoodsale.js).
contract HoodSaleRehearsalToken is HoodSaleToken {
    constructor(
        address owner_,
        address router_,
        address payable treasury_,
        address payable marketingWallet_
    ) HoodSaleToken(owner_, router_, treasury_, marketingWallet_) {}

    function name() public pure override returns (string memory) {
        return "HoodSale Rehearsal";
    }

    function symbol() public pure override returns (string memory) {
        return "HOODSR";
    }
}
