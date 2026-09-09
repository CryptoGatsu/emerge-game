/**
 * The land as tokens: the three contracts and where they live.
 *
 * `contracts/EmergeLand.sol` is the ERC-721 whose token id is the plot seed;
 * `contracts/EmergeRoyalties.sol` is where every marketplace pays the plot
 * holders' share of a resale; `contracts/EmergeMarket.sol` sells plots for
 * $EMERGE. This module is the one place their addresses and ABIs are written
 * down, for the browser and the server alike. Nothing here talks to a chain.
 *
 *   NEXT_PUBLIC_EMERGE_REGISTRY   the land contract — set, and plots are tokens
 *   NEXT_PUBLIC_EMERGE_MARKET     the market, optional
 *   NEXT_PUBLIC_EMERGE_ROYALTIES  the royalty receiver, optional
 *   (…_TESTNET variants of all three when NEXT_PUBLIC_CHAIN_TARGET=testnet)
 *   NEXT_PUBLIC_OPENSEA_CHAIN     OpenSea's slug for the chain, for links (default: robinhood)
 *   NEXT_PUBLIC_EMERGE_ROYALTY_BPS the royalty the land contract was deployed with (default 500 = 5%)
 */

import { ACTIVE_CHAIN } from './emerge';

const address = (raw: string | undefined | null) => (raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null);

/** The land contract: plots are tokens exactly when this is set. */
export const LAND_ADDRESS = address(ACTIVE_CHAIN.registryAddress);
// The testnet build reads its own addresses, as the token and land do, so a
// testnet deployment never points at mainnet contracts by accident.
const testnet = process.env.NEXT_PUBLIC_CHAIN_TARGET === 'testnet';
export const MARKET_ADDRESS = address(testnet ? process.env.NEXT_PUBLIC_EMERGE_MARKET_TESTNET : process.env.NEXT_PUBLIC_EMERGE_MARKET);
export const ROYALTIES_ADDRESS = address(testnet ? process.env.NEXT_PUBLIC_EMERGE_ROYALTIES_TESTNET : process.env.NEXT_PUBLIC_EMERGE_ROYALTIES);

/**
 * The holders' share of every resale, in basis points, as the land contract
 * was deployed with (`royaltyBps`). The contract is the authority — this is
 * what the interface and the collection metadata say, so keep them the same.
 */
export const ROYALTY_BPS = Math.max(0, Math.min(1000, Number(process.env.NEXT_PUBLIC_EMERGE_ROYALTY_BPS ?? 500) || 0));
export const ROYALTY_PERCENT = ROYALTY_BPS / 100;

/** Plots are ERC-721 tokens on this build. */
export const plotsAreTokens = () => LAND_ADDRESS !== null;
/** The in-game market can settle sales on chain. */
export const marketLive = () => plotsAreTokens() && MARKET_ADDRESS !== null;

/**
 * OpenSea's name for Robinhood Chain in its URLs — `opensea.io/token/robinhood/…`
 * is how it links the chain's ERC-20s — overridable should it change.
 */
export const OPENSEA_CHAIN = process.env.NEXT_PUBLIC_OPENSEA_CHAIN ?? (ACTIVE_CHAIN.key === 'robinhood' ? 'robinhood' : null);

/** The plot's page on OpenSea; null where plots are not tokens or the chain has no slug. */
export function openSeaUrl(seed: number): string | null {
  if (!OPENSEA_CHAIN || !LAND_ADDRESS) return null;
  return `https://opensea.io/item/${OPENSEA_CHAIN}/${LAND_ADDRESS}/${seed}`;
}

/** The token on the chain's explorer, in Blockscout's shape: the contract, then the instance. */
export function tokenExplorerUrl(seed: number): string | null {
  if (!ACTIVE_CHAIN.explorerUrl || !LAND_ADDRESS) return null;
  return `${ACTIVE_CHAIN.explorerUrl.replace(/\/$/, '')}/token/${LAND_ADDRESS}/instance/${seed}`;
}

export const LAND_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'mintedCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [{ name: 'start', type: 'uint256' }, { name: 'count', type: 'uint256' }], outputs: [{ name: 'seeds', type: 'uint256[]' }, { name: 'holders', type: 'address[]' }] },
  { type: 'function', name: 'tokensOf', stateMutability: 'view', inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'royaltyInfo', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'salePrice', type: 'uint256' }], outputs: [{ name: 'receiver', type: 'address' }, { name: 'royaltyAmount', type: 'uint256' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ name: 'holder', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'royaltyReceiver', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'royaltyBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint96' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'seed', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
  { type: 'function', name: 'mintBatch', stateMutability: 'nonpayable', inputs: [{ name: 'seeds', type: 'uint256[]' }, { name: 'to', type: 'address[]' }], outputs: [] },
  { type: 'function', name: 'burn', stateMutability: 'nonpayable', inputs: [{ name: 'seed', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'refreshMetadata', stateMutability: 'nonpayable', inputs: [{ name: 'seed', type: 'uint256' }], outputs: [] },
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }] },
] as const;

export const MARKET_ABI = [
  { type: 'function', name: 'listings', stateMutability: 'view', inputs: [{ name: 'seed', type: 'uint256' }], outputs: [{ name: 'seller', type: 'address' }, { name: 'price', type: 'uint256' }, { name: 'listedAt', type: 'uint64' }] },
  { type: 'function', name: 'listedCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'board', stateMutability: 'view', inputs: [{ name: 'start', type: 'uint256' }, { name: 'count', type: 'uint256' }], outputs: [{ name: 'seeds', type: 'uint256[]' }, { name: 'sellers', type: 'address[]' }, { name: 'prices', type: 'uint256[]' }, { name: 'live', type: 'bool[]' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'list', stateMutability: 'nonpayable', inputs: [{ name: 'seed', type: 'uint256' }, { name: 'price', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [{ name: 'seed', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ name: 'seed', type: 'uint256' }, { name: 'maxPrice', type: 'uint256' }], outputs: [] },
  { type: 'event', name: 'Sold', inputs: [{ name: 'seed', type: 'uint256', indexed: true }, { name: 'seller', type: 'address', indexed: true }, { name: 'buyer', type: 'address', indexed: true }, { name: 'price', type: 'uint256', indexed: false }, { name: 'fee', type: 'uint256', indexed: false }] },
] as const;

export const ROYALTIES_ABI = [
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'sweep', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;
