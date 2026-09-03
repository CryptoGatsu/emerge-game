/**
 * Vegetation and settlement clutter.
 *
 * Props are what turn a tile map into a place: dense trees, undergrowth,
 * flowers, fences, lanterns, market stalls, carts and resource piles. Every
 * sprite is drawn with its ground contact at the bottom centre of the canvas so
 * the renderer can anchor it at (0.5, 1) and sort it by world depth.
 */

import { BLOOM, BUILD, FOLIAGE, GROUND, WATER } from './palette';
import { groundShadow, outline, rect, rng, shade, speckle, surface, type Pixels } from './pixelCanvas';

const DARK = '#141c14';

/** A blobby mass of foliage built from overlapping discs, lit from upper left. */
function canopy(p: Pixels, cx: number, cy: number, rx: number, ry: number, seed: number, light: string, mid: string, dark: string) {
  const r = rng(seed);
  const blobs = 7 + Math.floor(r() * 4);
  const discs: [number, number, number][] = [];
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + r() * 0.7;
    const d = r() * 0.62;
    discs.push([cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d, (0.42 + r() * 0.34) * Math.min(rx, ry) + 3]);
  }
  discs.push([cx, cy, Math.min(rx, ry) * 0.92]);

  const paint = (color: string, dx: number, dy: number, scale: number) => {
    p.ctx.fillStyle = color;
    for (const [bx, by, br] of discs) {
      p.ctx.beginPath();
      p.ctx.arc(Math.round(bx + dx), Math.round(by + dy), Math.max(2, Math.round(br * scale)), 0, Math.PI * 2);
      p.ctx.fill();
    }
  };
  paint(dark, 0, 1, 1);
  paint(mid, -1, -1, 0.95);
  paint(light, -2, -3, 0.6);
  // Leaf texture so the canopy is not a smooth vector shape.
  speckle(p, seed + 71, Math.round(rx * ry * 0.5), [light, dark, mid], (x, y) => {
    for (const [bx, by, br] of discs) if ((x - bx) ** 2 + (y - by) ** 2 < br * br) return true;
    return false;
  });
}

function trunk(p: Pixels, cx: number, baseY: number, height: number, width: number, lean = 0) {
  for (let i = 0; i < height; i++) {
    const y = baseY - i;
    const x = Math.round(cx - width / 2 + (lean * i) / height);
    rect(p, x, y, width, 1, FOLIAGE.trunkDark);
    rect(p, x + 1, y, Math.max(1, width - 2), 1, FOLIAGE.trunk);
    if (i % 5 === 0) rect(p, x + 1, y, 1, 1, FOLIAGE.trunkLight);
  }
  // Root flare.
  rect(p, cx - width, baseY - 1, width * 2, 2, FOLIAGE.trunkDark);
}

type Species = 'pine' | 'oak' | 'birch' | 'palm' | 'mangrove' | 'acacia';

/**
 * A frond, drawn as a tapering arc from the crown outward and down.
 *
 * Palms are the one silhouette the blob canopy cannot fake: their read comes
 * entirely from separated leaves against the sky, so they get drawn stroke by
 * stroke instead.
 */
function frond(p: Pixels, cx: number, cy: number, angle: number, length: number, seed: number) {
  const r = rng(seed);
  const droop = 0.9 + r() * 0.5;
  for (let t = 0; t < length; t++) {
    const k = t / length;
    const x = Math.round(cx + Math.cos(angle) * t);
    const y = Math.round(cy + Math.sin(angle) * t + k * k * length * droop * 0.45);
    const width = Math.max(1, Math.round((1 - k) * 4));
    rect(p, x - (width >> 1), y, width, 1, k < 0.55 ? FOLIAGE.palm : FOLIAGE.palmDark);
    if (t % 3 === 0) rect(p, x - (width >> 1), y - 1, Math.max(1, width - 1), 1, FOLIAGE.palmLight);
  }
}

function tree(seed: number, species: Species, big: boolean): Pixels {
  const w = big ? 52 : 38;
  const h = big ? 76 : 56;
  const p = surface(w, h);
  const cx = Math.round(w / 2);
  const baseY = h - 3;
  groundShadow(p, cx, baseY, big ? 15 : 11, big ? 6 : 4, 0.32);

  if (species === 'pine') {
    trunk(p, cx, baseY, Math.round(h * 0.34), big ? 6 : 4);
    const tiers = big ? 4 : 3;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const ty = Math.round(h * 0.1 + t * h * 0.5);
      const rx = Math.round((big ? 24 : 17) * (0.5 + t * 0.62));
      canopy(p, cx, ty, rx, Math.round(rx * 0.6), seed + i * 13, FOLIAGE.pineLight, FOLIAGE.pine, FOLIAGE.pineDark);
    }
  } else if (species === 'oak') {
    trunk(p, cx, baseY, Math.round(h * 0.42), big ? 7 : 5, big ? 3 : 2);
    canopy(p, cx + 1, Math.round(h * 0.3), big ? 24 : 17, big ? 20 : 14, seed, FOLIAGE.oakLight, FOLIAGE.oak, FOLIAGE.oakDark);
  } else {
    // Birch: pale trunk with dark bark ticks.
    const th = Math.round(h * 0.52);
    for (let i = 0; i < th; i++) {
      const y = baseY - i;
      rect(p, cx - 2, y, 4, 1, '#d8d5c4');
      rect(p, cx - 2, y, 1, 1, '#a8a595');
      if (i % 7 === 3) rect(p, cx - 1, y, 2, 1, '#4a4636');
    }
    canopy(p, cx, Math.round(h * 0.26), big ? 21 : 15, big ? 17 : 12, seed, FOLIAGE.birchLight, FOLIAGE.birch, FOLIAGE.birchDark);
  }
  outline(p, DARK, 0.85);
  return p;
}

/** Trees for the desert, the swamp and the open plain. */
function exoticTree(seed: number, species: 'palm' | 'mangrove' | 'acacia', big: boolean): Pixels {
  const w = big ? 52 : 38;
  const h = big ? 76 : 56;
  const p = surface(w, h);
  const cx = Math.round(w / 2);
  const baseY = h - 3;
  const r = rng(seed);
  groundShadow(p, cx, baseY, big ? 14 : 10, big ? 6 : 4, 0.3);

  if (species === 'palm') {
    // A bare curved trunk with a crown of fronds, and nothing in between.
    const th = Math.round(h * 0.66);
    const lean = (r() < 0.5 ? -1 : 1) * (big ? 7 : 5);
    for (let i = 0; i < th; i++) {
      const y = baseY - i;
      const k = i / th;
      const x = Math.round(cx - 2 + lean * k * k);
      rect(p, x, y, 4, 1, FOLIAGE.trunkDark);
      rect(p, x + 1, y, 2, 1, FOLIAGE.trunk);
      if (i % 4 === 0) rect(p, x + 1, y, 3, 1, FOLIAGE.trunkLight);
    }
    const crownX = cx + lean;
    const crownY = baseY - th;
    const fronds = big ? 8 : 6;
    for (let i = 0; i < fronds; i++) {
      const a = Math.PI + (i / (fronds - 1)) * Math.PI;
      frond(p, crownX, crownY, a, big ? 20 : 14, seed + i * 37);
    }
    // Dates clustered under the crown.
    for (let i = 0; i < 5; i++) {
      rect(p, crownX - 3 + Math.floor(r() * 7), crownY + 2 + Math.floor(r() * 3), 1, 1, '#a86b34');
    }
  } else if (species === 'mangrove') {
    // Stilt roots first: they are most of what makes a mangrove recognisable.
    const th = Math.round(h * 0.38);
    for (let i = 0; i < (big ? 6 : 4); i++) {
      const spread = (i - (big ? 2.5 : 1.5)) * (big ? 6 : 5);
      for (let t = 0; t < (big ? 16 : 12); t++) {
        const k = t / (big ? 16 : 12);
        const x = Math.round(cx + spread * k);
        const y = Math.round(baseY - t * 0.9);
        rect(p, x, y, 2, 1, FOLIAGE.trunkDark);
      }
    }
    trunk(p, cx, baseY - (big ? 13 : 10), th, big ? 6 : 4);
    canopy(p, cx, Math.round(h * 0.3), big ? 25 : 18, big ? 15 : 11, seed,
      FOLIAGE.mangroveLight, FOLIAGE.mangrove, FOLIAGE.mangroveDark);
  } else {
    // Acacia: a bare trunk under a wide flat crown, the shape of dry country.
    trunk(p, cx, baseY, Math.round(h * 0.5), big ? 6 : 4, big ? 4 : 3);
    const crownY = Math.round(h * 0.28);
    canopy(p, cx + (big ? 2 : 1), crownY, big ? 26 : 19, big ? 9 : 7, seed,
      FOLIAGE.acaciaLight, FOLIAGE.acacia, FOLIAGE.acaciaDark);
    canopy(p, cx - (big ? 8 : 6), crownY + 4, big ? 14 : 10, big ? 6 : 5, seed + 91,
      FOLIAGE.acaciaLight, FOLIAGE.acacia, FOLIAGE.acaciaDark);
  }
  outline(p, DARK, 0.85);
  return p;
}

function deadTree(seed: number): Pixels {
  const p = surface(34, 52);
  const r = rng(seed);
  groundShadow(p, 17, 49, 9, 4, 0.28);
  trunk(p, 17, 49, 34, 5);
  for (let i = 0; i < 5; i++) {
    const y = 22 + Math.floor(r() * 14);
    const dir = r() < 0.5 ? -1 : 1;
    const len = 5 + Math.floor(r() * 7);
    for (let k = 0; k < len; k++) rect(p, 17 + dir * k, y - Math.floor(k * 0.7), 2, 1, FOLIAGE.trunkDark);
  }
  outline(p, DARK, 0.8);
  return p;
}

/** A young tree, the middle stage between a stump and a full canopy. */
function sapling(seed: number): Pixels {
  const p = surface(22, 30);
  groundShadow(p, 11, 28, 6, 2, 0.26);
  trunk(p, 11, 28, 14, 3);
  canopy(p, 11, 11, 8, 7, seed, FOLIAGE.oakLight, FOLIAGE.oak, FOLIAGE.oakDark);
  outline(p, DARK, 0.8);
  return p;
}

function bush(seed: number, berries: boolean): Pixels {
  const p = surface(30, 26);
  groundShadow(p, 15, 24, 9, 3, 0.28);
  canopy(p, 15, 14, 12, 9, seed, FOLIAGE.bushLight, FOLIAGE.bush, FOLIAGE.oakDark);
  if (berries) {
    const r = rng(seed + 99);
    for (let i = 0; i < 7; i++) rect(p, 5 + Math.floor(r() * 20), 8 + Math.floor(r() * 12), 1, 1, BLOOM.red);
  }
  outline(p, DARK, 0.8);
  return p;
}

function flowerPatch(seed: number, color: string): Pixels {
  const p = surface(24, 16);
  const r = rng(seed);
  for (let i = 0; i < 11; i++) {
    const x = 3 + Math.floor(r() * 18);
    const y = 6 + Math.floor(r() * 8);
    rect(p, x, y, 1, 4, FOLIAGE.bush);
    rect(p, x - 1, y - 1, 3, 2, color);
    rect(p, x, y - 1, 1, 1, shade(color, 0.35));
  }
  return p;
}

function rock(seed: number, big: boolean): Pixels {
  const w = big ? 34 : 20;
  const h = big ? 26 : 15;
  const p = surface(w, h);
  const r = rng(seed);
  groundShadow(p, w / 2, h - 2, w * 0.36, 3, 0.3);
  const cx = w / 2;
  const top = h - (big ? 22 : 12);
  p.ctx.fillStyle = GROUND.rock;
  p.ctx.beginPath();
  p.ctx.moveTo(cx - w * 0.36, h - 3);
  p.ctx.lineTo(cx - w * 0.22, top + 2);
  p.ctx.lineTo(cx + w * 0.05, top);
  p.ctx.lineTo(cx + w * 0.34, h - 5);
  p.ctx.lineTo(cx + w * 0.3, h - 3);
  p.ctx.closePath();
  p.ctx.fill();
  speckle(p, seed + 5, big ? 90 : 40, [GROUND.rockLight, GROUND.rockDark], (x, y) => p.ctx.isPointInPath(x + 0.5, y + 0.5));
  for (let i = 0; i < (big ? 4 : 2); i++) {
    const x = Math.floor(cx - w * 0.2 + r() * w * 0.4);
    rect(p, x, top + 3 + Math.floor(r() * 6), 1, 4, GROUND.rockDark);
  }
  rect(p, cx - w * 0.2, top + 1, w * 0.24, 2, GROUND.rockLight);
  outline(p, DARK, 0.8);
  return p;
}

function stump(seed: number): Pixels {
  const p = surface(20, 16);
  groundShadow(p, 10, 14, 7, 3, 0.3);
  rect(p, 5, 6, 10, 8, FOLIAGE.trunkDark);
  rect(p, 6, 6, 8, 7, FOLIAGE.trunk);
  p.ctx.fillStyle = FOLIAGE.trunkLight;
  p.ctx.beginPath();
  p.ctx.ellipse(10, 6, 5, 2.5, 0, 0, Math.PI * 2);
  p.ctx.fill();
  speckle(p, seed, 12, [FOLIAGE.trunk], (x, y) => (x - 10) ** 2 / 25 + (y - 6) ** 2 / 6 < 1);
  outline(p, DARK, 0.8);
  return p;
}

function reeds(seed: number): Pixels {
  const p = surface(22, 22);
  const r = rng(seed);
  for (let i = 0; i < 12; i++) {
    const x = 3 + Math.floor(r() * 16);
    const h = 8 + Math.floor(r() * 11);
    const lean = r() < 0.5 ? -1 : 1;
    for (let k = 0; k < h; k++) rect(p, x + Math.round((lean * k) / 7), 21 - k, 1, 1, k > h - 3 ? BLOOM.wheatDark : FOLIAGE.bush);
  }
  return p;
}

function lilypad(seed: number): Pixels {
  const p = surface(18, 10);
  const r = rng(seed);
  for (let i = 0; i < 3; i++) {
    const cx = 3 + Math.floor(r() * 12);
    const cy = 3 + Math.floor(r() * 5);
    p.ctx.fillStyle = FOLIAGE.bush;
    p.ctx.beginPath();
    p.ctx.ellipse(cx, cy, 3.5, 2, 0, 0, Math.PI * 2);
    p.ctx.fill();
    rect(p, cx - 1, cy - 1, 2, 1, FOLIAGE.bushLight);
  }
  rect(p, 8, 2, 1, 1, BLOOM.white);
  return p;
}

/**
 * A fence segment along one of the two isometric axes.
 *
 * Both variants used to draw the same line. `nw` mirrored the drawing order —
 * right to left instead of left to right — but mirrored the rise with it, so it
 * came out at the same slope as `ne` rather than the opposite one. A run of
 * alternating segments was therefore not two axes but one, repeated, while the
 * row of positions marched down the other axis: every post pointed across the
 * line it was standing in. That is the scattered fencing.
 *
 * `ne` rises to the right, which is the ground direction of increasing world y.
 * `nw` falls to the right, which is increasing world x. Both cover a full 32
 * pixels of screen width, so consecutive segments meet post to post.
 */
function fence(axis: 'ne' | 'nw'): Pixels {
  const p = surface(34, 26);
  const rise = axis === 'ne' ? -1 : 1;
  const y0 = axis === 'ne' ? 20 : 4;
  const railAt = (i: number) => y0 + rise * (i * 0.5);
  for (let i = 0; i <= 32; i += 8) {
    const yy = Math.round(railAt(i));
    rect(p, 1 + i, yy - 9, 2, 11, FOLIAGE.trunkDark);
    rect(p, 1 + i, yy - 9, 1, 11, FOLIAGE.trunk);
  }
  for (const off of [3, 7]) {
    for (let i = 0; i <= 32; i++) {
      rect(p, 1 + i, Math.round(railAt(i) - 9 + off), 1, 2, FOLIAGE.trunk);
    }
  }
  outline(p, DARK, 0.7);
  return p;
}

function lantern(lit: boolean): Pixels {
  const p = surface(16, 34);
  groundShadow(p, 8, 32, 5, 2, 0.3);
  rect(p, 7, 12, 2, 20, BUILD.metal);
  rect(p, 6, 30, 4, 2, BUILD.metal);
  rect(p, 4, 5, 8, 9, BUILD.metalLight);
  rect(p, 5, 6, 6, 7, lit ? BUILD.glassLit : BUILD.glassDark);
  if (lit) rect(p, 6, 7, 4, 5, BUILD.glassLitCore);
  rect(p, 3, 3, 10, 2, BUILD.metal);
  rect(p, 7, 1, 2, 2, BUILD.metal);
  outline(p, DARK, 0.85);
  return p;
}

function bench(): Pixels {
  const p = surface(30, 20);
  groundShadow(p, 15, 18, 11, 3, 0.28);
  rect(p, 4, 12, 22, 3, FOLIAGE.trunk);
  rect(p, 4, 12, 22, 1, FOLIAGE.trunkLight);
  rect(p, 5, 15, 2, 4, FOLIAGE.trunkDark);
  rect(p, 23, 15, 2, 4, FOLIAGE.trunkDark);
  rect(p, 4, 7, 22, 2, FOLIAGE.trunk);
  rect(p, 5, 8, 2, 5, FOLIAGE.trunkDark);
  rect(p, 23, 8, 2, 5, FOLIAGE.trunkDark);
  outline(p, DARK, 0.8);
  return p;
}

function stall(seed: number, awning: string): Pixels {
  const p = surface(40, 40);
  groundShadow(p, 20, 38, 14, 4, 0.3);
  // Counter.
  rect(p, 6, 24, 28, 10, BUILD.timber);
  rect(p, 6, 24, 28, 2, BUILD.timberLight);
  rect(p, 6, 32, 28, 2, BUILD.timberDark);
  // Posts and striped awning.
  rect(p, 5, 10, 2, 24, BUILD.timberDark);
  rect(p, 33, 10, 2, 24, BUILD.timberDark);
  for (let i = 0; i < 32; i++) {
    const x = 4 + i;
    const y = 8 + Math.round(Math.abs(i - 16) * 0.16);
    rect(p, x, y, 1, 6, i % 6 < 3 ? awning : BUILD.plasterLight);
  }
  rect(p, 4, 14, 32, 1, shade(awning, -0.35));
  // Goods on the counter.
  const r = rng(seed);
  const goods = [BLOOM.wheat, BLOOM.red, FOLIAGE.bushLight, BUILD.plasterLight, BLOOM.yellow];
  for (let i = 0; i < 7; i++) {
    const x = 8 + Math.floor(r() * 24);
    const w = 2 + Math.floor(r() * 3);
    rect(p, x, 21, w, 3, goods[Math.floor(r() * goods.length)]);
  }
  outline(p, DARK, 0.85);
  return p;
}

function crates(seed: number): Pixels {
  const p = surface(30, 26);
  const r = rng(seed);
  groundShadow(p, 15, 24, 11, 3, 0.3);
  const box = (x: number, y: number, s: number) => {
    rect(p, x, y, s, s, BUILD.timber);
    rect(p, x, y, s, 1, BUILD.timberLight);
    rect(p, x, y + s - 1, s, 1, BUILD.timberDark);
    rect(p, x, y, 1, s, BUILD.timberLight);
    rect(p, x + Math.floor(s / 2) - 1, y, 2, s, BUILD.timberDark);
  };
  box(4, 12, 11);
  box(15, 14, 9);
  box(8, 4, 9);
  void r;
  outline(p, DARK, 0.85);
  return p;
}

function barrel(): Pixels {
  const p = surface(16, 22);
  groundShadow(p, 8, 20, 6, 2, 0.3);
  rect(p, 3, 4, 10, 16, BUILD.timber);
  rect(p, 4, 4, 3, 16, BUILD.timberLight);
  rect(p, 3, 7, 10, 2, BUILD.metal);
  rect(p, 3, 15, 10, 2, BUILD.metal);
  p.ctx.fillStyle = BUILD.timberLight;
  p.ctx.beginPath();
  p.ctx.ellipse(8, 4, 5, 2, 0, 0, Math.PI * 2);
  p.ctx.fill();
  outline(p, DARK, 0.85);
  return p;
}

function woodpile(seed: number): Pixels {
  const p = surface(30, 20);
  const r = rng(seed);
  groundShadow(p, 15, 18, 12, 3, 0.3);
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 6 - row; i++) {
      const x = 4 + row * 2 + i * 4;
      const y = 15 - row * 4;
      rect(p, x, y, 4, 4, FOLIAGE.trunkDark);
      p.ctx.fillStyle = FOLIAGE.trunkLight;
      p.ctx.beginPath();
      p.ctx.ellipse(x + 1, y + 2, 1.5, 2, 0, 0, Math.PI * 2);
      p.ctx.fill();
      if (r() < 0.3) rect(p, x + 2, y + 1, 1, 2, FOLIAGE.trunk);
    }
  }
  outline(p, DARK, 0.85);
  return p;
}

function haybale(): Pixels {
  const p = surface(26, 20);
  groundShadow(p, 13, 18, 10, 3, 0.3);
  rect(p, 3, 6, 20, 12, BLOOM.wheatDark);
  rect(p, 3, 6, 20, 3, BLOOM.wheat);
  for (let i = 0; i < 20; i += 3) rect(p, 3 + i, 6, 1, 12, shade(BLOOM.wheatDark, -0.2));
  rect(p, 3, 10, 20, 1, BUILD.timberDark);
  rect(p, 3, 15, 20, 1, BUILD.timberDark);
  outline(p, DARK, 0.85);
  return p;
}

function well(): Pixels {
  const p = surface(34, 44);
  groundShadow(p, 17, 42, 13, 4, 0.3);
  // Stone ring.
  p.ctx.fillStyle = BUILD.stoneWall;
  p.ctx.beginPath();
  p.ctx.ellipse(17, 32, 12, 6, 0, 0, Math.PI * 2);
  p.ctx.fill();
  rect(p, 5, 26, 24, 7, BUILD.stoneWall);
  p.ctx.fillStyle = '#12252c';
  p.ctx.beginPath();
  p.ctx.ellipse(17, 26, 10, 5, 0, 0, Math.PI * 2);
  p.ctx.fill();
  p.ctx.fillStyle = WATER.deep;
  p.ctx.beginPath();
  p.ctx.ellipse(17, 27, 7, 3, 0, 0, Math.PI * 2);
  p.ctx.fill();
  speckle(p, 12, 90, [BUILD.stoneWallLight, BUILD.stoneWallDark], (x, y) => y > 25 && y < 36 && x > 4 && x < 30);
  // Roof and posts.
  rect(p, 6, 8, 2, 20, BUILD.timberDark);
  rect(p, 26, 8, 2, 20, BUILD.timberDark);
  for (let i = 0; i < 14; i++) {
    rect(p, 3 + i, 8 - Math.round(i * 0.45), 2, 4, BUILD.roofThatch);
    rect(p, 31 - i, 8 - Math.round(i * 0.45), 2, 4, BUILD.roofThatchDark);
  }
  rect(p, 16, 10, 2, 8, BUILD.timber);
  rect(p, 14, 17, 6, 5, BUILD.timber);
  outline(p, DARK, 0.85);
  return p;
}

function signpost(): Pixels {
  const p = surface(22, 30);
  groundShadow(p, 11, 28, 5, 2, 0.3);
  rect(p, 10, 6, 2, 22, FOLIAGE.trunkDark);
  rect(p, 3, 8, 16, 6, FOLIAGE.trunk);
  rect(p, 3, 8, 16, 1, FOLIAGE.trunkLight);
  rect(p, 5, 10, 10, 1, BUILD.plasterLight);
  rect(p, 5, 12, 7, 1, BUILD.plasterLight);
  outline(p, DARK, 0.85);
  return p;
}

function campfire(frame: number): Pixels {
  const p = surface(24, 26);
  groundShadow(p, 12, 24, 9, 3, 0.3);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    rect(p, 12 + Math.cos(a) * 7 - 1, 20 + Math.sin(a) * 3, 3, 2, GROUND.rockDark);
  }
  rect(p, 6, 17, 12, 3, FOLIAGE.trunkDark);
  rect(p, 8, 15, 8, 3, FOLIAGE.trunk);
  const h = 8 + (frame % 2) * 2;
  const w = 7 - (frame % 2);
  p.ctx.fillStyle = '#e2622c';
  p.ctx.beginPath();
  p.ctx.moveTo(12, 16 - h);
  p.ctx.lineTo(12 + w / 2, 17);
  p.ctx.lineTo(12 - w / 2, 17);
  p.ctx.closePath();
  p.ctx.fill();
  p.ctx.fillStyle = '#f4b23c';
  p.ctx.beginPath();
  p.ctx.moveTo(12, 18 - h * 0.66);
  p.ctx.lineTo(12 + w / 3, 17);
  p.ctx.lineTo(12 - w / 3, 17);
  p.ctx.closePath();
  p.ctx.fill();
  rect(p, 11, 14, 2, 2, '#fff0c0');
  return p;
}

function planter(seed: number): Pixels {
  const p = surface(22, 20);
  groundShadow(p, 11, 18, 8, 3, 0.28);
  rect(p, 3, 10, 16, 8, BUILD.timber);
  rect(p, 3, 10, 16, 1, BUILD.timberLight);
  rect(p, 3, 17, 16, 1, BUILD.timberDark);
  rect(p, 4, 9, 14, 2, GROUND.soilDark);
  const r = rng(seed);
  const petals = [BLOOM.white, BLOOM.yellow, BLOOM.pink, BLOOM.violet];
  for (let i = 0; i < 8; i++) {
    const x = 4 + Math.floor(r() * 14);
    const h = 3 + Math.floor(r() * 4);
    rect(p, x, 9 - h, 1, h, FOLIAGE.bush);
    rect(p, x - 1, 8 - h, 3, 2, petals[Math.floor(r() * petals.length)]);
  }
  outline(p, DARK, 0.8);
  return p;
}

export interface PropArt { name: string; pixels: Pixels }

export function buildProps(): PropArt[] {
  const out: PropArt[] = [];
  const add = (name: string, pixels: Pixels) => out.push({ name, pixels });

  for (const species of ['pine', 'oak', 'birch'] as const) {
    add(`prop.tree.${species}.big`, tree(species.length * 911 + 7, species, true));
    add(`prop.tree.${species}.small`, tree(species.length * 733 + 19, species, false));
  }
  for (const species of ['palm', 'mangrove', 'acacia'] as const) {
    add(`prop.tree.${species}.big`, exoticTree(species.length * 877 + 13, species, true));
    add(`prop.tree.${species}.small`, exoticTree(species.length * 641 + 23, species, false));
  }
  add('prop.tree.dead', deadTree(555));
  add('prop.sapling', sapling(560));
  add('prop.bush.0', bush(610, false));
  add('prop.bush.1', bush(611, true));
  add('prop.bush.2', bush(612, false));
  add('prop.flowers.0', flowerPatch(700, BLOOM.white));
  add('prop.flowers.1', flowerPatch(701, BLOOM.yellow));
  add('prop.flowers.2', flowerPatch(702, BLOOM.pink));
  add('prop.flowers.3', flowerPatch(703, BLOOM.violet));
  add('prop.rock.big', rock(800, true));
  add('prop.rock.small', rock(801, false));
  add('prop.stump', stump(810));
  add('prop.reeds', reeds(820));
  add('prop.lilypad', lilypad(830));
  add('prop.fence.ne', fence('ne'));
  add('prop.fence.nw', fence('nw'));
  add('prop.lantern', lantern(false));
  add('prop.lantern.lit', lantern(true));
  add('prop.bench', bench());
  add('prop.stall.0', stall(900, '#b6614a'));
  add('prop.stall.1', stall(901, '#3f6b46'));
  add('prop.stall.2', stall(902, '#4a7f8f'));
  add('prop.crates', crates(910));
  add('prop.barrel', barrel());
  add('prop.woodpile', woodpile(920));
  add('prop.haybale', haybale());
  add('prop.well', well());
  add('prop.signpost', signpost());
  add('prop.campfire.0', campfire(0));
  add('prop.campfire.1', campfire(1));
  add('prop.planter', planter(930));
  return out;
}
