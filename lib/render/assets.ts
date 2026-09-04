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

/** A filled disc, for wheels and hulls. */
function disc(p: Pixels, cx: number, cy: number, r: number, color: string) {
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y));
    rect(p, cx - w, cy + y, w * 2 + 1, 1, color);
  }
}
/** A spoked wheel: iron tyre, pale rim, hub, four spokes. */
function wheel(p: Pixels, cx: number, cy: number, r: number, tyre = '#2a2a2e', rim = '#7a828c') {
  disc(p, cx, cy, r, tyre);
  disc(p, cx, cy, r - 2, rim);
  disc(p, cx, cy, r - 3, '#1e1e22');
  rect(p, cx - r + 3, cy, r * 2 - 5, 1, rim); rect(p, cx, cy - r + 3, 1, r * 2 - 5, rim);
  disc(p, cx, cy, 1, '#c8c8c0');
}

/**
 * The cart a Stables puts under a working adult, and the horse that pulls it.
 * Side on, facing right: the rider sits on the box seat over the big wheel,
 * the horse in harness ahead. The near wheel and the side board come in front
 * of the rider on the split sprite.
 */
function cart(): Pixels {
  const p = surface(72, 28);
  // The horse: a bay, walking.
  rect(p, 44, 8, 22, 11, '#6b4a2e'); rect(p, 44, 8, 22, 2, '#7c5a3a');
  rect(p, 62, 3, 8, 9, '#6b4a2e'); rect(p, 66, 1, 4, 6, '#6b4a2e'); rect(p, 67, 0, 2, 2, '#4a3220');
  rect(p, 60, 2, 5, 8, '#3a2414');
  rect(p, 42, 7, 3, 9, '#3a2414');
  for (const [x, dy] of [[46, 0], [51, 2], [57, 1], [62, 0]] as [number, number][]) { rect(p, x, 19, 3, 6 - dy, '#4a3220'); rect(p, x, 24 - dy, 3, 2, '#1e1e22'); }
  rect(p, 68, 5, 1, 1, '#1e1e22'); rect(p, 63, 12, 3, 2, '#8a6a4e');
  rect(p, 44, 14, 22, 1, '#2a2a2e'); rect(p, 40, 12, 6, 1, '#2a2a2e');
  // The cart: shafts, bed, side board, seat, wheels.
  rect(p, 34, 13, 12, 2, BUILD.timberDark);
  rect(p, 6, 10, 30, 8, BUILD.timber); rect(p, 6, 10, 30, 1, BUILD.timberLight); rect(p, 6, 17, 30, 1, BUILD.timberDark);
  rect(p, 8, 12, 26, 1, BUILD.timberDark); rect(p, 8, 15, 26, 1, BUILD.timberDark);
  rect(p, 24, 6, 10, 4, '#8a5a3a'); rect(p, 24, 6, 10, 1, '#a87a52');
  rect(p, 8, 7, 12, 3, '#c9b47a'); rect(p, 10, 5, 8, 2, '#b8a469');
  wheel(p, 14, 20, 7); wheel(p, 32, 21, 5);
  return p;
}

/** The industrial era's rail trolley: an open-sided green tram on iron wheels, a chimney up front. */
function tram(): Pixels {
  const p = surface(56, 28);
  rect(p, 4, 4, 46, 3, '#1e3a26'); rect(p, 2, 6, 50, 1, '#2f5a3a');
  for (const x of [6, 22, 38, 46]) rect(p, x, 7, 2, 11, '#c9a552');
  rect(p, 4, 18, 46, 5, '#2f5a3a'); rect(p, 4, 18, 46, 1, '#5a8a5a'); rect(p, 4, 22, 46, 1, '#1e3a26');
  rect(p, 8, 20, 38, 1, '#c9a552');
  rect(p, 50, 8, 4, 10, '#3a3a3e'); rect(p, 49, 6, 6, 2, '#55555a');
  rect(p, 52, 0, 3, 8, '#3a3a3e'); rect(p, 51, 0, 5, 1, '#55555a');
  rect(p, 0, 23, 56, 1, '#55555a');
  wheel(p, 12, 24, 4); wheel(p, 26, 24, 4); wheel(p, 40, 24, 4);
  rect(p, 2, 12, 2, 3, '#ffd07a');
  return p;
}

/** A bicycle, side on: two big wheels, a frame, saddle and handlebars, pedals. */
function bike(): Pixels {
  const p = surface(40, 22);
  wheel(p, 9, 14, 7, '#2a2a2e', '#a8a8a0'); wheel(p, 31, 14, 7, '#2a2a2e', '#a8a8a0');
  // The frame: down tube, seat tube, top tube, chain stay, in red.
  for (let i = 0; i < 12; i++) rect(p, 12 + i, 14 - i, 2, 1, '#c84a4a');
  for (let i = 0; i < 10; i++) rect(p, 24 + i, 4 + i, 2, 1, '#c84a4a');
  rect(p, 14, 3, 12, 2, '#c84a4a');
  rect(p, 20, 5, 2, 9, '#c84a4a');
  rect(p, 9, 14, 12, 1, '#c84a4a');
  rect(p, 17, 1, 8, 2, '#2a2a2e');
  rect(p, 30, 0, 6, 2, '#2a2a2e'); rect(p, 32, 2, 2, 5, '#3a3a3e');
  disc(p, 20, 14, 2, '#3a3a3e'); rect(p, 17, 15, 3, 2, '#1e1e22'); rect(p, 21, 11, 3, 2, '#1e1e22');
  return p;
}

/** A small car in one of three colours, side on, the near door on the front layer. */
function car(color: string, dark: string): Pixels {
  const p = surface(52, 24);
  rect(p, 2, 10, 48, 9, color);
  rect(p, 10, 4, 30, 7, color); rect(p, 12, 3, 26, 1, color);
  rect(p, 13, 5, 10, 5, '#cfe8f0'); rect(p, 26, 5, 12, 5, '#cfe8f0');
  rect(p, 13, 5, 10, 1, '#f0fbff'); rect(p, 26, 5, 12, 1, '#f0fbff');
  rect(p, 2, 10, 48, 1, '#ffffff'); rect(p, 2, 18, 48, 1, dark);
  rect(p, 24, 11, 1, 7, dark); rect(p, 30, 13, 4, 1, dark);
  rect(p, 47, 12, 3, 3, '#ffe6a0'); rect(p, 1, 12, 3, 3, '#d04040');
  rect(p, 2, 19, 48, 1, '#2a2a2e');
  wheel(p, 12, 19, 5, '#1e1e22', '#9a9a9a'); wheel(p, 39, 19, 5, '#1e1e22', '#9a9a9a');
  return p;
}

/** An autonomous pod: a white capsule with a wide glass canopy, riding a light strip. No wheels to see. */
function pod(): Pixels {
  const p = surface(50, 24);
  rect(p, 6, 4, 38, 15, '#eef0f4'); rect(p, 10, 1, 30, 3, '#eef0f4'); rect(p, 2, 8, 46, 8, '#eef0f4');
  rect(p, 12, 3, 26, 8, '#7fd8e8'); rect(p, 14, 2, 22, 1, '#d8f4fa'); rect(p, 12, 3, 26, 1, '#bff0f8');
  rect(p, 4, 16, 42, 2, '#c8ccd8');
  rect(p, 6, 19, 38, 1, '#5fd6c8'); rect(p, 3, 20, 44, 1, '#3fa3a8'); rect(p, 8, 21, 34, 1, '#8fe3dc');
  rect(p, 44, 10, 3, 2, '#ffe6a0'); rect(p, 3, 10, 3, 2, '#ff6060');
  return p;
}

/** The ferry's boat: a clinker hull with a pale gunwale, a thwart to sit on, a dark waterline. */
function boat(): Pixels {
  const p = surface(56, 22);
  rect(p, 6, 6, 44, 9, '#7a4e2a'); rect(p, 3, 8, 50, 5, '#7a4e2a');
  rect(p, 8, 15, 40, 2, '#4a2e18'); rect(p, 12, 17, 32, 1, '#2f3f4a');
  rect(p, 6, 6, 44, 1, '#c99a5e'); rect(p, 1, 8, 4, 2, '#c99a5e'); rect(p, 51, 8, 4, 2, '#c99a5e');
  rect(p, 10, 9, 36, 1, '#5e3a20'); rect(p, 14, 12, 28, 1, '#5e3a20');
  rect(p, 20, 3, 16, 3, '#a8843a');
  rect(p, 0, 18, 56, 1, '#cfe8f0');
  return p;
}

/** The industrial ferry: an iron hull, a paddle wheel, a funnel with a plume. */
function steamboat(): Pixels {
  const p = surface(60, 28);
  rect(p, 6, 14, 48, 7, '#3a3a3e'); rect(p, 2, 16, 56, 4, '#3a3a3e');
  rect(p, 10, 21, 40, 2, '#22262a'); rect(p, 16, 23, 28, 1, '#2f3f4a');
  rect(p, 6, 14, 48, 1, '#c84a4a');
  rect(p, 14, 9, 30, 5, '#d8d0b8'); rect(p, 14, 9, 30, 1, '#ece8dc');
  for (const x of [17, 24, 31, 38]) rect(p, x, 10, 3, 3, '#1d2a30');
  rect(p, 26, 0, 6, 9, '#2a2a2e'); rect(p, 25, 0, 8, 2, '#c84a4a');
  rect(p, 33, 0, 5, 3, '#a8a8a8'); rect(p, 38, 0, 4, 2, '#c8c8c8');
  disc(p, 50, 18, 6, '#c84a4a'); disc(p, 50, 18, 4, '#3a3a3e'); rect(p, 44, 18, 12, 1, '#c84a4a'); rect(p, 50, 12, 1, 12, '#c84a4a');
  rect(p, 0, 24, 60, 1, '#cfe8f0');
  return p;
}

/** The modern ferry: a white motorboat with a low cabin, a rail, and a wake. */
function motorboat(): Pixels {
  const p = surface(56, 24);
  rect(p, 6, 12, 44, 7, '#f0f0ea'); rect(p, 2, 14, 52, 4, '#f0f0ea');
  rect(p, 6, 12, 44, 1, '#3a5a9a'); rect(p, 10, 19, 36, 2, '#b8bcc0'); rect(p, 14, 21, 28, 1, '#cfe8f0');
  rect(p, 16, 5, 22, 7, '#f0f0ea'); rect(p, 18, 6, 18, 4, '#7fd8e8'); rect(p, 18, 6, 18, 1, '#d8f4fa');
  rect(p, 40, 8, 6, 4, '#3a5a9a'); rect(p, 6, 9, 10, 1, '#b8bcc0'); for (const x of [7, 11, 15]) rect(p, x, 9, 1, 3, '#b8bcc0');
  rect(p, 0, 16, 3, 1, '#cfe8f0'); rect(p, 0, 22, 56, 1, '#cfe8f0');
  return p;
}

/** The AI era's ferry: a hydrofoil, hull lifted on two struts, a light strip along the side. */
function hydrofoil(): Pixels {
  const p = surface(60, 26);
  rect(p, 6, 8, 48, 8, '#eef0f4'); rect(p, 2, 10, 56, 4, '#eef0f4'); rect(p, 14, 3, 30, 5, '#eef0f4');
  rect(p, 16, 4, 26, 3, '#7fd8e8'); rect(p, 16, 4, 26, 1, '#d8f4fa');
  rect(p, 6, 16, 48, 1, '#5fd6c8'); rect(p, 8, 17, 44, 1, '#c8ccd8');
  rect(p, 14, 18, 3, 6, '#c8ccd8'); rect(p, 43, 18, 3, 6, '#c8ccd8');
  rect(p, 6, 24, 48, 1, '#b8c4d0'); rect(p, 10, 25, 40, 1, '#cfe8f0');
  return p;
}

/** The rows of a sprite from `cut` down, as their own sprite: the part of a vehicle in front of its rider. */
function frontOf(pixels: Pixels, cut: number): Pixels {
  const p = surface(pixels.w, pixels.h);
  p.ctx.drawImage(pixels.canvas, 0, cut, pixels.w, pixels.h - cut, 0, cut, pixels.w, pixels.h - cut);
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
  // Every vehicle in two layers: the whole thing behind the rider, and the
  // part below the cut in front of them, so a person sits in a car or a
  // boat and astride a bike rather than standing on top of it.
  const vehicle = (name: string, pixels: Pixels, cut: number) => { put(name, pixels); put(`${name}.front`, frontOf(pixels, cut)); };
  vehicle('fx.cart', cart(), 10);
  vehicle('fx.boat', boat(), 8);
  vehicle('fx.tram', tram(), 17);
  vehicle('fx.bike', bike(), 8);
  vehicle('fx.car.0', car('#c84a4a', '#7a2a2a'), 10);
  vehicle('fx.car.1', car('#3a5a9a', '#22365e'), 10);
  vehicle('fx.car.2', car('#e0c060', '#8a7430'), 10);
  vehicle('fx.pod', pod(), 11);
  vehicle('fx.steamboat', steamboat(), 14);
  vehicle('fx.motorboat', motorboat(), 12);
  vehicle('fx.hydrofoil', hydrofoil(), 8);
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
