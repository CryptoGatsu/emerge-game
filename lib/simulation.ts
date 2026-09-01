export type Terrain = 'fertile' | 'forest' | 'mountain' | 'rocky' | 'coastal' | 'river';
export type Job = 'farmer' | 'woodcutter' | 'miner' | 'quarry' | 'miller' | 'baker' | 'carpenter' | 'blacksmith' | 'tailor' | 'unemployed';
export type WorkingJob = Exclude<Job, 'unemployed'>;
export type Activity = 'walking' | 'working' | 'resting' | 'trading' | 'eating' | 'idle';
export type Phase = 'sleeping' | 'athome' | 'working' | 'eating' | 'socialising' | 'wandering';
export type Facing = 'n' | 's' | 'e' | 'w';
export type Season = 'Spring' | 'Summer' | 'Autumn' | 'Winter';
export type Weather = 'Clear' | 'Cloudy' | 'Rain' | 'Storm' | 'Fog' | 'Snow';
export type Resource = 'wheat' | 'vegetables' | 'wood' | 'stone' | 'ironOre' | 'wool' | 'flour' | 'bread' | 'furniture' | 'tools' | 'clothing';

export interface Citizen {
  id: string; name: string; familyId: string; age: number; job: Job; hash: number;
  hunger: number; rest: number; social: number; clothing: number; purpose: number;
  happiness: number; wage: number; wallet: number;
  x: number; y: number;
  destX: number; destY: number; destId?: string;
  path: number[]; dwell: number; wanderIdx: number; errand: boolean;
  phase: Phase; activity: Activity; facing: Facing; moving: boolean;
  targetBuildingId?: string; inside: boolean;
}
export interface Family { id: string; name: string; members: string[]; homeId: string; wealth: number; }
export interface Building { id: string; type: string; x: number; y: number; workers: string[]; active: boolean; production?: string; }
export interface MarketQuote { price: number; supply: number; demand: number; volume: number; trend: number; }
export interface World {
  id: string; seed: number; day: number; hour: number; terrain: Terrain[];
  season: Season; weather: Weather; weatherSeed: number; treasury: number; population: number;
  families: Family[]; citizens: Citizen[]; buildings: Building[];
  resources: Record<Resource, number>; market: Record<Resource, MarketQuote>; lastEvents: string[];
}

export const RESOURCE_LABELS: Record<Resource, string> = { wheat: 'Wheat', vegetables: 'Vegetables', wood: 'Wood', stone: 'Stone', ironOre: 'Iron Ore', wool: 'Wool', flour: 'Flour', bread: 'Bread', furniture: 'Furniture', tools: 'Tools', clothing: 'Clothing' };
export const JOB_LABELS: Record<Job, string> = { farmer: 'Farmer', woodcutter: 'Woodcutter', miner: 'Miner', quarry: 'Quarry worker', miller: 'Miller', baker: 'Baker', carpenter: 'Carpenter', blacksmith: 'Blacksmith', tailor: 'Tailor', unemployed: 'Unemployed' };
export const ACTIVITY_LABELS: Record<Activity, string> = { walking: 'Walking', working: 'Working', resting: 'At home', trading: 'Socializing', eating: 'Eating', idle: 'Idle' };
export const PHASE_LABELS: Record<Phase, string> = { sleeping: 'Asleep', athome: 'At home', working: 'At work', eating: 'Getting food', socialising: 'Socialising', wandering: 'Wandering' };

const jobs: Record<WorkingJob, { wage: number; output: Partial<Record<Resource, number>>; input?: Partial<Record<Resource, number>>; building: string }> = {
  farmer: { wage: 10, output: { wheat: 10, vegetables: 5 }, building: 'Farm' },
  woodcutter: { wage: 11, output: { wood: 12.5 }, building: 'Woodcutter' },
  miner: { wage: 14, output: { ironOre: 3.33 }, building: 'Mine' },
  quarry: { wage: 12, output: { stone: 9 }, building: 'Quarry' },
  miller: { wage: 13, output: { flour: 10 }, input: { wheat: 10 }, building: 'Mill' },
  baker: { wage: 15, output: { bread: 10 }, input: { flour: 10, wood: 2.5 }, building: 'Bakery' },
  carpenter: { wage: 15, output: { furniture: 5 }, input: { wood: 10 }, building: 'Carpenter' },
  blacksmith: { wage: 18, output: { tools: 4 }, input: { ironOre: 8, wood: 4 }, building: 'Blacksmith' },
  tailor: { wage: 16, output: { clothing: 4 }, input: { wool: 4 }, building: 'Tailor' },
};

const names = ['Avery', 'Carter', 'Maya', 'Noah', 'Elena', 'Theo', 'Iris', 'Miles', 'Lena', 'Jonah', 'Ruby', 'Owen', 'Nora', 'Eli', 'Clara', 'Finn', 'Milo', 'June', 'Ada', 'Leo', 'Mae', 'Sam', 'Wren', 'Kai', 'Rose', 'Jack', 'Lily', 'Ben', 'Anna', 'Max'];
const familyNames = ['Carter', 'Mason', 'Hayes', 'Bennett', 'Reed', 'Morgan', 'Brooks', 'Parker'];
const marketPrices: Record<Resource, number> = { wheat: 2, vegetables: 2.5, wood: 3, stone: 4, ironOre: 7, wool: 6, flour: 5, bread: 7, furniture: 14, tools: 20, clothing: 18 };
const marketBuffers: Record<Resource, number> = { wheat: 60, vegetables: 40, wood: 70, stone: 30, ironOre: 20, wool: 15, flour: 25, bread: 40, furniture: 10, tools: 8, clothing: 15 };
const terrainBonuses: Record<Terrain, Partial<Record<WorkingJob, number>>> = { fertile: { farmer: 1.3 }, forest: { woodcutter: 1.3 }, mountain: { miner: 1.3 }, rocky: { quarry: 1.25 }, coastal: {}, river: { farmer: 1.15 } };

// Road graph. Node coordinates match the drawn paths in the world view.
const roadNodes: [number, number][] = [[29, 24], [50, 24], [66, 24], [50, 46], [28, 46], [20, 72], [50, 72], [70, 82], [84, 72]];
const roadEdges: number[][] = [[1], [0, 2, 3], [1, 8], [1, 4, 6], [3, 5, 6], [4, 6], [3, 4, 5, 7], [6, 8], [7, 2]];

// BUGFIX: previously the only wander destinations were the 9 road nodes, so ~3 citizens
// stacked on each one. Sampling along every road segment gives ~50 distinct spots.
const wanderSpots: [number, number][] = (() => {
  const out: [number, number][] = [...roadNodes];
  const seen = new Set<string>();
  roadEdges.forEach((neighbours, a) => neighbours.forEach((b) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const t of [0.2, 0.4, 0.6, 0.8]) {
      out.push([roadNodes[a][0] + (roadNodes[b][0] - roadNodes[a][0]) * t, roadNodes[a][1] + (roadNodes[b][1] - roadNodes[a][1]) * t]);
    }
  }));
  return out;
})();

export function mulberry32(seed: number) {
  return function () { let t = (seed += 0x6D2B79F5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Deterministic golden-angle scatter so citizens sharing a destination stand in a ring
// around it instead of on the same pixel. Y is squashed to read as ground plane.
function standingOffset(hash: number, spread = 2.4): [number, number] {
  const angle = hash * 2.399963229728653;
  const r = spread + (hash % 4) * 0.75;
  return [Math.cos(angle) * r, Math.sin(angle) * r * 0.6];
}

function scheduleFor(hash: number) {
  return {
    wake: 6 + (hash % 3) * 0.5,
    workStart: 8 + (hash % 4) * 0.25,
    lunch: 12 + (hash % 3) * 0.3,
    lunchEnd: 13 + (hash % 2) * 0.4,
    workEnd: 17 + (hash % 3) * 0.5,
    homeTime: 21 + (hash % 4) * 0.3,
  };
}

function phaseFor(c: Citizen, hour: number): Phase {
  const s = scheduleFor(c.hash);
  const nightOwl = c.hash % 7 === 0;
  if (c.age < 16) {
    if (hour < s.wake || hour >= s.homeTime - 1.5) return 'sleeping';
    return hour > 15 ? 'wandering' : 'wandering';
  }
  if (hour < s.wake || hour >= s.homeTime + 1) return nightOwl ? 'wandering' : 'sleeping';
  if (hour < s.workStart) return 'athome';
  if (hour < s.lunch) return 'working';
  if (hour < s.lunchEnd) return 'eating';
  if (hour < s.workEnd) return 'working';
  if (hour < s.homeTime) return 'socialising';
  return 'athome';
}

function activityFor(phase: Phase): Activity {
  return phase === 'working' ? 'working' : phase === 'eating' ? 'eating' : phase === 'socialising' ? 'trading' : phase === 'wandering' ? 'idle' : 'resting';
}

function nearestRoad(x: number, y: number) {
  let best = 0, dist = Infinity;
  for (let i = 0; i < roadNodes.length; i++) { const n = roadNodes[i], d = (n[0] - x) ** 2 + (n[1] - y) ** 2; if (d < dist) { dist = d; best = i; } }
  return best;
}
function roadDistance(a: number, b: number) { return Math.hypot(roadNodes[a][0] - roadNodes[b][0], roadNodes[a][1] - roadNodes[b][1]); }
function roadPath(start: number, end: number): number[] {
  if (start === end) return [start];
  const open = [start], came = new Map<number, number>(), g = new Map([[start, 0]]), f = new Map([[start, roadDistance(start, end)]]);
  while (open.length) {
    open.sort((a, b) => (f.get(a) ?? Infinity) - (f.get(b) ?? Infinity));
    const current = open.shift()!;
    if (current === end) { const path = [current]; let cursor = current; while (came.has(cursor)) { cursor = came.get(cursor)!; path.unshift(cursor); } return path; }
    for (const next of roadEdges[current]) {
      const score = (g.get(current) ?? Infinity) + roadDistance(current, next);
      if (score < (g.get(next) ?? Infinity)) { came.set(next, current); g.set(next, score); f.set(next, score + roadDistance(next, end)); if (!open.includes(next)) open.push(next); }
    }
  }
  return [start, end];
}

function findBuilding(world: World, type: string) { return world.buildings.find((b) => b.type === type); }
function homeOf(world: World, c: Citizen) {
  const family = world.families.find((f) => f.id === c.familyId);
  return family ? world.buildings.find((b) => b.id === family.homeId) : undefined;
}
function jobBuilding(world: World, c: Citizen) { return c.job === 'unemployed' ? undefined : findBuilding(world, jobs[c.job].building); }

// BUGFIX: destinations are now committed and persist until the citizen actually arrives,
// instead of being recomputed every tick (which made everyone reverse direction mid-walk).
function assignDestination(world: World, c: Citizen, phase: Phase) {
  c.phase = phase;
  let target: { x: number; y: number; id?: string } | undefined;
  let spread = 2.4;

  if (phase === 'sleeping' || phase === 'athome') {
    target = homeOf(world, c);
    spread = 2.0;
  } else if (phase === 'working') {
    // Alternate between the workplace and a delivery run, so work is a visible loop.
    const workplace = jobBuilding(world, c);
    const depot = findBuilding(world, 'Storage') ?? findBuilding(world, 'Market');
    target = c.errand ? depot ?? workplace : workplace ?? depot;
    c.errand = !c.errand;
  } else if (phase === 'eating') {
    target = findBuilding(world, 'Market') ?? findBuilding(world, 'Bakery');
  } else if (phase === 'socialising') {
    const options = [findBuilding(world, 'Tavern'), findBuilding(world, 'Market'), undefined];
    target = options[c.wanderIdx % options.length];
    spread = 3.0;
  }

  if (!target) {
    c.wanderIdx = (c.wanderIdx * 7 + c.hash + 3) % wanderSpots.length;
    const spot = wanderSpots[c.wanderIdx];
    target = { x: spot[0], y: spot[1] };
    spread = 1.2;
  }

  const [ox, oy] = standingOffset(c.hash + c.wanderIdx, spread);
  c.destX = clamp(target.x + ox, 3, 97);
  c.destY = clamp(target.y + oy, 5, 95);
  c.destId = target.id;
  c.path = roadPath(nearestRoad(c.x, c.y), nearestRoad(c.destX, c.destY)).slice(1);
  c.dwell = phase === 'working' ? 1.2 + (c.hash % 4) * 0.4 : phase === 'socialising' ? 0.9 + (c.hash % 3) * 0.5 : 0.7 + (c.hash % 5) * 0.3;
  if (phase === 'socialising' || phase === 'wandering') c.wanderIdx = (c.wanderIdx + 1) % wanderSpots.length;
}

function hasArrived(c: Citizen) { return c.path.length === 0 && Math.hypot(c.destX - c.x, c.destY - c.y) < 0.06; }

function stepCitizen(c: Citizen, hours: number) {
  let budget = (c.age < 16 ? 9 : 12.5) * hours;
  c.moving = false;
  let guard = 0;
  while (budget > 0 && guard++ < 24) {
    const final = c.path.length === 0;
    const tx = final ? c.destX : roadNodes[c.path[0]][0];
    const ty = final ? c.destY : roadNodes[c.path[0]][1];
    const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
    if (d < 0.0001) { if (final) break; c.path.shift(); continue; }
    if (Math.abs(dx) > Math.abs(dy)) c.facing = dx > 0 ? 'e' : 'w'; else c.facing = dy > 0 ? 's' : 'n';
    const step = Math.min(d, budget);
    c.x = clamp(c.x + (dx / d) * step, 2, 98);
    c.y = clamp(c.y + (dy / d) * step, 4, 96);
    c.moving = true;
    budget -= step;
    if (step >= d && !final) c.path.shift(); else if (step >= d) break;
  }
}

function moveCitizens(world: World, hours: number) {
  for (const c of world.citizens) {
    if (c.age < 16) c.job = 'unemployed';
    let phase = phaseFor(c, world.hour);
    if (c.hunger < 35 && phase !== 'sleeping') phase = 'eating';

    if (phase !== c.phase) {
      assignDestination(world, c, phase);
    } else if (hasArrived(c)) {
      // Only re-roll a destination after dwelling, never mid-journey.
      if (phase === 'wandering' || phase === 'socialising' || phase === 'working') {
        c.dwell -= hours;
        if (c.dwell <= 0) assignDestination(world, c, phase);
      }
    }

    stepCitizen(c, hours);
    const arrived = hasArrived(c);
    c.activity = arrived ? activityFor(phase) : 'walking';
    c.inside = arrived && !!c.destId && phase !== 'wandering';
    c.targetBuildingId = c.destId;
  }
}

function updateBuildingWorkers(world: World) {
  for (const b of world.buildings) { b.workers = []; b.production = undefined; }
  for (const c of world.citizens) {
    if (!c.targetBuildingId || !c.inside) continue;
    const b = world.buildings.find((x) => x.id === c.targetBuildingId);
    if (!b) continue;
    if (c.activity === 'working' || c.activity === 'trading' || c.activity === 'resting' || c.activity === 'eating') {
      if (b.workers.length < 8) b.workers.push(c.id);
      if (c.activity === 'working') b.production = c.job;
    }
  }
}

function createMarket(): Record<Resource, MarketQuote> {
  return Object.fromEntries((Object.keys(marketPrices) as Resource[]).map((r) => [r, { price: marketPrices[r], supply: 0, demand: 0, volume: 0, trend: 0 }])) as Record<Resource, MarketQuote>;
}
function seasonForDay(day: number): Season { const n = (day - 1) % 120; return n < 30 ? 'Spring' : n < 60 ? 'Summer' : n < 90 ? 'Autumn' : 'Winter'; }
function weatherFor(season: Season, seed: number, day: number): Weather {
  const r = mulberry32(seed + day * 71)();
  if (season === 'Winter') return r < .42 ? 'Snow' : r < .64 ? 'Cloudy' : r < .73 ? 'Fog' : 'Clear';
  if (season === 'Spring') return r < .25 ? 'Rain' : r < .42 ? 'Cloudy' : r < .48 ? 'Fog' : 'Clear';
  if (season === 'Autumn') return r < .2 ? 'Rain' : r < .42 ? 'Cloudy' : r < .5 ? 'Fog' : 'Clear';
  return r < .15 ? 'Storm' : r < .3 ? 'Rain' : r < .5 ? 'Cloudy' : 'Clear';
}
function chooseJobFromSeed(terrain: Terrain[], n: number): WorkingJob {
  const a: WorkingJob[] = ['farmer', 'woodcutter', 'miner', 'quarry', 'miller', 'baker', 'carpenter', 'blacksmith', 'tailor'];
  return a[Math.abs(n + terrain.reduce((s, t) => s + t.length, 0)) % a.length];
}

export function createWorld(seed = 481516): World {
  const rand = mulberry32(seed);
  const terrain = Array.from({ length: 3 }, () => (['fertile', 'forest', 'mountain', 'rocky', 'coastal', 'river'] as Terrain[])[Math.floor(rand() * 6)]);
  const count = 20 + Math.floor(rand() * 11);
  const families: Family[] = [];
  const citizens: Citizen[] = [];
  for (let i = 0; i < Math.ceil(count / 4); i++) families.push({ id: `f${i}`, name: familyNames[i % familyNames.length], homeId: `h${i}`, members: [], wealth: 80 + Math.floor(rand() * 80) });
  for (let i = 0; i < count; i++) {
    const family = families[i % families.length];
    const age = i % 5 === 0 ? 8 + Math.floor(rand() * 8) : 18 + Math.floor(rand() * 42);
    const hash = i * 37 + 11;
    const x = 12 + Math.floor(rand() * 76), y = 12 + Math.floor(rand() * 76);
    const citizen: Citizen = {
      id: `c${i}`, name: names[i % names.length], familyId: family.id, age, hash,
      job: age >= 16 ? chooseJobFromSeed(terrain, i) : 'unemployed',
      hunger: 82 + rand() * 18, rest: 72 + rand() * 28, social: 60 + rand() * 40, clothing: 72 + rand() * 28,
      purpose: 55 + rand() * 45, happiness: 78, wage: 0, wallet: 45 + Math.floor(rand() * 55),
      x, y, destX: x, destY: y, path: [], dwell: 0, wanderIdx: i * 5, errand: false,
      phase: 'wandering', activity: 'idle', facing: 's', moving: false, inside: false,
    };
    citizens.push(citizen);
    family.members.push(citizen.id);
  }
  const buildings: Building[] = [
    { id: 'bank', type: 'Bank', x: 24, y: 24, workers: [], active: true },
    { id: 'market', type: 'Market', x: 29, y: 24, workers: [], active: true },
    { id: 'storage', type: 'Storage', x: 34, y: 24, workers: [], active: true },
    { id: 'tavern', type: 'Tavern', x: 42, y: 43, workers: [], active: true },
    { id: 'farm0', type: 'Farm', x: 38, y: 24, workers: [], active: true },
    { id: 'wood0', type: 'Woodcutter', x: 54, y: 24, workers: [], active: true },
    { id: 'mine0', type: 'Mine', x: 68, y: 30, workers: [], active: true },
    { id: 'quarry0', type: 'Quarry', x: 76, y: 46, workers: [], active: true },
    { id: 'mill0', type: 'Mill', x: 58, y: 55, workers: [], active: true },
    { id: 'bakery0', type: 'Bakery', x: 70, y: 58, workers: [], active: true },
  ];
  families.forEach((f, i) => buildings.push({ id: f.homeId, type: 'House', x: 20 + (i % 4) * 5, y: 34 + Math.floor(i / 4) * 6, workers: [], active: true }));

  const world: World = {
    id: `world-${seed.toString(36)}`, seed, day: 1, hour: 8, terrain, season: 'Spring',
    weather: weatherFor('Spring', seed, 1), weatherSeed: seed, treasury: 3000, population: count,
    families, citizens, buildings,
    resources: { wheat: 60, vegetables: 30, wood: 50, stone: 20, ironOre: 10, wool: 8, flour: 0, bread: 20, furniture: 0, tools: 5, clothing: 10 },
    market: createMarket(),
    lastEvents: ['Your world has emerged.', 'Families are settling into their homes.', 'The market is open and trade has begun.'],
  };
  // Give everyone a real first destination so the world is in motion on frame one.
  for (const c of world.citizens) assignDestination(world, c, phaseFor(c, world.hour));
  return world;
}

function householdTrade(world: World): string[] {
  const events: string[] = [];
  for (const c of world.citizens) {
    if (c.age < 16 || c.hunger > 62 || c.wallet < 1) continue;
    const r = (['bread', 'wheat', 'vegetables'] as Resource[]).find((x) => world.resources[x] >= 1);
    if (!r) continue;
    const price = world.market[r].price;
    if (c.wallet >= price) {
      c.wallet -= price; world.treasury += price; world.resources[r] -= 1;
      c.hunger = Math.min(100, c.hunger + 18);
      events.push(`${c.name} bought ${RESOURCE_LABELS[r].toLowerCase()} at the market.`);
    }
  }
  return events;
}

function marketStep(world: World, hours: number) {
  const events: string[] = [];
  for (const r of Object.keys(marketPrices) as Resource[]) {
    const q = world.market[r], stock = world.resources[r], buffer = marketBuffers[r];
    const scarcity = clamp((buffer - stock) / Math.max(buffer, 1), -1.5, 1.5), old = q.price;
    q.price = clamp(q.price * (1 + scarcity * .025 * hours), .5, 100);
    q.supply = Math.max(0, stock - buffer); q.demand = Math.max(0, buffer - stock); q.volume = 0; q.trend = q.price - old;
    if (stock < buffer * .65) {
      const qty = Math.min(Math.max(1, Math.ceil((buffer - stock) * .05 * hours)), Math.max(0, buffer - stock)), cost = qty * q.price;
      if (qty > 0 && world.treasury >= cost) { world.resources[r] += qty; world.treasury -= cost; q.volume += qty; if (qty >= 2) events.push(`Market bought ${qty} ${RESOURCE_LABELS[r]} for ${cost.toFixed(0)} Gold.`); }
    } else if (stock > buffer * 1.45) {
      const qty = Math.min(Math.max(1, Math.ceil((stock - buffer) * .035 * hours)), stock - buffer);
      if (qty > 0) { const revenue = qty * q.price; world.resources[r] -= qty; world.treasury += revenue; q.volume += qty; if (qty >= 2) events.push(`Market sold ${qty} ${RESOURCE_LABELS[r]} for ${revenue.toFixed(0)} Gold.`); }
    }
  }
  events.push(...householdTrade(world).slice(0, 2));
  if (events.length) world.lastEvents = [...events.slice(0, 4), ...world.lastEvents].slice(0, 10);
}

function terrainMultiplier(world: World, job: WorkingJob) { return world.terrain.reduce((s, t) => s + (terrainBonuses[t][job] || 1), 0) / world.terrain.length; }
function jobScore(world: World, j: WorkingJob) {
  const spec = world.terrain.map((t) => terrainBonuses[t][j] || 1).reduce((a, b) => a + b, 0) / world.terrain.length;
  const demand = j === 'farmer' ? (world.resources.wheat + world.resources.vegetables < 100 ? 2 : 1) : j === 'woodcutter' ? (world.resources.wood < 100 ? 2 : 1) : j === 'miner' ? (world.resources.ironOre < 40 ? 2 : 1) : 1;
  return spec * demand;
}
function chooseJob(world: World): WorkingJob {
  const available = (Object.keys(jobs) as WorkingJob[]).filter((j) => world.buildings.some((b) => b.type === jobs[j].building));
  const a: WorkingJob[] = available.length ? available : ['farmer'];
  return a.map((j) => ({ j, s: jobScore(world, j) })).sort((x, y) => y.s - x.s)[0].j;
}
function produce(world: World, events: string[]) {
  const counts: Partial<Record<Job, number>> = {};
  for (const c of world.citizens) counts[c.job] = (counts[c.job] || 0) + 1;
  for (const [job, count] of Object.entries(counts)) {
    if (!job || job === 'unemployed' || !count) continue;
    const wj = job as WorkingJob, recipe = jobs[wj], workers = Math.min(count, wj === 'miner' ? 3 : 2);
    const seasonal = world.season === 'Winter' && wj === 'farmer' ? .65 : world.season === 'Summer' && wj === 'farmer' ? 1.15 : 1;
    const weather = world.weather === 'Storm' ? .65 : world.weather === 'Rain' && wj === 'farmer' ? 1.08 : world.weather === 'Snow' ? .7 : 1;
    if (recipe.input && !Object.entries(recipe.input).every(([r, n]) => world.resources[r as Resource] >= (n as number) * workers)) continue;
    for (const [r, n] of Object.entries(recipe.input || {})) world.resources[r as Resource] -= (n as number) * workers;
    for (const [r, n] of Object.entries(recipe.output)) world.resources[r as Resource] += (n as number) * workers * terrainMultiplier(world, wj) * seasonal * weather;
  }
  if (counts.farmer) events.push(`${counts.farmer} farmers tended the fields.`);
  if (counts.woodcutter) events.push(`${counts.woodcutter} woodcutters worked the forest.`);
  if (world.weather === 'Storm') events.push('A storm slowed outdoor work today.');
}
function consume(world: World, events: string[]) {
  const need = world.citizens.reduce((s, c) => s + (c.age < 16 ? .5 : .9), 0);
  let remaining = need;
  for (const r of ['bread', 'wheat', 'vegetables'] as Resource[]) { const take = Math.min(world.resources[r], remaining); world.resources[r] -= take; remaining -= take; }
  if (remaining > 0) events.push('Food is running low. Families are searching the market.');
}
function maintenance(type: string) { return ({ Bank: 0, Market: 15, Storage: 3, House: 1, Farm: 3, Woodcutter: 2, Quarry: 4, Mine: 6, Mill: 5, Bakery: 6, Carpenter: 5, Blacksmith: 8, Tailor: 6, Tavern: 7, 'Town Hall': 10 } as Record<string, number>)[type] || 2; }
function daily(world: World) {
  const events: string[] = [];
  let wageCost = 0;
  for (const c of world.citizens) {
    if (c.age < 16) { c.job = 'unemployed'; c.wage = 0; continue; }
    const need = Math.min(c.hunger, c.rest, c.social, c.clothing, c.purpose);
    let jobKey: WorkingJob = c.job === 'unemployed' ? chooseJob(world) : c.job;
    if (need < 35) jobKey = chooseJob(world);
    c.job = jobKey; c.wage = jobs[jobKey].wage; wageCost += c.wage; c.wallet += c.wage;
    c.hunger = Math.max(0, c.hunger - 7); c.rest = Math.max(0, c.rest - 5);
    c.social = Math.max(0, c.social - 2); c.clothing = Math.max(0, c.clothing - 1);
    c.purpose = Math.min(100, c.purpose + .5);
  }
  produce(world, events); consume(world, events);
  world.treasury = Math.max(0, world.treasury - wageCost - world.buildings.filter((b) => b.active).reduce((s, b) => s + maintenance(b.type), 0));
  for (const f of world.families) f.wealth = world.citizens.filter((c) => c.familyId === f.id).reduce((s, c) => s + c.wallet, 0);
  world.lastEvents = [...events, ...world.lastEvents].slice(0, 10);
  world.population = world.citizens.length;
}

export function tick(world: World, hours = 1): World {
  const next = structuredClone(world);
  next.hour += hours;
  moveCitizens(next, hours);
  marketStep(next, hours);
  while (next.hour >= 24) {
    next.hour -= 24; next.day++;
    next.season = seasonForDay(next.day);
    next.weather = weatherFor(next.season, next.weatherSeed, next.day);
    daily(next);
  }
  updateBuildingWorkers(next);
  for (const c of next.citizens) {
    c.rest = Math.max(0, c.rest - hours * (next.weather === 'Storm' ? 2.3 : 2));
    c.social = Math.max(0, c.social - hours * .35);
    c.hunger = Math.max(0, c.hunger - hours * .75);
    if (c.activity === 'eating') c.hunger = Math.min(100, c.hunger + hours * 1.4);
    if (c.activity === 'resting') c.rest = Math.min(100, c.rest + hours * 1.1);
    c.happiness = clamp((c.hunger + c.rest + c.social + c.clothing + c.purpose) / 5, 0, 100);
  }
  return next;
}
