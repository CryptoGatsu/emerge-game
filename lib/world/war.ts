/**
 * War: the numbers.
 *
 * A plot can raise an army and march it onto somebody else's land. The
 * registry decides every battle, on the server, from published numbers and a
 * secret it commits to first, and both settlements play the same result back
 * as a scene. This file is the arithmetic both sides share — what a unit of
 * each age is worth, what it costs, how a battle is resolved — with no
 * imports, so the server, the panel and the wiki all read one table.
 *
 * Every age fights differently. A settlement's militia are cheap and know
 * their own ground; a township's men-at-arms hold a wall better than anyone
 * for the price; industrial riflemen hit hard away and stand thin at home;
 * a modern armoured corps is strong both ways and dear; the AI age's drone
 * corps has the hardest attack in the game and the least to fall back on
 * when it is caught at home.
 */

export type WarEra = 1 | 2 | 3 | 4 | 5;

export interface UnitSpec {
  /** One of them, and several. */
  name: string;
  plural: string;
  /** What one adds to an attack, and to a defence. */
  attack: number;
  defence: number;
  /** How much better they fight on their own plot. */
  home: number;
  /** What one costs to train: Gold from the treasury, and steel from the yard from the industrial age. */
  gold: number;
  steel: number;
  blurb: string;
}

export const UNITS: Record<WarEra, UnitSpec> = {
  1: { name: 'militiaman', plural: 'militia', attack: 1.0, defence: 1.1, home: 1.35, gold: 300, steel: 0, blurb: 'Spears, bows and a week of drill. Cheap, and they know their own ground: strong behind their own fences, weak away from them.' },
  2: { name: 'man-at-arms', plural: 'men-at-arms', attack: 1.4, defence: 1.9, home: 1.25, gold: 480, steel: 0, blurb: 'Pike, crossbow and a mail shirt. The best defence for the price in any age; slow and heavy on the attack.' },
  3: { name: 'rifleman', plural: 'riflemen', attack: 2.4, defence: 1.5, home: 1.1, gold: 700, steel: 1, blurb: 'Rifles and drill. They hit hard on the march and stand thin at home; the ironworks feeds them steel.' },
  4: { name: 'trooper', plural: 'armoured corps', attack: 3.3, defence: 3.2, home: 1.1, gold: 1100, steel: 2, blurb: 'Armour and a radio. Strong both ways and dear to raise; the machine works feeds them steel.' },
  5: { name: 'drone', plural: 'drone corps', attack: 4.8, defence: 2.4, home: 1.0, gold: 1600, steel: 3, blurb: 'A swarm and its handlers. The hardest attack in the game, and the least to fall back on when it is caught on the ground at home.' },
};

/** What it costs in $EMERGE, burned, to open a military base on a plot. Once per plot. */
export const BASE_COST_EMERGE = 250_000;

/** How long a new plot, and a plot just retaken, cannot be invaded. */
export const SHIELD_HOURS = 24;
export const SHIELD_MS = SHIELD_HOURS * 3_600_000;

/** The share of an occupied plot's daily yield that goes to the occupier. */
export const OCCUPIER_SHARE = 0.6;

/** What an occupier pays, in their own settlement's Gold, for each real day they hold a plot. */
export const occupyUpkeepGold = (era: number) => 250 * Math.max(1, Math.min(5, Math.round(era)));

/** How many days ahead an occupation can be paid. */
export const OCCUPY_PAID_DAYS_MAX = 3;

/** The most troops a base holds, by the plot's age. */
export const armyCap = (era: number) => 30 + 20 * (Math.max(1, Math.min(5, Math.round(era))) - 1);

/** How many troops a base can train in one real day. */
export const MAX_TRAIN_PER_DAY = 12;

/** The fewest troops an attack can be sent with. */
export const MIN_ATTACK = 3;

export const unitOf = (era: number): UnitSpec => UNITS[Math.max(1, Math.min(5, Math.round(era))) as WarEra];

/** What a force is worth on the attack. */
export function attackStrength(troops: number, era: number): number {
  return Math.max(0, troops) * unitOf(era).attack;
}

/** What a force is worth holding ground: on its own plot it fights with its home bonus, and the plot's own age adds a little wall. */
export function defenceStrength(troops: number, era: number, home: boolean, plotEra = 1): number {
  const unit = unitOf(era);
  return Math.max(0, troops) * unit.defence * (home ? unit.home : 1) * (1 + 0.05 * (Math.max(1, plotEra) - 1));
}

export interface BattleRound {
  by: 'attacker' | 'defender';
  hit: number;
  attackerLeft: number;
  defenderLeft: number;
}

export interface BattleResult {
  winner: 'attacker' | 'defender';
  rounds: BattleRound[];
  /** Who is left standing on each side, whole troops. */
  survivors: { attacker: number; defender: number };
}

/**
 * Fight it out. `roll` gives numbers in [0, 1); the server feeds it from a
 * committed secret so nobody can know the result early and anybody can check
 * it after. The stronger side lands more blows, never all of them: the most
 * lopsided pairing lands about seven in ten. Each side has a hundred points
 * of fight; the first to nothing loses. The winner keeps the share of its
 * troops its remaining fight says it should; the loser's rout leaves one in
 * five to walk home.
 */
export function resolveBattle(roll: () => number, attacker: { troops: number; era: number; home?: boolean }, defender: { troops: number; era: number; home: boolean; plotEra?: number }): BattleResult {
  // An owner retaking their own plot fights on their own ground too.
  const a = attackStrength(attacker.troops, attacker.era) * (attacker.home ? unitOf(attacker.era).home : 1);
  const d = defenceStrength(defender.troops, defender.era, defender.home, defender.plotEra ?? 1);
  if (attacker.troops <= 0) return { winner: 'defender', rounds: [], survivors: { attacker: 0, defender: defender.troops } };
  if (defender.troops <= 0) return { winner: 'attacker', rounds: [], survivors: { attacker: attacker.troops, defender: 0 } };
  const edge = (a - d) / (a + d || 1);
  const share = 0.5 + edge * 0.4;
  let left = { attacker: 100, defender: 100 };
  const rounds: BattleRound[] = [];
  for (let i = 0; i < 30 && left.attacker > 0 && left.defender > 0; i++) {
    const by: 'attacker' | 'defender' = roll() < share ? 'attacker' : 'defender';
    const hit = Math.round(8 + roll() * 14);
    if (by === 'attacker') left = { ...left, defender: Math.max(0, left.defender - hit) };
    else left = { ...left, attacker: Math.max(0, left.attacker - hit) };
    rounds.push({ by, hit, attackerLeft: left.attacker, defenderLeft: left.defender });
  }
  const winner: 'attacker' | 'defender' = left.defender <= 0 ? 'attacker' : left.attacker <= 0 ? 'defender' : left.attacker >= left.defender ? 'attacker' : 'defender';
  const keep = (troops: number, fight: number) => Math.max(1, Math.round(troops * (0.45 + 0.55 * fight / 100)));
  const rout = (troops: number) => Math.floor(troops * 0.2);
  const survivors = winner === 'attacker'
    ? { attacker: keep(attacker.troops, left.attacker), defender: rout(defender.troops) }
    : { attacker: rout(attacker.troops), defender: keep(defender.troops, left.defender) };
  return { winner, rounds, survivors };
}

/** The attacker's odds before the fight, for a card: a Monte Carlo over plain random rolls. */
export function attackOdds(attacker: { troops: number; era: number; home?: boolean }, defender: { troops: number; era: number; home: boolean; plotEra?: number }, samples = 400): number {
  if (attacker.troops <= 0) return 0;
  if (defender.troops <= 0) return 1;
  let wins = 0;
  let seed = 12345 + attacker.troops * 7 + defender.troops * 13;
  const roll = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < samples; i++) if (resolveBattle(roll, attacker, defender).winner === 'attacker') wins++;
  return wins / samples;
}

/** The kinds of fight the registry records. */
export type BattleKind = 'invasion' | 'ambush' | 'retake';

export interface BattleSide {
  address: string;
  name: string;
  seed: number;
  worldName: string;
  era: number;
  troops: number;
}

export interface Battle {
  id: string;
  kind: BattleKind;
  at: number;
  /** The plot it was fought on. */
  seed: number;
  attacker: BattleSide;
  defender: BattleSide;
  /** Whether the defender was the plot's own owner, fighting at home. */
  homeDefence: boolean;
  winner: 'attacker' | 'defender';
  rounds: BattleRound[];
  survivors: { attacker: number; defender: number };
  /** sha256 of the secret the rolls came from, published first; the secret itself once the fight is over. */
  commit: string;
  reveal: string;
}

export interface Occupation {
  /** The wallet whose army holds the plot, and what they are called. */
  by: string;
  byName: string;
  /** The plot their army came from. */
  fromSeed: number;
  fromName: string;
  since: number;
  troops: number;
  era: number;
  /** How long the occupation is paid for; past this the army goes home. */
  paidUntil: number;
}

export interface Army {
  troops: number;
  since: number;
  /** The UTC day of the last training and how many were trained on it, for the daily cap. */
  day?: string;
  today?: number;
  /** The same day and the Gold the registry has authorised on it, so a day's drilling cannot outrun the treasury. */
  goldDay?: string;
  goldToday?: number;
  /** The published treasury that authorisation was read against; a smaller one means the spending has been published and the tally starts again. */
  goldSeen?: number;
}

/** What a war event is, for the feed every screen watches. */
export type WarEventKind = 'invaded' | 'held' | 'retaken' | 'ambushed' | 'withdrew' | 'lapsed' | 'base';
export interface WarEvent {
  id: string;
  kind: WarEventKind;
  at: number;
  seed: number;
  region: string;
  worldName: string;
  /** Who did it, and to whom. */
  actor: string;
  actorName: string;
  other: string;
  otherName: string;
  troops?: number;
}
