/**
 * The land registry.
 *
 * A plot is a seed. Everything a player sees before they claim one — the
 * terrain, the traits, the size of the settlement that will emerge there — is
 * generated from that seed by the same code that will later run the world, so
 * the preview is the world, not a picture of one.
 */

import { createWorld, type Terrain } from '../simulation';
import { GRID, TILE_H, TILE_W, tileToScreen } from './iso';
import { TILE_COLOR, Tile, generateWorldMap } from './terrain';

export interface Plot {
  id: string;
  seed: number;
  region: string;
  /** Price in $EMERGE. */
  price: number;
  terrain: Terrain[];
  population: number;
  families: number;
  blurb: string;
}

const REGIONS = [
  'Fernrest Vale', 'Alder Hollow', 'Mosswater Bend', 'Thornebrook',
  'Sunmere Shallows', 'Elderford Rise', 'Briar Fen', 'Kestrel Ridge',
];

const TERRAIN_NOTE: Record<Terrain, string> = {
  fertile: 'deep soil that rewards a plough',
  forest: 'old woodland thick enough to lose a road in',
  mountain: 'iron in the bones of the hills',
  rocky: 'good clean building stone at the surface',
  coastal: 'open water and a long horizon',
  river: 'fast water running the length of it',
};

const TERRAIN_PREMIUM: Record<Terrain, number> = {
  fertile: 70, forest: 45, mountain: 80, rocky: 40, coastal: 30, river: 55,
};

function describe(terrain: Terrain[]) {
  const unique = [...new Set(terrain)];
  const notes = unique.map((t) => TERRAIN_NOTE[t]);
  if (notes.length === 1) return `Land with ${notes[0]}.`;
  return `Land with ${notes.slice(0, -1).join(', ')} and ${notes[notes.length - 1]}.`;
}

/** Read a plot's character out of the world its seed would create. */
export function inspectPlot(seed: number, index: number): Plot {
  const world = createWorld(seed);
  const price = 180 + world.terrain.reduce((sum, t) => sum + TERRAIN_PREMIUM[t], 0) + world.population * 4;
  return {
    id: `plot-${seed.toString(36)}`,
    seed,
    region: REGIONS[index % REGIONS.length],
    price: Math.round(price / 10) * 10,
    terrain: world.terrain,
    population: world.population,
    families: world.families.length,
    blurb: describe(world.terrain),
  };
}

/** Seeds on offer. Fixed, so the same plots are for sale for everyone. */
export const PLOT_SEEDS = [481516, 2308, 90210, 71077, 33871, 604800];

export function catalogue(): Plot[] {
  return PLOT_SEEDS.map((seed, i) => inspectPlot(seed, i));
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
 * Saved worlds
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

const STORAGE_KEY = 'emerge.world.v1';

export function loadClaimedWorld(): ClaimedWorld | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClaimedWorld;
    return typeof parsed?.seed === 'number' && typeof parsed?.name === 'string' ? parsed : null;
  } catch {
    // A corrupt or unreadable entry should send the player to the plot view,
    // never crash the app on boot.
    return null;
  }
}

export function saveClaimedWorld(world: ClaimedWorld) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(world));
  } catch {
    // Private browsing and full quotas both land here. The world still plays;
    // it just will not be remembered next visit.
  }
}

export function clearClaimedWorld() {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to do */ }
}
