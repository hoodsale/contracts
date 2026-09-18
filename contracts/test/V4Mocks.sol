// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Test-only: a plain ERC20 with an owner, standing in for a launched v4 token.
contract MockOwnedERC20 is ERC20, Ownable {
    constructor(string memory name_, string memory symbol_, uint256 supply_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _mint(owner_, supply_);
    }
}

/// Test-only: a wallet that refuses ETH, to prove a rejected payout cannot block trading.
contract RejectingWallet {
    receive() external payable {
        revert("no thanks");
    }
}

/// Test-only: a wallet that burns all the gas it is given, to prove the payout's gas cap holds.
contract GasBurningWallet {
    uint256 public counter;

    receive() external payable {
        while (true) counter++;
    }
}

/// Test-only: records the ETH it receives, standing in for a rewards token's sink.
contract RewardsSinkMock {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}
