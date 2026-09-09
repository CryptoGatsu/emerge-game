import 'server-only';

/**
 * Plots as tokens, from the server's side.
 *
 * The game sells land the way it always has: a claim is paid for in $EMERGE,
 * verified off the chain and written as a row. Once the land contract is
 * deployed, that row is also minted as a token to the buyer, by the vault
 * key, which the contract names as its minter. From then on the chain is the
 * title: a plot sold on OpenSea or in the game's market changes hands there,
 * and `syncOwners` brings the rows into line with it, so the world map, the
 * dividend weights and every "is this plot yours" check follow the token.
 *
 * Minting is queued rather than done inline. A claim must never fail because
 * the chain was slow, and a mint must never be sent twice because a reply
 * was lost — so the queue is drained under a lock, each seed is checked on
 * chain before it goes, and a batch that may have been sent is written down
 * with its hash until the chain says one way or the other.
 *
 * Royalties from resales land in the royalty receiver. `sweepRoyalties`
 * moves them to the vault and books the $EMERGE into the holders' dividend
 * pool, so a trading fee on land goes back to the people who hold land.
 */

import { createPublicClient, defineChain, encodeFunctionData, http, type Hex } from 'viem';
import { ACTIVE_CHAIN, TOKEN, tokenLive } from '../chain/emerge';
import { ERC20_ABI, LAND_ABI, LAND_ADDRESS, MARKET_ABI, MARKET_ADDRESS, ROYALTIES_ABI, ROYALTIES_ADDRESS, plotsAreTokens } from '../chain/plots';
import { serverKey } from '../limits';
import { counter, getValue, hdel, hget, hgetall, hset, incrBy, push, range, releaseLock, setValue, takeLock } from './kv';
import { allClaims, claimOf, displayNames, publishWorld, readPlayerRecord, readWorld, savePlayerRecord, type Claim } from './registry';
import { callFromVault, receiptOf, vaultAddress, vaultCanSign } from './signer';
import { DIVIDEND_POOL } from './treasury';
import { forgetLandMarket } from './landMarket';

const chain = () => defineChain({
  id: ACTIVE_CHAIN.chainId ?? 4663,
  name: ACTIVE_CHAIN.label,
  nativeCurrency: { name: 'Robinhood', symbol: 'RH', decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } },
});
const reader = () => createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });

const MINT_QUEUE = serverKey('nft:mint-queue');
const MINTED = serverKey('nft:minted');
const IN_FLIGHT = serverKey('nft:mint-in-flight');
const SYNC_LOCK = serverKey('nft:sync-lock');
const MINT_LOCK = serverKey('nft:mint-lock');
const LAST_SYNC = serverKey('nft:last-sync');
const TRANSFERS = serverKey('nft:transfers');
const ROYALTY_LEDGER = serverKey('nft:royalties');
const ROYALTY_HELD = (token: string) => serverKey(`nft:royalties:held:${token.toLowerCase()}`);
const ZERO = '0x0000000000000000000000000000000000000000';

export const nftLive = plotsAreTokens;

/* ------------------------------------------------------------------ *
 * Reading the chain
 * ------------------------------------------------------------------ */

/** Every minted seed and who holds it; a burnt plot reads as null. */
export async function readRegistry(): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (!LAND_ADDRESS) return out;
  const client = reader();
  const total = Number(await client.readContract({ address: LAND_ADDRESS as Hex, abi: LAND_ABI, functionName: 'mintedCount' }));
  const PAGE = 200;
  for (let start = 0; start < total; start += PAGE) {
    const [seeds, holders] = await client.readContract({ address: LAND_ADDRESS as Hex, abi: LAND_ABI, functionName: 'registry', args: [BigInt(start), BigInt(PAGE)] });
    seeds.forEach((seed, i) => {
      const holder = holders[i].toLowerCase();
      out.set(Number(seed), holder === ZERO ? null : holder);
    });
  }
  return out;
}

/** Who holds a plot on chain: null when it is not minted or was burnt. Throws when the chain cannot be reached. */
export async function holderOnChain(seed: number): Promise<string | null> {
  if (!LAND_ADDRESS) return null;
  try {
    const who = await reader().readContract({ address: LAND_ADDRESS as Hex, abi: LAND_ABI, functionName: 'ownerOf', args: [BigInt(seed)] });
    return who.toLowerCase() === ZERO ? null : who.toLowerCase();
  } catch (error) {
    // `ownerOf` reverts for a plot nobody holds: an answer. A network error is not.
    const message = error instanceof Error ? error.message : '';
    if (/no owner|revert|execution reverted/i.test(message)) return null;
    throw error;
  }
}

/**
 * Whether this wallet holds this plot, as the game should judge it before
 * spending anything on it. The row is the quick answer; where plots are
 * tokens the chain is asked too, and disagreement means the row is stale —
 * the sync is nudged and the chain's word is used. A chain that cannot be
 * reached falls back to the row: a network blip must not lock a player out
 * of their own land.
 */
export async function holdsPlot(claim: Claim | null, owner: string): Promise<boolean> {
  const me = owner.toLowerCase();
  if (!claim || claim.owner.toLowerCase() !== me) {
    if (!nftLive() || !claim) return false;
    try {
      const holder = await holderOnChain(claim.seed);
      if (holder === me) { void syncOwners().catch(() => {}); return true; }
    } catch { /* the row stands */ }
    return false;
  }
  if (!nftLive()) return true;
  try {
    const holder = await holderOnChain(claim.seed);
    if (holder !== null && holder !== me) { void syncOwners().catch(() => {}); return false; }
  } catch { /* the row stands */ }
  return true;
}

/* ------------------------------------------------------------------ *
 * Minting
 * ------------------------------------------------------------------ */

export interface QueuedMint { seed: number; to: string; at: number; tries: number; problem?: string }

/** Ask for a plot to be minted to its holder. Idempotent: a seed already queued keeps its first entry. */
export async function queueMint(seed: number, to: string): Promise<void> {
  if (!nftLive()) return;
  const held = await hget(MINT_QUEUE, String(seed));
  if (held) return;
  await hset(MINT_QUEUE, String(seed), JSON.stringify({ seed, to: to.toLowerCase(), at: Date.now(), tries: 0 } satisfies QueuedMint));
}

export async function mintQueue(): Promise<QueuedMint[]> {
  const rows = await hgetall(MINT_QUEUE);
  return Object.values(rows).map((raw) => { try { return JSON.parse(raw) as QueuedMint; } catch { return null; } }).filter((q): q is QueuedMint => !!q).sort((a, b) => a.at - b.at);
}

export type Flushed = { minted: number; skipped: number; waiting: number; txHash: string | null; problem?: string };

/**
 * Mint what is waiting, in one batch of up to thirty.
 *
 * Every seed is checked on chain first: one already held by its claimant is
 * done and dropped; one held by somebody else is dropped with a note, since
 * the chain outranks the queue; the rest go in a `mintBatch`. A batch whose
 * reply was lost is kept as in flight with its hash, and nothing more is
 * minted until its receipt is read.
 */
export async function flushMints(limit = 30): Promise<Flushed> {
  if (!nftLive()) return { minted: 0, skipped: 0, waiting: 0, txHash: null, problem: 'Plots are not tokens on this build.' };
  if (!vaultCanSign()) return { minted: 0, skipped: 0, waiting: (await mintQueue()).length, txHash: null, problem: 'The vault is not configured to sign.' };
  if (!(await takeLock(MINT_LOCK, 120))) return { minted: 0, skipped: 0, waiting: (await mintQueue()).length, txHash: null, problem: 'A mint is already being sent.' };
  try {
    // A batch in flight settles first, one way or the other.
    const flying = await getValue(IN_FLIGHT);
    if (flying) {
      const { txHash, seeds } = JSON.parse(flying) as { txHash: string; seeds: number[]; at: number };
      const state = await receiptOf(txHash);
      if (state === 'pending') return { minted: 0, skipped: 0, waiting: (await mintQueue()).length, txHash, problem: 'The last batch is still settling.' };
      if (state === 'success') {
        for (const seed of seeds) { await hdel(MINT_QUEUE, String(seed)); await hset(MINTED, String(seed), txHash); }
      }
      // Reverted or missing: the seeds stay queued and are checked on chain below.
      await setValue(IN_FLIGHT, '', 1);
    }
    const queue = await mintQueue();
    const batch: QueuedMint[] = [];
    let skipped = 0;
    for (const q of queue) {
      if (batch.length >= limit) break;
      const holder = await holderOnChain(q.seed);
      if (holder === q.to) { await hdel(MINT_QUEUE, String(q.seed)); skipped++; continue; }
      if (holder !== null) {
        // Held by somebody else on chain: the chain wins, and the row follows it in the sync.
        await hdel(MINT_QUEUE, String(q.seed));
        await push(TRANSFERS, JSON.stringify({ at: Date.now(), seed: q.seed, note: `not minted: the chain already holds it for ${holder}` }), 200);
        skipped++;
        continue;
      }
      batch.push(q);
    }
    if (!batch.length) return { minted: 0, skipped, waiting: 0, txHash: null };
    const data = batch.length === 1
      ? encodeFunctionData({ abi: LAND_ABI, functionName: 'mint', args: [BigInt(batch[0].seed), batch[0].to as Hex] })
      : encodeFunctionData({ abi: LAND_ABI, functionName: 'mintBatch', args: [batch.map((q) => BigInt(q.seed)), batch.map((q) => q.to as Hex)] });
    const sent = await callFromVault(LAND_ADDRESS!, data);
    if (!sent.ok) {
      if (sent.maybeSent && sent.txHash) {
        await setValue(IN_FLIGHT, JSON.stringify({ txHash: sent.txHash, seeds: batch.map((q) => q.seed), at: Date.now() }), 86_400);
        return { minted: 0, skipped, waiting: queue.length, txHash: sent.txHash, problem: sent.problem };
      }
      for (const q of batch) await hset(MINT_QUEUE, String(q.seed), JSON.stringify({ ...q, tries: q.tries + 1, problem: sent.problem }));
      return { minted: 0, skipped, waiting: queue.length, txHash: null, problem: sent.problem };
    }
    // Sent. Kept in flight until the receipt confirms it, then dropped from the queue.
    await setValue(IN_FLIGHT, JSON.stringify({ txHash: sent.txHash, seeds: batch.map((q) => q.seed), at: Date.now() }), 86_400);
    const state = await receiptOf(sent.txHash).catch(() => 'pending' as const);
    if (state === 'success') {
      for (const q of batch) { await hdel(MINT_QUEUE, String(q.seed)); await hset(MINTED, String(q.seed), sent.txHash); }
      await setValue(IN_FLIGHT, '', 1);
      return { minted: batch.length, skipped, waiting: queue.length - batch.length - skipped, txHash: sent.txHash };
    }
    return { minted: 0, skipped, waiting: queue.length, txHash: sent.txHash, problem: state === 'reverted' ? 'The batch reverted.' : 'Sent; waiting for the chain to confirm it.' };
  } finally {
    await releaseLock(MINT_LOCK);
  }
}

/**
 * The surprise: every plot anybody holds, minted to them. Reads the chain
 * once, queues what is missing, and drains the queue a batch at a time.
 */
export async function airdrop(): Promise<{ queued: number; alreadyMinted: number; batches: Flushed[] }> {
  const rows = await allClaims();
  const chainMap = await readRegistry();
  let queued = 0, alreadyMinted = 0;
  for (const row of rows) {
    const holder = chainMap.get(row.seed) ?? null;
    if (holder === row.owner.toLowerCase()) { alreadyMinted++; continue; }
    if (holder !== null) continue; // somebody else's on chain: the sync moves the row
    await queueMint(row.seed, row.owner);
    queued++;
  }
  const batches: Flushed[] = [];
  for (let i = 0; i < 20; i++) {
    const done = await flushMints();
    batches.push(done);
    if (done.problem || done.waiting <= 0) break;
  }
  return { queued, alreadyMinted, batches };
}

/* ------------------------------------------------------------------ *
 * Following the chain
 * ------------------------------------------------------------------ */

export interface Synced { moved: { seed: number; from: string; to: string }[]; released: number[]; unminted: number; at: number }

/**
 * Bring the rows into line with the chain.
 *
 * A plot whose holder differs from its row moved: on OpenSea, in the market,
 * wallet to wallet. The row goes to the holder with everything the plot has
 * earned — its era, its expansion, its cover, its banner — and without what
 * was the seller's: the listing, the offers, the hired hand. A burnt plot's
 * row is dropped, as a release would drop it. A claim row with no token is
 * queued to be minted.
 */
export async function syncOwners(chain?: Map<number, string | null>): Promise<Synced> {
  const empty: Synced = { moved: [], released: [], unminted: 0, at: Date.now() };
  if (!nftLive() && !chain) return empty;
  if (!(await takeLock(SYNC_LOCK, 60))) return empty;
  try {
    const chainMap = chain ?? await readRegistry();
    const rows = await allClaims();
    const names = await displayNames().catch(() => ({} as Record<string, string>));
    const out: Synced = { moved: [], released: [], unminted: 0, at: Date.now() };
    for (const row of rows) {
      if (!chainMap.has(row.seed)) { out.unminted++; if (nftLive()) await queueMint(row.seed, row.owner); continue; }
      const holder = chainMap.get(row.seed) ?? null;
      if (holder === null) {
        await releaseRow(row);
        out.released.push(row.seed);
        continue;
      }
      if (holder !== row.owner.toLowerCase()) {
        await moveRow(row, holder, names[holder] ?? '');
        out.moved.push({ seed: row.seed, from: row.owner.toLowerCase(), to: holder });
      }
    }
    if (out.moved.length || out.released.length) await forgetLandMarket().catch(() => {});
    await setValue(LAST_SYNC, JSON.stringify(out), 7 * 86_400);
    return out;
  } finally {
    await releaseLock(SYNC_LOCK);
  }
}

export async function lastSync(): Promise<Synced | null> {
  try { return JSON.parse((await getValue(LAST_SYNC)) ?? 'null'); } catch { return null; }
}

const CLAIMS = serverKey('claims');
const WORLDS_INDEX = serverKey('worlds');

/** The row follows the token: everything the plot has earned goes with it, nothing that was the seller's. */
async function moveRow(row: Claim, to: string, toName: string) {
  const { forSale: _s, listedAt: _l, offers: _o, hiring: _h, hand: _d, ...kept } = row;
  const moved: Claim = { ...kept, owner: to, ownerName: toName || `${to.slice(0, 6)}…${to.slice(-4)}`, at: Date.now() };
  await hset(CLAIMS, String(row.seed), JSON.stringify(moved));
  const world = await readWorld(row.seed).catch(() => null);
  if (world) await publishWorld({ ...world, owner: to, ownerName: moved.ownerName }).catch(() => {});
  await push(TRANSFERS, JSON.stringify({ at: Date.now(), seed: row.seed, from: row.owner.toLowerCase(), to }), 200);
  // The seller's record stops carrying it.
  try {
    const record = await readPlayerRecord(row.owner.toLowerCase()) as { claims?: { seed: number }[]; listings?: { seed: number }[] } | null;
    if (record && (Array.isArray(record.claims) || Array.isArray(record.listings))) {
      await savePlayerRecord(row.owner.toLowerCase(), {
        ...record,
        claims: (record.claims ?? []).filter((c) => c.seed !== row.seed),
        listings: (record.listings ?? []).filter((l) => l.seed !== row.seed),
        savedAt: Date.now(),
      });
    }
  } catch { /* the row is the title; the record catches up on their next visit */ }
}

async function releaseRow(row: Claim) {
  await hdel(CLAIMS, String(row.seed));
  await hdel(WORLDS_INDEX, String(row.seed));
  await push(TRANSFERS, JSON.stringify({ at: Date.now(), seed: row.seed, from: row.owner.toLowerCase(), to: null, note: 'burnt' }), 200);
}

/** The last two hundred moves the sync made, newest first. */
export async function recentTransfers(): Promise<unknown[]> {
  return (await range(TRANSFERS)).map((raw) => { try { return JSON.parse(raw); } catch { return null; } }).filter(Boolean).reverse();
}

/* ------------------------------------------------------------------ *
 * The market board, from the chain
 * ------------------------------------------------------------------ */

export interface ChainListing { seed: number; seller: string; price: number; live: boolean }

/** Every listing on the market contract, with its price in whole $EMERGE. */
export async function marketBoard(): Promise<ChainListing[]> {
  if (!MARKET_ADDRESS) return [];
  const client = reader();
  const total = Number(await client.readContract({ address: MARKET_ADDRESS as Hex, abi: MARKET_ABI, functionName: 'listedCount' }));
  const out: ChainListing[] = [];
  for (let start = 0; start < total; start += 200) {
    const [seeds, sellers, prices, live] = await client.readContract({ address: MARKET_ADDRESS as Hex, abi: MARKET_ABI, functionName: 'board', args: [BigInt(start), 200n] });
    seeds.forEach((seed, i) => out.push({ seed: Number(seed), seller: sellers[i].toLowerCase(), price: Number(prices[i] / 10n ** 18n), live: live[i] }));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Royalties, back to the holders
 * ------------------------------------------------------------------ */

export interface Swept { token: string; symbol: string; amount: number; txHash: string | null; booked: 'dividends' | 'held' | 'nothing' }

/** What the royalty receiver holds right now, per token, in whole units. */
export async function royaltiesWaiting(): Promise<{ token: string; symbol: string; amount: number }[]> {
  if (!ROYALTIES_ADDRESS) return [];
  const client = reader();
  const out: { token: string; symbol: string; amount: number }[] = [];
  const native = await client.getBalance({ address: ROYALTIES_ADDRESS as Hex }).catch(() => 0n);
  out.push({ token: ZERO, symbol: 'ETH', amount: Number(native) / 1e18 });
  for (const t of royaltyTokens()) {
    const raw = await client.readContract({ address: t.address as Hex, abi: ERC20_ABI, functionName: 'balanceOf', args: [ROYALTIES_ADDRESS as Hex] }).catch(() => 0n);
    out.push({ token: t.address, symbol: t.symbol, amount: Number(raw / 10n ** BigInt(t.decimals - 6)) / 1e6 });
  }
  return out;
}

/** The tokens royalties may arrive in: $EMERGE always, plus whatever `EMERGE_ROYALTY_TOKENS` names as `SYMBOL:address:decimals`. */
function royaltyTokens(): { address: string; symbol: string; decimals: number }[] {
  const out: { address: string; symbol: string; decimals: number }[] = [];
  if (tokenLive() && ACTIVE_CHAIN.tokenAddress) out.push({ address: ACTIVE_CHAIN.tokenAddress, symbol: TOKEN.ticker, decimals: 18 });
  for (const entry of (process.env.EMERGE_ROYALTY_TOKENS ?? '').split(',')) {
    const [symbol, address, decimals] = entry.split(':').map((x) => x.trim());
    if (symbol && /^0x[0-9a-fA-F]{40}$/.test(address ?? '')) out.push({ address, symbol, decimals: Number(decimals) || 18 });
  }
  return out;
}

/**
 * Move what the royalty receiver holds to the vault and book it.
 *
 * $EMERGE goes straight into the holders' dividend pool, so the next weekly
 * settlement pays it out with the rest. Anything else — the chain's coin, a
 * stablecoin — is held in the vault and counted under its own heading until
 * it is turned into $EMERGE by hand, and the Bank shows it as owed.
 */
export async function sweepRoyalties(): Promise<Swept[]> {
  if (!ROYALTIES_ADDRESS || !vaultCanSign()) return [];
  const waiting = await royaltiesWaiting();
  const out: Swept[] = [];
  for (const w of waiting) {
    if (!(w.amount > 0)) { out.push({ ...w, txHash: null, booked: 'nothing' }); continue; }
    const data = encodeFunctionData({ abi: ROYALTIES_ABI, functionName: 'sweep', args: [w.token as Hex] });
    const sent = await callFromVault(ROYALTIES_ADDRESS, data);
    if (!sent.ok && !(sent.maybeSent && sent.txHash)) { out.push({ ...w, txHash: null, booked: 'nothing' }); continue; }
    const txHash = sent.txHash ?? null;
    // Booked once the chain confirms it, so a lost reply never books twice.
    const state = txHash ? await receiptOf(txHash).catch(() => 'pending' as const) : 'missing';
    if (state !== 'success') { out.push({ ...w, txHash, booked: 'nothing' }); continue; }
    const isEmerge = ACTIVE_CHAIN.tokenAddress && w.token.toLowerCase() === ACTIVE_CHAIN.tokenAddress.toLowerCase();
    if (isEmerge) {
      await incrBy(DIVIDEND_POOL, Math.floor(w.amount));
      out.push({ ...w, txHash, booked: 'dividends' });
    } else {
      await incrBy(ROYALTY_HELD(w.token), Math.round(w.amount * 1e6));
      out.push({ ...w, txHash, booked: 'held' });
    }
    await push(ROYALTY_LEDGER, JSON.stringify({ at: Date.now(), token: w.token, symbol: w.symbol, amount: w.amount, txHash }), 300);
  }
  return out;
}

/** What royalties have been swept so far, newest first, and what is held unconverted. */
export async function royaltyBook(): Promise<{ swept: unknown[]; held: { token: string; symbol: string; amount: number }[] }> {
  const swept = (await range(ROYALTY_LEDGER)).map((raw) => { try { return JSON.parse(raw); } catch { return null; } }).filter(Boolean).reverse();
  const held: { token: string; symbol: string; amount: number }[] = [];
  for (const t of [{ address: ZERO, symbol: 'ETH' }, ...royaltyTokens()]) {
    const micro = await counter(ROYALTY_HELD(t.address));
    if (micro > 0) held.push({ token: t.address, symbol: t.symbol, amount: micro / 1e6 });
  }
  return { swept, held };
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export async function nftStatus() {
  const rows = await allClaims().catch(() => [] as Claim[]);
  let mintedCount: number | null = null, unminted: number | null = null, chainProblem: string | null = null;
  if (nftLive()) {
    try {
      const chainMap = await readRegistry();
      mintedCount = [...chainMap.values()].filter((h) => h !== null).length;
      unminted = rows.filter((r) => (chainMap.get(r.seed) ?? null) !== r.owner.toLowerCase()).length;
    } catch (error) {
      chainProblem = error instanceof Error ? error.message.slice(0, 160) : 'unreachable';
    }
  }
  return {
    live: nftLive(),
    land: LAND_ADDRESS, market: MARKET_ADDRESS, royalties: ROYALTIES_ADDRESS,
    minter: vaultAddress(), canSign: vaultCanSign(),
    rows: rows.length, mintedCount, unminted, chainProblem,
    queue: (await mintQueue()).length,
    inFlight: await getValue(IN_FLIGHT).then((v) => (v ? JSON.parse(v) : null)).catch(() => null),
    lastSync: await lastSync(),
    royaltiesWaiting: nftLive() ? await royaltiesWaiting().catch(() => []) : [],
  };
}

/** A plot's mint transaction, when the game minted it. */
export const mintTxOf = (seed: number) => hget(MINTED, String(seed));
/** Whether a seed's claim row has a token (or one queued), for the metadata route. */
export const claimRow = claimOf;
