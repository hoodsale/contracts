// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Presale} from "./Presale.sol";

/// @title PresaleCode
/// @notice Holds the creation code of Presale. PresaleFactory used to embed it directly, which
///         would push the factory past the 24KB contract size limit with the quick presale logic
///         in place. The factory fetches the code from here and deploys presales with CREATE, so
///         Presale's constructor and its `factory = msg.sender` rule stay exactly as they were.
contract PresaleCode {
    function creationCode() external pure returns (bytes memory) {
        return type(Presale).creationCode;
    }
}
