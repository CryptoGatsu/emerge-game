// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Emerge — the land, as tokens.
 *
 * One plot, one token, one owner, on chain and checkable by anybody. A plot's
 * token id is the seed that generates its terrain, so the thing you own and
 * the thing the game draws are the same number: nobody has to trust a server
 * to tell them who holds Fernrest Vale.
 *
 * ERC-721 with metadata, so a plot shows up in a wallet, on an explorer and on
 * any marketplace; ERC-2981, so every marketplace that honours creator
 * earnings pays the plot holders' share to the royalty receiver; ERC-4906, so
 * a marketplace re-reads a plot's picture when it changes. Written without
 * imports so it can be dropped into Remix and deployed as one file.
 *
 * ## Who mints
 *
 * The game sells land: a claim is paid for in $EMERGE, burned and verified
 * off chain, and then the plot is minted here to the buyer by the minter —
 * the game's vault key. Plots claimed before this contract existed are
 * minted to their holders the same way, in batches. Nothing here takes
 * payment, so there is no price to get wrong and no allowance to sign.
 *
 * ## What the owner can and cannot do
 *
 * The owner sets the metadata address, the royalty and the minter, and can
 * ask marketplaces to refresh a picture. The owner cannot take a plot, move a
 * plot, or mint over a plot somebody holds: `mint` refuses a seed that has an
 * owner. A holder may burn their own plot, which is how a plot is given up.
 */
contract EmergeLand {
    /* ---------------------------------------------------------------- *
     * ERC-721
     * ---------------------------------------------------------------- */

    string public constant name = "Emerge Land";
    string public constant symbol = "EMLAND";

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    /** Every seed ever minted, so the whole registry can be read back. */
    uint256[] public minted;
    /** Whether a seed is already in `minted`, so a burnt and re-minted plot is listed once. */
    mapping(uint256 => bool) private _indexed;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /** ERC-4906: a marketplace should re-read this token's metadata. */
    event MetadataUpdate(uint256 _tokenId);
    /** ERC-4906: every token's metadata should be re-read. */
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    /** Raised when a plot is minted to its holder, by the game. */
    event Minted(uint256 indexed seed, address indexed to);
    /** Raised when a holder gives a plot up. */
    event Burned(uint256 indexed seed, address indexed holder);

    /* ---------------------------------------------------------------- *
     * Configuration
     * ---------------------------------------------------------------- */

    address public owner;
    /** The one address that may mint: the game's vault key. */
    address public minter;

    /** `tokenURI(seed)` is this followed by the seed in decimal. */
    string public baseURI;
    /** Collection-level metadata, which OpenSea reads for the collection page. */
    string public contractURI;

    /** ERC-2981: who is paid on a resale, and how much of it, in basis points. */
    address public royaltyReceiver;
    uint96 public royaltyBps;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(string memory baseURI_, string memory contractURI_, address royaltyReceiver_, uint96 royaltyBps_) {
        owner = msg.sender;
        minter = msg.sender;
        baseURI = baseURI_;
        contractURI = contractURI_;
        require(royaltyBps_ <= 1000, "royalty too high");
        royaltyReceiver = royaltyReceiver_;
        royaltyBps = royaltyBps_;
    }

    /* ---------------------------------------------------------------- *
     * Minting and burning
     * ---------------------------------------------------------------- */

    /** Mint a plot to its holder. The game calls this once the claim is paid. */
    function mint(uint256 seed, address to) external {
        require(msg.sender == minter, "not minter");
        _mint(seed, to);
    }

    /** Mint many at once: the plots claimed before this contract existed, to the wallets that hold them. */
    function mintBatch(uint256[] calldata seeds, address[] calldata to) external {
        require(msg.sender == minter, "not minter");
        require(seeds.length == to.length, "length mismatch");
        for (uint256 i = 0; i < seeds.length; i++) {
            _mint(seeds[i], to[i]);
        }
    }

    /** Give a plot up. Only its holder may, and the seed goes back on the market. */
    function burn(uint256 seed) external {
        address holder = ownerOf(seed);
        require(msg.sender == holder || _tokenApprovals[seed] == msg.sender || _operatorApprovals[holder][msg.sender], "not allowed");
        delete _tokenApprovals[seed];
        _balances[holder] -= 1;
        delete _owners[seed];
        emit Transfer(holder, address(0), seed);
        emit Burned(seed, holder);
    }

    function _mint(uint256 seed, address to) internal {
        require(seed != 0, "no such plot");
        require(to != address(0), "no receiver");
        require(_owners[seed] == address(0), "already minted");
        _owners[seed] = to;
        _balances[to] += 1;
        if (!_indexed[seed]) {
            _indexed[seed] = true;
            minted.push(seed);
        }
        emit Transfer(address(0), to, seed);
        emit Minted(seed, to);
    }

    /* ---------------------------------------------------------------- *
     * Reading the registry back
     * ---------------------------------------------------------------- */

    /** How many plots have ever been minted, for paging `registry`. */
    function mintedCount() external view returns (uint256) {
        return minted.length;
    }

    /**
     * A page of the registry: seeds and their holders. A burnt plot reads as
     * holder zero. Included so the game can read every plot in one call
     * rather than one call per plot.
     */
    function registry(uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory seeds, address[] memory holders)
    {
        uint256 end = start + count;
        if (end > minted.length) end = minted.length;
        uint256 size = end > start ? end - start : 0;
        seeds = new uint256[](size);
        holders = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            uint256 seed = minted[start + i];
            seeds[i] = seed;
            holders[i] = _owners[seed];
        }
    }

    /** Every plot a wallet holds. A scan, fine for a registry of a few hundred plots. */
    function tokensOf(address who) external view returns (uint256[] memory seeds) {
        uint256 held = _balances[who];
        seeds = new uint256[](held);
        uint256 n = 0;
        for (uint256 i = 0; i < minted.length && n < held; i++) {
            if (_owners[minted[i]] == who) seeds[n++] = minted[i];
        }
    }

    /* ---------------------------------------------------------------- *
     * Metadata — ERC-721 Metadata, ERC-2981, ERC-4906
     * ---------------------------------------------------------------- */

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_owners[tokenId] != address(0), "no such plot");
        return string(abi.encodePacked(baseURI, _decimal(tokenId)));
    }

    /** ERC-2981: what a marketplace pays the plot holders' pool on a sale at `salePrice`. */
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) {
        return (royaltyReceiver, (salePrice * royaltyBps) / 10_000);
    }

    function setBaseURI(string calldata value) external onlyOwner {
        baseURI = value;
        _refreshAll();
    }

    function setContractURI(string calldata value) external onlyOwner {
        contractURI = value;
    }

    /** At most ten percent, so a royalty can never be set that eats a sale. */
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        require(bps <= 1000, "royalty too high");
        royaltyReceiver = receiver;
        royaltyBps = bps;
    }

    function setMinter(address value) external onlyOwner {
        minter = value;
    }

    function transferOwnership(address value) external onlyOwner {
        require(value != address(0), "no owner");
        owner = value;
    }

    /** Ask marketplaces to re-read one plot's picture — after its owner rebuilt it, say. */
    function refreshMetadata(uint256 seed) external onlyOwner {
        emit MetadataUpdate(seed);
    }

    /** Ask marketplaces to re-read every plot's picture. */
    function refreshAll() external onlyOwner {
        _refreshAll();
    }

    function _refreshAll() internal {
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function _decimal(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) digits++;
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            out[--digits] = bytes1(uint8(48 + v % 10));
        }
        return string(out);
    }

    /* ---------------------------------------------------------------- *
     * ERC-721 surface
     * ---------------------------------------------------------------- */

    function ownerOf(uint256 tokenId) public view returns (address) {
        address holder = _owners[tokenId];
        require(holder != address(0), "no owner");
        return holder;
    }

    function balanceOf(address who) external view returns (uint256) {
        require(who != address(0), "no such owner");
        return _balances[who];
    }

    function approve(address to, uint256 tokenId) external {
        address holder = ownerOf(tokenId);
        require(to != holder, "already owner");
        require(msg.sender == holder || _operatorApprovals[holder][msg.sender], "not allowed");
        _tokenApprovals[tokenId] = to;
        emit Approval(holder, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        require(_owners[tokenId] != address(0), "no such plot");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "self");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address holder, address operator) public view returns (bool) {
        return _operatorApprovals[holder][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "not allowed");
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        require(_acceptsTokens(from, to, tokenId, data), "receiver rejected");
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 Metadata
            || interfaceId == 0x2a55205a // ERC-2981
            || interfaceId == 0x49064906 // ERC-4906
            || interfaceId == 0x01ffc9a7; // ERC-165
    }

    /* ---------------------------------------------------------------- *
     * Internals
     * ---------------------------------------------------------------- */

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address holder = ownerOf(tokenId);
        return spender == holder
            || _tokenApprovals[tokenId] == spender
            || _operatorApprovals[holder][spender];
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(ownerOf(tokenId) == from, "not the owner");
        require(to != address(0), "no receiver");
        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _acceptsTokens(address from, address to, uint256 tokenId, bytes memory data)
        private
        returns (bool)
    {
        if (to.code.length == 0) return true;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 got) {
            return got == IERC721Receiver.onERC721Received.selector;
        } catch {
            return false;
        }
    }
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
