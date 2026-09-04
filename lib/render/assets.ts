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
import { buildBuildingArt, buildBuildings, type BuildingArt } from './buildings';
import { buildProps } from './props';
import { animalFrame, fishingRod, huntingBow } from './wildlifeArt';
import { clash, funnel, rubble, torch } from './dangerArt';
import { ANIMAL_KINDS } from '../world/wildlife';
import { buildTiles, canopyPattern } from './tiles';
import { BLOOM, BUILD, FOLIAGE, UI, WATER } from './palette';
import { glow, outline, rect, rng, surface, type Pixels } from './pixelCanvas';

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

  /** Add after the atlas is live: the page it lands on is re-uploaded at once. */
  addLive(pixels: Pixels): Texture {
    const tex = this.add(pixels);
    this.pages[this.pages.length - 1].source.update();
    return tex;
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
  glow(p, 32, 32, 32, '#ffcf7a', 0.6);
  glow(p, 32, 32, 14, '#fff0c8', 0.35);
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

/**
 * The cart a Stables puts under a working adult. Side-on, drawn under the
 * body: a plank bed on two spoked wheels, the shafts reaching forward.
 */
function cart(): Pixels {
  const p = surface(22, 12);
  // Shafts, then the bed, then the wheels over the bed so the axle reads.
  rect(p, 15, 5, 7, 1, BUILD.timberDark);
  rect(p, 2, 3, 14, 4, BUILD.timber);
  rect(p, 2, 3, 14, 1, BUILD.timberLight);
  rect(p, 2, 6, 14, 1, BUILD.timberDark);
  rect(p, 3, 1, 3, 2, '#c9b47a');
  rect(p, 7, 1, 4, 2, '#8f7f4a');
  for (const cx of [5, 13]) {
    rect(p, cx - 2, 6, 5, 5, '#3a2a1a');
    rect(p, cx - 1, 7, 3, 3, '#6b4a2e');
    rect(p, cx, 8, 1, 1, '#d8b24a');
  }
  return p;
}

/**
 * The ferry's boat, drawn under anyone crossing the water: a clinker hull
 * with a pale gunwale and a dark waterline, wide enough to sit a person in.
 */
function boat(): Pixels {
  const p = surface(32, 14);
  // Hull, waterline, then the pale gunwale and the thwart the passenger sits on.
  rect(p, 4, 5, 24, 6, '#7a4e2a');
  rect(p, 2, 6, 28, 4, '#7a4e2a');
  rect(p, 5, 11, 22, 1, '#4a2e18');
  rect(p, 8, 12, 16, 1, '#2f3f4a');
  rect(p, 4, 5, 24, 1, '#c99a5e');
  rect(p, 1, 6, 3, 2, '#c99a5e');
  rect(p, 28, 6, 3, 2, '#c99a5e');
  rect(p, 6, 7, 20, 1, '#5e3a20');
  rect(p, 10, 8, 12, 1, '#5e3a20');
  rect(p, 14, 3, 4, 2, '#a8843a');
  return p;
}

/** The industrial era's rail trolley: a short green carriage on iron wheels, a little chimney up front. */
function tram(): Pixels {
  const p = surface(26, 14);
  rect(p, 2, 3, 20, 8, '#2f5a3a');
  rect(p, 2, 3, 20, 1, '#5a8a5a');
  rect(p, 2, 9, 20, 2, '#1e3a26');
  for (const x of [5, 10, 15]) { rect(p, x, 5, 3, 3, '#1d2a30'); rect(p, x, 5, 3, 1, '#7ab0c0'); }
  rect(p, 22, 1, 2, 5, '#3a3a3e');
  rect(p, 21, 0, 4, 1, '#55555a');
  for (const cx of [6, 18]) { rect(p, cx - 2, 10, 5, 4, '#3a3a3e'); rect(p, cx - 1, 11, 3, 2, '#7a828c'); }
  rect(p, 0, 11, 26, 1, '#55555a');
  return p;
}

/** A bicycle, side on: two wheels, a frame, the handlebars up front. */
function bike(): Pixels {
  const p = surface(22, 12);
  for (const cx of [5, 17]) {
    rect(p, cx - 4, 4, 9, 8, '#3a3a3e');
    rect(p, cx - 3, 5, 7, 6, '#7a828c');
    rect(p, cx - 2, 6, 5, 4, '#3a3a3e');
    rect(p, cx - 1, 7, 3, 2, '#c8c8c0');
  }
  rect(p, 6, 3, 10, 1, '#c84a4a');
  rect(p, 9, 1, 1, 6, '#c84a4a');
  rect(p, 5, 5, 1, 4, '#c84a4a');
  rect(p, 14, 3, 1, 5, '#c84a4a');
  rect(p, 16, 0, 3, 1, '#3a3a3e');
  rect(p, 17, 1, 1, 3, '#3a3a3e');
  rect(p, 8, 0, 3, 1, '#2a2a2a');
  return p;
}

/** A small car in one of three colours, side on. */
function car(color: string, dark: string): Pixels {
  const p = surface(28, 13);
  rect(p, 2, 5, 24, 5, color);
  rect(p, 7, 2, 13, 4, color);
  rect(p, 8, 3, 4, 3, '#cfe8f0');
  rect(p, 14, 3, 5, 3, '#cfe8f0');
  rect(p, 2, 5, 24, 1, '#ffffff');
  rect(p, 2, 9, 24, 1, dark);
  rect(p, 25, 6, 2, 2, '#ffe6a0');
  rect(p, 1, 6, 2, 2, '#d04040');
  for (const cx of [7, 21]) { rect(p, cx - 2, 9, 5, 4, '#1e1e22'); rect(p, cx - 1, 10, 3, 2, '#9a9a9a'); }
  return p;
}

/** An autonomous pod: a rounded white capsule on a light strip, no wheels to see. */
function pod(): Pixels {
  const p = surface(26, 12);
  rect(p, 3, 2, 20, 8, '#eef0f4');
  rect(p, 5, 0, 16, 2, '#eef0f4');
  rect(p, 1, 4, 24, 4, '#eef0f4');
  rect(p, 6, 2, 14, 4, '#7fd8e8');
  rect(p, 6, 2, 14, 1, '#d8f4fa');
  rect(p, 3, 9, 20, 1, '#5fd6c8');
  rect(p, 1, 10, 24, 1, '#3fa3a8');
  rect(p, 2, 6, 22, 1, '#c8ccd8');
  return p;
}

/** The industrial ferry: an iron hull with a funnel and a plume. */
function steamboat(): Pixels {
  const p = surface(34, 16);
  rect(p, 3, 8, 28, 5, '#3a3a3e');
  rect(p, 1, 9, 32, 3, '#3a3a3e');
  rect(p, 5, 13, 24, 1, '#22262a');
  rect(p, 9, 14, 16, 1, '#2f3f4a');
  rect(p, 3, 8, 28, 1, '#c84a4a');
  rect(p, 8, 5, 18, 3, '#d8d0b8');
  rect(p, 14, 0, 4, 5, '#2a2a2e');
  rect(p, 13, 0, 6, 1, '#c84a4a');
  rect(p, 10, 6, 3, 1, '#1d2a30'); rect(p, 20, 6, 3, 1, '#1d2a30');
  rect(p, 19, 0, 3, 2, '#a8a8a8'); rect(p, 22, 0, 2, 1, '#c8c8c8');
  return p;
}

/** The modern ferry: a white motorboat with a low cabin and a wake. */
function motorboat(): Pixels {
  const p = surface(34, 14);
  rect(p, 3, 7, 28, 5, '#f0f0ea');
  rect(p, 1, 8, 32, 3, '#f0f0ea');
  rect(p, 3, 7, 28, 1, '#3a5a9a');
  rect(p, 5, 12, 24, 1, '#b8bcc0');
  rect(p, 8, 13, 18, 1, '#cfe8f0');
  rect(p, 9, 3, 14, 4, '#f0f0ea');
  rect(p, 10, 4, 12, 2, '#7fd8e8');
  rect(p, 24, 5, 3, 2, '#3a5a9a');
  rect(p, 0, 9, 2, 1, '#cfe8f0');
  return p;
}

/** The AI era's ferry: a hydrofoil, hull lifted clear on two struts, a light strip along it. */
function hydrofoil(): Pixels {
  const p = surface(36, 16);
  rect(p, 4, 4, 28, 5, '#eef0f4');
  rect(p, 2, 5, 32, 3, '#eef0f4');
  rect(p, 9, 1, 16, 3, '#eef0f4');
  rect(p, 10, 2, 14, 2, '#7fd8e8');
  rect(p, 4, 9, 28, 1, '#5fd6c8');
  rect(p, 8, 10, 2, 4, '#c8ccd8'); rect(p, 26, 10, 2, 4, '#c8ccd8');
  rect(p, 4, 14, 28, 1, '#b8c4d0');
  rect(p, 6, 15, 24, 1, '#cfe8f0');
  return p;
}

/** Something a citizen is carrying, held in front of them as they walk. */
function carried(kind: 'crate' | 'sack' | 'log' | 'loaf' | 'cloth' | 'fish' | 'game' | 'basket'): Pixels {
  const p = surface(12, 10);
  // Drawn small and outlined: a carried thing has to read against a body of
  // roughly the same size without swallowing it.
  switch (kind) {
    case 'crate':
      rect(p, 1, 2, 10, 7, BUILD.timber);
      rect(p, 1, 2, 10, 1, BUILD.timberLight);
      rect(p, 5, 2, 2, 7, BUILD.timberDark);
      rect(p, 1, 8, 10, 1, BUILD.timberDark);
      break;
    case 'sack':
      rect(p, 2, 3, 8, 6, '#c9b47a');
      rect(p, 3, 1, 6, 3, '#b8a469');
      rect(p, 2, 8, 8, 1, '#8f7f4a');
      break;
    case 'log':
      rect(p, 0, 4, 12, 4, FOLIAGE.trunk);
      rect(p, 0, 4, 12, 1, FOLIAGE.trunkLight);
      rect(p, 0, 7, 12, 1, FOLIAGE.trunkDark);
      break;
    case 'loaf':
      rect(p, 2, 3, 8, 5, BLOOM.wheat);
      rect(p, 3, 2, 6, 2, BLOOM.wheatDark);
      rect(p, 2, 7, 8, 1, '#8f7233');
      break;
    case 'cloth':
      rect(p, 2, 2, 8, 7, '#a86a8f');
      rect(p, 2, 4, 8, 1, '#d8a8c4');
      rect(p, 2, 7, 8, 1, '#7a4a68');
      break;
    case 'fish':
      // A brace of fish on a string.
      rect(p, 1, 3, 7, 3, '#b8c8cf');
      rect(p, 8, 2, 2, 5, '#8fa4ac');
      rect(p, 2, 4, 5, 1, '#e4eef0');
      rect(p, 3, 6, 6, 3, '#9db3bb');
      rect(p, 9, 6, 2, 3, '#7c929a');
      rect(p, 2, 3, 1, 1, '#1c2a1a');
      break;
    case 'game':
      // A hare slung over the shoulder, or the haunch of something bigger.
      rect(p, 1, 3, 9, 5, '#8c6640');
      rect(p, 2, 2, 4, 2, '#a07a4c');
      rect(p, 9, 5, 2, 3, '#6b4a2e');
      rect(p, 1, 7, 9, 1, '#5a3d24');
      rect(p, 3, 4, 2, 1, '#c8a878');
      break;
    case 'basket':
      rect(p, 2, 4, 8, 5, '#b08a4c');
      rect(p, 2, 4, 8, 1, '#c9a566');
      rect(p, 4, 1, 4, 3, '#6f4a9a');
      rect(p, 5, 2, 2, 1, '#c93a2f');
      rect(p, 2, 8, 8, 1, '#7d5f2e');
      break;
  }
  outline(p, '#1c2a1a', 0.9);
  return p;
}

/** Screen-space vignette, stretched over the viewport to settle the edges. */
function vignette(): Pixels {
  const p = surface(256, 256);
  const g = p.ctx.createRadialGradient(128, 128, 40, 128, 128, 150);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.62, 'rgba(214,224,208,1)');
  g.addColorStop(1, 'rgba(120,140,120,1)');
  p.ctx.fillStyle = g;
  p.ctx.fillRect(0, 0, 256, 256);
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

  /** How many atlas pages the art took, for the trial build's diagnostics. */
  get pages() { return this.packer?.pageCount ?? 0; }
  private packer: AtlasPacker | null = null;
  attachPacker(packer: AtlasPacker) { this.packer = packer; }

  /**
   * Make sure a building art key exists, building it into the atlas if it is
   * one of the era bodies that are not built at load. Returns false for a key
   * that names nothing.
   */
  ensureBuilding(key: string): boolean {
    if (this.buildingMeta.has(key)) return true;
    if (!this.packer) return false;
    for (const b of buildBuildingArt(key)) {
      if (this.buildingMeta.has(b.name)) continue;
      this.set(`building.${b.name}`, this.packer.addLive(b.pixels));
      this.set(`building.${b.name}.lit`, this.packer.addLive(b.lit));
      this.buildingMeta.set(b.name, { anchorY: b.anchorY, door: b.door, chimney: b.chimney, width: b.pixels.w, height: b.pixels.h });
    }
    return this.buildingMeta.has(key);
  }

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
  for (const kind of ['crate', 'sack', 'log', 'loaf', 'cloth', 'fish', 'game', 'basket'] as const) put(`fx.carry.${kind}`, carried(kind));
  put('fx.rod', fishingRod());
  put('fx.cart', cart());
  put('fx.boat', boat());
  put('fx.tram', tram());
  put('fx.bike', bike());
  put('fx.car.0', car('#c84a4a', '#7a2a2a'));
  put('fx.car.1', car('#3a5a9a', '#22365e'));
  put('fx.car.2', car('#e0c060', '#8a7430'));
  put('fx.pod', pod());
  put('fx.steamboat', steamboat());
  put('fx.motorboat', motorboat());
  put('fx.hydrofoil', hydrofoil());
  for (let f = 0; f < 4; f++) put(`fx.funnel.${f}`, funnel(f));
  put('fx.torch.0', torch(0));
  put('fx.torch.1', torch(1));
  put('fx.clash', clash());
  put('overlay.rubble', rubble());
  put('fx.bow', huntingBow());
  for (const kind of ANIMAL_KINDS) {
    put(`wild.${kind}.0`, animalFrame(kind, 0));
    put(`wild.${kind}.1`, animalFrame(kind, 1));
  }
  put('fx.vignette', vignette());
  put('fx.bird.0', bird(0));
  put('fx.bird.1', bird(1));
  put('fx.leaf.0', leafMote('#c98a3a'));
  put('fx.leaf.1', leafMote('#a85a2a'));
  put('fx.leaf.2', leafMote('#d8b24a'));
  for (const kind of ['work', 'eat', 'social', 'sleep', 'trade'] as const) {
    put(`icon.${kind}`, activityIcon(kind));
  }

  pack.finalise();
  lib.attachPacker(pack);
  cached = lib;
  return lib;
}

/** Stable per-citizen appearance derived from their cosmetic `look` seed. */
export interface Appearance {
  skin: number; hair: number; shirt: number; pants: number; shoes: number;
  /** The one bright thing on the coat: collar and belt. */
  accent: number;
  hairStyle: number; scale: number;
}

const toInt = (hex: string) => parseInt(hex.slice(1), 16);

export function appearanceFor(look: number, age: number, palettes: {
  skin: readonly string[]; hair: readonly string[]; shirt: readonly string[];
  pants: readonly string[]; shoes: readonly string[]; accent: readonly string[];
}): Appearance {
  const r = rng(look);
  return {
    skin: toInt(palettes.skin[Math.floor(r() * palettes.skin.length)]),
    hair: toInt(palettes.hair[Math.floor(r() * palettes.hair.length)]),
    shirt: toInt(palettes.shirt[Math.floor(r() * palettes.shirt.length)]),
    pants: toInt(palettes.pants[Math.floor(r() * palettes.pants.length)]),
    shoes: toInt(palettes.shoes[Math.floor(r() * palettes.shoes.length)]),
    accent: toInt(palettes.accent[Math.floor(r() * palettes.accent.length)]),
    hairStyle: Math.floor(r() * HAIR_STYLES),
    // Sized so a person reads clearly against a building at normal zoom, with
    // children visibly smaller than adults.
    scale: age < 16 ? 1.0 : 1.26 + r() * 0.16,
  };
}
