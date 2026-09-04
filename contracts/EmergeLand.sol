// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Emerge — the land registry.
 *
 * One plot, one owner, on chain and checkable by anybody. A plot's token id is
 * the seed that generates its terrain, so the thing you own and the thing the
 * game draws are the same number: nobody has to trust a server to tell them
 * who holds Fernrest Vale.
 *
 * ERC-721 rather than a bare mapping, so a plot shows up in a wallet, on an
 * explorer and on any marketplace without this contract needing to know those
 * exist. Written without imports so it can be dropped into Remix and deployed
 * as one file.
 *
 * ## What claiming costs, and where it goes
 *
 * `claim` pulls the price in $EMERGE from the caller and sends it straight to
 * the burn address in the same transaction. There is no window in which this
 * contract holds anybody's tokens, and no path by which the owner can take
 * them: the transfer is caller → burn, and this contract is only the thing
 * that requires it to have happened.
 *
 * The price is derived from the seed on chain, using the same hash the game
 * uses to decide a plot's biome, so a claim cannot be underpaid and the price
 * shown before you sign is the price the contract will charge.
 *
 * ## Deployment
 *
 * 1. Deploy with the $EMERGE token address, a burn address, and whether the
 *    token can burn its own supply (`burnByCall`).
 * 2. Set `NEXT_PUBLIC_EMERGE_REGISTRY` to this contract's address.
 * 3. Players call `approve(registry, amount)` on the token once, then claim.
 *
 * For a Pons v2 launch, or any token carrying OpenZeppelin's `ERC20Burnable`,
 * deploy with `burnByCall = true` and the payment is genuinely destroyed. For a
 * token without it, pass false and a burn address the token will accept —
 * **not** the zero address, which OpenZeppelin's `_transfer` reverts on.
 *
 * `setBasePrice`, `setBiomePremium` and `setBurnAddress` let the owner tune
 * pricing and move the burn target. The owner cannot take a plot, cannot move
 * a plot, and cannot touch the token — the only privileged actions are
 * pricing and where burns are sent.
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

    /** What each owner called their world. Cosmetic, and theirs to change. */
    mapping(uint256 => string) public worldName;

    /** Every seed ever claimed, so the whole registry can be read back. */
    uint256[] public claimed;

    /**
     * Whether a seed is already in `claimed`.
     *
     * `claimed` is an index for reading the registry back, not a record of
     * ownership — `_owners` is that. A plot given up and taken again would
     * otherwise be pushed twice, so `claimedCount` would over-report and a page
     * of `registry` would carry the same seed at two positions. Both harmless
     * to a caller that keys by seed, and both wrong to one that counts.
     */
    mapping(uint256 => bool) private _indexed;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /** Raised when a plot is settled, with what it cost and what it is called. */
    event Claimed(uint256 indexed seed, address indexed owner, uint256 price, string worldName);
    /** Raised when a plot is given up and goes back on the market. */
    event Released(uint256 indexed seed, address indexed owner);
    event Renamed(uint256 indexed seed, string worldName);

    /* ---------------------------------------------------------------- *
     * Configuration
     * ---------------------------------------------------------------- */

    address public owner;

    /** The $EMERGE token. Set once at deployment and never movable. */
    IERC20 public immutable token;

    /**
     * Where claim fees go. Not held here, not withdrawable by anybody: the
     * token moves caller → burn inside `claim`, in one transaction.
     */
    address public burnAddress;

    /**
     * Whether payment is destroyed with `burnFrom` rather than sent to
     * `burnAddress`.
     *
     * True for any token with OpenZeppelin's `ERC20Burnable`. Note that most
     * OpenZeppelin tokens *revert* on a transfer to the zero address, so a
     * deployment that leaves this false must give `burnAddress` a real one —
     * `0x…dEaD` — or every claim will fail.
     */
    bool public burnByCall;

    /** The floor a plot costs, before what the land is worth. */
    uint256 public basePrice;

    /**
     * What each of the nine biomes adds, in whole tokens before scaling.
     *
     * Indexed the same way the game indexes them, and derived from the seed by
     * the same hash, so the two cannot disagree about what a plot costs.
     */
    uint256[9] public biomePremium;

    /** Multiplies the base and premium into token units. */
    uint256 public priceScale;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address tokenAddress, address burnTo, bool burnByCall_) {
        owner = msg.sender;
        token = IERC20(tokenAddress);
        burnAddress = burnTo;
        burnByCall = burnByCall_;

        // Matching the game's own numbers at deployment. All adjustable after.
        basePrice = 180;
        priceScale = 800 * 1e18;
        // In `BIOME_KINDS` order, which is the order `biomeOf` indexes into:
        // valley, woodland, highland, wetland, steppe, coast, desert, swamp, grassland.
        // Taken from `BIOME_PREMIUM` in lib/world/plots.ts. The order is not
        // alphabetical and not the order they are written about anywhere else,
        // so it is checked against the game rather than assumed.
        biomePremium = [uint256(190), 120, 165, 110, 95, 130, 85, 100, 175];
    }

    /* ---------------------------------------------------------------- *
     * Pricing
     * ---------------------------------------------------------------- */

    /**
     * Which biome a seed grows, 0-8.
     *
     * A direct port of `biomeKindFor` in `lib/world/biomes.ts`: the same
     * 32-bit mix, so the chain and the game always name the same land. The
     * casts to uint32 are what make `Math.imul` and `>>> 13` mean here what
     * they mean in JavaScript.
     */
    function biomeOf(uint256 seed) public pure returns (uint256) {
        unchecked {
            uint32 h = uint32(seed) ^ 0x9e3779b9;
            h = uint32(uint256(h) * 0x85ebca6b);
            h ^= h >> 13;
            h = uint32(uint256(h) * 0xc2b2ae35);
            // JavaScript's `Math.abs` on a signed 32-bit value: the sign bit is
            // dropped, and -2147483648 maps to itself.
            uint32 magnitude = h & 0x80000000 != 0 ? uint32(0 - h) : h;
            return uint256(magnitude) % 9;
        }
    }

    /** What a plot costs, in token units. Read this before asking to claim. */
    function priceOf(uint256 seed) public view returns (uint256) {
        return (basePrice + biomePremium[biomeOf(seed)]) * priceScale;
    }

    /* ---------------------------------------------------------------- *
     * Claiming
     * ---------------------------------------------------------------- */

    /**
     * Settle a plot.
     *
     * Requires an ERC-20 allowance for at least `priceOf(seed)`. The whole
     * price is burned in this transaction; nothing is retained.
     *
     * `maxPrice` is the caller's protection against the owner raising the
     * price between them reading it and signing. Pass the price you were
     * shown.
     */
    function claim(uint256 seed, string calldata worldName_, uint256 maxPrice) external {
        require(seed != 0, "no such plot");
        require(_owners[seed] == address(0), "already settled");

        uint256 price = priceOf(seed);
        require(price <= maxPrice, "price moved");

        /*
         * Destroy the payment, by whichever route the token allows.
         *
         * `burnFrom` is the real thing: total supply falls and anybody counting
         * how much $EMERGE exists sees it. It needs `ERC20Burnable`, which every
         * Pons v2 launch carries but not every token does — so the transfer to a
         * dead address stays as the fallback for one that does not.
         *
         * Both spend the same allowance the player already granted, so the
         * choice changes nothing about what they sign.
         */
        if (burnByCall) {
            token.burnFrom(msg.sender, price);
        } else {
            require(token.transferFrom(msg.sender, burnAddress, price), "payment failed");
        }

        _owners[seed] = msg.sender;
        _balances[msg.sender] += 1;
        worldName[seed] = worldName_;
        if (!_indexed[seed]) {
            _indexed[seed] = true;
            claimed.push(seed);
        }

        emit Transfer(address(0), msg.sender, seed);
        emit Claimed(seed, msg.sender, price, worldName_);
    }

    /** Give a plot up. It goes back on the market for anybody to take. */
    function release(uint256 seed) external {
        address holder = _owners[seed];
        require(holder == msg.sender, "not yours");
        _burnPlot(seed, holder);
        emit Released(seed, holder);
    }

    /** Rename your world. Free, and only the owner may. */
    function rename(uint256 seed, string calldata worldName_) external {
        require(_owners[seed] == msg.sender, "not yours");
        worldName[seed] = worldName_;
        emit Renamed(seed, worldName_);
    }

    /** How many plots have ever been claimed, for reading the registry back. */
    function claimedCount() external view returns (uint256) {
        return claimed.length;
    }

    /**
     * A page of the registry: seeds, their owners and their names.
     *
     * Included so the game can show every plot anybody holds in one call
     * rather than one call per plot. A released plot reads as owner zero.
     */
    function registry(uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory seeds, address[] memory owners, string[] memory names)
    {
        uint256 end = start + count;
        if (end > claimed.length) end = claimed.length;
        uint256 size = end > start ? end - start : 0;
        seeds = new uint256[](size);
        owners = new address[](size);
        names = new string[](size);
        for (uint256 i = 0; i < size; i++) {
            uint256 seed = claimed[start + i];
            seeds[i] = seed;
            owners[i] = _owners[seed];
            names[i] = worldName[seed];
        }
    }

    /* ---------------------------------------------------------------- *
     * Owner controls — pricing and the burn target, nothing else
     * ---------------------------------------------------------------- */

    function setBasePrice(uint256 value) external onlyOwner { basePrice = value; }
    function setPriceScale(uint256 value) external onlyOwner { priceScale = value; }
    function setBiomePremium(uint256 index, uint256 value) external onlyOwner {
        require(index < 9, "no such biome");
        biomePremium[index] = value;
    }
    function setBurnAddress(address value) external onlyOwner { burnAddress = value; }
    function setBurnByCall(bool value) external onlyOwner { burnByCall = value; }
    function transferOwnership(address value) external onlyOwner { owner = value; }

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

    function _burnPlot(uint256 tokenId, address holder) internal {
        delete _tokenApprovals[tokenId];
        delete worldName[tokenId];
        _balances[holder] -= 1;
        delete _owners[tokenId];
        emit Transfer(holder, address(0), tokenId);
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

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    /// OpenZeppelin's `ERC20Burnable`. Spends the caller's allowance, then destroys.
    function burnFrom(address account, uint256 amount) external;
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
