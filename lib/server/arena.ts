import 'server-only';

/**
 * The colosseum.
 *
 * One arena, shared by everybody, on its own island that anybody can walk into
 * whether or not they hold land. Players enter a citizen; the arena pairs them
 * and runs a bout every few minutes; everyone watching sees the same fight and
 * the same result.
 *
 * **Why the bout is committed to before it is fought.** The outcome has to be
 * the same for every viewer, so it has to be a function of published data. But
 * a function of published data is a function anybody can evaluate early — and a
 * bet on a fight whose winner you can already compute is not a bet. So the
 * server draws a secret when the bout is made, publishes only its hash, and
 * reveals the secret when the bout is over. Nobody can predict the winner;
 * anybody can check afterwards that the hash matches and that the fight was not
 * rewritten to suit the house. That is the whole trick, and it is the reason
 * this file holds a secret at all.
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import { getValue, hgetall, hsetWindow, setValue, shared, takeLock } from './kv';
import { serverKey } from '../limits';

/** How long one bout lasts, start to finish, in milliseconds. */
export const BOUT_MS = 180_000;

/** How much of that is open for betting. The rest is the fight. */
export const BETTING_MS = 120_000;

/** Which bout is running at a given moment. */
export const boutAt = (ms: number) => Math.floor(ms / BOUT_MS);

/** How long a fighter stays on the roster without being re-entered. */
const ROSTER_TTL_SECONDS = 900;

const ROSTER = serverKey('arena:roster');
const BOUT = (id: number) => serverKey(`arena:bout:${id}`);
const HISTORY = serverKey('arena:history');
const LOCK = serverKey('arena:make');

/**
 * A fighter, as the arena knows them.
 *
 * Everything here is public — it has to be, because the crowd is betting on it.
 * Nothing here can be spent, and none of it is taken on trust for anything that
 * matters: see `strengthOf`.
 */
export interface Fighter {
  /** Stable id: the plot they came from and the citizen on it. */
  id: string;
  name: string;
  /** The settlement that entered them. */
  worldName: string;
  seed: number;
  owner: string;
  ownerName: string;
  /** Their trade, and how many days they have done it. */
  job: string;
  level: number;
  /** How fit they are, 0-100, at the moment of entry. */
  vigour: number;
  at: number;
  /** Bouts won and lost, kept by the arena rather than by the client. */
  won: number;
  lost: number;
}

export type Phase = 'betting' | 'fighting' | 'settled';

export interface Bout {
  id: number;
  /** When betting closes and when the bout ends. */
  opensAt: number;
  closesAt: number;
  endsAt: number;
  red: Fighter;
  blue: Fighter;
  /** `sha256` of the secret. Published before the fight; checkable after it. */
  commit: string;
  /** Revealed once the bout is over, so anybody can recompute the result. */
  reveal?: string;
  /** 'red' or 'blue', once it has been fought. */
  winner?: 'red' | 'blue';
  /** How the fight went, blow by blow, for the crowd to watch. */
  rounds?: Round[];
  /**
   * What the house is offering, as a decimal multiple.
   *
   * Worked out once, when the bout is made, and stored with it. Measuring the
   * odds means running the fight a few thousand times, which is fine every
   * three minutes and absurd on every request from every viewer.
   */
  odds: { red: number; blue: number };
}

export interface Round {
  /** Who landed it. */
  by: 'red' | 'blue';
  /** What they did, as an index into the client's move list. */
  move: number;
  /** Damage dealt. */
  hit: number;
  /** Health left, after the blow. */
  redLeft: number;
  blueLeft: number;
}

/**
 * How hard somebody hits.
 *
 * Deliberately a narrow spread. A level-ten master is meaningfully better than
 * a newcomer but nowhere near unbeatable — around a sixty-forty edge — because
 * an arena where the favourite always wins is an arena nobody watches twice,
 * and because the numbers behind it come from a client. A settlement that
 * lied about its fighter would buy itself a small edge in a game of Gold that
 * cannot leave the world; that is the whole prize, and it is why nothing here
 * is worth forging.
 */
export function strengthOf(f: Fighter): number {
  const level = Math.max(0, Math.min(10, Math.round(f.level)));
  const vigour = Math.max(0, Math.min(100, f.vigour));
  return 10 + level * 1.1 + (vigour / 100) * 3;
}

/**
 * How often red actually wins, measured rather than derived.
 *
 * The first version published odds from a formula and let the fight run on a
 * different one, and the two disagreed wildly: the formula said a grandmaster
 * beat a newcomer 67% of the time and the fight said 98%. Odds that do not
 * match the fight are not long odds, they are wrong odds — every bet in the
 * house would have been mispriced.
 *
 * So this runs the real fight, several thousand times, with the same function
 * the bout will use. It is exact by construction and it cannot drift, because
 * there is no second model to drift from. It costs a few milliseconds and it
 * happens once every three minutes.
 */
export function winChance(red: Fighter, blue: Fighter, samples = 3000): number {
  let wins = 0;
  for (let i = 0; i < samples; i += 1) {
    if (fight(`odds:${i}:${red.id}:${blue.id}`, red, blue).winner === 'red') wins += 1;
  }
  return wins / samples;
}

/** The odds the crowd is offered, as a decimal multiple, before the house edge. */
export function trueOdds(red: Fighter, blue: Fighter): { red: number; blue: number } {
  // Kept off the extremes: an arena that offers 40-to-1 on a hopeless case is
  // an arena where one lucky night undoes a week of the house's edge.
  const p = Math.max(0.08, Math.min(0.92, winChance(red, blue)));
  return { red: 1 / p, blue: 1 / (1 - p) };
}

/* ------------------------------------------------------------------ *
 * The roster
 * ------------------------------------------------------------------ */

/** Put a fighter forward. Replaces whatever that citizen last entered as. */
export async function enter(fighter: Fighter): Promise<void> {
  await hsetWindow(ROSTER, fighter.id, JSON.stringify(fighter), ROSTER_TTL_SECONDS);
}

/** Everybody currently on the roster, freshest first. */
export async function roster(): Promise<Fighter[]> {
  const rows = await hgetall(ROSTER);
  const now = Date.now();
  const out: Fighter[] = [];
  for (const raw of Object.values(rows)) {
    try {
      const f = JSON.parse(raw) as Fighter;
      if (typeof f.at === 'number' && now - f.at <= ROSTER_TTL_SECONDS * 1000) out.push(f);
    } catch {
      // A row we cannot read is a fighter who does not turn up.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/* ------------------------------------------------------------------ *
 * The fight
 * ------------------------------------------------------------------ */

/**
 * Fight a bout from its secret.
 *
 * Pure: the same secret and the same two fighters always give the same fight,
 * which is what lets every viewer watch the same thing and what lets anybody
 * check the result afterwards.
 */
export function fight(secret: string, red: Fighter, blue: Fighter): { winner: 'red' | 'blue'; rounds: Round[] } {
  const rolls = createHmac('sha256', secret).update(`${red.id}|${blue.id}`).digest();
  let cursor = 0;
  const roll = () => {
    const byte = rolls[cursor % rolls.length];
    cursor += 1;
    return byte / 255;
  };

  const power = { red: strengthOf(red), blue: strengthOf(blue) };
  /*
   * How often the better fighter lands, and it is deliberately compressed.
   *
   * Strength used to decide both who landed *and* how hard, and the two
   * compounded: a grandmaster beat a newcomer ninety-eight times in a hundred,
   * which is not a bout, it is an execution. Skill now decides only who gets
   * the blow in. The most lopsided pairing the game can produce lands about
   * three blows in five, which comes out as a favourite worth backing and an
   * underdog worth watching.
   */
  const edge = (power.red - power.blue) / (power.red + power.blue);
  const share = 0.5 + edge * 0.42;
  let redLeft = 100;
  let blueLeft = 100;
  const rounds: Round[] = [];

  // Capped rather than open-ended: a bout has to fit in the minute the crowd
  // is watching, and a fight that never ends is a fight nobody can bet on.
  for (let i = 0; i < 24 && redLeft > 0 && blueLeft > 0; i += 1) {
    const by: 'red' | 'blue' = roll() < share ? 'red' : 'blue';
    const move = Math.floor(roll() * 6);
    // The same blow whoever throws it. All the difference between fighters is
    // in how often they get to throw one.
    const hit = Math.round(9 + roll() * 16);
    if (by === 'red') blueLeft = Math.max(0, blueLeft - hit);
    else redLeft = Math.max(0, redLeft - hit);
    rounds.push({ by, move, hit, redLeft, blueLeft });
  }

  const winner: 'red' | 'blue' = blueLeft <= 0 ? 'red'
    : redLeft <= 0 ? 'blue'
      // Nobody down at the bell: the one still standing straighter takes it.
      : redLeft >= blueLeft ? 'red' : 'blue';
  return { winner, rounds };
}

/** Check a finished bout: does the revealed secret match what was promised? */
export function verify(bout: Bout): boolean {
  if (!bout.reveal) return false;
  return createHash('sha256').update(bout.reveal).digest('hex') === bout.commit;
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

function parse(raw: string | null): Bout | null {
  if (!raw) return null;
  try {
    const bout = JSON.parse(raw) as Bout;
    return typeof bout.id === 'number' && bout.red && bout.blue ? bout : null;
  } catch {
    return null;
  }
}

/** Draw two different fighters, weighted toward whoever has waited longest. */
function pair(entrants: Fighter[], id: number): [Fighter, Fighter] | null {
  if (entrants.length < 2) return null;
  // Deterministic from the bout number, so two servers making the same bout
  // make the same one.
  const pick = createHmac('sha256', String(id)).update('pairing').digest();
  const pool = [...entrants].sort((a, b) => a.at - b.at);
  const first = pool[pick[0] % pool.length];
  const rest = pool.filter((f) => f.id !== first.id);
  if (!rest.length) return null;
  const second = rest[pick[1] % rest.length];
  return [first, second];
}

/**
 * The bout in force right now, making it if nobody has yet.
 *
 * Made once and stored, like the market's fixing, so every viewer is watching
 * the same card. The secret is drawn here and only its hash goes out until the
 * fight is over.
 */
export async function currentBout(): Promise<Bout | null> {
  const now = Date.now();
  const id = boutAt(now);
  const held = parse(await getValue(BOUT(id)));
  if (held) return revealIfDue(held, now);

  if (!(await takeLock(LOCK, 20))) return null;

  const entrants = await roster();
  const drawn = pair(entrants, id);
  if (!drawn) return null;

  const secret = randomBytes(24).toString('hex');
  const bout: Bout = {
    id,
    opensAt: id * BOUT_MS,
    closesAt: id * BOUT_MS + BETTING_MS,
    endsAt: (id + 1) * BOUT_MS,
    red: drawn[0],
    blue: drawn[1],
    commit: createHash('sha256').update(secret).digest('hex'),
    odds: trueOdds(drawn[0], drawn[1]),
  };
  // The secret is stored beside the bout but never served until the reveal.
  await setValue(BOUT(id), JSON.stringify({ ...bout, secret }), 7200);
  return bout;
}

/**
 * Serve a bout with the secret still withheld, or with it revealed if due.
 *
 * The reveal is at the moment betting *closes*, not at the bell. That is the
 * earliest it is safe — no more money can go on — and it has to be that early,
 * because the crowd watches the fight during the minute between the two. The
 * first cut revealed at the bell, which meant the fighting minute had nothing
 * in it to show: everybody stared at two names circling each other and then the
 * bout vanished into the results.
 */
async function revealIfDue(stored: Bout & { secret?: string }, now: number): Promise<Bout> {
  const { secret, ...open } = stored;
  if (now < stored.closesAt || !secret) return open;
  if (stored.winner) return open;

  const result = fight(secret, stored.red, stored.blue);
  const settled: Bout = { ...open, reveal: secret, winner: result.winner, rounds: result.rounds };
  await setValue(BOUT(stored.id), JSON.stringify({ ...settled, secret }), 7200);
  await recordResult(settled);
  return settled;
}

/** The bout before this one, settled, so the crowd can see how it went. */
export async function lastBout(): Promise<Bout | null> {
  const id = boutAt(Date.now()) - 1;
  const stored = parse(await getValue(BOUT(id)));
  if (!stored) return null;
  return revealIfDue(stored as Bout & { secret?: string }, Date.now());
}

/** Keep the winner's and loser's records, and a short history for the board. */
async function recordResult(bout: Bout): Promise<void> {
  if (!bout.winner) return;
  const won = bout.winner === 'red' ? bout.red : bout.blue;
  const lost = bout.winner === 'red' ? bout.blue : bout.red;
  const rows = await hgetall(ROSTER);
  const bump = async (f: Fighter, field: 'won' | 'lost') => {
    const raw = rows[f.id];
    if (!raw) return;
    try {
      const held = JSON.parse(raw) as Fighter;
      held[field] = (held[field] ?? 0) + 1;
      await hsetWindow(ROSTER, f.id, JSON.stringify(held), ROSTER_TTL_SECONDS);
    } catch {
      // Nothing to bump.
    }
  };
  await bump(won, 'won');
  await bump(lost, 'lost');
  await hsetWindow(HISTORY, String(bout.id), JSON.stringify({
    id: bout.id,
    at: bout.endsAt,
    winner: won.name,
    winnerWorld: won.worldName,
    loser: lost.name,
    loserWorld: lost.worldName,
  }), 7200);
}

/** The last few results, newest first. */
export async function recentResults(limit = 8): Promise<{
  id: number; at: number; winner: string; winnerWorld: string; loser: string; loserWorld: string;
}[]> {
  const rows = await hgetall(HISTORY);
  const out = [];
  for (const raw of Object.values(rows)) {
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Skip what will not read.
    }
  }
  return out.sort((a, b) => b.id - a.id).slice(0, limit);
}

/** True when the arena is shared rather than one instance talking to itself. */
export const arenaShared = shared;
