// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Emerge — where plot royalties land.
 *
 * The land contract names this as its ERC-2981 receiver, so every marketplace
 * that honours creator earnings — OpenSea, the game's own market — pays the
 * royalty on a plot sale here, in whatever the sale was priced in: $EMERGE,
 * the chain's own coin, or any other token.
 *
 * Nothing stays here. `sweep` forwards whatever has arrived to the vault,
 * and the game books what arrived into the holders' dividend pool, so a
 * trading fee on land goes back to the people who hold land. Anybody may
 * call `sweep`; the only thing the owner controls is which vault it goes to.
 *
 * Written without imports so it can be dropped into Remix and deployed as
 * one file.
 */
contract EmergeRoyalties {
    address public owner;
    /** Where every sweep goes: the game's vault. */
    address public vault;

    /** Raised on every sweep, with the token (zero for the chain's own coin) and what moved. */
    event Swept(address indexed token, uint256 amount, address indexed by);
    event VaultChanged(address indexed vault);

    constructor(address vault_) {
        require(vault_ != address(0), "no vault");
        owner = msg.sender;
        vault = vault_;
    }

    /** The chain's own coin, sent by a marketplace settling in it. */
    receive() external payable {}

    /**
     * Forward everything held in `token` to the vault. Pass the zero address
     * for the chain's own coin. Anybody may call it; there is nowhere else
     * the money can go.
     */
    function sweep(address token) external returns (uint256 amount) {
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount == 0) return 0;
            (bool sent, ) = vault.call{value: amount}("");
            require(sent, "send failed");
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (amount == 0) return 0;
            require(IERC20(token).transfer(vault, amount), "transfer failed");
        }
        emit Swept(token, amount, msg.sender);
    }

    function setVault(address value) external {
        require(msg.sender == owner, "not owner");
        require(value != address(0), "no vault");
        vault = value;
        emit VaultChanged(value);
    }

    function transferOwnership(address value) external {
        require(msg.sender == owner, "not owner");
        require(value != address(0), "no owner");
        owner = value;
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
