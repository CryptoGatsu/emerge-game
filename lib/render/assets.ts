/**
 * The Emerge asset library.
 *
 * Every texture the renderer draws is resolved through this registry by name.
 * Today the textures are generated procedurally at boot (see `tiles.ts`,
 * `props.ts`, `buildings.ts`, `character.ts`); when authored sprite sheets land,
 * `overrideTexture()` swaps them in under the same names and neither the
 * renderer nor the simulation changes.
 *
 * Naming convention:
 *   tile.<type>.<variant>          terrain diamonds
 *   prop.<name>                    trees, rocks, clutter
 *   building.<Type>                base sprite
 *   building.<Type>.lit            additive night-window overlay
 *   char.<dir>.<state>.<frame>.<layer>   tintable character part masks
 *   char.hair.<dir>.<state>.<frame>.<style>
 *   char.hat.<dir>.<state>.<frame>.<kind>
 *   fx.<name> / icon.<name>        particles, rings and badges
 */

import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import {
  BODY_LAYERS, HATS, bodyFrame, characterFrameKeys, hairFrame, hatFrame,
  type HatKind, HAIR_STYLES,
} from './character';
import { buildBuildings, type BuildingArt } from './buildings';
import { buildProps } from './props';
import { buildTiles, canopyPattern } from './tiles';
import { BLOOM, BUILD, UI, WATER } from './palette';
import { glow, rect, rng, surface, type Pixels } from './pixelCanvas';

const PAGE = 2048;
const PAD = 2;

/**
 * Shelf packer.
 *
 * Every generated sprite goes onto a shared atlas page so the renderer can draw
 * the whole settlement — thousands of tiles, props, characters — in a handful of
 * batched draw calls instead of one per sprite. Without this, a dense world
 * costs several thousand draw calls a frame.
 */
class AtlasPacker {
  private pages: { pixels: Pixels; source: CanvasSource }[] = [];
  private x = 0;
  private y = 0;
  private rowH = 0;

  private newPage() {
    const pixels = surface(PAGE, PAGE);
    const source = new CanvasSource({ resource: pixels.canvas, scaleMode: 'nearest' });
    this.pages.push({ pixels, source });
    this.x = 0; this.y = 0; this.rowH = 0;
  }

  add(pixels: Pixels): Texture {
    if (!this.pages.length) this.newPage();
    const w = pixels.w + PAD;
    const h = pixels.h + PAD;
    if (this.x + w > PAGE) { this.x = 0; this.y += this.rowH; this.rowH = 0; }
    if (this.y + h > PAGE) this.newPage();
    const page = this.pages[this.pages.length - 1];
    page.pixels.ctx.drawImage(pixels.canvas, this.x, this.y);
    const frame = new Rectangle(this.x, this.y, pixels.w, pixels.h);
    this.x += w;
    this.rowH = Math.max(this.rowH, h);
    return new Texture({ source: page.source, frame });
  }

  /** Push the finished pages to the GPU. Called once after generation. */
  finalise() {
    for (const page of this.pages) page.source.update();
  }

  get pageCount() { return this.pages.length; }
}

/* ------------------------------------------------------------------ *
 * Effects and small overlays
 * ------------------------------------------------------------------ */

function smokePuff(): Pixels {
  const p = surface(16, 16);
  glow(p, 8, 8, 8, '#d8d8d0', 0.85);
  return p;
}
function sparkDot(color: string): Pixels {
  const p = surface(8, 8);
  glow(p, 4, 4, 4, color, 0.9);
  return p;
}
function rainDrop(): Pixels {
  const p = surface(3, 12);
  rect(p, 1, 0, 1, 12, '#a9cbe0');
  rect(p, 1, 8, 1, 4, '#d6ecf5');
  return p;
}
function snowFlake(): Pixels {
  const p = surface(5, 5);
  rect(p, 1, 1, 3, 3, '#ffffff');
  rect(p, 2, 0, 1, 5, '#eef6ff');
  rect(p, 0, 2, 5, 1, '#eef6ff');
  return p;
}
function selectionRing(color: string, thickness: number): Pixels {
  const p = surface(48, 26);
  p.ctx.strokeStyle = color;
  p.ctx.lineWidth = thickness;
  p.ctx.beginPath();
  p.ctx.ellipse(24, 13, 18, 8, 0, 0, Math.PI * 2);
  p.ctx.stroke();
  return p;
}
function softShadow(): Pixels {
  const p = surface(24, 12);
  p.ctx.fillStyle = 'rgba(0,0,0,0.42)';
  p.ctx.beginPath();
  p.ctx.ellipse(12, 6, 7, 3, 0, 0, Math.PI * 2);
  p.ctx.fill();
  return p;
}
function lampGlow(): Pixels {
  const p = surface(64, 64);
  glow(p, 32, 32, 32, '#ffd88a', 0.55);
  return p;
}
function splashRing(frame: number): Pixels {
  const p = surface(20, 12);
  p.ctx.strokeStyle = WATER.foam;
  p.ctx.lineWidth = 1;
  p.ctx.beginPath();
  p.ctx.ellipse(10, 6, 3 + frame * 2.5, 1.5 + frame, 0, 0, Math.PI * 2);
  p.ctx.stroke();
  return p;
}

/** Tiny glyphs shown over a building when citizens are busy inside it. */
function activityIcon(kind: 'work' | 'eat' | 'social' | 'sleep' | 'trade'): Pixels {
  const p = surface(12, 12);
  const g = UI.cream;
  switch (kind) {
    case 'work':
      rect(p, 2, 7, 8, 2, '#8a6640');
      rect(p, 7, 3, 4, 3, BUILD.metalLight);
      break;
    case 'eat':
      rect(p, 2, 5, 8, 4, BLOOM.wheat);
      rect(p, 3, 4, 6, 2, BLOOM.wheatDark);
      break;
    case 'social':
      rect(p, 3, 3, 5, 7, g);
      rect(p, 3, 3, 5, 2, BLOOM.wheat);
      rect(p, 8, 5, 2, 3, g);
      break;
    case 'sleep':
      rect(p, 3, 3, 6, 1, g);
      rect(p, 6, 4, 2, 1, g);
      rect(p, 5, 5, 2, 1, g);
      rect(p, 3, 6, 6, 1, g);
      rect(p, 5, 8, 4, 1, g);
      break;
    case 'trade':
      p.ctx.fillStyle = BUILD.gold;
      p.ctx.beginPath();
      p.ctx.arc(6, 6, 4, 0, Math.PI * 2);
      p.ctx.fill();
      rect(p, 5, 4, 2, 5, '#a8843a');
      break;
  }
  return p;
}

/** A bird in silhouette, two frames of wingbeat. */
function bird(frame: number): Pixels {
  const p = surface(14, 10);
  const up = frame === 0;
  const body = '#2a3326';
  rect(p, 6, 5, 3, 2, body);
  if (up) {
    for (let i = 0; i < 5; i++) { rect(p, 5 - i, 4 - i, 2, 1, body); rect(p, 8 + i, 4 - i, 2, 1, body); }
  } else {
    for (let i = 0; i < 5; i++) { rect(p, 5 - i, 5 + Math.floor(i * 0.6), 2, 1, body); rect(p, 8 + i, 5 + Math.floor(i * 0.6), 2, 1, body); }
  }
  return p;
}

/** A leaf that drifts across the world in autumn wind. */
function leafMote(color: string): Pixels {
  const p = surface(6, 6);
  rect(p, 1, 2, 4, 2, color);
  rect(p, 2, 1, 2, 4, color);
  return p;
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export interface BuildingMeta { anchorY: number; door: [number, number]; chimney?: [number, number]; width: number; height: number }

export class AssetLibrary {
  private textures = new Map<string, Texture>();
  private overrides = new Map<string, Texture>();
  readonly buildingMeta = new Map<string, BuildingMeta>();

  get(name: string): Texture {
    const found = this.overrides.get(name) ?? this.textures.get(name);
    if (!found) throw new Error(`Emerge: missing texture "${name}"`);
    return found;
  }

  has(name: string) { return this.overrides.has(name) || this.textures.has(name); }

  /** Returns the texture if present, else the fallback name's texture. */
  getOr(name: string, fallback: string): Texture {
    return this.has(name) ? this.get(name) : this.get(fallback);
  }

  set(name: string, texture: Texture) { this.textures.set(name, texture); }

  /**
   * Replace a generated texture with an authored one. This is the seam for the
   * upcoming sprite pipeline: load a sheet, slice it, and call this per frame.
   * Nothing else in the codebase needs to know the art changed.
   */
  overrideTexture(name: string, texture: Texture) { this.overrides.set(name, texture); }

  /** Drop all overrides and fall back to the generated art. */
  clearOverrides() { this.overrides.clear(); }

  get names(): string[] { return [...this.textures.keys()]; }
}

/**
 * The distant-forest backdrop. Kept out of the atlas because a tiling sprite
 * needs a texture that owns its whole source.
 */
export function backdropTexture(): Texture {
  if (!backdrop) {
    const pixels = canopyPattern();
    backdrop = new Texture({ source: new CanvasSource({ resource: pixels.canvas, scaleMode: 'nearest' }) });
  }
  return backdrop;
}
let backdrop: Texture | null = null;

let cached: AssetLibrary | null = null;

/**
 * Build (or return) the asset library. Generation is synchronous and takes a few
 * hundred milliseconds on first call, so the client shows a boot state while it
 * runs and reuses the result across hot reloads.
 */
export function loadAssets(): AssetLibrary {
  if (cached) return cached;
  const lib = new AssetLibrary();
  const pack = new AtlasPacker();
  const put = (name: string, pixels: Pixels) => lib.set(name, pack.add(pixels));

  for (const { name, pixels } of buildTiles()) put(name, pixels);
  for (const { name, pixels } of buildProps()) put(name, pixels);

  const { art, overlays } = buildBuildings();
  for (const b of art as BuildingArt[]) {
    put(`building.${b.name}`, b.pixels);
    put(`building.${b.name}.lit`, b.lit);
    lib.buildingMeta.set(b.name, {
      anchorY: b.anchorY, door: b.door, chimney: b.chimney,
      width: b.pixels.w, height: b.pixels.h,
    });
  }
  for (const { name, pixels } of overlays) put(name, pixels);

  // Character masks: body parts, then hair styles and hats as separate sets.
  for (const { dir, state, frame } of characterFrameKeys()) {
    const layers = bodyFrame(dir, state, frame);
    for (const layer of BODY_LAYERS) put(`char.${dir}.${state}.${frame}.${layer}`, layers[layer]);
    for (let style = 0; style < HAIR_STYLES; style++) {
      put(`char.hair.${dir}.${state}.${frame}.${style}`, hairFrame(dir, state, frame, style));
    }
    for (const kind of HATS) {
      if (kind === 'none') continue;
      put(`char.hat.${dir}.${state}.${frame}.${kind}`, hatFrame(dir, state, frame, kind as Exclude<HatKind, 'none'>));
    }
  }

  put('fx.smoke', smokePuff());
  put('fx.spark', sparkDot('#ffca6b'));
  put('fx.firefly', sparkDot(UI.emerald));
  put('fx.rain', rainDrop());
  put('fx.snow', snowFlake());
  put('fx.shadow', softShadow());
  put('fx.lampglow', lampGlow());
  put('fx.select', selectionRing(UI.emerald, 2));
  put('fx.hover', selectionRing(UI.cream, 1));
  for (let f = 0; f < 3; f++) put(`fx.splash.${f}`, splashRing(f));
  put('fx.bird.0', bird(0));
  put('fx.bird.1', bird(1));
  put('fx.leaf.0', leafMote('#c98a3a'));
  put('fx.leaf.1', leafMote('#a85a2a'));
  put('fx.leaf.2', leafMote('#d8b24a'));
  for (const kind of ['work', 'eat', 'social', 'sleep', 'trade'] as const) {
    put(`icon.${kind}`, activityIcon(kind));
  }

  pack.finalise();
  cached = lib;
  return lib;
}

/** Stable per-citizen appearance derived from their cosmetic `look` seed. */
export interface Appearance {
  skin: number; hair: number; shirt: number; pants: number; shoes: number;
  hairStyle: number; scale: number;
}

const toInt = (hex: string) => parseInt(hex.slice(1), 16);

export function appearanceFor(look: number, age: number, palettes: {
  skin: readonly string[]; hair: readonly string[]; shirt: readonly string[];
  pants: readonly string[]; shoes: readonly string[];
}): Appearance {
  const r = rng(look);
  return {
    skin: toInt(palettes.skin[Math.floor(r() * palettes.skin.length)]),
    hair: toInt(palettes.hair[Math.floor(r() * palettes.hair.length)]),
    shirt: toInt(palettes.shirt[Math.floor(r() * palettes.shirt.length)]),
    pants: toInt(palettes.pants[Math.floor(r() * palettes.pants.length)]),
    shoes: toInt(palettes.shoes[Math.floor(r() * palettes.shoes.length)]),
    hairStyle: Math.floor(r() * HAIR_STYLES),
    // Sized so a person reads clearly against a building at normal zoom, with
    // children visibly smaller than adults.
    scale: age < 16 ? 1.0 : 1.26 + r() * 0.16,
  };
}
