/**
 * HUD snapshots.
 *
 * The world advances every animation frame, but React only needs a readable
 * summary a few times a second. This module turns the live world into a small
 * plain object so the interface never re-renders off the simulation's clock and
 * never holds a reference into mutable simulation state.
 */

import { formOf } from './world/forms';
import { ERAS, eraSpec } from './world/eras';
import { cityGate, dailyCeiling, festivalCost, goldCap, insured, buildersHere, houseRoom, herdOf, keepOf, openPostsOf, upgradeEffect, tradeTitle, notablesOpen, notableAt, roleOf, NOTABLE_ROLES, NOTABLE_TIERS, NOTABLE_BASE, NOTABLE_BONUS, NOTABLE_FROM_ERA, postFor, type NotableRole, type CityGate, type Building } from './simulation';
import {
  ACTIVITY_LABELS, HAZARD_DEFENCE, HAZARD_FIGHT, HAZARD_LABELS, JOBS, LEDGER_LABELS, fightCost, rebuildCost,
  maxLevelFor, PHASE_LABELS, SKILL_TITLES, daysToNextLevel, levelOf, moveCost, skillDays,
  skillLevel, skillOutput, upgradeCost, upgradeAllQuote, upkeepOf,
  RESOURCE_LABELS, STEWARDSHIP_DAILY_CAP,
  UNDEMOLISHABLE, activeGathering, buildMaterials, describeTemperature, friendsOf, ledgerTotals,
  readiness, talkingWith, WEALTH_WORDS, wealthOf,
  type FeedEntry, type Gathering, type HazardKind, type LedgerLine, type MarketQuote, type Resource,
  type WorkingJob, type Job, type World, type Citizen, adviseBuild, latelyOf, traitWords, foodInStore, type Advice, eraGate, eraOf, type EraGate, tradeCapacity, buildingPosts, TRAIN_COST_GOLD, formName } from './simulation';
import { statusLine } from './speech';

export interface FocusCitizen {
  kind: 'citizen';
  id: string; name: string; handle: string; age: number;
  job: string; activity: string; phase: string; status: string;
  /** How good they are at their trade, or null for anybody without one. */
  skill: {
    level: number; title: string; days: number; toNext: number | null; output: number;
  } | null;
  family: string; home: string | null;
  mood: number; energy: number; purpose: number; hunger: number; social: number;
  wallet: number; wage: number;
  friends: { id: string; name: string }[];
  /** How they talk, in two words: "warm, a worrier". */
  traits: string[];
  /** What has happened to them lately, newest first. */
  lately: string[];
  /** The last conversation they had, if they remember one: who and what about. */
  lastTalk: { name: string; topic: string; daysAgo: number } | null;
  trouble: string | null;
    project: string | null;
}

/** The trade a workplace employs, or null for a building that employs nobody. */
const tradeOf = (type: string): WorkingJob | null => (Object.keys(JOBS) as WorkingJob[]).find((j) => JOBS[j].building === type) ?? null;

export interface FocusBuilding {
  kind: 'building';
  id: string; type: string; occupants: number; production: string | null;
  /** The building's kind as the simulation names it, under whatever the card calls it. */
  buildingType: string;
  /** What the kind is called in the plot's age: the townhouse behind "Carter Townhouse". */
  kindName: string;
  /** Why the trade did not work in full yesterday, when it did not. */
  idle: string | null;
  /** The people posted here against its posts, for a workplace. */
  crew: { posted: number; posts: number; over: number } | null;
  /** The professional who keeps a civic building, or what it lacks: null for a building that wants none, or before the township. */
  keeper: { name: string; role: string; tier: string; id: string } | { wants: string; base: number } | null;
  x: number; y: number; upkeep: number; active: boolean;
  people: { id: string; name: string; doing: string }[];
  /** Whether it can be pulled down, and what comes back if it is. */
  ruined: boolean;
    damage: number;
    rebuild: { gold: number; wood: number; stone: number; stocked: boolean };
    demolishable: boolean;
  /** Why it cannot be pulled down, when it cannot. */
  keeps: string | null;
  /** The family that would have to move out, when one lives here. */
  household: string | null;
  salvage: { wood: number; stone: number };
  /** How far it has been improved, and what the next step would take. */
  level: number;
  maxLevel: number;
  /** The age the cap belongs to, and the next one that lifts it, or null at the last. */
  cap: { era: string; next: string | null };
  upgrade: { gold: number; wood: number; stone: number; stocked: boolean } | null;
  /** Improving every building of this type at once, when there is more than one to improve. */
  upgradeAll: { count: number; gold: number; wood: number; stone: number; affordable: number } | null;
  /** What moving it costs, in Gold. */
  moveGold: number;
  /** For a house: who sleeps here against the beds, and the beds an improvement would add. */
  beds: { sleeping: number; room: number; next: number | null } | null;
  /** What the next improvement would do, in a line. */
  improves: string;
  /** For a lodge: the animals alive on the land, and how many its hunters can reach. */
  herd: { land: number; reach: number } | null;
}

export type Focus = FocusCitizen | FocusBuilding;

export interface EventCard {
  id: string; name: string; time: string; status: 'now' | 'later' | 'tomorrow'; attendees: number;
  /** What came of it, once it has finished. Absent while it is still to come. */
  outcome?: string;
}

export interface Snapshot {
  name: string;
  seed: number;
  day: number;
  hour: number;
  clock: string;
  season: string;
  weather: string;
  /** Degrees Celsius, and the word for how that feels. */
  temperature: number;
  temperatureLabel: string;
  population: number;
  /** Everyone who has been born here and everyone who has died. */
  births: number;
  deaths: number;
  /** How many are sat on a bench or at a fire right now. */
  seated: number;
  treasury: number;
  /** The most Gold the settlement may hold, shown beside what it holds. */
  goldCap: number;
  /** What a full treasury turned away yesterday, if anything. */
  unbanked: number;
  /** What the settlement pays, as a multiple of the going rate. */
  wageRate: number;
  /** Today's wage bill at that rate, in Gold. */
  payroll: number;
  happiness: number;
  energy: number;
  food: number;
  employed: number;
  outdoors: number;
  socialising: number;
  familyCount: number;
  householdWealth: number;
  dailyWages: number;
  upkeep: number;
  /**
   * Yesterday's books: what the settlement earned and what it spent, by
   * heading. Today's totals move under the player's eye, so the panel shows
   * both — the running day, and the last one that finished.
   */
  earnedToday: number;
  spentToday: number;
  earnedYesterday: number;
  spentYesterday: number;
  incomeLines: { key: LedgerLine; label: string; amount: number }[];
  outgoingLines: { key: LedgerLine; label: string; amount: number }[];
  /** The standing decision of the last town meeting, while it holds. */
  resolution: { text: string; voters: number; day: number } | null;
  /** What to build next, and why, in order. */
  advice: Advice[];
  /** The professionals: who is in town offering, who is engaged, and whether the plot's age takes them yet. */
  talent: Talent;
  /** What the settlement's showcases have produced, newest first. */
  artworks: { id: string; title: string; maker: string; day: number }[];
  /**
   * What the player is earning by running this place, and why.
   *
   * Kept visible rather than buried in the Bank, because the point of the
   * figure is that it responds to what the player does.
   */
  stewardship: {
    score: number;
    attention: number;
    dailyYield: number;
    lifetime: number;
    /** Real hours since the player last did anything here. */
    idleHours: number;
    cap: number;
  };
  /** What is going wrong right now, and what it is doing. */
  /** A line about the rogue at large, or null when the settlement is at peace with itself. */
  rogue: string | null;
  hazards: { id: string; kind: HazardKind; label: string; effect: string; days: number; hours: number | null; severity: number; fought: boolean; wrecked: number; fight: { gold: number; title: string; blurb: string } }[];
  /**
   * How ready the settlement is for each kind of trouble, as a percentage, with
   * the thing that would improve it. Shown whether or not anything is
   * happening, because the point is to build the defence before the fire.
   */
  readiness: { kind: HazardKind; label: string; percent: number; defence: string }[];
  feed: FeedEntry[];
  events: EventCard[];
  resources: { key: Resource; label: string; amount: number }[];
  market: { key: Resource; label: string; quote: MarketQuote; keep: number; floor: number }[];
  /** Yesterday's real throughput, per resource. */
  production: Partial<Record<Resource, number>>;
  consumption: Partial<Record<Resource, number>>;
  unlockedAreas: string[];
  /** The outer belt is open for building. */
  expanded: boolean;
  /** How many crossings stand, so the Build panel can offer to take one down. */
  bridges: number;
  /** Ponds the player dug, so the fill tool shows only when there is one. */
  dug: number;
  /** Which era the plot is in, and what stands between it and the next. */
  era: { id: number; name: string; days: number; gate: EraGate };
  /** The city level and what the next one asks. */
  city: CityGate;
  /** Charter and insurance bought for the plot: when each runs out, in wall-clock ms, or 0. */
  cover: { charterUntil: number; insuredUntil: number; insured: boolean; buildersUntil: number; builders: boolean };
  /** Today's festival: what one costs, and whether one has been held. */
  festival: { cost: number; held: boolean };
  /** Whether the player has closed the gates to newcomers, and the posts standing open. */
  gates: { closed: boolean; openPosts: number };
  /** The banner the plot flies, or null. */
  banner: string | null;
  /**
   * Everybody and every workplace at a glance: who does what and where, which
   * trades have open posts, which buildings stand short-handed. What the
   * People panel is made of.
   */
  roster: Roster;
  projects: { id: string; name: string; owner: string; progress: number; length: number }[];
  focus: Focus | null;
}

/**
 * Who reports where, in one pass: those posted to a building, and anyone of
 * a trade not yet posted anywhere counted at the trade's first standing site.
 * A map rather than a filter per building, because the roster reads it for
 * every workplace on every snapshot and a city has a hundred of them.
 */
function postedCounts(world: World): Map<string, number> {
  /*
   * Everybody without a workplace of their own used to be counted at the
   * first building of their kind, so a town with three forges and six smiths
   * showed the first one "6 of 2 posts filled" and the other two empty.
   * Players reported the card as a bug, and it was one: the count, not the
   * staffing.
   *
   * They are spread instead, each going to whichever site of their trade has
   * the most room left — which fills the sites evenly and, when a trade is
   * genuinely over its posts, spreads the overflow rather than piling it on
   * one door.
   */
  const sites = new Map<string, Building[]>();
  for (const b of world.buildings) {
    if (!b.active || b.ruined) continue;
    const list = sites.get(b.type);
    if (list) list.push(b); else sites.set(b.type, [b]);
  }
  const counts = new Map<string, number>();
  const spare: Citizen[] = [];
  for (const c of world.citizens) {
    if (c.age < 16 || c.job === 'unemployed') continue;
    if (c.workplaceId) counts.set(c.workplaceId, (counts.get(c.workplaceId) ?? 0) + 1);
    else spare.push(c);
  }
  for (const c of spare) {
    const list = sites.get(JOBS[c.job as WorkingJob].building);
    if (!list?.length) continue;
    const roomiest = list.reduce((best, b) => (
      buildingPosts(b, world) - (counts.get(b.id) ?? 0) > buildingPosts(best, world) - (counts.get(best.id) ?? 0) ? b : best
    ), list[0]);
    counts.set(roomiest.id, (counts.get(roomiest.id) ?? 0) + 1);
  }
  return counts;
}
/** How many people report to this one workplace. */
const postedAt = (world: World, b: Building) => postedCounts(world).get(b.id) ?? 0;

export interface TalentOffer {
  id: string; name: string; role: NotableRole; roleLabel: string; tier: number; tierWord: string;
  fee: number; salary: number; daysLeft: number;
  /** The building they would keep, in the age's name, or null when every post of the role is kept or none stands. */
  post: string | null;
  /** What that building runs at without them, and with them, in per cent. */
  base: number; full: number;
}
export interface Talent {
  open: boolean;
  /** The age they first come to. */
  fromEra: string;
  offers: TalentOffer[];
  hired: { id: string; name: string; roleLabel: string; tierWord: string; building: string; salary: number; days: number; full: number }[];
}
function talentOf(world: World): Talent {
  const open = notablesOpen(world);
  const offers: TalentOffer[] = open ? (world.talent?.offers ?? []).map((o) => {
    const post = postFor(world, o.role);
    return {
      id: o.id, name: o.name, role: o.role, roleLabel: NOTABLE_ROLES[o.role].label, tier: o.tier, tierWord: NOTABLE_TIERS[o.tier],
      fee: o.fee, salary: o.salary, daysLeft: Math.max(0, (o.until ?? world.day) - world.day + 1),
      post: post ? formName(post.type, post.era ?? 1) : null,
      base: Math.round(NOTABLE_BASE * 100), full: Math.round((1 + NOTABLE_BONUS[o.tier]) * 100),
    };
  }) : [];
  const hired = (world.notables ?? []).map((n) => {
    const b = world.buildings.find((x) => x.id === n.buildingId);
    return { id: n.id, name: n.name, roleLabel: NOTABLE_ROLES[n.role].label, tierWord: NOTABLE_TIERS[n.tier], building: b ? formName(b.type, b.era ?? 1) : NOTABLE_ROLES[n.role].buildings[0], salary: n.salary, days: world.day - (n.since ?? world.day), full: Math.round((1 + NOTABLE_BONUS[n.tier]) * 100) };
  });
  return { open, fromEra: eraSpec(NOTABLE_FROM_ERA).name, offers, hired };
}

export interface RosterPerson {
  id: string; name: string; age: number; job: Job; jobLabel: string;
  /** Of age and in a trade, but beyond the posts the trade has: paid for a day that counts for nothing. */
  idle?: boolean;
  /** The kind of building their trade works at, or null for the unemployed. */
  workplace: string | null;
  /** The building they are in right now, if they are at work in one. */
  at: string | null;
  skill: { level: number; title: string } | null;
  /** Holding a trade the player trained them for. */
  trained: boolean;
}
export interface RosterTrade {
  job: WorkingJob; label: string; building: string;
  workers: number; capacity: number; open: number;
}
export interface RosterBuilding {
  id: string; type: string; level: number; ruined: boolean; era: number;
  /** The name over the door in the age it was raised or rebuilt in. */
  name: string;
  /** People at their posts inside right now, and the posts it has; null for a building that employs nobody. */
  crew: number; posts: number | null;
  /** People who carry the trade and report here with no post to fill. */
  over: number;
  /** The trade that works here, if one does. */
  trade: string | null;
}
export interface Roster {
  people: RosterPerson[];
  trades: RosterTrade[];
  buildings: RosterBuilding[];
  unemployed: number;
  openPosts: number;
  trainCost: number;
  hasSchool: boolean;
}

function rosterOf(world: World): Roster {
  const working = (Object.keys(JOBS) as WorkingJob[]);
  const counts: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) counts[c.job] = (counts[c.job] ?? 0) + 1;
  const trades: RosterTrade[] = working.map((job) => {
    const capacity = tradeCapacity(world, job);
    const workers = counts[job] ?? 0;
    return { job, label: tradeTitle(job, eraOf(world)), building: formName(JOBS[job].building, eraOf(world)), workers, capacity, open: Math.max(0, capacity - workers) };
  }).filter((t) => t.capacity > 0 || t.workers > 0);
  const byType = (type: string) => JOBS[working.find((j) => JOBS[j].building === type) as WorkingJob] ? working.find((j) => JOBS[j].building === type) ?? null : null;
  const people: RosterPerson[] = world.citizens.filter((c) => c.age >= 16).map((c) => {
    const job = c.job;
    const at = c.inside && c.targetBuildingId ? world.buildings.find((b) => b.id === c.targetBuildingId) : undefined;
    const days = job === 'unemployed' ? 0 : skillDays(c, job as WorkingJob);
    const level = skillLevel(days);
    return {
      id: c.id, name: c.name, age: Math.floor(c.age), job, jobLabel: tradeTitle(job, eraOf(world)),
      workplace: job === 'unemployed' ? null : JOBS[job as WorkingJob].building,
      at: at ? at.type : null,
      skill: job === 'unemployed' ? null : { level, title: SKILL_TITLES[level] },
      trained: !!c.trained && world.day - c.trained.since < c.trained.hold,
    };
  });
  // The unemployed first, then by trade, then by name.
  people.sort((a, b) => (a.job === 'unemployed' ? 0 : 1) - (b.job === 'unemployed' ? 0 : 1) || a.jobLabel.localeCompare(b.jobLabel) || a.name.localeCompare(b.name));
  const posted = postedCounts(world);
  // Who is beyond the posts: in each trade with more hands than posts, the
  // least learned are the ones without one. This is who the "without work"
  // figure and filter mean, since everybody of age carries a trade.
  const idle = new Set<string>();
  for (const t of trades) {
    if (t.workers <= t.capacity) continue;
    world.citizens.filter((c) => c.age >= 16 && c.job === t.job)
      .sort((a, b) => skillDays(a, t.job) - skillDays(b, t.job))
      .slice(0, t.workers - t.capacity)
      .forEach((c) => idle.add(c.id));
  }
  for (const p of people) if (idle.has(p.id)) p.idle = true;
  const buildings: RosterBuilding[] = world.buildings.filter((b) => b.type !== 'House').map((b) => {
    const trade = byType(b.type);
    return {
      id: b.id, type: b.type, name: formName(b.type, b.era ?? 1), level: levelOf(b), ruined: !!b.ruined, era: b.era ?? 1,
      // Who is posted here, not who happens to be inside this minute: at
      // night every farm read "0 of 4 at their posts", and a player with
      // fourteen farms took that for a town that would not work them.
      ...(() => {
        // A workplace cannot have more posts filled than it has posts. It used
        // to print the head count that reported to the door, so a town with far
        // more hands in a trade than work for them showed "2 slots, 112 filled"
        // beside its own count of a hundred and fifteen without work — two
        // figures from the same panel contradicting each other, which is what
        // players reported. The count is what fills a post; the rest are the
        // ones the panel already calls without work, and the card now says how
        // many of them turned up here.
        const counted = trade ? posted.get(b.id) ?? 0 : b.workers.length;
        const posts = trade ? buildingPosts(b, world) : null;
        return {
          crew: posts === null ? counted : Math.min(counted, posts),
          over: posts === null ? 0 : Math.max(0, counted - posts),
          posts,
          trade: trade ? tradeTitle(trade, eraOf(world)) : null,
        };
      })(),
    };
  }).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return {
    people, trades, buildings,
    unemployed: people.filter((p) => p.job === 'unemployed' || p.idle).length,
    openPosts: trades.reduce((s, t) => s + t.open, 0),
    trainCost: TRAIN_COST_GOLD,
    hasSchool: world.buildings.some((b) => b.type === 'School' && b.active && !b.ruined),
  };
}

const MARKET_ORDER: Resource[] = ['wheat', 'vegetables', 'fish', 'game', 'berries', 'wood', 'stone', 'ironOre', 'wool', 'hides', 'herbs', 'flour', 'bread', 'furniture', 'tools', 'clothing'];

export function formatClock(hour: number) {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour % 1) * 60);
  const suffix = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}

function eventTime(hour: number) {
  const h = Math.floor(hour);
  const suffix = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}

function eventCards(world: World): EventCard[] {
  const live = activeGathering(world);
  const cards = world.gatherings.map((g: Gathering): EventCard => ({
    id: g.id,
    name: g.name,
    time: live?.id === g.id ? 'Happening now' : world.hour > g.hour + g.duration ? 'Tomorrow' : eventTime(g.hour),
    status: live?.id === g.id ? 'now' : world.hour > g.hour + g.duration ? 'tomorrow' : 'later',
    attendees: g.attendees.length,
    outcome: g.outcome,
  }));
  return cards.sort((a, b) => (a.status === 'now' ? -1 : b.status === 'now' ? 1 : 0));
}

function focusFor(world: World, target: { kind: 'citizen' | 'building'; id: string } | null): Focus | null {
  if (!target) return null;
  if (target.kind === 'citizen') {
    const c = world.citizens.find((x) => x.id === target.id);
    if (!c) return null;
    const family = world.families.find((f) => f.id === c.familyId);
    const home = family ? world.buildings.find((b) => b.id === family.homeId) : undefined;
    const project = world.projects.find((p) => p.ownerId === c.id);
    return {
      kind: 'citizen',
      id: c.id, name: c.name, handle: c.handle, age: Math.floor(c.age),
      job: tradeTitle(c.job, eraOf(world)), activity: ACTIVITY_LABELS[c.activity], phase: PHASE_LABELS[c.phase],
      // What they are worth at their trade, and how far off the next step is.
      skill: c.job === 'unemployed' ? null : (() => {
        const days = skillDays(c, c.job as WorkingJob);
        const level = skillLevel(days);
        return {
          level,
          title: SKILL_TITLES[level],
          days: Math.floor(days),
          toNext: daysToNextLevel(days),
          output: skillOutput(c),
        };
      })(),
      // "Socialising" tells the player nothing when the person is in the middle
      // of an actual conversation with somebody they can name.
      status: (() => {
        const with_ = talkingWith(world, c.id);
        return with_ ? `Talking with ${with_.name}` : statusLine(c, world);
      })(),
      family: family?.name ?? 'Unknown',
      home: home ? `${family?.name} House` : null,
      mood: c.happiness, energy: c.rest, purpose: c.purpose, hunger: c.hunger, social: c.social,
      wallet: c.wallet, wage: c.wage,
      friends: friendsOf(world, c.id).slice(0, 4).map((f) => ({ id: f.citizen.id, name: f.citizen.name })),
      traits: [WEALTH_WORDS[wealthOf(c)], ...traitWords(c)],
      lately: latelyOf(world, c).slice(0, 4),
      lastTalk: (() => {
        const talks = Object.entries(c.lastTalk ?? {}).sort((x, y) => y[1].day - x[1].day);
        for (const [id, talk] of talks) {
          const other = world.citizens.find((o) => o.id === id);
          if (other) return { name: other.name, topic: talk.topic, daysAgo: world.day - talk.day };
        }
        return null;
      })(),
      project: project?.name ?? null,
      trouble: c.jailed ? `In the jail, ${c.jailed} ${c.jailed === 1 ? 'day' : 'days'} to go`
        : c.rogue ? `Turned on the settlement${c.rogue.damage ? `, ${c.rogue.damage} ${c.rogue.damage === 1 ? 'building' : 'buildings'} wrecked` : ''}`
          : c.chasing ? 'Going after the rogue'
            : c.sick ? `Sick, day ${c.sick}`
              : c.fleeing && c.fleeing > 0 ? 'Running for open ground' : null,
    };
  }
  const b = world.buildings.find((x) => x.id === target.id);
  if (!b) return null;
  const family = b.type === 'House' ? world.families.find((f) => f.homeId === b.id) : undefined;
  return {
    kind: 'building',
    id: b.id,
    type: family ? `${family.name} ${formName('House', b.era ?? 1)}` : formName(b.type, b.era ?? 1),
    buildingType: b.type,
    kindName: formName(b.type, b.era ?? 1),
    occupants: b.workers.length,
    production: b.production ? tradeTitle(b.production as Job, eraOf(world)) : null,
    idle: (() => {
      const trade = tradeOf(b.type);
      const s = trade ? world.shortages?.[trade] : undefined;
      if (!trade || !s) return null;
      const what = RESOURCE_LABELS[s.short].toLowerCase();
      return s.hands === 0
        ? `Stood idle yesterday: no ${what} in store.`
        : `${s.hands} of ${s.workers} worked yesterday: the store ran short of ${what}.`;
    })(),
    crew: (() => {
      const trade = tradeOf(b.type);
      if (!trade) return null;
      // Posts filled, never bodies at the door — see the roster above.
      const counted = postedAt(world, b);
      const posts = buildingPosts(b, world);
      return { posted: Math.min(counted, posts), posts, over: Math.max(0, counted - posts) };
    })(),
    keeper: (() => {
      const role = roleOf(b.type);
      if (!role || !notablesOpen(world)) return null;
      const n = notableAt(world, b);
      return n
        ? { id: n.id, name: n.name, role: NOTABLE_ROLES[n.role].label, tier: NOTABLE_TIERS[n.tier] }
        : { wants: NOTABLE_ROLES[role].label, base: Math.round(NOTABLE_BASE * 100) };
    })(),
    x: b.x, y: b.y,
    upkeep: Math.round(upkeepOf(b)),
    level: levelOf(b),
    maxLevel: maxLevelFor(world),
    // Why the cap is where it is, for the card to say when it is reached.
    // The next age that actually lifts the cap, not simply the next age: with
    // four from the township to the modern age, "the industrial opens one
    // more" was a promise the industrial did not keep.
    cap: { era: eraSpec(eraOf(world)).name, next: (() => { for (let e = eraOf(world) + 1; e <= ERAS.length; e++) if (formOf('House', e).cap > maxLevelFor(world)) return eraSpec(e).name; return null; })() },
    // `stocked` is what lets the button refuse out loud: Gold alone is not
    // enough to improve a building, and a button that looks live and then does
    // nothing is worse than one that says it cannot yet.
    upgrade: (() => {
      const next = upgradeCost(b, world);
      if (!next) return null;
      return {
        ...next,
        stocked: world.resources.wood >= next.wood && world.resources.stone >= next.stone,
      };
    })(),
    upgradeAll: upgradeAllQuote(world, b.type),
    moveGold: moveCost(b.type),
    improves: upgradeEffect(b.type),
    beds: b.type === 'House'
      ? {
        sleeping: world.families.filter((f) => f.homeId === b.id).reduce((s, f) => s + f.members.length, 0),
        room: houseRoom(b, world),
        next: levelOf(b) < maxLevelFor(world) ? houseRoom({ ...b, level: levelOf(b) + 1 }, world) : null,
      }
      : null,
    herd: b.type === 'Lodge' ? herdOf(world, b) : null,
    active: b.active,
    people: b.workers.map((id) => {
      const c = world.citizens.find((x) => x.id === id);
      return { id, name: c?.name ?? 'Someone', doing: c ? ACTIVITY_LABELS[c.activity] : '' };
    }),
    // The market is the settlement's heart and a lived-in house is somebody's
    // home; neither offers the button.
    ruined: !!b.ruined,
    damage: Math.round((b.damage ?? 0) * 100),
    rebuild: (() => {
      const cost = rebuildCost(b);
      return { ...cost, stocked: world.resources.wood >= cost.wood && world.resources.stone >= cost.stone };
    })(),
    demolishable: !b.ruined && !UNDEMOLISHABLE.includes(b.type),
    keeps: UNDEMOLISHABLE.includes(b.type) ? `The ${formName(b.type, b.era ?? 1).toLowerCase()} holds the settlement together. It cannot be pulled down.` : null,
    household: family && family.members.length > 0 ? family.name : null,
    salvage: (() => {
      const need = buildMaterials(b.type);
      return { wood: Math.floor(need.wood / 2), stone: Math.floor(need.stone / 2) };
    })(),
  };
}

/** Build the snapshot the interface renders from. */
/**
 * One side of a day's books, biggest heading first and the empty ones dropped.
 *
 * A saved world is written by whichever build the player last had open, so it
 * can hold a heading this build has retired — 'idle' outlived the carrying
 * cost that wrote it. The label lookup then came back undefined and the Bank
 * threw on it, which is a whole panel lost to a line worth 250 Gold. Headings
 * this build has no name for are dropped: the money is still in the treasury
 * and still in the day's totals, it simply has nothing to be called.
 */
function ledgerLines(side: Partial<Record<LedgerLine, number>>) {
  return (Object.keys(side) as LedgerLine[])
    .filter((key) => (side[key] ?? 0) >= 0.5 && LEDGER_LABELS[key])
    .map((key) => ({ key, label: LEDGER_LABELS[key], amount: side[key] ?? 0 }))
    .sort((a, b) => b.amount - a.amount);
}

export function snapshot(world: World, target: { kind: 'citizen' | 'building'; id: string } | null): Snapshot {
  const people = world.citizens;
  const count = Math.max(1, people.length);
  const avg = (pick: (c: (typeof people)[number]) => number) => people.reduce((s, c) => s + pick(c), 0) / count;
  const today = ledgerTotals(world.ledger);
  const closed = ledgerTotals(world.ledgerYesterday);
  const ready = readiness(world);

  return {
    name: world.name,
    seed: world.seed,
    day: world.day,
    hour: world.hour,
    clock: formatClock(world.hour),
    season: world.season,
    weather: world.weather,
    temperature: world.temperature,
    temperatureLabel: describeTemperature(world.temperature),
    population: world.population,
    births: world.births,
    deaths: world.deaths,
    seated: people.filter((c) => c.seated).length,
    treasury: world.treasury,
    goldCap: goldCap(world),
    unbanked: Math.round(world.ledgerYesterday?.unbanked ?? 0),
    wageRate: world.wageRate,
    payroll: Math.round(world.citizens
      .filter((c) => c.age >= 16 && c.job !== 'unemployed')
      .reduce((sum, c) => sum + JOBS[c.job as WorkingJob].wage, 0) * world.wageRate),
    happiness: Math.round(avg((c) => c.happiness)),
    energy: Math.round(avg((c) => c.rest)),
    food: Math.round(foodInStore(world)),
    employed: people.filter((c) => c.job !== 'unemployed').length,
    outdoors: people.filter((c) => !c.inside).length,
    socialising: people.filter((c) => c.activity === 'trading').length,
    familyCount: world.families.length,
    householdWealth: world.families.reduce((s, f) => s + f.wealth, 0),
    dailyWages: people.reduce((s, c) => s + c.wage, 0),
    upkeep: world.buildings.filter((b) => b.active).length,
    earnedToday: today.earned,
    spentToday: today.spent,
    earnedYesterday: closed.earned,
    spentYesterday: closed.spent,
    incomeLines: ledgerLines(world.ledgerYesterday.in),
    outgoingLines: ledgerLines(world.ledgerYesterday.out),
    advice: adviseBuild(world),
    talent: talentOf(world),
    resolution: world.resolution
      ? { text: world.resolution.text, voters: world.resolution.voters, day: world.resolution.day }
      : null,
    artworks: world.artworks.slice(0, 8).map((a) => ({ id: a.id, title: a.title, maker: a.maker, day: a.day })),
    stewardship: {
      score: world.stewardship.score,
      attention: world.stewardship.attention,
      dailyYield: world.stewardship.dailyYield,
      lifetime: world.stewardship.lifetime,
      idleHours: Math.max(0, (Date.now() - world.stewardship.lastActionAt) / 3_600_000),
      cap: dailyCeiling(world),
    },
    rogue: (() => {
      const r = world.citizens.find((c) => c.rogue);
      if (!r) return null;
      const mark = world.buildings.find((b) => b.id === r.rogue?.targetId);
      const after = world.citizens.filter((c) => c.chasing === r.id).map((c) => c.name);
      return `${r.name} is wrecking ${mark ? `the ${formName(mark.type, mark.era ?? 1).toLowerCase()}` : 'what they can'}${after.length ? `. ${after.join(' and ')} ${after.length === 1 ? 'is' : 'are'} after them` : ''}.`;
    })(),
    hazards: world.hazards.map((h) => ({
      id: h.id, kind: h.kind, label: h.label, effect: h.effect, days: h.days,
      hours: h.hours !== undefined && h.hours > 0 ? Math.ceil(h.hours) : null,
      severity: h.severity ?? 0.5, fought: !!h.fought, wrecked: (h.wrecked ?? []).length,
      fight: { gold: fightCost(world, h), title: HAZARD_FIGHT[h.kind].title, blurb: HAZARD_FIGHT[h.kind].blurb },
    })),
    readiness: (Object.entries(ready) as [HazardKind, number][])
      .map(([kind, value]) => ({
        kind,
        label: HAZARD_LABELS[kind],
        percent: Math.round(value * 100),
        defence: HAZARD_DEFENCE[kind],
      }))
      .sort((a, b) => a.percent - b.percent),
    feed: world.feed.slice(0, 14),
    events: eventCards(world),
    resources: (Object.keys(RESOURCE_LABELS) as Resource[]).map((key) => ({ key, label: RESOURCE_LABELS[key], amount: world.resources[key] })),
    market: MARKET_ORDER.map((key) => ({ key, label: RESOURCE_LABELS[key], quote: world.market[key], keep: world.keep?.[key] ?? 0, floor: keepOf(world, key) })),
    production: { ...world.flow.produced },
    consumption: { ...world.flow.consumed },
    unlockedAreas: [...world.unlockedAreas],
    expanded: !!world.expanded,
    bridges: world.layout.bridges.length,
    dug: (world.dug ?? []).length,
    era: { id: eraOf(world), name: eraSpec(eraOf(world)).name, days: Math.max(0, world.day - (world.eraSince ?? 1)), gate: eraGate(world) },
    city: cityGate(world),
    cover: { charterUntil: world.charterUntil ?? 0, insuredUntil: world.insuredUntil ?? 0, insured: insured(world), buildersUntil: world.buildersUntil ?? 0, builders: buildersHere(world) },
    festival: { cost: festivalCost(world), held: world.festivalDay === world.day },
    gates: { closed: !!world.gatesClosed, openPosts: openPostsOf(world) },
    banner: world.banner ?? null,
    roster: rosterOf(world),
    projects: world.projects.map((p) => ({
      id: p.id, name: p.name, progress: p.progress, length: p.length,
      owner: world.citizens.find((c) => c.id === p.ownerId)?.name ?? 'Someone',
    })),
    focus: focusFor(world, target),
  };
}

/** Feed entry icons, keyed by the event kind the simulation recorded. */
export const FEED_ICON: Record<FeedEntry['kind'], string> = {
  world: '✦',
  build: '⌂',
  social: '✧',
  discovery: '◈',
  project: '✎',
  market: '◎',
  weather: '☁',
  work: '⚒',
};

export const WEATHER_ICON: Record<string, string> = {
  Clear: '☀', Cloudy: '☁', Rain: '☂', Storm: '⚡', Fog: '≋', Snow: '❄',
};
