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
}

const REGIONS = [
  'Fernrest Vale', 'Alder Hollow', 'Mosswater Bend', 'Thornebrook',
  'Sunmere Shallows', 'Elderford Rise', 'Briar Fen', 'Kestrel Ridge',
  'Hollowmere', 'Ashenford', 'Windrow Downs', 'Greyfell', 'Saltmarch',
  'Rookspire', 'Cairnwood', 'Lowbarrow',
];

/** What each biome is worth, since land that supports more trades is worth more. */
const BIOME_PREMIUM: Record<BiomeKind, number> = {
  valley: 190, highland: 165, woodland: 120, wetland: 110, coast: 130, steppe: 95,
};

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
    region: REGIONS[index % REGIONS.length],
    price: Math.round(price / 10) * 10,
    biome: profile.kind,
    biomeLabel: profile.label,
    population: world.population,
    families: world.families.length,
    blurb: profile.blurb,
    trades,
  };
}

/**
 * Seeds on offer. Fixed, so the same land is for sale for everyone, and chosen
 * to cover every biome — a shop that happened to show three woodlands would
 * hide the fact that plots differ in kind at all.
 */
export const PLOT_SEEDS = [1490, 1910, 1070, 1210, 1420, 1000];

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
