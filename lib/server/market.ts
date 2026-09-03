/**
 * The world market.
 *
 * Every settlement in the game trades into one market, not its own. If bread is
 * short across the worlds people are actually running, bread is dear in all of
 * them — including in a valley with a full granary, whose baker then has
 * something worth selling. That is the whole point: a price is a piece of news
 * about somewhere else, and until now each settlement was quoting itself.
 *
 * **How it works.** The server holds one price per good. Every so often it
 * looks at how short of each good the running settlements are, works out where
 * that says the price should sit, and eases the price a little way toward it —
 * the same easing a settlement used to do alone, over the same clamps, so the
 * numbers stay inside the range the economy was balanced in. Clients read the
 * result and their citizens trade at it.
 *
 * **Why nobody can move it on their own.** The index reads the *mean* position
 * across settlements, not the sum, and each settlement gets exactly one
 * reading. A reading is only accepted for a plot the caller can prove they own,
 * which costs a plot's price in burned tokens. So influence is bought at
 * 212,000 $EMERGE a vote, spent, not staked — and one more voice among a
 * hundred moves the mean by a hundredth. Each reading is also clamped to the
 * same [-1, 1.5] range a real settlement can reach before it is counted, so a
 * forged one is worth no more than an honest one.
 *
 * **What it cannot do.** The market moves Gold, which never leaves a
 * settlement. It cannot mint $EMERGE, and stewardship yield does not read a
 * price. The worst a manipulated index could do is make somebody's town buy
 * bread dearly — which is a thing that happens in markets.
 */

import {
  BASE_PRICES, PRICE_CEILING, PRICE_FLOOR, RESOURCES, shortageOf, targetPrice,
  type Resource,
} from '../world/goods';
import { getValue, hdel, hgetall, hsetWindow, setValue, shared, takeLock } from './kv';

/** One price per good, as everyone sees it right now. */
export type Prices = Record<Resource, number>;

export interface MarketIndex {
  /** Which fixing these prices belong to. */
  epoch: number;
  /** What everything costs during that fixing. */
  prices: Prices;
  /** What everything will cost during the one after it. */
  next: Prices;
  /** When the fixing came into force, in epoch milliseconds. */
  at: number;
  /** The server's clock at the moment of answering, so clients can agree on the changeover. */
  now: number;
  /** How many settlements were read into it. */
  traders: number;
  /** True when this is the one shared index rather than a single instance's. */
  shared: boolean;
}

const KEY = 'emerge:market:index';
const SAMPLES = 'emerge:market:samples';
const TICK_LOCK = 'emerge:market:tick';

/**
 * How long a settlement's reading counts for.
 *
 * Long enough that a world open in a tab keeps its voice between polls, short
 * enough that a settlement nobody is running stops speaking for itself within a
 * few minutes. Prices should follow the worlds being played, not the worlds
 * that were once opened.
 */
export const SAMPLE_TTL_SECONDS = 420;

/**
 * How long a price stands, in milliseconds.
 *
 * The market does not move continuously. It fixes a price, holds it for two
 * minutes, and then fixes the next one — and this is what makes "everybody
 * pays the same" true rather than nearly true.
 *
 * The first attempt let the price move whenever a request happened to arrive,
 * which meant each client showed whatever the index had said at the moment it
 * last asked. Two settlements polling twenty seconds apart quoted bread at 7.39
 * and 7.46, and the panel disagreed with the server that fed it. A price that
 * depends on when you asked is not a shared price.
 */
export const EPOCH_MS = 120_000;

/** Which fixing is in force at a given moment. */
const epochAt = (ms: number) => Math.floor(ms / EPOCH_MS);

/**
 * How far the price closes on its target at each fixing.
 *
 * Deliberately gentler than a single settlement's own easing was. A shared
 * price that lurches is a price nobody can plan around, and with every world
 * pushing on it the pressure is steadier than one town's granary ever was.
 */
const EASE_PER_EPOCH = 0.16;

/**
 * The most a price may move between two fixings, as a fraction of its base.
 *
 * A floor under nothing and a ceiling over everything still allows a jump from
 * one to the other in a single step if the target swings. This is what makes
 * the line on the chart a line.
 */
const MAX_STEP = 0.12;

const startingPrices = (): Prices =>
  Object.fromEntries(RESOURCES.map((r) => [r, BASE_PRICES[r]])) as Prices;

/** Read prices back, discarding any figure that is not inside the clamps. */
function readPrices(raw: unknown): Prices {
  const prices = startingPrices();
  if (!raw || typeof raw !== 'object') return prices;
  const source = raw as Partial<Record<Resource, unknown>>;
  for (const r of RESOURCES) {
    const value = Number(source[r]);
    // A stored price outside the clamps is not trusted back in: the bounds are
    // the contract, and a bad write must not become permanent.
    if (Number.isFinite(value)
      && value >= BASE_PRICES[r] * PRICE_FLOOR
      && value <= BASE_PRICES[r] * PRICE_CEILING) {
      prices[r] = value;
    }
  }
  return prices;
}

/** The stored fixing: what a price is now, and what it will be next. */
interface Fixing {
  epoch: number;
  prices: Prices;
  next: Prices;
  traders: number;
}

function parse(raw: string | null): Fixing | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as { epoch?: number; prices?: unknown; next?: unknown; traders?: number };
    if (typeof json.epoch !== 'number' || !Number.isFinite(json.epoch)) return null;
    return {
      epoch: Math.floor(json.epoch),
      prices: readPrices(json.prices),
      next: readPrices(json.next),
      traders: Math.max(0, Math.round(Number(json.traders) || 0)),
    };
  } catch {
    return null;
  }
}

/**
 * What the running settlements are short of, averaged.
 *
 * Absent settlements are absent rather than neutral: a market with three worlds
 * trading in it should move like a market with three worlds in it. Averaging
 * against a fixed denominator would have made every early reading a whisper.
 */
async function pressure(): Promise<{ shortage: Partial<Record<Resource, number>>; traders: number }> {
  const rows = await hgetall(SAMPLES);
  const totals: Partial<Record<Resource, number>> = {};
  let traders = 0;
  const now = Date.now();

  // A hash cannot expire its fields one at a time, so the rows of worlds that
  // stopped playing are cleared here, on the read that noticed them. Without
  // this the market would keep being told what a settlement was short of on
  // Tuesday for as long as anybody anywhere kept the key alive.
  const stale: string[] = [];

  for (const [seed, raw] of Object.entries(rows)) {
    let sample: { at?: number; s?: Partial<Record<Resource, number>> };
    try {
      sample = JSON.parse(raw) as typeof sample;
    } catch {
      stale.push(seed);
      continue;
    }
    if (typeof sample.at !== 'number' || now - sample.at > SAMPLE_TTL_SECONDS * 1000) {
      stale.push(seed);
      continue;
    }
    traders += 1;
    for (const r of RESOURCES) {
      const value = Number(sample.s?.[r]);
      if (!Number.isFinite(value)) continue;
      totals[r] = (totals[r] ?? 0) + Math.min(1.5, Math.max(-1, value));
    }
  }

  // Bounded so one unlucky read cannot turn into a hundred round trips.
  for (const seed of stale.slice(0, 32)) await hdel(SAMPLES, seed);

  if (!traders) return { shortage: {}, traders: 0 };
  const shortage: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) shortage[r] = (totals[r] ?? 0) / traders;
  return { shortage, traders };
}

/** One fixing on from here, given what the settlements are short of. */
function step(from: Prices, shortage: Partial<Record<Resource, number>>, traders: number): Prices {
  const to = {} as Prices;
  for (const r of RESOURCES) {
    // With nobody trading, prices drift home rather than freezing wherever the
    // last player left them.
    const target = traders ? targetPrice(r, shortage[r] ?? 0) : BASE_PRICES[r];
    const cap = BASE_PRICES[r] * MAX_STEP;
    const move = (target - from[r]) * EASE_PER_EPOCH;
    const moved = from[r] + Math.min(cap, Math.max(-cap, move));
    to[r] = Math.min(
      BASE_PRICES[r] * PRICE_CEILING,
      Math.max(BASE_PRICES[r] * PRICE_FLOOR, Math.round(moved * 1000) / 1000),
    );
  }
  return to;
}

/**
 * The prices as they stand, and the ones that take over at the next fixing.
 *
 * Both are handed out together, and that is the point. A client that has asked
 * at any time in the last two minutes already holds the price that is about to
 * come into force, so it changes over at the same instant as every other
 * client rather than whenever its own next request happens to land. The
 * server's clock goes out with them for the same reason: the changeover is at
 * an agreed moment, not at each browser's idea of one.
 *
 * Only one request per fixing does any work. Everyone else reads what it wrote,
 * and a request that arrives while the fixing is being taken gets the previous
 * one — which still carries the current price as its `next`, so nobody is
 * served a stale figure even then.
 */
export async function readMarket(): Promise<MarketIndex> {
  const now = Date.now();
  const epoch = epochAt(now);
  const stored = parse(await getValue(KEY));

  const answer = (f: Fixing): MarketIndex => ({
    epoch: f.epoch,
    prices: f.prices,
    next: f.next,
    at: f.epoch * EPOCH_MS,
    now,
    traders: f.traders,
    shared: shared(),
  });

  if (stored && stored.epoch === epoch) return answer(stored);

  // Somebody else is taking this fixing. Their answer will be along; ours is
  // the last one, which for a caller one epoch behind is still complete —
  // `next` is the price now in force.
  if (!(await takeLock(TICK_LOCK, 20))) {
    if (stored) return answer(stored);
    const prices = startingPrices();
    return { epoch, prices, next: prices, at: epoch * EPOCH_MS, now, traders: 0, shared: shared() };
  }

  const { shortage, traders } = await pressure();

  // Where the price stands now, walked forward from whatever was last fixed.
  // One step for the fixing we already published, then one for each that
  // passed with nobody here to take it — capped, so an index left alone
  // overnight catches up over a few fixings rather than teleporting.
  let prices: Prices;
  if (!stored) {
    prices = startingPrices();
  } else if (stored.epoch + 1 === epoch) {
    prices = stored.next;
  } else {
    prices = stored.next;
    const missed = Math.min(8, epoch - stored.epoch - 1);
    for (let i = 0; i < missed; i += 1) prices = step(prices, shortage, traders);
  }

  const fixing: Fixing = { epoch, prices, next: step(prices, shortage, traders), traders };
  await setValue(KEY, JSON.stringify(fixing), 86_400);
  return answer(fixing);
}

/**
 * Record one settlement's position, replacing whatever it said last.
 *
 * Keyed by plot seed, so a player with four worlds speaks four times and a
 * player with four browser tabs open on one world speaks once.
 */
export async function recordSample(seed: number, stocks: Partial<Record<Resource, number>>): Promise<void> {
  const s: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCES) {
    const stock = Number(stocks[r]);
    if (!Number.isFinite(stock) || stock < 0) continue;
    // Converted here rather than trusted from the client: what arrives is a
    // count of things in a barn, and what is stored is a number on a fixed
    // scale. A caller cannot send a shortage of nine.
    s[r] = shortageOf(r, Math.min(100_000, stock));
  }
  await hsetWindow(SAMPLES, String(seed), JSON.stringify({ at: Date.now(), s }), SAMPLE_TTL_SECONDS);
}
