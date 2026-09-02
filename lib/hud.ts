/**
 * HUD snapshots.
 *
 * The world advances every animation frame, but React only needs a readable
 * summary a few times a second. This module turns the live world into a small
 * plain object so the interface never re-renders off the simulation's clock and
 * never holds a reference into mutable simulation state.
 */

import {
  ACTIVITY_LABELS, HAZARD_DEFENCE, HAZARD_LABELS, JOB_LABELS, LEDGER_LABELS, PHASE_LABELS,
  RESOURCE_LABELS, STEWARDSHIP_DAILY_CAP,
  activeGathering, buildMaterials, describeTemperature, friendsOf, ledgerTotals, readiness, talkingWith,
  type FeedEntry, type Gathering, type HazardKind, type LedgerLine, type MarketQuote, type Resource, type World,
} from './simulation';
import { statusLine } from './speech';

export interface FocusCitizen {
  kind: 'citizen';
  id: string; name: string; handle: string; age: number;
  job: string; activity: string; phase: string; status: string;
  family: string; home: string | null;
  mood: number; energy: number; purpose: number; hunger: number; social: number;
  wallet: number; wage: number;
  friends: { id: string; name: string }[];
  project: string | null;
}

export interface FocusBuilding {
  kind: 'building';
  id: string; type: string; occupants: number; production: string | null;
  x: number; y: number; upkeep: number; active: boolean;
  people: { id: string; name: string; doing: string }[];
  /** Whether it can be pulled down, and what comes back if it is. */
  demolishable: boolean;
  salvage: { wood: number; stone: number };
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
    idleDays: number;
    cap: number;
  };
  /** What is going wrong right now, and what it is doing. */
  hazards: { id: string; kind: HazardKind; label: string; effect: string; days: number }[];
  /**
   * How ready the settlement is for each kind of trouble, as a percentage, with
   * the thing that would improve it. Shown whether or not anything is
   * happening, because the point is to build the defence before the fire.
   */
  readiness: { kind: HazardKind; label: string; percent: number; defence: string }[];
  feed: FeedEntry[];
  events: EventCard[];
  resources: { key: Resource; label: string; amount: number }[];
  market: { key: Resource; label: string; quote: MarketQuote }[];
  /** Yesterday's real throughput, per resource. */
  production: Partial<Record<Resource, number>>;
  consumption: Partial<Record<Resource, number>>;
  unlockedAreas: string[];
  projects: { id: string; name: string; owner: string; progress: number; length: number }[];
  focus: Focus | null;
}

const MARKET_ORDER: Resource[] = ['wheat', 'vegetables', 'wood', 'stone', 'ironOre', 'wool', 'flour', 'bread', 'furniture', 'tools', 'clothing'];

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
      job: JOB_LABELS[c.job], activity: ACTIVITY_LABELS[c.activity], phase: PHASE_LABELS[c.phase],
      // "Socialising" tells the player nothing when the person is in the middle
      // of an actual conversation with somebody they can name.
      status: (() => {
        const with_ = talkingWith(world, c.id);
        return with_ ? `Talking with ${with_.name}` : statusLine(c);
      })(),
      family: family?.name ?? 'Unknown',
      home: home ? `${family?.name} House` : null,
      mood: c.happiness, energy: c.rest, purpose: c.purpose, hunger: c.hunger, social: c.social,
      wallet: c.wallet, wage: c.wage,
      friends: friendsOf(world, c.id).slice(0, 4).map((f) => ({ id: f.citizen.id, name: f.citizen.name })),
      project: project?.name ?? null,
    };
  }
  const b = world.buildings.find((x) => x.id === target.id);
  if (!b) return null;
  const family = b.type === 'House' ? world.families.find((f) => f.homeId === b.id) : undefined;
  return {
    kind: 'building',
    id: b.id,
    type: family ? `${family.name} House` : b.type,
    occupants: b.workers.length,
    production: b.production ? JOB_LABELS[b.production as keyof typeof JOB_LABELS] ?? b.production : null,
    x: b.x, y: b.y,
    upkeep: 0,
    active: b.active,
    people: b.workers.map((id) => {
      const c = world.citizens.find((x) => x.id === id);
      return { id, name: c?.name ?? 'Someone', doing: c ? ACTIVITY_LABELS[c.activity] : '' };
    }),
    // The market is the settlement's heart and a lived-in house is somebody's
    // home; neither offers the button.
    demolishable: b.type !== 'Market' && !(family && family.members.length > 0),
    salvage: (() => {
      const need = buildMaterials(b.type);
      return { wood: Math.floor(need.wood / 2), stone: Math.floor(need.stone / 2) };
    })(),
  };
}

/** Build the snapshot the interface renders from. */
/** One side of a day's books, biggest heading first and the empty ones dropped. */
function ledgerLines(side: Partial<Record<LedgerLine, number>>) {
  return (Object.keys(side) as LedgerLine[])
    .filter((key) => (side[key] ?? 0) >= 0.5)
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
    happiness: Math.round(avg((c) => c.happiness)),
    energy: Math.round(avg((c) => c.rest)),
    food: Math.round(world.resources.bread + world.resources.wheat + world.resources.vegetables),
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
    resolution: world.resolution
      ? { text: world.resolution.text, voters: world.resolution.voters, day: world.resolution.day }
      : null,
    artworks: world.artworks.slice(0, 8).map((a) => ({ id: a.id, title: a.title, maker: a.maker, day: a.day })),
    stewardship: {
      score: world.stewardship.score,
      attention: world.stewardship.attention,
      dailyYield: world.stewardship.dailyYield,
      lifetime: world.stewardship.lifetime,
      idleDays: Math.max(0, world.day - world.stewardship.lastActionDay),
      cap: STEWARDSHIP_DAILY_CAP,
    },
    hazards: world.hazards.map((h) => ({ id: h.id, kind: h.kind, label: h.label, effect: h.effect, days: h.days })),
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
    market: MARKET_ORDER.map((key) => ({ key, label: RESOURCE_LABELS[key], quote: world.market[key] })),
    production: { ...world.flow.produced },
    consumption: { ...world.flow.consumed },
    unlockedAreas: [...world.unlockedAreas],
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
