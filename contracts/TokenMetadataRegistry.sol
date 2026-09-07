// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

interface ITokenOwner {
    function owner() external view returns (address);
}

interface IRenouncedToken {
    function renouncedBy() external view returns (address);
}

interface ITokenFactoryRegistry {
    function isPlatformToken(address token) external view returns (bool);
    function owner() external view returns (address);
}

interface IPresaleFactoryAllowlist {
    function allowedToken(address token) external view returns (bool);
}

interface IPresaleFactoryQuick {
    function quickLaunch() external view returns (address);
}

interface IQuickLaunch {
    function creatorOf(address presale) external view returns (address);
    function presaleOfToken(address token) external view returns (address);
}

/// @title TokenMetadataRegistry
/// @notice Stores profile information for platform tokens on-chain: logo, banner
///         image, description and social media links. The profile is written by the
///         token's editor (see canEdit): the token owner, or the wallet that created the
///         token through QuickLaunch (quick tokens have no owner). The tokenomics record is
///         written by the token owner only. Besides factory tokens, platform tokens on the
///         PresaleFactory allowlist (e.g. HOODS) are also eligible.
contract TokenMetadataRegistry {
    struct Metadata {
        string logoURI;
        string bannerURI;
        string description;
        string website;
        string twitter;
        string telegram;
        string discord;
        uint64 updatedAt;
    }

    uint256 public constant MAX_DESCRIPTION_BYTES = 2000;
    uint256 public constant MAX_URI_BYTES = 400;

    /// @notice A tokenomics slice: label, share of supply (bps) and a short note (e.g. "locked 12 months").
    struct Allocation {
        string label;
        uint16 bps;
        string note;
    }

    uint256 public constant MAX_ALLOCATIONS = 12;
    uint256 public constant MAX_LABEL_BYTES = 32;
    uint256 public constant MAX_NOTE_BYTES = 120;
    uint256 public constant BPS = 10_000;

    mapping(address => Allocation[]) private _tokenomics;

    ITokenFactoryRegistry public immutable tokenFactory;
    /// @notice Allowlist source; set by the platform owner. If zero, only factory tokens are eligible.
    IPresaleFactoryAllowlist public presaleFactory;
    mapping(address => Metadata) private _metadata;

    event MetadataUpdated(address indexed token, address indexed by);
    event TokenomicsUpdated(address indexed token, address indexed by, uint256 slices);
    event PresaleFactorySet(address presaleFactory);

    error NotTokenOwner();
    error NotEditor();
    error NotPlatformToken();
    error NotPlatformOwner();
    error TooLong();
    error BadAllocation();

    constructor(address tokenFactory_) {
        require(tokenFactory_ != address(0), "zero factory");
        tokenFactory = ITokenFactoryRegistry(tokenFactory_);
    }

    /// @notice Only the owner of TokenFactory (the platform) can call this.
    function setPresaleFactory(address presaleFactory_) external {
        if (msg.sender != tokenFactory.owner()) revert NotPlatformOwner();
        presaleFactory = IPresaleFactoryAllowlist(presaleFactory_);
        emit PresaleFactorySet(presaleFactory_);
    }

    /// @notice Whether a profile can be written for this token: a factory token or one on the allowlist.
    function isEligible(address token) public view returns (bool) {
        if (tokenFactory.isPlatformToken(token)) return true;
        return address(presaleFactory) != address(0) && presaleFactory.allowedToken(token);
    }

    /// @notice Whether `account` may write the profile of `token`: the token owner, the wallet
    ///         that renounced ownership of a platform token (renouncedBy, recorded by the token),
    ///         or the wallet that created the token through the platform's QuickLaunch (quick
    ///         tokens renounce ownership at creation). Independent of the sale state, so a profile
    ///         can be edited before, during and after a sale. Tokens without an owner() function
    ///         have no owner editor.
    function canEdit(address token, address account) public view returns (bool) {
        if (account == address(0)) return false;
        if (controllerOf(token) == account) return true;
        if (address(presaleFactory) == address(0)) return false;
        address quickLaunch = IPresaleFactoryQuick(address(presaleFactory)).quickLaunch();
        if (quickLaunch == address(0)) return false;
        address presale = IQuickLaunch(quickLaunch).presaleOfToken(token);
        if (presale == address(0)) return false;
        return IQuickLaunch(quickLaunch).creatorOf(presale) == account;
    }

    function setMetadata(address token, Metadata calldata data) external {
        if (!isEligible(token)) revert NotPlatformToken();
        if (!canEdit(token, msg.sender)) revert NotEditor();

        _checkLength(bytes(data.description).length, MAX_DESCRIPTION_BYTES);
        _checkLength(bytes(data.logoURI).length, MAX_URI_BYTES);
        _checkLength(bytes(data.bannerURI).length, MAX_URI_BYTES);
        _checkLength(bytes(data.website).length, MAX_URI_BYTES);
        _checkLength(bytes(data.twitter).length, MAX_URI_BYTES);
        _checkLength(bytes(data.telegram).length, MAX_URI_BYTES);
        _checkLength(bytes(data.discord).length, MAX_URI_BYTES);

        Metadata storage m = _metadata[token];
        m.logoURI = data.logoURI;
        m.bannerURI = data.bannerURI;
        m.description = data.description;
        m.website = data.website;
        m.twitter = data.twitter;
        m.telegram = data.telegram;
        m.discord = data.discord;
        m.updatedAt = uint64(block.timestamp);

        emit MetadataUpdated(token, msg.sender);
    }

    /// @notice Writes the project's supply distribution (the token owner or, once ownership is
    ///         renounced, the wallet that renounced it; eligible tokens only).
    ///         The slices must sum to exactly 100% (10000 bps); an empty array deletes the record.
    function setTokenomics(address token, Allocation[] calldata slices) external {
        if (!isEligible(token)) revert NotPlatformToken();
        if (msg.sender == address(0) || controllerOf(token) != msg.sender) revert NotTokenOwner();
        if (slices.length > MAX_ALLOCATIONS) revert BadAllocation();

        delete _tokenomics[token];
        uint256 total;
        for (uint256 i = 0; i < slices.length; i++) {
            _checkLength(bytes(slices[i].label).length, MAX_LABEL_BYTES);
            _checkLength(bytes(slices[i].note).length, MAX_NOTE_BYTES);
            if (slices[i].bps == 0 || bytes(slices[i].label).length == 0) revert BadAllocation();
            total += slices[i].bps;
            _tokenomics[token].push(slices[i]);
        }
        if (slices.length > 0 && total != BPS) revert BadAllocation();
        emit TokenomicsUpdated(token, msg.sender, slices.length);
    }

    function tokenomicsOf(address token) external view returns (Allocation[] memory) {
        return _tokenomics[token];
    }

    function hasTokenomics(address token) external view returns (bool) {
        return _tokenomics[token].length > 0;
    }

    function metadataOf(address token) external view returns (Metadata memory) {
        return _metadata[token];
    }

    function hasMetadata(address token) external view returns (bool) {
        return _metadata[token].updatedAt != 0;
    }

    function _checkLength(uint256 len, uint256 max) private pure {
        if (len > max) revert TooLong();
    }

    /// @notice The wallet in charge of a token's profile and tokenomics: its owner, or, when the
    ///         token has no owner, the account that renounced ownership (zero for a token that
    ///         records neither). A quick token's renouncer is the QuickLaunch contract, which is
    ///         why canEdit also asks QuickLaunch for the creator.
    function controllerOf(address token) public view returns (address) {
        address owner = _addressView(token, ITokenOwner.owner.selector);
        if (owner != address(0)) return owner;
        return _addressView(token, IRenouncedToken.renouncedBy.selector);
    }

    /// @dev An address-returning view of a token, or the zero address when the call fails or
    ///      returns nothing (a contract without the function, or an address without code).
    function _addressView(address token, bytes4 selector) private view returns (address) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length < 32) return address(0);
        return address(uint160(uint256(bytes32(data))));
    }
}
