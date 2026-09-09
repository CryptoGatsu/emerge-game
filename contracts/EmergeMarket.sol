// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Emerge — the land market, priced in $EMERGE.
 *
 * A holder lists a plot at a price; a buyer pays it in $EMERGE and the plot
 * moves in the same transaction. Nothing is escrowed: the seller keeps the
 * plot in their own wallet until it sells and merely approves this contract
 * to move it, and the buyer's $EMERGE goes straight to the seller and the
 * royalty receiver. This contract never holds a token or a plot of anybody's.
 *
 * The fee on a sale is whatever the land contract's ERC-2981 says — the same
 * royalty every other marketplace pays — and it goes to the same receiver,
 * so a sale here and a sale on OpenSea feed the holders' pool alike.
 *
 * A listing is only as good as the seller's approval and holding: if the
 * plot has moved or the approval was withdrawn, `buy` refuses rather than
 * moving something the seller no longer has to sell. Written without
 * imports so it can be dropped into Remix and deployed as one file.
 */
contract EmergeMarket {
    struct Listing {
        address seller;
        uint256 price;
        uint64 listedAt;
    }

    address public owner;
    /** The land contract, whose plots are sold here. */
    IEmergeLand public immutable land;
    /** The token a sale is priced in: $EMERGE. */
    IERC20 public immutable token;
    /** The owner can stop new sales while keeping every listing in place. */
    bool public paused;

    mapping(uint256 => Listing) public listings;
    /** Every seed with a live listing, so the board can be read in one call. */
    uint256[] private _listed;
    /** Position in `_listed`, plus one; zero means not listed. */
    mapping(uint256 => uint256) private _position;

    event Listed(uint256 indexed seed, address indexed seller, uint256 price);
    event Cancelled(uint256 indexed seed, address indexed seller);
    event Sold(uint256 indexed seed, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event Paused(bool paused);

    uint256 private _entered = 1;
    modifier nonReentrant() {
        require(_entered == 1, "reentered");
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address land_, address token_) {
        require(land_ != address(0) && token_ != address(0), "no contracts");
        owner = msg.sender;
        land = IEmergeLand(land_);
        token = IERC20(token_);
    }

    /* ---------------------------------------------------------------- *
     * Listing
     * ---------------------------------------------------------------- */

    /**
     * Put a plot up at `price` whole units of $EMERGE (in the token's own
     * decimals). The caller must hold the plot and have approved this
     * contract for it — `approve(market, seed)` or `setApprovalForAll`.
     * Listing again replaces the price.
     */
    function list(uint256 seed, uint256 price) external {
        require(price > 0, "name a price");
        require(land.ownerOf(seed) == msg.sender, "not yours");
        require(_mayMove(msg.sender, seed), "approve the market first");
        listings[seed] = Listing({ seller: msg.sender, price: price, listedAt: uint64(block.timestamp) });
        if (_position[seed] == 0) {
            _listed.push(seed);
            _position[seed] = _listed.length;
        }
        emit Listed(seed, msg.sender, price);
    }

    /** Take a plot down. The seller may; so may whoever now holds a plot that was sold or moved elsewhere. */
    function cancel(uint256 seed) external {
        Listing memory it = listings[seed];
        require(it.seller != address(0), "not listed");
        address holder = _holder(seed);
        require(msg.sender == it.seller || msg.sender == holder, "not yours");
        _drop(seed);
        emit Cancelled(seed, it.seller);
    }

    /* ---------------------------------------------------------------- *
     * Buying
     * ---------------------------------------------------------------- */

    /**
     * Buy a listed plot. `maxPrice` is the buyer's protection against the
     * seller raising the price between the buyer reading it and signing:
     * pass the price you were shown. The buyer must have approved this
     * contract to spend at least the price in $EMERGE.
     *
     * Order: the listing is taken down first, then the money moves, then the
     * plot. A transfer that fails reverts the whole thing.
     */
    function buy(uint256 seed, uint256 maxPrice) external nonReentrant {
        require(!paused, "market paused");
        Listing memory it = listings[seed];
        require(it.seller != address(0), "not for sale");
        require(it.price <= maxPrice, "price moved");
        require(msg.sender != it.seller, "your own plot");
        // Still theirs, and still ours to move: a plot sold elsewhere or
        // pulled back is not for sale here whatever the listing says.
        require(land.ownerOf(seed) == it.seller, "not for sale");
        require(_mayMove(it.seller, seed), "not for sale");

        _drop(seed);

        (address receiver, uint256 fee) = land.royaltyInfo(seed, it.price);
        if (fee > it.price) fee = it.price;
        if (fee > 0 && receiver != address(0)) {
            require(token.transferFrom(msg.sender, receiver, fee), "fee failed");
        } else {
            fee = 0;
        }
        require(token.transferFrom(msg.sender, it.seller, it.price - fee), "payment failed");
        land.transferFrom(it.seller, msg.sender, seed);
        require(land.ownerOf(seed) == msg.sender, "plot did not move");

        emit Sold(seed, it.seller, msg.sender, it.price, fee);
    }

    /* ---------------------------------------------------------------- *
     * Reading the board
     * ---------------------------------------------------------------- */

    /** How many listings stand, for paging `board`. */
    function listedCount() external view returns (uint256) {
        return _listed.length;
    }

    /**
     * A page of the board: seeds, sellers, prices, and whether each listing
     * is still good — the seller still holds the plot and this contract may
     * still move it. A stale one is shown so a holder can take it down.
     */
    function board(uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory seeds, address[] memory sellers, uint256[] memory prices, bool[] memory live)
    {
        uint256 end = start + count;
        if (end > _listed.length) end = _listed.length;
        uint256 size = end > start ? end - start : 0;
        seeds = new uint256[](size);
        sellers = new address[](size);
        prices = new uint256[](size);
        live = new bool[](size);
        for (uint256 i = 0; i < size; i++) {
            uint256 seed = _listed[start + i];
            Listing memory it = listings[seed];
            seeds[i] = seed;
            sellers[i] = it.seller;
            prices[i] = it.price;
            live[i] = _holder(seed) == it.seller && _mayMove(it.seller, seed);
        }
    }

    /* ---------------------------------------------------------------- *
     * Owner controls — pausing new sales, nothing else
     * ---------------------------------------------------------------- */

    function setPaused(bool value) external {
        require(msg.sender == owner, "not owner");
        paused = value;
        emit Paused(value);
    }

    function transferOwnership(address value) external {
        require(msg.sender == owner, "not owner");
        require(value != address(0), "no owner");
        owner = value;
    }

    /* ---------------------------------------------------------------- *
     * Internals
     * ---------------------------------------------------------------- */

    function _mayMove(address seller, uint256 seed) internal view returns (bool) {
        return land.isApprovedForAll(seller, address(this)) || land.getApproved(seed) == address(this);
    }

    /** The plot's holder, or zero when it has been burnt. */
    function _holder(uint256 seed) internal view returns (address) {
        try land.ownerOf(seed) returns (address who) {
            return who;
        } catch {
            return address(0);
        }
    }

    function _drop(uint256 seed) internal {
        uint256 pos = _position[seed];
        if (pos != 0) {
            uint256 last = _listed[_listed.length - 1];
            _listed[pos - 1] = last;
            _position[last] = pos;
            _listed.pop();
            delete _position[seed];
        }
        delete listings[seed];
    }
}

interface IEmergeLand {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address holder, address operator) external view returns (bool);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
