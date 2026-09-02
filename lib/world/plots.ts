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
}

/**
 * Place names, drawn from the biome rather than from a single list.
 *
 * A shared list assigned by index produced a Red Desert called Briar Fen and a
 * Blackwater Swamp called Kestrel Ridge, which undercuts the whole point of
 * telling plots apart at a glance.
 */
const REGION_NAMES: Record<BiomeKind, string[]> = {
  valley: ['Fernrest Vale', 'Elderford Bend', 'Willowdale', 'Rivermarch'],
  woodland: ['Alder Hollow', 'Cairnwood', 'Thornebrook', 'Deepbough'],
  highland: ['Kestrel Ridge', 'Greyfell', 'Rookspire', 'Stonewatch'],
  wetland: ['Briar Fen', 'Mosswater', 'Reedmere', 'Lowbarrow'],
  steppe: ['Windrow Downs', 'Tallgrass', 'Farholt', 'Openreach'],
  coast: ['Sunmere Shallows', 'Saltmarch', 'Kelphaven', 'Tidewick'],
  desert: ['Emberwaste', 'Duneward', 'Ashenford', 'Sablereach'],
  swamp: ['Blackmire', 'Gloamwater', 'Rootfen', 'Sunkenhollow'],
  grassland: ['Hollowmere', 'Greenhale', 'Meadowlark', 'Broadfield'],
};

/** What each biome is worth, since land that supports more trades is worth more. */
const BIOME_PREMIUM: Record<BiomeKind, number> = {
  valley: 190, highland: 165, woodland: 120, wetland: 110, coast: 130,
  steppe: 95, desert: 85, swamp: 100, grassland: 175,
};

/**
 * Where each plot sits in the region.
 *
 * The first nine are placed by hand so the map reads as a composed piece of
 * country rather than a scatter plot — the desert out west, the fen and the
 * swamp along the southern water, the highland up in the north-east. Anything
 * prospected afterwards is placed on a spiral out from the middle, which keeps
 * new land inside the coast and away from what is already claimed.
 */
const REGION_SITES: [number, number][] = [
  [0.44, 0.46], // valley, the heart of it
  [0.26, 0.30], // woodland
  [0.74, 0.24], // highland
  [0.55, 0.74], // wetland
  [0.70, 0.55], // steppe
  [0.86, 0.66], // coast
  [0.14, 0.60], // desert
  [0.36, 0.80], // swamp
  [0.56, 0.20], // grassland
];

function regionSite(index: number): [number, number] {
  if (index < REGION_SITES.length) return REGION_SITES[index];
  const n = index - REGION_SITES.length;
  const angle = n * 2.399963229728653;
  const radius = 0.16 + Math.sqrt(n + 1) * 0.075;
  return [
    Math.max(0.07, Math.min(0.93, 0.5 + Math.cos(angle) * radius)),
    Math.max(0.1, Math.min(0.9, 0.5 + Math.sin(angle) * radius * 0.8)),
  ];
}

/** Read a plot's character out of the world its seed would create. */
export function inspectPlot(seed: number, index: number): Plot {
  const world = createWorld(seed);
  const profile = biomeFor(seed);
  const trades = [...new Set(world.buildings
    .filter((b) => !['Market', 'Bank', 'Storage', 'Tavern', 'House'].includes(b.type))
    .map((b) => b.type))];
  const price = 180 + BIOME_PREMIUM[profile.kind] + world.population * 4 + trades.length * 12;
  return {
    id: `plot-${seed.toString(36)}`,
    seed,
    region: REGION_NAMES[profile.kind][index % REGION_NAMES[profile.kind].length],
    price: Math.round(price / 10) * 10,
    biome: profile.kind,
    biomeLabel: profile.label,
    population: world.population,
    families: world.families.length,
    blurb: profile.blurb,
    trades,
    mapX: regionSite(index)[0],
    mapY: regionSite(index)[1],
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
  return PLOT_SEEDS.map((seed, i) => inspectPlot(seed, i));
}

/**
 * Prospect a brand-new plot. The seed comes from the moment it was found, so no
 * two prospected plots are the same piece of land.
 */
export function prospectPlot(index: number): Plot {
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 8;
  return inspectPlot(seed, index);
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
export function drawRegionMap(canvas: HTMLCanvasElement, plots: Plot[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !plots.length) return;

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
      // A landmass: an ellipse softened by noise, so the coast is ragged.
      const nx = (x / W - 0.5) * 2, ny = (y / H - 0.5) * 2;
      const radial = 1 - Math.hypot(nx * 1.02, ny * 1.16);
      const n = fbm(REGION_SEED, x * 0.026, y * 0.026, 4);
      const land = radial + (n - 0.5) * 0.78;

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
        const [baseHex, liftHex] = BIOME_MAP_COLOR[sites[nearest][2]];
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
export interface PlayerRecord {
  ledger: VaultLedger;
  /** Seeds of plots this player prospected into existence. */
  prospected: number[];
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
    prospected: Array.isArray(parsed?.prospected) ? parsed!.prospected!.filter((n) => Number.isFinite(n)) : [],
    listings: Array.isArray(parsed?.listings) ? parsed!.listings! : [],
  };
}

export const savePlayer = (record: PlayerRecord) => writeJson(PLAYER_KEY, record);

/** Everything currently for sale: the fixed catalogue plus anything prospected. */
export function marketPlots(record: PlayerRecord): Plot[] {
  const base = catalogue();
  const found = record.prospected.map((seed, i) => inspectPlot(seed, base.length + i));
  return [...base, ...found];
}
