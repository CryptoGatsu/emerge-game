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

import { waterOf, type Building, type World } from '../simulation';
import { GRID, worldToTile } from './iso';
import { biomeProfile, type BiomeProfile } from './biomes';
import { onDeck, type WorldLayout } from './layout';
import { fbm, heightField } from './relief';
import { hash2, nearestOn, valueNoise, type Polyline, type WaterField } from './water';

export enum Tile {
  Grass, Flowers, Meadow, Forest, Soil, Tilled, CropWheat, CropVeg,
  Path, Plaza, Rock, Sand, Water, WaterShore,
  /** Biome ground: wind-rippled desert sand, sodden fen, dry steppe scrub. */
  Dune, Marsh, Scrub,
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
  [Tile.Dune]: { key: 'tile.dune', variants: 3 },
  [Tile.Marsh]: { key: 'tile.marsh', variants: 3 },
  [Tile.Scrub]: { key: 'tile.scrub', variants: 3 },
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
  [Tile.Dune]: '#d8b878',
  [Tile.Marsh]: '#5d7a4a',
  [Tile.Scrub]: '#93a558',
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
 * Water and elevation
 *
 * Both now come from shared modules. The terrain generator used to build its
 * own river from the biome routes and the simulation had no idea where it was,
 * which is how citizens ended up walking across it.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Roads
 * ------------------------------------------------------------------ */

/**
 * Sample the road graph into gently curved polylines. The simulation routes
 * along straight edges; drawing them with a deterministic meander is what makes
 * the result read as worn stone paths instead of a graph.
 */
function buildRoads(seed: number, layout: WorldLayout): Polyline {
  const pts: [number, number][] = [];
  const widths: number[] = [];
  const seen = new Set<string>();
  layout.edges.forEach((neighbours, a) => neighbours.forEach((b) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    const [ax, ay] = layout.nodes[a];
    const [bx, by] = layout.nodes[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const phase = valueNoise(seed + 613, a * 1.7, b * 2.3) * Math.PI * 2;
    const amp = 1.1 + valueNoise(seed + 811, b * 1.3, a * 0.9) * 1.8;
    const steps = Math.max(10, Math.round(len * 1.6));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // A single arc across the segment, tapering to zero at both junctions.
      const bend = Math.sin(t * Math.PI) * amp * Math.sin(phase + t * 1.4);
      pts.push([ax + dx * t + nx * bend, ay + dy * t + ny * bend]);
      // A street between two core nodes is the main one, and is drawn wider
      // than the track out to a mine head.
      const major = layout.roles[a] !== 'work' && layout.roles[b] !== 'work' ? 1 : 0;
      widths.push(1.35 + major * 0.6 + valueNoise(seed + 97, (a + t) * 3, b) * 0.55);
    }
  }));
  return { pts, widths };
}

const nearest = nearestOn;

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
  const layout = world.layout;
  const water: WaterField = waterOf(world);
  const river = water.river;
  const roads = buildRoads(seed, layout);
  const PLAZA = layout.plaza;
  const props: PropInstance[] = [];
  const waterfalls: { tx: number; ty: number }[] = [];

  const cell = 100 / grid;
  const worldOf = (tx: number, ty: number): [number, number] => [(tx + 0.5) * cell, (ty + 0.5) * cell];

  // Building footprints get a clear apron so props never grow through walls.
  const footprints = world.buildings.map((b) => ({ x: b.x, y: b.y, r: b.type === 'Market' || b.type === 'Town Hall' ? 7 : 5.5 }));
  const blocked = (wx: number, wy: number, pad = 0) =>
    footprints.some((f) => (f.x - wx) ** 2 + (f.y - wy) ** 2 < (f.r + pad) ** 2);

  // Every farm gets fields, not just the first one. A grassland with three of
  // them used to plough only one.
  const farms = world.buildings.filter((b) => b.type === 'Farm');
  const core = layout.plaza;
  const bridgeNear = (wx: number, wy: number) => onDeck(layout.bridges, wx, wy);

  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const i = ty * grid + tx;
      const [wx, wy] = worldOf(tx, ty);
      tone[i] = fbm(seed + 5200, wx * 0.022, wy * 0.022, 3);
      const h = heightField(seed, wx, wy, profile.plateau);
      field[i] = h;
      steps[i] = h > 0.5 ? 1 : 0;

      // The wet test is the shared mask, not a second opinion. Painting water
      // where the simulation thinks there is none is exactly the disagreement
      // that let citizens walk on the river.
      const inWater = water.isWater(wx, wy);
      const riverHit = river.pts.length ? nearest(river, wx, wy) : { d: Infinity, w: 0 };
      const pondD = Math.hypot(wx - water.pond.x, wy - water.pond.y);
      const pondEdge = water.pond.r + (valueNoise(seed + 55, wx * 0.14, wy * 0.14) - 0.5) * 5;
      const nearWater = riverHit.d < riverHit.w + 0.9 || pondD < pondEdge + 1.1;

      const roadHit = nearest(roads, wx, wy);
      const roadEdge = roadHit.w + (valueNoise(seed + 191, wx * 0.3, wy * 0.3) - 0.5) * 1.0;
      const onRoad = roadHit.d < roadEdge;
      const inPlaza = Math.hypot(wx - core.x, wy - core.y) < core.r + (valueNoise(seed + 37, wx * 0.2, wy * 0.2) - 0.5) * 2.4;
      const field2 = farms.find((f) => Math.hypot(wx - f.x, wy - f.y) < 14);

      let tile: Tile;
      if (inWater) {
        // A deck carries the road over the water instead of interrupting it.
        tile = bridgeNear(wx, wy) && onRoad ? Tile.Path
          : nearWater && !((riverHit.d < riverHit.w - 1.6) || pondD < pondEdge - 1.8) ? Tile.WaterShore
            : Tile.Water;
      } else if (inPlaza) {
        tile = Tile.Plaza;
      } else if (onRoad) {
        tile = Tile.Path;
      } else if (nearWater) {
        tile = profile.ground === 'marsh' ? Tile.Marsh : Tile.Sand;
      } else if (field2 && !blocked(wx, wy, 1)) {
        // Ploughed strips around the farm, alternating crop and fallow.
        const strip = Math.floor((wx - field2.x + wy * 0.35) / 4.5);
        tile = strip % 3 === 0 ? Tile.Tilled : strip % 3 === 1 ? Tile.CropWheat : Tile.CropVeg;
      } else if (steps[i] === 1) {
        // The shelf is rock where it is exposed and upland cover everywhere
        // else, so a highland still reads as part of a lived-in world.
        tile = fbm(seed + 700, wx * 0.09, wy * 0.09, 3) > 0.52 ? Tile.Rock
          : profile.ground === 'dune' ? Tile.Dune : Tile.Meadow;
      } else if (fbm(seed + 700, wx * 0.06, wy * 0.06, 3) > profile.rockThreshold) {
        tile = Tile.Rock;
      } else {
        const forest = fbm(seed + 1300, wx * 0.045, wy * 0.045, 4);
        const bloom = fbm(seed + 2600, wx * 0.09, wy * 0.09, 3);
        // Keep the settlement core open; push woodland out to the edges. The
        // core is wherever this world's square ended up, not the map's middle —
        // and the reach is capped, because a town near one corner would
        // otherwise read every far tile as remote and grow a forest over the
        // entire map.
        const fromCore = Math.min(Math.hypot(wx - core.x, wy - core.y), 34) / 60;
        // Ground cover the biome brings with it: dune, fen or scrub claims the
        // open ground before grass gets a look in.
        const cover = profile.groundCover > 0
          && fbm(seed + 3300, wx * 0.05, wy * 0.05, 3) < profile.groundCover
          ? profile.ground : 'grass';
        tile = forest + fromCore * 0.28 + profile.forest > 0.62 ? Tile.Forest
          : cover === 'dune' ? Tile.Dune
            : cover === 'marsh' ? Tile.Marsh
              : cover === 'scrub' ? Tile.Scrub
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
        const dry = profile.ground === 'dune' ? Tile.Dune : profile.ground === 'marsh' ? Tile.Marsh : Tile.Grass;
        tiles[i] = dry;
        variants[i] = Math.floor(hash2(seed + 88, tx, ty) * TILE_ART[dry].variants);
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
    placeSettlementProps(props, world, roads, seed, water.pond, layout, profile.ground);
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
          // A desert bank grows palms, not bulrushes.
          if (profile.ground === 'dune') {
            if (r3 < 0.12) { name = TREES[0]; sway = 1; }
            else if (r3 < 0.2) { name = `prop.bush.${Math.floor(r3 * 40) % 3}`; sway = 0.5; }
          } else if (r3 < 0.26) { name = 'prop.reeds'; sway = 0.8; }
          else if (r3 < 0.32) name = 'prop.rock.small';
        } else if (tile === Tile.Dune) {
          // Sparse by design: emptiness is what a desert is made of.
          if (nearRoad) continue;
          if (r3 < 0.018) { name = SMALL_TREES[Math.floor(r3 * 200) % 3]; sway = 1; }
          else if (r3 < 0.05) { name = `prop.bush.${Math.floor(r3 * 90) % 3}`; sway = 0.5; }
          else if (r3 < 0.075) name = 'prop.rock.small';
          else if (r3 < 0.085) name = 'prop.tree.dead';
        } else if (tile === Tile.Marsh) {
          if (nearRoad) { if (r3 < 0.14) { name = 'prop.reeds'; sway = 0.8; } }
          else if (r3 < 0.3) { name = 'prop.reeds'; sway = 0.8; }
          else if (r3 < 0.42) { name = TREES[Math.floor(r3 * 20) % 3]; sway = 1; }
          else if (r3 < 0.5) { name = `prop.bush.${Math.floor(r3 * 50) % 3}`; sway = 0.6; }
          else if (r3 < 0.54) name = 'prop.stump';
        } else if (tile === Tile.Scrub) {
          if (nearRoad) continue;
          if (r3 < 0.06) { name = SMALL_TREES[Math.floor(r3 * 70) % 3]; sway = 1; }
          else if (r3 < 0.2) { name = `prop.bush.${Math.floor(r3 * 60) % 3}`; sway = 0.6; }
          else if (r3 < 0.26) { name = `prop.flowers.${Math.floor(r3 * 80) % 4}`; sway = 0.4; }
          else if (r3 < 0.29) name = 'prop.rock.small';
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
function placeSettlementProps(out: PropInstance[], world: World, roads: Polyline, seed: number, pond: { x: number; y: number; r: number }, layout: WorldLayout, bank: BiomeProfile['ground']) {
  const at = (type: string) => world.buildings.find((b) => b.type === type);
  const push = (wx: number, wy: number, name: string, sway = 0, glowing = false) =>
    out.push({ wx, wy, name, sway, glow: glowing });

  // A deck at every place the plan found a road crossing water, laid along the
  // whole span rather than as a single sprite at the midpoint — a crossing is
  // as long as the water under it.
  for (const bridge of layout.bridges) {
    const sections = Math.max(1, Math.round(bridge.span / 2.6));
    for (let i = -sections; i <= sections; i++) {
      const t = (i / Math.max(1, sections)) * bridge.span;
      push(bridge.x + Math.cos(bridge.angle) * t, bridge.y + Math.sin(bridge.angle) * t, 'prop.bridge');
    }
  }

  // Benches, fires, the well and the market stalls stand exactly where the
  // simulation says they do, because citizens walk up to them and use them.
  // Drawing them anywhere else would put people sitting on empty ground.
  for (const amenity of world.amenities) {
    if (amenity.kind === 'bench') push(amenity.x, amenity.y, 'prop.bench');
    else if (amenity.kind === 'well') push(amenity.x, amenity.y, 'prop.well');
    else if (amenity.kind === 'campfire') push(amenity.x, amenity.y, 'prop.campfire.0', 0, true);
    else push(amenity.x, amenity.y, `prop.stall.${(Math.round(amenity.x + amenity.y)) % 3}`);
  }

  const PLAZA = layout.plaza;
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
    push(market.x - 10, market.y + 2.5, 'prop.crates');
    push(market.x + 10.5, market.y + 2, 'prop.barrel');
  }

  for (const farm of world.buildings.filter((b) => b.type === 'Farm')) {
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
  if (tavern) push(tavern.x + 8, tavern.y + 1, 'prop.lantern', 0, true);

  const quarry = at('Quarry');
  if (quarry) {
    push(quarry.x - 6, quarry.y + 3, 'prop.rock.big');
    push(quarry.x + 6.5, quarry.y + 2, 'prop.rock.big');
    push(quarry.x + 2, quarry.y + 6, 'prop.rock.small');
  }

  // Reeds and lilies around the pond edge. A desert spring gets palms instead.
  const rim = Math.max(18, Math.round(pond.r * 3));
  const desert = world.buildings.length > 0 && bank === 'dune';
  for (let i = 0; i < rim; i++) {
    const a = (i / rim) * Math.PI * 2;
    const r = pond.r + 0.6 + hash2(seed + 404, i, 1) * 1.6;
    const name = desert
      ? (i % 4 === 0 ? 'prop.tree.palm.small' : 'prop.bush.0')
      : (i % 3 === 0 ? 'prop.reeds' : 'prop.bush.0');
    push(pond.x + Math.cos(a) * r, pond.y + Math.sin(a) * r * 0.9, name, 0.8);
  }
}


