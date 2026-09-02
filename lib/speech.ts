/**
 * Speech and thought lines.
 *
 * Lines are derived from real citizen state (activity, job, needs, weather) and
 * picked deterministically from the citizen's hash plus a slowly-changing beat,
 * so a bubble stays stable while it is on screen instead of flickering every
 * frame. Nothing here feeds back into the simulation.
 */

import {
  JOB_LABELS, buildingOf, plannedDay, spokenLine, talkingWith,
  type Citizen, type World,
} from './simulation';

type Line = string;

const BY_ACTIVITY: Record<string, Line[]> = {
  working: [
    'Working on a new idea...',
    'Almost got the rhythm of this.',
    'This batch is going to be a good one.',
    'One more run and I can call it a day.',
    'The settlement needs this finished.',
  ],
  walking: [
    'Beautiful day in {world}.',
    'Long way round today.',
    'The path by the water is worth it.',
    'Heading over now.',
    'I keep meaning to plant something here.',
  ],
  trading: [
    'Anyone want to trade resources?',
    'Best market in {world}.',
    'Just finished my new song.',
    'You should have seen the market today.',
    'Tell me what you have been building.',
    'Same time tomorrow?',
  ],
  eating: [
    'Bread is still warm.',
    'I needed this.',
    'Best thing all day.',
    'Trading a loaf for a story.',
  ],
  resting: [
    'Quiet night.',
    'Resting my hands.',
    'Tomorrow I start something new.',
    'Home at last.',
  ],
  idle: [
    'I like it here in {world}.',
    'Watching the world go by.',
    'Wonder what is over the ridge.',
    'Nothing to do but look at the trees.',
    'The light here is lovely.',
  ],
};

const BY_JOB: Partial<Record<string, Line[]>> = {
  farmer: ['The fields are coming along.', 'Rain would help right now.'],
  woodcutter: ['This grove keeps giving.', 'Careful where that one falls.'],
  miner: ['Something is glinting down there.', 'Deeper than I thought.'],
  quarry: ['Good clean stone today.', 'This block is for the square.'],
  miller: ['Wheat in, flour out.', 'The wheel is running sweet.'],
  baker: ['Fresh bread in an hour.', 'Save one for the tavern.'],
  carpenter: ['Measure twice out here.', 'This joint will outlive me.'],
  blacksmith: ['Tools for the whole street.', 'The forge is hot enough.'],
  tailor: ['Winter is coming for these coats.', 'Wool is finally in.'],
};

const BY_NEED: { test: (c: Citizen) => boolean; lines: Line[] }[] = [
  { test: (c) => c.hunger < 30, lines: ['I need to get to the market.', 'Running on empty.'] },
  { test: (c) => c.rest < 25, lines: ['I have been up too long.', 'Just need to sit down.'] },
  { test: (c) => c.social < 25, lines: ['It has been a quiet few days.', 'I should find the others.'] },
  { test: (c) => c.purpose > 88, lines: ['I know exactly what to build next.', 'Everything is clicking today.'] },
];

/** Time of day colours what people say as much as what they are doing. */
const BY_HOUR: { from: number; to: number; lines: Line[] }[] = [
  { from: 0, to: 5.5, lines: ['Cannot sleep tonight.', '{world} is so quiet now.', 'Just the stars out here.'] },
  { from: 5.5, to: 8, lines: ['Early start today.', 'Nobody else is up yet.', 'Cold this morning.'] },
  { from: 19, to: 21.5, lines: ['Lanterns are on.', 'Long day. Worth it.', 'Meet you at the tavern?'] },
  { from: 21.5, to: 24, lines: ['Heading home.', 'One more song and I will turn in.', 'Good night, {world}.'] },
];

const BY_WEATHER: Partial<Record<string, Line[]>> = {
  Rain: ['Rain is good for the fields.', 'Should have brought a hood.'],
  Storm: ['Getting inside before that hits.', 'Wind is picking up.'],
  Snow: ['First snow of the season.', 'Cold enough to see your breath.'],
  Fog: ['Cannot see the ridge at all.', 'Everything sounds closer in this.'],
};

/** A line for a citizen at the current beat, or null when they have nothing to say. */
export function speechFor(world: World, c: Citizen, beat: number): string | null {
  // An actual conversation outranks anything this module can invent. When
  // somebody is mid-exchange the bubble is their turn in it, so two people
  // standing together take turns on one subject instead of saying two
  // unrelated things at each other.
  const spoken = spokenLine(world, c.id);
  if (spoken) return spoken.text;
  // In a conversation but not the one talking: listening. Turn-taking only
  // reads as turn-taking if the listener is quiet — otherwise both bubbles are
  // up at once and it looks like two people talking over each other.
  if (talkingWith(world, c.id)) return null;

  const roll = (c.hash * 31 + beat * 17) % 100;
  if (roll > 34) return null;

  // What they are actually doing, before anything generic. A line that names
  // where this person is walking and why is worth a dozen that could belong to
  // anybody: "Off to the bakery — flour to drop in" tells the player something
  // true about the settlement, and "Beautiful day in Fernrest" does not.
  const real = plannedLine(world, c);
  if (real && (c.hash + beat) % 3 !== 0) return real.replace('{world}', world.name);

  return moodLine(world, c, beat);
}

/**
 * A line about this citizen's real errand.
 *
 * Everything here is read out of the simulation: where they are heading, what
 * building that is, what their trade does with it, and what they mean to do
 * with the rest of the day.
 */
function plannedLine(world: World, c: Citizen): string | null {
  if (c.age < 16) return null;
  const plan = plannedDay(world, c);
  const heading = buildingOf(world, c.destId);

  if (c.swimming) return 'Cold — making for the bank.';
  if (c.carried) return 'Put me down!';

  if (c.activity === 'walking' && heading) {
    const place = heading.type === 'House'
      ? (world.families.find((f) => f.homeId === heading.id)?.name ?? '') + ' house'
      : `the ${heading.type.toLowerCase()}`;
    switch (c.phase) {
      case 'working': return `Off to ${place}. ${plan.work}`;
      case 'eating': return `Going to ${place} for something to eat.`;
      case 'socialising': return `Heading to ${place} for the evening.`;
      case 'sleeping':
      case 'athome': return `Turning in. Back to ${place}.`;
      default: return `On my way to ${place}.`;
    }
  }

  if (c.activity === 'working') return plan.work;
  if (c.phase === 'socialising' && plan.evening) return plan.evening;
  if (c.phase === 'eating') return 'Getting something to eat before I go back.';
  if (c.phase === 'sleeping') return null;
  return plan.today;
}

/** The old, mood-driven line, still used when there is nothing concrete to say. */
function moodLine(world: World, c: Citizen, beat: number): string | null {
  const pools: Line[][] = [];
  for (const need of BY_NEED) if (need.test(c)) pools.push(need.lines);
  const hour = BY_HOUR.find((h) => world.hour >= h.from && world.hour < h.to);
  // Weight the time of day heavily: nothing breaks the illusion faster than
  // someone admiring a beautiful day at ten at night.
  if (hour) { pools.push(hour.lines); pools.push(hour.lines); }
  const weather = BY_WEATHER[world.weather];
  if (weather && !c.inside) pools.push(weather);
  const job = BY_JOB[c.job];
  if (job && c.activity === 'working') pools.push(job);
  if (!hour) pools.push(BY_ACTIVITY[c.activity] ?? BY_ACTIVITY.idle);

  const pool = pools[(c.hash + beat) % pools.length];
  // Citizens name the place they live in, whatever the player called it.
  return pool[(c.hash * 7 + beat * 3) % pool.length].replace('{world}', world.name);
}

/** One-line status used by the inspector and the selected-being card. */
export function statusLine(c: Citizen): string {
  if (c.age < 16) return c.activity === 'walking' ? 'Exploring the settlement' : 'Playing outside';
  switch (c.activity) {
    case 'working': return `${JOB_LABELS[c.job]} at work`;
    case 'walking': return 'On the way somewhere';
    case 'trading': return 'Socialising';
    case 'eating': return 'Eating at the market';
    case 'resting': return 'Resting at home';
    default: return 'Taking a moment';
  }
}
