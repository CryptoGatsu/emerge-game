/**
 * The land as tokens, from the browser's side.
 *
 * `contracts/EmergeLand.sol` is an ERC-721 in which **the token id is the plot
 * seed** — the same number that generates the terrain. A plot is not a row in
 * our database that happens to mention a wallet: it is a token in that wallet,
 * transferable, visible in any explorer and on any marketplace, and readable
 * by anybody without asking this game anything.
 *
 * The game still sells land the way it always has — a claim is paid for in
 * $EMERGE and verified off the chain — and then the plot is minted to the
 * buyer. What changes is everything after: a plot changes hands as a token,
 * on OpenSea or in the game's own market (`contracts/EmergeMarket.sol`,
 * priced in $EMERGE), and the game follows the chain.
 *
 * Every function here answers rather than throwing, and every one degrades
 * to "plots are not tokens on this build" rather than pretending.
 */

import { encodeFunctionData, decodeFunctionResult, type Abi, type Hex } from 'viem';
import { ACTIVE_CHAIN, TOKEN, activeProvider, ethCall, rpc, tokenLive, walletAvailable, type ChainConfig } from './emerge';
import { ERC20_ABI, LAND_ABI, LAND_ADDRESS, MARKET_ABI, MARKET_ADDRESS, marketLive, openSeaUrl, plotsAreTokens, tokenExplorerUrl } from './plots';

export { openSeaUrl, plotsAreTokens, marketLive };

/**
 * True once plots are tokens on this build. The name is kept from the earlier
 * design, where a claim was itself the on-chain transaction; today a claim is
 * paid to the game and the token follows.
 */
export const onChainClaimsLive = (config: ChainConfig = ACTIVE_CHAIN) => plotsAreTokens() && !!config.registryAddress;

export function plotExplorerUrl(seed: number): string | null {
  return tokenExplorerUrl(seed);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function read<T>(to: string, abi: Abi, functionName: string, args: unknown[]): Promise<T | null> {
  try {
    const data = encodeFunctionData({ abi, functionName, args });
    const raw = await ethCall(to, data);
    if (!raw || raw === '0x') return null;
    return decodeFunctionResult({ abi, functionName, data: raw as Hex }) as T;
  } catch {
    return null;
  }
}

export interface RegistryPlot { seed: number; owner: string }

/** Every minted plot and who holds it, or null when the chain cannot be read. */
export async function allOnChainPlots(): Promise<RegistryPlot[] | null> {
  if (!LAND_ADDRESS) return null;
  const total = await read<bigint>(LAND_ADDRESS, LAND_ABI as Abi, 'mintedCount', []);
  if (total === null) return null;
  const out: RegistryPlot[] = [];
  for (let start = 0n; start < total; start += 200n) {
    const page = await read<readonly [readonly bigint[], readonly string[]]>(LAND_ADDRESS, LAND_ABI as Abi, 'registry', [start, 200n]);
    if (!page) return null;
    page[0].forEach((seed, i) => { const owner = page[1][i].toLowerCase(); if (!/^0x0+$/.test(owner)) out.push({ seed: Number(seed), owner }); });
  }
  return out;
}

/** Who holds a plot on chain: null when nobody, undefined when the chain could not be read. */
export async function holderOf(seed: number): Promise<string | null | undefined> {
  if (!LAND_ADDRESS) return undefined;
  try {
    const data = encodeFunctionData({ abi: LAND_ABI, functionName: 'ownerOf', args: [BigInt(seed)] });
    const raw = await ethCall(LAND_ADDRESS, data);
    if (!raw || raw === '0x') return null;
    const who = decodeFunctionResult({ abi: LAND_ABI, functionName: 'ownerOf', data: raw as Hex });
    return /^0x0+$/.test(who) ? null : who.toLowerCase();
  } catch (error) {
    // A revert is "no owner"; a network failure is unknown.
    const message = error instanceof Error ? error.message : String(error);
    return /revert|no owner|execution/i.test(message) ? null : undefined;
  }
}

export interface MarketListing { seed: number; seller: string; price: number; live: boolean }

/** A plot's listing on the market, if any. */
export async function marketListing(seed: number): Promise<MarketListing | null> {
  if (!MARKET_ADDRESS) return null;
  const row = await read<readonly [string, bigint, bigint]>(MARKET_ADDRESS, MARKET_ABI as Abi, 'listings', [BigInt(seed)]);
  if (!row || /^0x0+$/.test(row[0])) return null;
  return { seed, seller: row[0].toLowerCase(), price: Number(row[1] / 10n ** 18n), live: true };
}

/** The whole market board. */
export async function marketBoard(): Promise<MarketListing[]> {
  if (!MARKET_ADDRESS) return [];
  const total = await read<bigint>(MARKET_ADDRESS, MARKET_ABI as Abi, 'listedCount', []);
  if (total === null) return [];
  const out: MarketListing[] = [];
  for (let start = 0n; start < total; start += 200n) {
    const page = await read<readonly [readonly bigint[], readonly string[], readonly bigint[], readonly boolean[]]>(MARKET_ADDRESS, MARKET_ABI as Abi, 'board', [start, 200n]);
    if (!page) break;
    page[0].forEach((seed, i) => out.push({ seed: Number(seed), seller: page[1][i].toLowerCase(), price: Number(page[2][i] / 10n ** 18n), live: page[3][i] }));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Signing
 * ------------------------------------------------------------------ */

type Sent = { ok: true; txHash: string } | { ok: false; message: string };

async function send(from: string, to: string, data: string): Promise<Sent> {
  const provider = activeProvider();
  if (!provider || !walletAvailable()) return { ok: false, message: 'Connect a wallet first.' };
  try {
    const txHash = (await provider.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] })) as string;
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, message: 'The wallet did not return a transaction hash.' };
    return { ok: true, txHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The wallet refused.';
    return { ok: false, message: /rejected|denied|cancel/i.test(message) ? 'You cancelled the signature.' : message.slice(0, 200) };
  }
}

/** Wait for a transaction to be mined, up to about a minute. */
export async function mined(txHash: string, tries = 30): Promise<'success' | 'reverted' | 'pending'> {
  for (let i = 0; i < tries; i++) {
    try {
      const receipt = await ethReceipt(txHash);
      if (receipt) return receipt.status === '0x1' ? 'success' : 'reverted';
    } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return 'pending';
}

async function ethReceipt(txHash: string): Promise<{ status: string } | null> {
  return rpc<{ status: string } | null>('eth_getTransactionReceipt', [txHash]);
}

/** Give a plot up: burn the token. Only the holder's wallet can sign this. */
export async function burnPlotOnChain(from: string, seed: number): Promise<Sent> {
  if (!LAND_ADDRESS) return { ok: false, message: 'Plots are not tokens on this build.' };
  return send(from, LAND_ADDRESS, encodeFunctionData({ abi: LAND_ABI, functionName: 'burn', args: [BigInt(seed)] }));
}

/** Whether the market may move this wallet's plots. */
export async function marketApproved(owner: string): Promise<boolean> {
  if (!LAND_ADDRESS || !MARKET_ADDRESS) return false;
  return (await read<boolean>(LAND_ADDRESS, LAND_ABI as Abi, 'isApprovedForAll', [owner as Hex, MARKET_ADDRESS as Hex])) === true;
}

/** Let the market move this wallet's plots when they sell. One signature, once. */
export async function approveMarket(from: string): Promise<Sent> {
  if (!LAND_ADDRESS || !MARKET_ADDRESS) return { ok: false, message: 'The market is not deployed on this build.' };
  return send(from, LAND_ADDRESS, encodeFunctionData({ abi: LAND_ABI, functionName: 'setApprovalForAll', args: [MARKET_ADDRESS as Hex, true] }));
}

/** List a plot on the market at a price in whole $EMERGE. */
export async function listOnChain(from: string, seed: number, price: number): Promise<Sent> {
  if (!MARKET_ADDRESS) return { ok: false, message: 'The market is not deployed on this build.' };
  if (!(price > 0)) return { ok: false, message: 'Name a price.' };
  return send(from, MARKET_ADDRESS, encodeFunctionData({ abi: MARKET_ABI, functionName: 'list', args: [BigInt(seed), BigInt(Math.round(price)) * 10n ** 18n] }));
}

export async function cancelOnChain(from: string, seed: number): Promise<Sent> {
  if (!MARKET_ADDRESS) return { ok: false, message: 'The market is not deployed on this build.' };
  return send(from, MARKET_ADDRESS, encodeFunctionData({ abi: MARKET_ABI, functionName: 'cancel', args: [BigInt(seed)] }));
}

/** What the buyer has let the market spend, in whole $EMERGE. */
export async function marketAllowance(owner: string): Promise<number> {
  if (!MARKET_ADDRESS || !tokenLive() || !ACTIVE_CHAIN.tokenAddress) return 0;
  const raw = await read<bigint>(ACTIVE_CHAIN.tokenAddress, ERC20_ABI as Abi, 'allowance', [owner as Hex, MARKET_ADDRESS as Hex]);
  return raw === null ? 0 : Number(raw / 10n ** 18n);
}

/** Let the market take the price from the buyer. */
export async function approveMarketSpend(from: string, price: number): Promise<Sent> {
  if (!MARKET_ADDRESS || !ACTIVE_CHAIN.tokenAddress) return { ok: false, message: 'The market is not deployed on this build.' };
  return send(from, ACTIVE_CHAIN.tokenAddress, encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [MARKET_ADDRESS as Hex, BigInt(Math.round(price)) * 10n ** 18n] }));
}

/** Buy a listed plot at the price shown; the contract refuses if it moved. */
export async function buyOnChain(from: string, seed: number, price: number): Promise<Sent> {
  if (!MARKET_ADDRESS) return { ok: false, message: 'The market is not deployed on this build.' };
  return send(from, MARKET_ADDRESS, encodeFunctionData({ abi: MARKET_ABI, functionName: 'buy', args: [BigInt(seed), BigInt(Math.round(price)) * 10n ** 18n] }));
}

export const marketTicker = () => TOKEN.ticker;
