/**
 * World map generation.
 *
 * Turns a world seed and the simulation's road graph and building list into a
 * dense, natural-looking landscape: a river with a waterfall off the north-east
 * plateau, a pond in the south, ploughed fields by the farm, curved stone paths
 * that follow the road graph rather than drawing it, and thousands of scattered
 * trees, rocks, flowers and settlement clutter.
 *
 * Everything here is deterministic from the seed, so the same world always
 * regenerates identically.
 */

import { ROAD_EDGES, ROAD_NODES, type Building, type World } from '../simulation';
import { GRID, worldToTile } from './iso';
import { PONDS, WATER_ROUTES, biomeProfile, type BiomeProfile } from './biomes';

export enum Tile {
  Grass, Flowers, Meadow, Forest, Soil, Tilled, CropWheat, CropVeg,
  Path, Plaza, Rock, Sand, Water, WaterShore,
}

/** Art key prefix and variant count for each tile kind. */
export const TILE_ART: Record<Tile, { key: string; variants: number }> = {
  [Tile.Grass]: { key: 'tile.grass', variants: 4 },
  [Tile.Flowers]: { key: 'tile.flowers', variants: 2 },
  [Tile.Meadow]: { key: 'tile.meadow', variants: 2 },
  [Tile.Forest]: { key: 'tile.forest', variants: 2 },
  [Tile.Soil]: { key: 'tile.soil', variants: 1 },
  [Tile.Tilled]: { key: 'tile.tilled', variants: 2 },
  [Tile.CropWheat]: { key: 'tile.crop.wheat', variants: 0 },
  [Tile.CropVeg]: { key: 'tile.crop.veg', variants: 0 },
  [Tile.Path]: { key: 'tile.path', variants: 3 },
  [Tile.Plaza]: { key: 'tile.plaza', variants: 2 },
  [Tile.Rock]: { key: 'tile.rock', variants: 2 },
  [Tile.Sand]: { key: 'tile.sand', variants: 1 },
  [Tile.Water]: { key: 'tile.water', variants: 4 },
  [Tile.WaterShore]: { key: 'tile.watershore', variants: 4 },
};

/** Flat colour per terrain kind, for minimaps and plot previews. */
export const TILE_COLOR: Record<Tile, string> = {
  [Tile.Grass]: '#4c8a3d',
  [Tile.Flowers]: '#5f9d4a',
  [Tile.Meadow]: '#6cae51',
  [Tile.Forest]: '#2c4f27',
  [Tile.Soil]: '#5d452c',
  [Tile.Tilled]: '#6a4e30',
  [Tile.CropWheat]: '#b79c47',
  [Tile.CropVeg]: '#4e8c3a',
  [Tile.Path]: '#a89468',
  [Tile.Plaza]: '#9d9682',
  [Tile.Rock]: '#767466',
  [Tile.Sand]: '#c2ab72',
  [Tile.Water]: '#26688a',
  [Tile.WaterShore]: '#3a90ab',
};

export interface PropInstance {
  /** World units, so props sort against citizens using the same depth rule. */
  wx: number;
  wy: number;
  name: string;
  /** Wind response: 0 for rock and timber, 1 for canopy. */
  sway: number;
  /** Only lit props (lanterns, campfires) light up after dark. */
  glow?: boolean;
  flip?: boolean;
  /** Per-instance size, so a wood is not a field of identical trees. */
  scale?: number;
}

export interface WorldMap {
  grid: number;
  tiles: Uint8Array;
  variants: Uint8Array;
  /** Quantised elevation step used to draw tiles. */
  steps: Uint8Array;
  /** Continuous elevation used to place entities, so walking up a slope is smooth. */
  field: Float32Array;
  /** Tiles that need a cliff face drawn beneath them. */
  cliffs: Uint8Array;
  /** 0-1 shading weight per tile, varying over tens of tiles rather than one. */
  tone: Float32Array;
  waterfalls: { tx: number; ty: number }[];
  props: PropInstance[];
  /** Continuous height in elevation steps at a world position. */
  heightAt(wx: number, wy: number): number;
  tileAt(wx: number, wy: number): Tile;
}

/* ------------------------------------------------------------------ *
 * Noise
 * ------------------------------------------------------------------ */

function hash2(seed: number, x: number, y: number) {
  let h = seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function valueNoise(seed: number, x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(seed, xi, yi), b = hash2(seed, xi + 1, yi);
  const c = hash2(seed, xi, yi + 1), d = hash2(seed, xi + 1, yi + 1);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(seed: number, x: number, y: number, octaves = 4) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(seed + i * 977, x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ *
 * Water and elevation
 * ------------------------------------------------------------------ */

/**
 * Water for a biome.
 *
 * Routes come from the biome table and are chosen in isometric screen space:
 * a channel laid along a world axis projects to the straight edge of a diamond
 * and reads as a moat rather than a river.
 */
function waterFor(profile: BiomeProfile) {
  const pond = PONDS[profile.water];
  return {
    routes: WATER_ROUTES[profile.water],
    pond: { x: pond.x, y: pond.y, r: pond.r * profile.pondScale },
  };
}

/** Where the north road crosses the water, a bridge is drawn instead of a ford. */
const BRIDGE = { x: 46, y: 16 };

function riverWidth(seed: number, t: number, scale: number) {
  return (2.5 + valueNoise(seed + 313, t * 2.4, 0) * 1.7) * scale;
}

interface Polyline { pts: [number, number][]; widths: number[] }

function buildRiver(seed: number, profile: BiomeProfile): Polyline {
  const pts: [number, number][] = [];
  const widths: number[] = [];
  for (const route of waterFor(profile).routes) {
    for (let i = 0; i < route.length - 1; i++) {
      const [ax, ay] = route[i];
      const [bx, by] = route[i + 1];
      const steps = 14;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        // Meander perpendicular to the run so the bank is never a straight edge.
        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const wobble = (valueNoise(seed + 71, (i + t) * 1.7, 0) - 0.5) * 3.2;
        pts.push([ax + dx * t + nx * wobble, ay + dy * t + ny * wobble]);
        widths.push(riverWidth(seed, i + t, profile.waterScale));
      }
    }
  }
  return { pts, widths };
}

/** Elevation field: a raised shelf in the north-east that the mine road climbs. */
function heightField(seed: number, wx: number, wy: number, plateau: number) {
  if (plateau <= 0) return 0;
  const ridge = ((wx - 70) * 0.06 + (34 - wy) * 0.045) * plateau;
  const noise = (fbm(seed + 4001, wx * 0.05, wy * 0.05, 3) - 0.5) * 0.7;
  return Math.max(0, Math.min(1, ridge + noise));
}

/* ------------------------------------------------------------------ *
 * Roads
 * ------------------------------------------------------------------ */

/**
 * Sample the road graph into gently curved polylines. The simulation routes
 * along straight edges; drawing them with a deterministic meander is what makes
 * the result read as worn stone paths instead of a graph.
 */
function buildRoads(seed: number): Polyline {
  const pts: [number, number][] = [];
  const widths: number[] = [];
  const seen = new Set<string>();
  ROAD_EDGES.forEach((neighbours, a) => neighbours.forEach((b) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    const [ax, ay] = ROAD_NODES[a];
    const [bx, by] = ROAD_NODES[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const phase = hash2(seed + 613, a, b) * Math.PI * 2;
    const amp = 1.1 + hash2(seed + 811, b, a) * 1.8;
    const steps = Math.max(10, Math.round(len * 1.6));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // A single arc across the segment, tapering to zero at both junctions.
      const bend = Math.sin(t * Math.PI) * amp * Math.sin(phase + t * 1.4);
      pts.push([ax + dx * t + nx * bend, ay + dy * t + ny * bend]);
      // Main streets are wider than the lanes out to the farm and forest.
      const major = (a <= 8 && b <= 8) ? 1 : 0;
      widths.push(1.35 + major * 0.65 + valueNoise(seed + 97, (a + t) * 3, b) * 0.55);
    }
  }));
  return { pts, widths };
}

/** Squared distance from a point to the nearest sample, plus that sample's width. */
function nearest(line: Polyline, x: number, y: number): { d: number; w: number } {
  let best = Infinity, w = 0;
  for (let i = 0; i < line.pts.length; i++) {
    const dx = line.pts[i][0] - x, dy = line.pts[i][1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; w = line.widths[i]; }
  }
  return { d: Math.sqrt(best), w };
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

const PLAZA = { x: 50, y: 47, r: 5.6 };

export interface MapOptions {
  /** Skip prop scattering. Plot previews only need the ground. */
  props?: boolean;
}

export function generateWorldMap(world: World, options: MapOptions = {}): WorldMap {
  const seed = world.seed;
  const grid = GRID;
  const n = grid * grid;
  const tiles = new Uint8Array(n);
  const variants = new Uint8Array(n);
  const steps = new Uint8Array(n);
  const field = new Float32Array(n);
  const cliffs = new Uint8Array(n);
  const tone = new Float32Array(n);
  const profile = biomeProfile(world.biome);
  const water = waterFor(profile);
  const river = buildRiver(seed, profile);
  const roads = buildRoads(seed);
  const props: PropInstance[] = [];
  const waterfalls: { tx: number; ty: number }[] = [];

  const cell = 100 / grid;
  const worldOf = (tx: number, ty: number): [number, number] => [(tx + 0.5) * cell, (ty + 0.5) * cell];

  // Building footprints get a clear apron so props never grow through walls.
  const footprints = world.buildings.map((b) => ({ x: b.x, y: b.y, r: b.type === 'Market' || b.type === 'Town Hall' ? 7 : 5.5 }));
  const blocked = (wx: number, wy: number, pad = 0) =>
    footprints.some((f) => (f.x - wx) ** 2 + (f.y - wy) ** 2 < (f.r + pad) ** 2);

  const farm = world.buildings.find((b) => b.type === 'Farm');

  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const i = ty * grid + tx;
      const [wx, wy] = worldOf(tx, ty);
      tone[i] = fbm(seed + 5200, wx * 0.022, wy * 0.022, 3);
      const h = heightField(seed, wx, wy, profile.plateau);
      field[i] = h;
      steps[i] = h > 0.5 ? 1 : 0;

      const riverHit = nearest(river, wx, wy);
      const pondD = Math.hypot(wx - water.pond.x, wy - water.pond.y);
      const pondEdge = water.pond.r + (valueNoise(seed + 55, wx * 0.14, wy * 0.14) - 0.5) * 5;
      const inWater = (riverHit.d < riverHit.w && steps[i] === 0) || pondD < pondEdge;
      const nearWater = riverHit.d < riverHit.w + 0.9 || pondD < pondEdge + 1.1;

      const roadHit = nearest(roads, wx, wy);
      const roadEdge = roadHit.w + (valueNoise(seed + 191, wx * 0.3, wy * 0.3) - 0.5) * 1.0;
      const onRoad = roadHit.d < roadEdge;
      const inPlaza = Math.hypot(wx - PLAZA.x, wy - PLAZA.y) < PLAZA.r + (valueNoise(seed + 37, wx * 0.2, wy * 0.2) - 0.5) * 2.4;

      let tile: Tile;
      if (inWater) {
        tile = nearWater && !((riverHit.d < riverHit.w - 1.6) || pondD < pondEdge - 1.8) ? Tile.WaterShore : Tile.Water;
      } else if (inPlaza) {
        tile = Tile.Plaza;
      } else if (onRoad) {
        tile = Tile.Path;
      } else if (nearWater) {
        tile = Tile.Sand;
      } else if (farm && Math.hypot(wx - farm.x, wy - farm.y) < 15 && !blocked(wx, wy, 1)) {
        // Ploughed strips around the farm, alternating crop and fallow.
        const strip = Math.floor((wx - farm.x + wy * 0.35) / 4.5);
        tile = strip % 3 === 0 ? Tile.Tilled : strip % 3 === 1 ? Tile.CropWheat : Tile.CropVeg;
      } else if (steps[i] === 1) {
        // The shelf is rock where it is exposed and upland meadow everywhere else,
        // so the highland still reads as part of a lush world.
        tile = fbm(seed + 700, wx * 0.09, wy * 0.09, 3) > 0.52 ? Tile.Rock : Tile.Meadow;
      } else if (fbm(seed + 700, wx * 0.06, wy * 0.06, 3) > profile.rockThreshold) {
        tile = Tile.Rock;
      } else {
        const forest = fbm(seed + 1300, wx * 0.045, wy * 0.045, 4);
        const bloom = fbm(seed + 2600, wx * 0.09, wy * 0.09, 3);
        // Keep the settlement core open; push woodland out to the edges.
        const fromCore = Math.hypot(wx - 50, wy - 50) / 60;
        tile = forest + fromCore * 0.28 + profile.forest > 0.62 ? Tile.Forest
          : bloom > profile.bloom ? Tile.Flowers
            : bloom < 0.34 ? Tile.Meadow
              : Tile.Grass;
      }

      tiles[i] = tile;
      const art = TILE_ART[tile];
      variants[i] = art.variants ? Math.floor(hash2(seed + 88, tx, ty) * art.variants) : 0;
    }
  }

  // Nothing may be built on water. Carve a dry apron under every footprint so a
  // building can never end up floating, whether it was placed by the world
  // generator or dropped there by the player.
  for (const f of footprints) {
    const reach = f.r + 2;
    const minX = Math.max(0, Math.floor((f.x - reach) / cell));
    const maxX = Math.min(grid - 1, Math.ceil((f.x + reach) / cell));
    const minY = Math.max(0, Math.floor((f.y - reach) / cell));
    const maxY = Math.min(grid - 1, Math.ceil((f.y + reach) / cell));
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const i = ty * grid + tx;
        const [wx, wy] = worldOf(tx, ty);
        if ((f.x - wx) ** 2 + (f.y - wy) ** 2 > reach ** 2) continue;
        const kind = tiles[i] as Tile;
        if (kind !== Tile.Water && kind !== Tile.WaterShore && kind !== Tile.Sand) continue;
        tiles[i] = Tile.Grass;
        variants[i] = Math.floor(hash2(seed + 88, tx, ty) * TILE_ART[Tile.Grass].variants);
      }
    }
  }

  // Cliff faces where a raised tile overhangs a lower one to the south or east.
  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const i = ty * grid + tx;
      if (!steps[i]) continue;
      const [wx, wy] = worldOf(tx, ty);
      if (blocked(wx, wy, 2)) continue;
      const south = ty + 1 < grid ? steps[(ty + 1) * grid + tx] : 0;
      const east = tx + 1 < grid ? steps[ty * grid + tx + 1] : 0;
      if (!south || !east) cliffs[i] = 1;
    }
  }

  // The river drops off the shelf as a waterfall.
  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const i = ty * grid + tx;
      if (!cliffs[i]) continue;
      const [wx, wy] = worldOf(tx, ty);
      const hit = nearest(river, wx, wy);
      if (hit.d < hit.w + 1.2) { waterfalls.push({ tx, ty }); cliffs[i] = 0; }
    }
  }

  const heightAt = (wx: number, wy: number) => heightField(seed, wx, wy, profile.plateau);
  const tileAt = (wx: number, wy: number) => {
    const tx = Math.max(0, Math.min(grid - 1, Math.floor(wx / cell)));
    const ty = Math.max(0, Math.min(grid - 1, Math.floor(wy / cell)));
    return tiles[ty * grid + tx] as Tile;
  };

  if (options.props !== false) {
    scatterProps(props, { seed, grid, cell, tiles, steps, worldOf, blocked, roads, river, heightAt, profile });
    placeSettlementProps(props, world, roads, seed, water.pond);
  }

  return { grid, tiles, variants, steps, field, cliffs, tone, waterfalls, props, heightAt, tileAt };
}

/* ------------------------------------------------------------------ *
 * Props
 * ------------------------------------------------------------------ */

interface ScatterCtx {
  seed: number; grid: number; cell: number;
  tiles: Uint8Array; steps: Uint8Array;
  worldOf: (tx: number, ty: number) => [number, number];
  blocked: (wx: number, wy: number, pad?: number) => boolean;
  roads: Polyline; river: Polyline;
  heightAt: (wx: number, wy: number) => number;
  profile: BiomeProfile;
}

const bigTree = (species: string) => `prop.tree.${species}.big`;
const smallTree = (species: string) => `prop.tree.${species}.small`;

function scatterProps(out: PropInstance[], ctx: ScatterCtx) {
  const { seed, grid, tiles, steps, worldOf, blocked, roads, profile } = ctx;
  const TREES = profile.trees.map(bigTree);
  const SMALL_TREES = profile.trees.map(smallTree);
  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const i = ty * grid + tx;
      const tile = tiles[i] as Tile;
      // Up to four props per tile, jittered inside the diamond, so woodland
      // reads as a canopy rather than a grid of trees.
      for (let k = 0; k < 4; k++) {
        const r1 = hash2(seed + 1200 + k * 191, tx, ty);
        const r2 = hash2(seed + 2400 + k * 313, tx, ty);
        const r3 = hash2(seed + 3600 + k * 577, tx, ty);
        const [bx, by] = worldOf(tx, ty);
        const wx = bx + (r1 - 0.5) * ctx.cell * 0.95;
        const wy = by + (r2 - 0.5) * ctx.cell * 0.95;
        if (blocked(wx, wy)) continue;
        const roadHit = nearest(roads, wx, wy);
        const nearRoad = roadHit.d < roadHit.w + 1.4;

        let name: string | null = null;
        let sway = 0;
        if (tile === Tile.Forest) {
          if (nearRoad) { if (r3 < 0.25) { name = SMALL_TREES[Math.floor(r3 * 12) % 3]; sway = 1; } }
          else if (r3 < 0.52) { name = TREES[Math.floor(r3 * 9) % 3]; sway = 1; }
          else if (r3 < 0.68) { name = SMALL_TREES[Math.floor(r3 * 7) % 3]; sway = 1; }
          else if (r3 < 0.78) { name = `prop.bush.${Math.floor(r3 * 30) % 3}`; sway = 0.6; }
          else if (r3 < 0.83) name = 'prop.stump';
          else if (r3 < 0.87) name = 'prop.rock.small';
        } else if (tile === Tile.Grass) {
          if (nearRoad) { if (r3 < 0.07) { name = `prop.flowers.${Math.floor(r3 * 50) % 4}`; sway = 0.4; } }
          else if (r3 < 0.09) { name = TREES[Math.floor(r3 * 30) % 3]; sway = 1; }
          else if (r3 < 0.15) { name = SMALL_TREES[Math.floor(r3 * 40) % 3]; sway = 1; }
          else if (r3 < 0.24) { name = `prop.bush.${Math.floor(r3 * 60) % 3}`; sway = 0.6; }
          else if (r3 < 0.3) { name = `prop.flowers.${Math.floor(r3 * 90) % 4}`; sway = 0.4; }
        } else if (tile === Tile.Meadow) {
          if (nearRoad) continue;
          if (r3 < 0.3) { name = `prop.flowers.${Math.floor(r3 * 70) % 4}`; sway = 0.4; }
          else if (r3 < 0.36) { name = `prop.bush.${Math.floor(r3 * 40) % 3}`; sway = 0.6; }
          else if (r3 < 0.39) { name = SMALL_TREES[Math.floor(r3 * 20) % 3]; sway = 1; }
        } else if (tile === Tile.Flowers) {
          if (nearRoad) continue;
          if (r3 < 0.42) { name = `prop.flowers.${Math.floor(r3 * 80) % 4}`; sway = 0.4; }
          else if (r3 < 0.5) { name = `prop.bush.${Math.floor(r3 * 50) % 3}`; sway = 0.6; }
        } else if (tile === Tile.Rock) {
          if (nearRoad) continue;
          if (r3 < 0.22) name = 'prop.rock.big';
          else if (r3 < 0.4) name = 'prop.rock.small';
          else if (r3 < 0.46 && !steps[i]) { name = 'prop.tree.dead'; sway = 0.5; }
          else if (r3 < 0.52 && !steps[i]) { name = SMALL_TREES[0]; sway = 1; }
        } else if (tile === Tile.Sand) {
          if (r3 < 0.26) { name = 'prop.reeds'; sway = 0.8; }
          else if (r3 < 0.32) name = 'prop.rock.small';
        } else if (tile === Tile.Water) {
          if (r3 < 0.05) { name = 'prop.lilypad'; sway = 0.2; }
        }

        if (!name) continue;
        out.push({ wx, wy, name, sway, flip: r1 > 0.5 && !name.includes('tree'), scale: 0.82 + r2 * 0.42 });
      }
    }
  }
}

/** Hand-placed settlement dressing that reads as somewhere people have built this place. */
function placeSettlementProps(out: PropInstance[], world: World, roads: Polyline, seed: number, pond: { x: number; y: number; r: number }) {
  const at = (type: string) => world.buildings.find((b) => b.type === type);
  const push = (wx: number, wy: number, name: string, sway = 0, glowing = false) =>
    out.push({ wx, wy, name, sway, glow: glowing });

  // Bridge where the north road crosses the river.
  push(BRIDGE.x, BRIDGE.y, 'prop.bridge');

  // Well and benches in the square.
  push(PLAZA.x + 3.5, PLAZA.y + 1.5, 'prop.well');
  push(PLAZA.x - 5, PLAZA.y + 2.5, 'prop.bench');
  push(PLAZA.x + 5.5, PLAZA.y - 3, 'prop.bench');
  push(PLAZA.x - 4.5, PLAZA.y - 3.5, 'prop.planter', 0.4);
  push(PLAZA.x + 1.5, PLAZA.y + 5.5, 'prop.planter', 0.4);
  push(PLAZA.x - 7.5, PLAZA.y - 1, 'prop.signpost');

  // Lanterns spaced along the main streets.
  const lanternEvery = 46;
  for (let i = 0; i < roads.pts.length; i += lanternEvery) {
    const [x, y] = roads.pts[i];
    const side = hash2(seed + 909, i, 3) > 0.5 ? 1 : -1;
    push(x + side * 2.6, y + side * 1.4, 'prop.lantern', 0, true);
  }

  const market = at('Market');
  if (market) {
    // Stalls fanned out in front of the market hall.
    const spots: [number, number, number][] = [
      [-7, 4.5, 0], [-2.5, 6, 1], [2.5, 6, 2], [7, 4.5, 0], [-8.5, 0.5, 1], [8.5, 0.5, 2],
    ];
    for (const [dx, dy, kind] of spots) push(market.x + dx, market.y + dy, `prop.stall.${kind}`);
    push(market.x - 10, market.y + 2.5, 'prop.crates');
    push(market.x + 10.5, market.y + 2, 'prop.barrel');
    push(market.x + 4, market.y + 8.5, 'prop.campfire.0', 0, true);
  }

  const farm = at('Farm');
  if (farm) {
    push(farm.x + 6.5, farm.y + 2, 'prop.haybale');
    push(farm.x + 9, farm.y + 3.5, 'prop.haybale');
    push(farm.x - 6.5, farm.y + 3, 'prop.crates');
    for (let i = 0; i < 6; i++) push(farm.x - 11 + i * 3.4, farm.y + 8.5, i % 2 ? 'prop.fence.ne' : 'prop.fence.nw');
  }

  const wood = at('Woodcutter');
  if (wood) {
    push(wood.x + 5.5, wood.y + 2.5, 'prop.woodpile');
    push(wood.x - 5, wood.y + 2, 'prop.woodpile');
    push(wood.x + 2.5, wood.y + 5, 'prop.stump');
  }

  const smith = at('Blacksmith');
  if (smith) {
    push(smith.x + 5.5, smith.y + 2.5, 'prop.barrel');
    push(smith.x - 5, smith.y + 3, 'prop.crates');
  }

  const storage = at('Storage');
  if (storage) {
    push(storage.x - 6, storage.y + 3, 'prop.crates');
    push(storage.x + 6.5, storage.y + 2.5, 'prop.barrel');
    push(storage.x + 4, storage.y + 5, 'prop.crates');
  }

  const tavern = at('Tavern');
  if (tavern) {
    push(tavern.x - 5.5, tavern.y + 3.5, 'prop.bench');
    push(tavern.x + 5.5, tavern.y + 3.5, 'prop.bench');
    push(tavern.x + 8, tavern.y + 1, 'prop.lantern', 0, true);
    push(tavern.x - 2, tavern.y + 6.5, 'prop.campfire.0', 0, true);
  }

  const quarry = at('Quarry');
  if (quarry) {
    push(quarry.x - 6, quarry.y + 3, 'prop.rock.big');
    push(quarry.x + 6.5, quarry.y + 2, 'prop.rock.big');
    push(quarry.x + 2, quarry.y + 6, 'prop.rock.small');
  }

  // Reeds and lilies around the pond edge.
  const rim = Math.max(18, Math.round(pond.r * 3));
  for (let i = 0; i < rim; i++) {
    const a = (i / rim) * Math.PI * 2;
    const r = pond.r + 0.6 + hash2(seed + 404, i, 1) * 1.6;
    push(pond.x + Math.cos(a) * r, pond.y + Math.sin(a) * r * 0.9, i % 3 === 0 ? 'prop.reeds' : 'prop.bush.0', 0.8);
  }
}

export { BRIDGE, PLAZA };
