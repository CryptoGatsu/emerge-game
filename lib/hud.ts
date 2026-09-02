/**
 * HUD snapshots.
 *
 * The world advances every animation frame, but React only needs a readable
 * summary a few times a second. This module turns the live world into a small
 * plain object so the interface never re-renders off the simulation's clock and
 * never holds a reference into mutable simulation state.
 */

import {
  ACTIVITY_LABELS, JOB_LABELS, PHASE_LABELS, RESOURCE_LABELS,
  activeGathering, describeTemperature, friendsOf,
  type FeedEntry, type Gathering, type MarketQuote, type Resource, type World,
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
}

export type Focus = FocusCitizen | FocusBuilding;

export interface EventCard { id: string; name: string; time: string; status: 'now' | 'later' | 'tomorrow'; attendees: number }

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
      status: statusLine(c),
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
  };
}

/** Build the snapshot the interface renders from. */
export function snapshot(world: World, target: { kind: 'citizen' | 'building'; id: string } | null): Snapshot {
  const people = world.citizens;
  const count = Math.max(1, people.length);
  const avg = (pick: (c: (typeof people)[number]) => number) => people.reduce((s, c) => s + pick(c), 0) / count;

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
