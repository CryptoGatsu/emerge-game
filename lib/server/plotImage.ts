import 'server-only';

/**
 * A plot's picture, for its token.
 *
 * Drawn from the same terrain the game draws — the tile grid the seed grows,
 * the water, the roads — with the settlement's buildings on it as they stand
 * in the owner's last published copy. An SVG, so it is a few kilobytes,
 * scales to any marketplace card, and needs no image service: the same
 * request that serves the metadata can serve the picture. Isometric, so it
 * reads as the world map's plot rather than a flat chart.
 *
 * Cached for a while per seed: a picture that changed within the minute is
 * not worth a world generation per request.
 */

import { createWorld, type World } from '../simulation';
import { biomeProfile } from '../world/biomes';
import { ERAS } from '../world/eras';
import { worldFromSave, type SavedWorld } from '../world/save';
import { Tile, TILE_COLOR, generateWorldMap } from '../world/terrain';
import { serverKey } from '../limits';
import { getValue, setValue } from './kv';
import { claimOf, readWorld } from './registry';

const CACHE = (seed: number) => serverKey(`nft:image:${seed}`);
const KEEP_SECONDS = 600;

/** The world to draw: the owner's published copy when there is one, else a fresh one grown from the seed. */
export async function worldForPicture(seed: number, worldName: string): Promise<World> {
  try {
    const published = await readWorld(seed);
    const world = published ? worldFromSave(published.snapshot as SavedWorld, seed, worldName) : null;
    if (world) return world;
  } catch { /* a fresh world is still the right land */ }
  return createWorld(seed, worldName);
}

const ROOF: Record<string, string> = {
  House: '#a3493a', Market: '#c9a24a', Storage: '#7a5a3a', Farm: '#b79c47', Woodcutter: '#5a3f27', Fishery: '#3a6f8a',
  Quarry: '#8a8578', Mine: '#5d5a52', Mill: '#8c6a3f', Bakery: '#c77b4a', Carpenter: '#6b4b2f', Blacksmith: '#4a4a52',
  Tailor: '#7f4b7a', Lodge: '#4f5f3a', Forager: '#4f7a3c', School: '#5a6fa3', Clinic: '#a3a3a3', Library: '#6a5aa3',
  Tavern: '#a37a3a', Jail: '#555a66', 'Town Hall': '#3f7a48', Bank: '#c7a23a', Lab: '#4a8aa3', Cafe: '#b56a4a', Studio: '#8a4a8a',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * The SVG. 1024 square, the map as an isometric diamond, a title bar with
 * the world's name, its region and biome, its era and level.
 */
export function plotSvg(world: World, meta: { region: string; era: number; level: number | null; population: number }): string {
  const map = generateWorldMap(world, { props: false });
  const g = map.grid;
  const size = 1024;
  // Tile side so the diamond spans about 86% of the width: an isometric
  // diamond of g tiles is g*side*sqrt(2) wide when rotated 45° and squashed.
  const side = (size * 0.86) / (g * Math.SQRT2);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`);
  parts.push('<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1a22"/><stop offset="1" stop-color="#162a33"/></linearGradient></defs>');
  parts.push(`<rect width="${size}" height="${size}" fill="url(#sky)"/>`);
  // Rotate 45° and squash to half height: the classic isometric diamond.
  const cx = size / 2, cy = size * 0.5;
  const w = g * side;
  parts.push(`<g transform="translate(${cx} ${cy}) scale(1 0.5) rotate(45) translate(${-w / 2} ${-w / 2})">`);
  // The plinth under the land, so it reads as an island on the sea of the card.
  parts.push(`<rect x="-6" y="-6" width="${w + 12}" height="${w + 12}" fill="#0a1418" opacity="0.6"/>`);
  // Tiles as row runs of one colour, so a 48×48 map is a few hundred rects, not two thousand.
  for (let ty = 0; ty < g; ty++) {
    let x0 = 0;
    let colour = TILE_COLOR[map.tiles[ty * g] as Tile] ?? '#4c8a3d';
    for (let tx = 1; tx <= g; tx++) {
      const c = tx < g ? TILE_COLOR[map.tiles[ty * g + tx] as Tile] ?? '#4c8a3d' : null;
      if (c !== colour) {
        parts.push(`<rect x="${(x0 * side).toFixed(1)}" y="${(ty * side).toFixed(1)}" width="${((tx - x0) * side + 0.4).toFixed(1)}" height="${(side + 0.4).toFixed(1)}" fill="${colour}"/>`);
        x0 = tx;
        colour = c ?? colour;
      }
    }
  }
  // Buildings as small blocks on their footprints, roof-coloured.
  const cell = 100 / g;
  const scale = side / cell;
  for (const b of world.buildings) {
    const bx = (b.x - map.t0 * cell) * scale, by = (b.y - map.t0 * cell) * scale;
    const r = (b.type === 'Market' || b.type === 'Town Hall' ? 3.2 : b.type === 'House' ? 2.0 : 2.6) * scale;
    const roof = b.ruined ? '#3a3a3a' : ROOF[b.type] ?? '#8c6a3f';
    parts.push(`<rect x="${(bx - r).toFixed(1)}" y="${(by - r).toFixed(1)}" width="${(2 * r).toFixed(1)}" height="${(2 * r).toFixed(1)}" fill="${roof}" stroke="#1a120a" stroke-width="1.2" rx="1"/>`);
  }
  parts.push('</g>');
  // The title bar.
  const profile = biomeProfile(world.biome);
  const era = ERAS[Math.max(0, Math.min(ERAS.length - 1, meta.era - 1))]?.name ?? 'Settlement';
  parts.push(`<rect x="0" y="${size - 176}" width="${size}" height="176" fill="#0a1418" opacity="0.85"/>`);
  parts.push(`<text x="48" y="${size - 108}" fill="#e8f0ea" font-family="Georgia, 'Times New Roman', serif" font-size="56" font-weight="bold">${esc(world.name)}</text>`);
  parts.push(`<text x="48" y="${size - 60}" fill="#9fb8a8" font-family="Helvetica, Arial, sans-serif" font-size="26">${esc(meta.region)} · ${esc(profile.label)} · ${esc(era)}${meta.level ? ` · City level ${meta.level}` : ''} · ${meta.population} people</text>`);
  parts.push(`<text x="${size - 48}" y="${size - 60}" fill="#6f8f7c" font-family="Helvetica, Arial, sans-serif" font-size="22" text-anchor="end">EMERGE · plot #${world.seed}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/** The picture for a seed, cached. `null` when nobody holds the plot. */
export async function plotImage(seed: number): Promise<string | null> {
  const held = await getValue(CACHE(seed)).catch(() => null);
  if (held) return held;
  const claim = await claimOf(seed).catch(() => null);
  const world = await worldForPicture(seed, claim?.worldName ?? `Plot ${seed}`);
  const svg = plotSvg(world, {
    region: claim?.region ?? 'Unclaimed land',
    era: claim?.era ?? world.era ?? 1,
    level: world.works?.level ?? null,
    population: world.citizens.length,
  });
  await setValue(CACHE(seed), svg, KEEP_SECONDS).catch(() => {});
  return svg;
}
