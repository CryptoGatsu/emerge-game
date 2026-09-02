/**
 * The land registry.
 *
 * A plot is a seed. Everything a player sees before they claim one — the
 * terrain, the traits, the size of the settlement that will emerge there — is
 * generated from that seed by the same code that will later run the world, so
 * the preview is the world, not a picture of one.
 */

import { createWorld } from '../simulation';
import { biomeFor, type BiomeKind } from './biomes';
import { normaliseLedger, type VaultLedger } from '../chain/vault';
import { GRID, TILE_H, TILE_W, tileToScreen } from './iso';
import { fbm } from './relief';
import { TILE_COLOR, Tile, generateWorldMap } from './terrain';

export interface Plot {
  id: string;
  seed: number;
  region: string;
  /** Price in $EMERGE. */
  price: number;
  biome: BiomeKind;
  biomeLabel: string;
  population: number;
  families: number;
  blurb: string;
  /** Trades the land supports, which is the real reason to prefer one plot. */
  trades: string[];
  /** Where this plot sits on the region map, normalised to 0-1. */
  mapX: number;
  mapY: number;
  /** Which island of the chain it belongs to. */
  island: string;
  /** Which chart that island is on, and which of its slots this plot holds. */
  chart: number;
  slot: number;
}

/**
 * Place names, drawn from the biome rather than from a single list.
 *
 * A shared list assigned by index produced a Red Desert called Briar Fen and a
 * Blackwater Swamp called Kestrel Ridge, which undercuts the whole point of
 * telling plots apart at a glance.
 */
const REGION_NAMES: Record<BiomeKind, string[]> = {
  valley: ['Fernrest Vale', 'Elderford Bend', 'Willowdale', 'Rivermarch', 'Havenford', 'Wyndmere'],
  woodland: ['Alder Hollow', 'Cairnwood', 'Thornebrook', 'Deepbough', 'Elmshade', 'Briarwood'],
  highland: ['Kestrel Ridge', 'Greyfell', 'Rookspire', 'Stonewatch', 'Cragmoor', 'Ironscar'],
  wetland: ['Briar Fen', 'Mosswater', 'Reedmere', 'Lowbarrow', 'Willowfen', 'Marshlight'],
  steppe: ['Windrow Downs', 'Tallgrass', 'Farholt', 'Openreach', 'Longsight', 'Dryhearth'],
  coast: ['Sunmere Shallows', 'Saltmarch', 'Kelphaven', 'Tidewick', 'Spraycliff', 'Bayreach'],
  desert: ['Emberwaste', 'Duneward', 'Ashenford', 'Sablereach', 'Sunscorch', 'Dryreach'],
  swamp: ['Blackmire', 'Gloamwater', 'Rootfen', 'Sunkenhollow', 'Fenlight', 'Stillwater'],
  grassland: ['Hollowmere', 'Greenhale', 'Meadowlark', 'Broadfield', 'Larkmoor', 'Summerlea'],
};

/**
 * $EMERGE per point of a plot's raw score.
 *
 * A plot lands between about three hundred and four hundred thousand $EMERGE,
 * against a starting allocation of two million and a survey fee of a hundred
 * and twenty thousand — so the allocation is five or six plots, and a plot is
 * roughly a fortnight of running a world well.
 */
const PRICE_SCALE = 800;

/** What each biome is worth, since land that supports more trades is worth more. */
const BIOME_PREMIUM: Record<BiomeKind, number> = {
  valley: 190, highland: 165, woodland: 120, wetland: 110, coast: 130,
  steppe: 95, desert: 85, swamp: 100, grassland: 175,
};

/**
 * The archipelago.
 *
 * Every plot used to sit on one landmass, and with twenty-five of them claimed
 * the map was a wall of overlapping labels with no sense of place left in it.
 * Now the region is a chain of islands, and even the nine plots the land office
 * opens with are spread across it.
 *
 * The capacities are small on purpose. A marker carries a name, so it is about
 * a sixth of the map wide; nine of them will not fit inside one island however
 * they are arranged, and crowding them produced exactly the wall of labels this
 * was meant to fix. Fewer per island, more islands.
 */
export interface Island {
  name: string;
  /** Centre and radii on the map, normalised to 0-1. */
  x: number;
  y: number;
  rx: number;
  ry: number;
  /** How many plots this island has room for. */
  capacity: number;
  /** Noise offset, so no two islands share a coastline. */
  shape: number;
}

/**
 * The chain, laid out with real water between the islands.
 *
 * The gaps are wider than they look they need to be. Each coastline is an
 * ellipse pushed about a third of its radius by noise, so two islands whose
 * ellipses merely fail to touch will still grow into one another and land as a
 * single blob with three names printed on it.
 */
/**
 * The home chart, hand-placed so no two coastlines merge.
 *
 * Every other chart is this geometry mirrored and thinned, which is deliberate:
 * the gaps here were tuned by eye against the noise that roughens each coast,
 * and a freshly generated set of ellipses reliably produced two islands grown
 * into one blob with three names printed across it. Mirroring cannot introduce
 * an overlap that is not already here.
 */
const HOME_CHART: Island[] = [
  // Capacity is set by how much coast there actually is. A skerry a twentieth
  // of the map wide was carrying three settlements, whose markers landed within
  // thirty pixels of each other with a name on each — the crowding the player
  // saw. One island, one town, unless there is room for more.
  { name: 'Fernrest', x: 0.24, y: 0.43, rx: 0.20, ry: 0.31, capacity: 4, shape: 0 },
  { name: 'Kestrel Reach', x: 0.70, y: 0.20, rx: 0.16, ry: 0.16, capacity: 3, shape: 311 },
  { name: 'Saltmarch', x: 0.68, y: 0.76, rx: 0.16, ry: 0.17, capacity: 3, shape: 907 },
  { name: 'Ashen Skerry', x: 0.90, y: 0.47, rx: 0.05, ry: 0.10, capacity: 1, shape: 2203 },
  { name: 'Tidewick', x: 0.46, y: 0.86, rx: 0.09, ry: 0.08, capacity: 2, shape: 3391 },
  { name: 'Windrow Holm', x: 0.16, y: 0.90, rx: 0.10, ry: 0.07, capacity: 2, shape: 1451 },
  { name: 'Gale Rock', x: 0.47, y: 0.10, rx: 0.07, ry: 0.07, capacity: 1, shape: 4177 },
  { name: 'Farholt', x: 0.90, y: 0.87, rx: 0.06, ry: 0.09, capacity: 1, shape: 5051 },
];

/**
 * Names for the islands of charts past the first: eight per chart, in blocks,
 * so no name appears on two charts. Sharing a pool with a stride shorter than a
 * chart's island count put Grey Mull and Sable Isle on both Chart 2 and Chart
 * 3, which makes two different places look like the same one.
 */
const ISLAND_NAMES = [
  'Corrach', 'Brindle Holm', 'Stormward', 'Hallow Skerry', 'Lambert Rock', 'Netherhaigh',
  'Cold Sound', 'Marrowbank',
  'Quillhaven', 'Torrin', 'Grey Mull', 'Sable Isle', 'Wrackreach', 'Ossory',
  'Thrushmere', 'Barrenhead',
  'Fallowsound', 'Lorn', 'Kittiwake', 'Sunder Rock', 'Halloway', 'Verne',
  'Cape Alder', 'Drumcarrow',
  'Ferrishaw', 'Coldbarrow', 'Rimewatch', 'Anvil Rock', 'Mewstone', 'Salter Holm',
  'Larkspit', 'Undermere',
  'Hollowsound', 'Craigmar', 'Petrel Isle', 'Bleak Ness', 'Fastnet', 'Longhaven',
  'Turnstone', 'Cairnmuir',
];

/** The first chart, kept as a name because the land office opens on it. */
export const HOME_CHART_INDEX = 0;

/**
 * How many charts a player can sail between.
 *
 * Not unlimited, because "somewhere else to look" stops meaning anything when
 * there is always somewhere else: with enough charts the land office becomes a
 * slot machine rather than a map. Six is enough that running one dry is a
 * decision about where to go next.
 */
export const CHART_COUNT = 6;

/** A chart's name, as the land office prints it. */
export function chartName(chart: number) {
  return chart === HOME_CHART_INDEX ? 'The Home Chart' : `Chart ${chart + 1}`;
}

/**
 * The islands of one chart.
 *
 * Mirrored from the home chart along one or both axes and thinned to between
 * five and eight islands, with fresh names and fresh coastline noise, so no two
 * charts read as the same water.
 */
export function islandsFor(chart: number): Island[] {
  if (chart === HOME_CHART_INDEX) return HOME_CHART;
  const flipX = (chart & 1) === 1;
  const flipY = (chart & 2) === 2;
  const keep = 8 - (chart % 3);
  return HOME_CHART.slice(0, keep).map((island, i) => ({
    ...island,
    name: ISLAND_NAMES[((chart - 1) * 8 + i) % ISLAND_NAMES.length],
    x: flipX ? 1 - island.x : island.x,
    y: flipY ? 1 - island.y : island.y,
    shape: island.shape + chart * 613 + 97,
  }));
}

/** How many plots a chart has room for in total. */
export function chartCapacity(chart: number) {
  return islandsFor(chart).reduce((sum, island) => sum + island.capacity, 0);
}

/**
 * Which island a slot on a chart belongs to, and its place on it.
 *
 * A slot past the chart's capacity has no island: the caller is expected to
 * have refused the prospecting rather than crowding another marker onto the
 * last skerry, which is what the eight islands of the home chart were doing
 * with fifty-six plots on them.
 */
export function islandOf(slot: number, chart = HOME_CHART_INDEX): { island: Island; slot: number } | null {
  let remaining = slot;
  for (const island of islandsFor(chart)) {
    if (remaining < island.capacity) return { island, slot: remaining };
    remaining -= island.capacity;
  }
  return null;
}

/**
 * Where a plot sits on its island: a golden-angle spiral out from the middle,
 * which spreads any number of them without two ever landing on top of each
 * other, and keeps them inside the coast.
 */
function regionSite(slot: number, chart: number): [number, number] {
  const spot = islandOf(slot, chart);
  if (!spot) return [0.5, 0.5];
  const { island } = spot;
  if (spot.slot === 0) return [island.x, island.y];
  const angle = spot.slot * 2.399963229728653;
  // Out to most of the island's radius, not a third of it: the markers carry
  // labels a hundred and forty pixels wide, and a tighter spiral piles four of
  // them on top of each other in the middle of the map.
  const spread = 0.42 + Math.sqrt(spot.slot / Math.max(1, island.capacity)) * 0.55;
  return [
    Math.max(0.03, Math.min(0.97, island.x + Math.cos(angle) * island.rx * spread)),
    Math.max(0.05, Math.min(0.95, island.y + Math.sin(angle) * island.ry * spread)),
  ];
}

/** Read a plot's character out of the world its seed would create. */
export function inspectPlot(seed: number, slot: number, chart = HOME_CHART_INDEX): Plot {
  const world = createWorld(seed);
  const profile = biomeFor(seed);
  const trades = [...new Set(world.buildings
    .filter((b) => !['Market', 'Bank', 'Storage', 'Tavern', 'House'].includes(b.type))
    .map((b) => b.type))];
  // Priced on the same scale as everything else the token buys. It used to
  // come out at four or five hundred $EMERGE — less than a hundredth of what
  // surveying a new plot costs — which made claiming land the cheapest thing
  // in the game by three orders of magnitude.
  const price = (180 + BIOME_PREMIUM[profile.kind] + world.population * 4 + trades.length * 12) * PRICE_SCALE;
  return {
    id: `plot-${seed.toString(36)}`,
    seed,
    // Named from the seed rather than from its place in the list, so a plot
    // keeps its name wherever it ends up and two plots of the same biome only
    // collide by chance rather than every sixth time.
    region: REGION_NAMES[profile.kind][Math.abs(seed) % REGION_NAMES[profile.kind].length],
    price: Math.round(price / 5_000) * 5_000,
    biome: profile.kind,
    biomeLabel: profile.label,
    population: world.population,
    families: world.families.length,
    blurb: profile.blurb,
    trades,
    mapX: regionSite(slot, chart)[0],
    mapY: regionSite(slot, chart)[1],
    island: islandOf(slot, chart)?.island.name ?? 'Open water',
    chart,
    slot,
  };
}

/**
 * Seeds on offer. Fixed, so the same land is for sale for everyone, and chosen
 * so that the nine of them are one of each biome — a shop that happened to show
 * three woodlands would hide the fact that plots differ in kind at all. The
 * order matches `REGION_SITES`, which is what puts each biome where it belongs
 * on the map.
 */
export const PLOT_SEEDS = [1050, 1120, 1000, 1020, 1220, 1060, 1030, 1080, 1040];

export function catalogue(): Plot[] {
  return PLOT_SEEDS.map((seed, i) => inspectPlot(seed, i, HOME_CHART_INDEX));
}

/**
 * Prospect a brand-new plot on a chart, in the first slot that chart has free.
 *
 * Returns null when the chart is full, which is the whole point: land is
 * finite, and the answer to a full chart is to sail to another one rather than
 * to stack another marker on the same skerry.
 */
export function prospectPlot(chart: number, takenSlots: number[]): Plot | null {
  const capacity = chartCapacity(chart);
  const used = new Set(takenSlots);
  let slot = -1;
  for (let i = 0; i < capacity; i++) {
    if (!used.has(i)) { slot = i; break; }
  }
  if (slot < 0) return null;
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 8;
  return inspectPlot(seed, slot, chart);
}

/**
 * Paint a plot's terrain onto a canvas.
 *
 * Runs the real map generator with props switched off, which is fast enough to
 * preview a page of plots and guarantees the ground you buy is the ground you
 * get.
 */
export function drawPlotPreview(canvas: HTMLCanvasElement, seed: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const world = createWorld(seed);
  const map = generateWorldMap(world, { props: false });

  // `tileToScreen` returns screen pixels, so the fit is against the projected
  // size of the whole field, not against the tile count.
  const sceneW = GRID * TILE_W;
  const sceneH = GRID * TILE_H;
  const scale = Math.min(canvas.width / sceneW, canvas.height / sceneH);
  const originX = canvas.width / 2;
  const originY = (canvas.height - sceneH * scale) / 2;
  const w = TILE_W * scale;
  const h = TILE_H * scale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  for (let ty = 0; ty < map.grid; ty++) {
    for (let tx = 0; tx < map.grid; tx++) {
      const i = ty * map.grid + tx;
      ctx.fillStyle = TILE_COLOR[map.tiles[i] as Tile];
      const p = tileToScreen(tx, ty, map.steps[i] * 0.4);
      // Tiles are drawn as overlapping blocks rather than diamonds: at this size
      // a diamond is three pixels across and the seams would show as a grid.
      ctx.fillRect(originX + p.x * scale - w / 2, originY + p.y * scale, w + 1, h + 1);
    }
  }

  // Where the settlement will stand.
  ctx.fillStyle = '#f0d79a';
  for (const b of world.buildings) {
    const p = tileToScreen((b.x / 100) * GRID, (b.y / 100) * GRID);
    ctx.fillRect(originX + p.x * scale - 1, originY + p.y * scale - 1, 2.5, 2.5);
  }
}

/* ------------------------------------------------------------------ *
 * The region map
 * ------------------------------------------------------------------ */

/** How each biome reads from altitude: a land tone and a highlight. */
const BIOME_MAP_COLOR: Record<BiomeKind, [string, string]> = {
  valley: ['#4c8a3d', '#6cae51'],
  woodland: ['#2f5b28', '#3f7a33'],
  highland: ['#7b7a6a', '#9b9a88'],
  wetland: ['#4e7a55', '#69976d'],
  steppe: ['#93a558', '#b3c072'],
  coast: ['#5c9070', '#7bb08c'],
  desert: ['#c9a463', '#e2c084'],
  swamp: ['#3f5a42', '#527055'],
  grassland: ['#5aa049', '#79c162'],
};

const SEA = '#16303f';
const SEA_DEEP = '#0f2430';
const SHORE = '#2b5a6b';

/**
 * The whole region, painted as one landmass with every plot's territory in its
 * own colour.
 *
 * Drawn at a deliberately low internal resolution and blown up without
 * smoothing: a map of a pixel-art world should look drawn rather than
 * photographed, and it makes the whole thing cheap enough to repaint whenever
 * the plots change.
 */
export function drawRegionMap(canvas: HTMLCanvasElement, plots: Plot[], chart = HOME_CHART_INDEX) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const islands = islandsFor(chart);

  const W = 300, H = 190;
  const buffer = ctx.createImageData(W, H);
  const data = buffer.data;
  const REGION_SEED = 7710;

  // Territories are nearest-site, so a plot owns the ground around it and the
  // borders fall where two claims meet.
  const sites = plots.map((p) => [p.mapX * W, p.mapY * H, p.biome] as [number, number, BiomeKind]);

  const hex = (c: string): [number, number, number] =>
    [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const sea = hex(SEA), seaDeep = hex(SEA_DEEP), shore = hex(SHORE);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // The chain: each island is an ellipse softened by its own noise, and the
      // map takes whichever is nearest to being land at this point.
      let land = -1;
      for (const island of islands) {
        const nx = (x / W - island.x) / island.rx;
        const ny = (y / H - island.y) / island.ry;
        const radial = 1 - Math.hypot(nx, ny);
        const n = fbm(REGION_SEED + island.shape, x * 0.03, y * 0.03, 4);
        land = Math.max(land, radial + (n - 0.5) * 0.5);
      }

      let nearest = 0, best = Infinity, second = Infinity;
      for (let i = 0; i < sites.length; i++) {
        const d = (sites[i][0] - x) ** 2 + (sites[i][1] - y) ** 2;
        if (d < best) { second = best; best = d; nearest = i; }
        else if (d < second) second = d;
      }

      let r: number, g: number, b: number;
      if (land < 0) {
        // Two sea tones so the water has depth rather than being a flat field.
        const deep = land < -0.22;
        [r, g, b] = deep ? seaDeep : sea;
        const ripple = fbm(REGION_SEED + 400, x * 0.09, y * 0.09, 2);
        r += (ripple - 0.5) * 10; g += (ripple - 0.5) * 12; b += (ripple - 0.5) * 14;
      } else if (land < 0.045) {
        [r, g, b] = shore;
      } else {
        // An unsurveyed chart has no plots on it and therefore no territories.
        // The land is still drawn — that is what makes it somewhere to go —
        // just in the plain green of ground nobody has walked yet.
        const [baseHex, liftHex] = sites.length
          ? BIOME_MAP_COLOR[sites[nearest][2]]
          : (['#3f6b39', '#4d7d43'] as [string, string]);
        const lift = fbm(REGION_SEED + 900, x * 0.05, y * 0.05, 3);
        const base = hex(lift > 0.54 ? liftHex : baseHex);
        [r, g, b] = base;
        // Shade toward the coast so the land has a little relief in it.
        const k = Math.min(1, land * 2.6);
        r *= 0.72 + k * 0.3; g *= 0.72 + k * 0.3; b *= 0.72 + k * 0.3;
        // A pale seam where two territories meet, so borders are legible.
        const edge = Math.sqrt(second) - Math.sqrt(best);
        if (edge < 1.6) { r = r * 0.55 + 120; g = g * 0.55 + 120; b = b * 0.55 + 96; }
      }

      const i = (y * W + x) * 4;
      data[i] = Math.max(0, Math.min(255, r));
      data[i + 1] = Math.max(0, Math.min(255, g));
      data[i + 2] = Math.max(0, Math.min(255, b));
      data[i + 3] = 255;
    }
  }

  // Blit through an offscreen canvas: putImageData ignores transforms, so it
  // cannot be scaled directly.
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  off.getContext('2d')?.putImageData(buffer, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

/* ------------------------------------------------------------------ *
 * What the player owns, locally
 * ------------------------------------------------------------------ */

export interface ClaimedWorld {
  seed: number;
  name: string;
  region: string;
  price: number;
  claimedAt: number;
  /** Wallet the plot was claimed from, when one was connected. */
  owner: string | null;
  /** Transaction hash, once claims actually settle on chain. */
  txHash: string | null;
}

export interface Listing { seed: number; region: string; price: number; listedAt: number }

/**
 * The player's record, kept separately from whichever world they are in.
 *
 * The $EMERGE balance belongs to the player, not the plot: leaving a world to
 * look at the land office must not take their tokens with it.
 */
/**
 * A plot the player found by surveying, and where on the chain it landed.
 *
 * It used to be a bare seed, with the plot's place derived from its position in
 * the list. That put every plot past the chain's capacity onto the last skerry
 * — fifty-six markers over eight islands, most of them stacked — and it meant
 * a plot could move if the list ahead of it ever changed.
 */
export interface FoundPlot {
  seed: number;
  chart: number;
  slot: number;
}

export interface PlayerRecord {
  ledger: VaultLedger;
  /** Plots this player prospected into existence. */
  prospected: FoundPlot[];
  /**
   * Plots this player owns.
   *
   * Leaving a world used to delete the claim outright, so walking back to the
   * land office meant paying for the same land again. A claim is a purchase; it
   * survives leaving, and a player can hold several and move between them.
   */
  claims: ClaimedWorld[];
  /** Plots they have put up for resale. */
  listings: Listing[];
}

const WORLD_KEY = 'emerge.world.v1';
const PLAYER_KEY = 'emerge.player.v1';

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // A corrupt entry should send the player to the land office, never crash
    // the app on boot.
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing and full quotas both land here. Play continues; it just
    // will not be remembered next visit.
  }
}

export function loadClaimedWorld(): ClaimedWorld | null {
  const parsed = readJson<ClaimedWorld & { ledger?: unknown }>(WORLD_KEY);
  if (!parsed || typeof parsed.seed !== 'number' || typeof parsed.name !== 'string') return null;
  return parsed;
}

export const saveClaimedWorld = (world: ClaimedWorld) => writeJson(WORLD_KEY, world);

export function clearClaimedWorld() {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(WORLD_KEY); } catch { /* nothing to do */ }
}

export function loadPlayer(): PlayerRecord {
  const parsed = readJson<Partial<PlayerRecord>>(PLAYER_KEY);
  return {
    ledger: normaliseLedger(parsed?.ledger),
    prospected: readProspected(parsed?.prospected),
    claims: readClaims(parsed?.claims),
    listings: Array.isArray(parsed?.listings) ? parsed!.listings! : [],
  };
}

function readClaims(raw: unknown): ClaimedWorld[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is ClaimedWorld =>
    !!c && typeof c === 'object'
    && Number.isFinite((c as ClaimedWorld).seed)
    && typeof (c as ClaimedWorld).name === 'string');
}

/** Record a claim, or update the one already held on that seed. */
export function withClaim(record: PlayerRecord, claim: ClaimedWorld): PlayerRecord {
  const rest = record.claims.filter((c) => c.seed !== claim.seed);
  return { ...record, claims: [...rest, claim] };
}

/** Give a plot up: it leaves the player's holdings and can be claimed again. */
export function withoutClaim(record: PlayerRecord, seed: number): PlayerRecord {
  return {
    ...record,
    claims: record.claims.filter((c) => c.seed !== seed),
    listings: record.listings.filter((l) => l.seed !== seed),
  };
}

/** The claim this player holds on a plot, if any. */
export function claimOf(record: PlayerRecord, seed: number): ClaimedWorld | null {
  return record.claims.find((c) => c.seed === seed) ?? null;
}

export const savePlayer = (record: PlayerRecord) => writeJson(PLAYER_KEY, record);

/**
 * Read back a player's found plots, including from a save written before they
 * carried a chart and a slot. An old bare-seed list is laid onto the home chart
 * after the nine it opens with, and anything past that chart's capacity is
 * dropped rather than stacked — those markers were unreadable anyway.
 */
function readProspected(raw: unknown): FoundPlot[] {
  if (!Array.isArray(raw)) return [];
  const capacity = chartCapacity(HOME_CHART_INDEX);
  const out: FoundPlot[] = [];
  for (const entry of raw) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      const slot = PLOT_SEEDS.length + out.length;
      if (slot >= capacity) continue;
      out.push({ seed: entry, chart: HOME_CHART_INDEX, slot });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const e = entry as Partial<FoundPlot>;
      if (Number.isFinite(e.seed) && Number.isFinite(e.chart) && Number.isFinite(e.slot)) {
        out.push({ seed: e.seed!, chart: e.chart!, slot: e.slot! });
      }
    }
  }
  return out;
}

/** Which slots on a chart are already spoken for. */
export function usedSlots(record: PlayerRecord, chart: number): number[] {
  const taken = record.prospected.filter((p) => p.chart === chart).map((p) => p.slot);
  return chart === HOME_CHART_INDEX ? [...PLOT_SEEDS.map((_, i) => i), ...taken] : taken;
}

/**
 * Everything for sale on one chart: the fixed catalogue, plus anything found
 * there, with repeated place names resolved.
 *
 * A plot's name comes from its seed and its biome, out of a list of six per
 * biome, so a chart with sixteen plots on it reliably has two Rookspires and
 * two Bayreaches — and a map with the same name printed twice on it is a map
 * you cannot navigate by. Later arrivals step along their biome's list to the
 * first name nobody on this chart is using, and fall back to a numbered name
 * only if the whole list is taken.
 */
export function marketPlots(record: PlayerRecord, chart = HOME_CHART_INDEX): Plot[] {
  const base = chart === HOME_CHART_INDEX ? catalogue() : [];
  const found = record.prospected
    .filter((p) => p.chart === chart)
    .map((p) => inspectPlot(p.seed, p.slot, p.chart));
  const all = [...base, ...found];

  const used = new Set<string>();
  for (const plot of all) {
    if (!used.has(plot.region)) { used.add(plot.region); continue; }
    const names = REGION_NAMES[plot.biome];
    const start = names.indexOf(plot.region);
    let renamed = '';
    for (let i = 1; i <= names.length; i++) {
      const candidate = names[(start + i) % names.length];
      if (!used.has(candidate)) { renamed = candidate; break; }
    }
    if (!renamed) {
      let n = 2;
      while (used.has(`${plot.region} ${n}`)) n++;
      renamed = `${plot.region} ${n}`;
    }
    plot.region = renamed;
    used.add(renamed);
  }
  return all;
}

/** How much room is left on a chart. */
export function chartRoom(record: PlayerRecord, chart: number) {
  const capacity = chartCapacity(chart);
  const used = usedSlots(record, chart).length;
  return { capacity, used, free: Math.max(0, capacity - used) };
}
