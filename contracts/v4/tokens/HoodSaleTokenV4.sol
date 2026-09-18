// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title HoodSaleTokenV4
 * @notice A token launched into a Uniswap v4 pool. It carries no transfer tax at all: the
 *         platform's share and the creator's share are charged by the pool's hook, on the ETH
 *         side of each trade. That keeps the token itself plain, which is what Uniswap's routers
 *         and every aggregator expect, and it means a wallet-to-wallet transfer costs nothing.
 *
 *         Both the Standard and the Tax launch types use this contract; what separates them is
 *         the tax the hook is configured with, not the token's code. `tokenType` records which
 *         one the launch was created as, so the site can label it.
 */
contract HoodSaleTokenV4 is ERC20, Ownable {
    /// @notice Tells readers the tax lives in a Uniswap v4 hook rather than in this contract
    uint8 public constant POOL_VERSION = 4;

    /// @notice The launcher that created this token and opens its pool
    address public immutable launcher;
    address public immutable tokenFactory;
    /// @notice 0 Standard, 1 Tax, matching TokenFactory.TokenType
    uint8 public immutable tokenType;
    /// @notice The account that renounced ownership; zero while the token has an owner
    address public renouncedBy;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address launcher_,
        address tokenFactory_,
        uint8 tokenType_
    ) ERC20(name_, symbol_) Ownable(launcher_) {
        require(launcher_ != address(0), "zero launcher");
        launcher = launcher_;
        tokenFactory = tokenFactory_;
        tokenType = tokenType_;
        _mint(launcher_, totalSupply_);
    }

    /// @notice 4 for a Uniswap v4 launch. V2 tokens do not answer this call, which is how the
    ///         platform's contracts and the site tell the two apart.
    function poolVersion() external pure returns (uint8) {
        return POOL_VERSION;
    }

    /// @notice Renouncing is recorded so the site can show who gave the ownership up.
    function renounceOwnership() public override onlyOwner {
        renouncedBy = owner();
        _transferOwnership(address(0));
    }
}
