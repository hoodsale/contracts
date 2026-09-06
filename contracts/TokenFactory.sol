// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {StandardToken} from "./tokens/StandardToken.sol";
import {TaxToken} from "./tokens/TaxToken.sol";
import {RewardsToken} from "./tokens/RewardsToken.sol";

/// @dev Token creation code is split into a separate deployer contract per type
///      so that the 24KB contract size limit is not hit.
contract StandardTokenDeployer {
    address public immutable factory;

    constructor(address factory_) {
        factory = factory_;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address router_,
        uint16 platformTaxBps_
    ) external returns (address) {
        require(msg.sender == factory, "only factory");
        return address(
            new StandardToken(name_, symbol_, totalSupply_, creator_, treasury_, factory, router_, platformTaxBps_)
        );
    }
}

contract TaxTokenDeployer {
    address public immutable factory;

    constructor(address factory_) {
        factory = factory_;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address router_,
        uint16 platformTaxBps_,
        address marketingWallet_,
        uint16 buyTaxBps_,
        uint16 sellTaxBps_
    ) external returns (address) {
        require(msg.sender == factory, "only factory");
        return address(
            new TaxToken(
                name_, symbol_, totalSupply_, creator_, treasury_, factory, router_,
                platformTaxBps_, marketingWallet_, buyTaxBps_, sellTaxBps_
            )
        );
    }
}

/// @dev The platform's route store for reward tokens: the QuickLaunch of the presale factory
interface IPresaleFactoryQuickLaunch {
    function quickLaunch() external view returns (address);
}

interface IRewardRouteStore {
    function rewardRouteV3Of(address rewardToken) external view returns (bytes memory);
}

/// @dev Deploys RewardsToken. Carries the chain's Uniswap V3 router and quoter for the reward
///      swap's V3 leg, and gives every new token the V3 route the platform's QuickLaunch stores
///      for its reward token, so a token created through the factory directly starts on the same
///      route as a quick launch (tokenized stocks trade on V3 on Robinhood Chain).
contract RewardsTokenDeployer {
    address public immutable factory;
    address public immutable v3Router;
    address public immutable v3Quoter;

    constructor(address factory_, address v3Router_, address v3Quoter_) {
        factory = factory_;
        v3Router = v3Router_;
        v3Quoter = v3Quoter_;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address router_,
        uint16 platformTaxBps_,
        address rewardToken_,
        address marketingWallet_,
        uint16[4] calldata taxes_
    ) external returns (address) {
        require(msg.sender == factory, "only factory");
        return address(
            new RewardsToken(
                name_, symbol_, totalSupply_, creator_, treasury_, factory, router_,
                platformTaxBps_, rewardToken_, marketingWallet_, taxes_,
                v3Router, v3Quoter, platformRouteV3For(rewardToken_)
            )
        );
    }

    /// @notice The V3 path the platform's current QuickLaunch stores for `rewardToken`; empty when
    ///         there is none, or when the presale factory or its QuickLaunch has no route store.
    function platformRouteV3For(address rewardToken) public view returns (bytes memory) {
        if (v3Router == address(0)) return "";
        address presaleFactory = TokenFactory(factory).presaleFactory();
        if (presaleFactory == address(0)) return "";
        (bool ok, bytes memory data) = presaleFactory.staticcall(abi.encodeCall(IPresaleFactoryQuickLaunch.quickLaunch, ()));
        if (!ok || data.length < 32) return "";
        address quickLaunch = abi.decode(data, (address));
        if (quickLaunch == address(0)) return "";
        (ok, data) = quickLaunch.staticcall(abi.encodeCall(IRewardRouteStore.rewardRouteV3Of, (rewardToken)));
        if (!ok || data.length < 64) return "";
        return abi.decode(data, (bytes));
    }
}

/// @title TokenFactory
/// @notice Creates platform tokens and keeps a registry of them. Creation is FREE
///         (gas only); instead, every token carries a 0.25% platform tax per buy/sell that
///         goes to the Treasury. Presales can only be run with tokens created by this factory.
contract TokenFactory is Ownable {
    enum TokenType {
        Standard,
        Tax,
        Rewards
    }

    struct TokenInfo {
        address token;
        address creator;
        TokenType tokenType;
        uint64 createdAt;
        address rewardToken; // for the Rewards type; 0 for the others
        string name;
        string symbol;
    }

    uint16 public constant MAX_PLATFORM_TAX_BPS = 50; // 0.5% cap

    address public treasury;
    address public router;
    address public presaleFactory;
    /// @notice Platform tax embedded into newly created tokens (default 0.25%, hard cap 0.5%)
    uint16 public platformTaxBps = 25; // 0.25% on buys and sells

    StandardTokenDeployer public standardDeployer;
    TaxTokenDeployer public taxDeployer;
    RewardsTokenDeployer public rewardsDeployer;

    address[] public allTokens;
    mapping(address => TokenInfo) public infoOf;
    mapping(address => address[]) private _tokensOfCreator;

    event TokenCreated(address indexed token, address indexed creator, TokenType tokenType, string name, string symbol);
    event PlatformTaxUpdated(uint16 bps);
    event PresaleFactorySet(address presaleFactory);

    constructor(address owner_, address treasury_, address router_) Ownable(owner_) {
        require(treasury_ != address(0) && router_ != address(0), "zero addr");
        treasury = treasury_;
        router = router_;
    }

    // ------------------------------------------------------------- admin

    function setDeployers(
        StandardTokenDeployer standard_,
        TaxTokenDeployer tax_,
        RewardsTokenDeployer rewards_
    ) external onlyOwner {
        standardDeployer = standard_;
        taxDeployer = tax_;
        rewardsDeployer = rewards_;
    }

    function setPresaleFactory(address presaleFactory_) external onlyOwner {
        require(presaleFactory_ != address(0), "zero addr");
        presaleFactory = presaleFactory_;
        emit PresaleFactorySet(presaleFactory_);
    }

    function setPlatformTaxBps(uint16 bps) external onlyOwner {
        require(bps <= MAX_PLATFORM_TAX_BPS, "tax too high");
        platformTaxBps = bps;
        emit PlatformTaxUpdated(bps);
    }

    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "zero addr");
        treasury = treasury_;
    }

    function setRouter(address router_) external onlyOwner {
        require(router_ != address(0), "zero addr");
        router = router_;
    }

    // ---------------------------------------------------------- creation

    function createStandardToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_
    ) external returns (address token) {
        require(totalSupply_ > 0, "zero supply");
        token = standardDeployer.deploy(
            name_, symbol_, totalSupply_, msg.sender, treasury, router, platformTaxBps
        );
        _register(token, msg.sender, TokenType.Standard, address(0), name_, symbol_);
    }

    function createTaxToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address marketingWallet_,
        uint16 buyTaxBps_,
        uint16 sellTaxBps_
    ) external returns (address token) {
        require(totalSupply_ > 0, "zero supply");
        token = taxDeployer.deploy(
            name_, symbol_, totalSupply_, msg.sender, treasury, router,
            platformTaxBps, marketingWallet_, buyTaxBps_, sellTaxBps_
        );
        _register(token, msg.sender, TokenType.Tax, address(0), name_, symbol_);
    }

    /// @notice Rewards / Stock-Rewards token: rewardToken_ can be WETH, USDG or the
    ///         address of a Robinhood tokenized stock (e.g. tAAPL).
    function createRewardsToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address rewardToken_,
        address marketingWallet_,
        uint16[4] calldata taxes_ // [rewardsBuy, rewardsSell, marketingBuy, marketingSell]
    ) external returns (address token) {
        require(totalSupply_ > 0, "zero supply");
        token = rewardsDeployer.deploy(
            name_, symbol_, totalSupply_, msg.sender, treasury, router,
            platformTaxBps, rewardToken_, marketingWallet_, taxes_
        );
        _register(token, msg.sender, TokenType.Rewards, rewardToken_, name_, symbol_);
    }

    function _register(
        address token,
        address creator,
        TokenType tokenType,
        address rewardToken,
        string calldata name_,
        string calldata symbol_
    ) private {
        infoOf[token] = TokenInfo({
            token: token,
            creator: creator,
            tokenType: tokenType,
            createdAt: uint64(block.timestamp),
            rewardToken: rewardToken,
            name: name_,
            symbol: symbol_
        });
        allTokens.push(token);
        _tokensOfCreator[creator].push(token);
        emit TokenCreated(token, creator, tokenType, name_, symbol_);
    }

    // ------------------------------------------------------------ views

    function isPlatformToken(address token) external view returns (bool) {
        return infoOf[token].token != address(0);
    }

    /// @dev Lets helper contracts such as the Lens read the struct as a whole.
    function tokenInfo(address token) external view returns (TokenInfo memory) {
        return infoOf[token];
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    function tokensOfCreator(address creator) external view returns (address[] memory) {
        return _tokensOfCreator[creator];
    }

    function getTokens(uint256 start, uint256 count) external view returns (TokenInfo[] memory infos) {
        uint256 len = allTokens.length;
        if (start >= len) return new TokenInfo[](0);
        uint256 end = start + count > len ? len : start + count;
        infos = new TokenInfo[](end - start);
        for (uint256 i = start; i < end; i++) {
            infos[i - start] = infoOf[allTokens[i]];
        }
    }
}
