import 'server-only';

/**
 * What the token is doing in the market.
 *
 * Price, market cap, volume and the pair come from DexScreener, which indexes
 * a token by its address on whatever chain it trades; the holder count comes
 * from the chain's explorer. Neither is ours, so both are read through one
 * server route with a short cache — the front page must not have every
 * visitor's browser hitting a third party — and each is allowed to fail on
 * its own: a holder count the explorer will not give is a blank, not a page
 * that says nothing at all.
 *
 * The price history is our own. Nobody hands out free candles for a chain
 * this young, so the server keeps a sample every few minutes for as long as
 * the site has been up, and the chart is honest about how much of that it
 * has. It starts as a dot and becomes a line.
 */

import { ACTIVE_CHAIN } from '../chain/emerge';
import { serverKey } from '../limits';
import { getValue, push, range, setValue, takeLock } from './kv';

export interface PricePoint { at: number; price: number }

export interface TokenStats {
  available: boolean;
  reason?: string;
  /** When these figures were read. */
  at: number;
  priceUsd: number | null;
  /** Percent over the last day. */
  change24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  pairUrl: string | null;
  dex: string | null;
  /** Oldest first. As much as the server has sampled. */
  history: PricePoint[];
}

/** How long the figures are held before being read again. Overridable for a test. */
const CACHE_SECONDS = Math.max(1, Number(process.env.EMERGE_TOKEN_CACHE_SECONDS) || 60);
/** One sample this often, for a week of them. */
const SAMPLE_MS = Math.max(1000, Number(process.env.EMERGE_TOKEN_SAMPLE_MS) || 5 * 60_000);
const KEEP_SAMPLES = 7 * 24 * 12;

const STATS = serverKey('token:stats');
const HISTORY = serverKey('token:history');
const SAMPLE_LOCK = serverKey('token:sample');

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull the figures out of a DexScreener token response.
 *
 * Several pairs can exist for one token; the one with the most liquidity is
 * the one the price actually forms on, so that is the one quoted.
 */
export function parseDexScreener(json: unknown): Omit<TokenStats, 'at' | 'holders' | 'history'> {
  const pairs = (json as { pairs?: unknown[] } | null)?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return {
      available: false, reason: 'No trading pair has been indexed for this token yet.',
      priceUsd: null, change24h: null, marketCap: null, fdv: null, volume24h: null,
      liquidityUsd: null, pairUrl: null, dex: null,
    };
  }
  type Pair = {
    priceUsd?: unknown; priceChange?: { h24?: unknown }; volume?: { h24?: unknown };
    liquidity?: { usd?: unknown }; fdv?: unknown; marketCap?: unknown; url?: unknown; dexId?: unknown;
  };
  const best = [...(pairs as Pair[])].sort((a, b) => (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0))[0];
  return {
    available: true,
    priceUsd: num(best.priceUsd),
    change24h: num(best.priceChange?.h24),
    marketCap: num(best.marketCap),
    fdv: num(best.fdv),
    volume24h: num(best.volume?.h24),
    liquidityUsd: num(best.liquidity?.usd),
    pairUrl: typeof best.url === 'string' ? best.url : null,
    dex: typeof best.dexId === 'string' ? best.dexId : null,
  };
}

/** The holder count out of a Blockscout token response. */
export function parseHolders(json: unknown): number | null {
  const raw = (json as { holders?: unknown; holders_count?: unknown } | null);
  const n = num(raw?.holders ?? raw?.holders_count);
  return n === null ? null : Math.round(n);
}

/** Where to ask. Overridable so a deployment can point at a mirror, and a test at a stub. */
function marketUrl(address: string): string {
  const template = process.env.EMERGE_TOKEN_STATS_URL ?? 'https://api.dexscreener.com/latest/dex/tokens/{address}';
  return template.replace('{address}', address);
}
function holdersUrl(address: string): string | null {
  const template = process.env.EMERGE_TOKEN_HOLDERS_URL
    ?? (ACTIVE_CHAIN.explorerUrl ? `${ACTIVE_CHAIN.explorerUrl.replace(/\/$/, '')}/api/v2/tokens/{address}` : null);
  return template ? template.replace('{address}', address) : null;
}

async function readJson(url: string, ms = 6000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function history(): Promise<PricePoint[]> {
  const rows = await range(HISTORY);
  const out: PricePoint[] = [];
  for (const raw of rows) {
    try {
      const p = JSON.parse(raw) as PricePoint;
      if (Number.isFinite(p.at) && Number.isFinite(p.price)) out.push(p);
    } catch { /* a row we cannot read is a gap in the line */ }
  }
  return out;
}

/** Keep a sample, if it is time for one. The lock is what makes it one, not one per instance. */
async function sample(price: number, now: number): Promise<void> {
  if (!(await takeLock(SAMPLE_LOCK, Math.max(1, Math.floor(SAMPLE_MS / 1000) - 10)))) return;
  await push(HISTORY, JSON.stringify({ at: now, price }), KEEP_SAMPLES);
}

const empty = (reason: string): TokenStats => ({
  available: false, reason, at: Date.now(),
  priceUsd: null, change24h: null, marketCap: null, fdv: null, volume24h: null,
  liquidityUsd: null, holders: null, pairUrl: null, dex: null, history: [],
});

/** The figures, from the cache when they are fresh and from the sources when they are not. */
export async function readTokenStats(): Promise<TokenStats> {
  const address = ACTIVE_CHAIN.tokenAddress;
  if (!address) return empty('The token contract is not configured on this deployment.');

  const cached = await getValue(STATS);
  if (cached) {
    try {
      const held = JSON.parse(cached) as TokenStats;
      return { ...held, history: await history() };
    } catch { /* fall through and read afresh */ }
  }

  const now = Date.now();
  let market: ReturnType<typeof parseDexScreener>;
  try {
    market = parseDexScreener(await readJson(marketUrl(address)));
  } catch {
    market = {
      available: false, reason: 'The market data service could not be reached.',
      priceUsd: null, change24h: null, marketCap: null, fdv: null, volume24h: null,
      liquidityUsd: null, pairUrl: null, dex: null,
    };
  }

  let holders: number | null = null;
  const hurl = holdersUrl(address);
  if (hurl) {
    try { holders = parseHolders(await readJson(hurl)); } catch { holders = null; }
  }

  const stats: TokenStats = { ...market, at: now, holders, history: [] };
  if (market.available && market.priceUsd !== null) await sample(market.priceUsd, now);
  // Short cache either way: a failure is not retried on every visit either.
  await setValue(STATS, JSON.stringify({ ...stats, history: undefined }), market.available ? CACHE_SECONDS : 30);
  return { ...stats, history: await history() };
}
