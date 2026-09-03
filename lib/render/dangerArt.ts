/**
 * The pictures of trouble: a funnel cloud, a torch, a scuffle, rubble.
 *
 * Drawn once at boot like every other sprite, in the same pixel hand, so a
 * tornado over the settlement reads as part of the world and not a special
 * effect laid over it.
 */

import { glow, outline, rect, surface, type Pixels } from './pixelCanvas';

const DARK = '#141c14';

/** One frame of the funnel: a grey cone, banded so it reads as turning. */
export function funnel(frame: number): Pixels {
  const W = 56, H = 96;
  const p = surface(W, H);
  const shades = ['#5f666b', '#7c8388', '#98a0a5', '#7c8388'];
  for (let y = 0; y < 84; y++) {
    const t = y / 84;
    // Wide at the top, a thread at the ground, with a wobble down its length.
    const half = 4 + (1 - t) * (1 - t) * 22 + Math.sin(t * 9 + frame * 1.6) * 2;
    const cx = W / 2 + Math.sin(t * 5.5 + frame * 0.8) * 3 * t;
    const band = Math.floor((y / 5 + frame) % shades.length);
    rect(p, Math.round(cx - half), y, Math.round(half * 2), 1, shades[band]);
    rect(p, Math.round(cx - half), y, 2, 1, '#4a5054');
    rect(p, Math.round(cx + half - 2), y, 2, 1, '#aeb5ba');
  }
  // Dust kicked up at the foot.
  glow(p, W / 2, 88, 22, '#b9a98a', 0.55);
  glow(p, W / 2 - 10 + frame * 4, 90, 12, '#d0c3a6', 0.4);
  outline(p, '#2a2f33', 0.5);
  return p;
}

/** A torch, held by somebody who means harm with it. */
export function torch(frame: number): Pixels {
  const p = surface(10, 16);
  rect(p, 4, 7, 2, 9, '#5a3d24');
  rect(p, 3, 6, 4, 2, '#8a5a34');
  const lift = frame % 2;
  rect(p, 2, 2 + lift, 6, 5 - lift, '#e0702a');
  rect(p, 3, 1 + lift, 4, 4, '#f2b13a');
  rect(p, 4, 0 + lift, 2, 3, '#fff0a8');
  outline(p, DARK, 0.7);
  return p;
}

/** The burst of a scuffle: a few spikes and a puff. */
export function clash(): Pixels {
  const p = surface(26, 22);
  glow(p, 13, 11, 10, '#f4e9c8', 0.5);
  const spikes: [number, number, number, number][] = [[13, 2, 13, 8], [3, 6, 8, 9], [23, 6, 18, 9], [4, 18, 9, 14], [22, 18, 17, 14], [13, 20, 13, 15]];
  for (const [x0, y0, x1, y1] of spikes) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      rect(p, Math.round(x0 + (x1 - x0) * (i / steps)), Math.round(y0 + (y1 - y0) * (i / steps)), 1, 1, '#f7d95a');
    }
  }
  rect(p, 11, 8, 4, 6, '#fff6d8');
  return p;
}

/** What is left of a building: a heap of stone and a broken beam. */
export function rubble(): Pixels {
  const p = surface(64, 30);
  const stones = ['#7d7972', '#9a958c', '#5f5b55', '#b0aba1'];
  let s = 7;
  const r = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216; };
  for (let i = 0; i < 26; i++) {
    const w = 4 + Math.floor(r() * 8), h = 3 + Math.floor(r() * 4);
    const x = 4 + Math.floor(r() * 52), y = 10 + Math.floor(r() * 14);
    rect(p, x, y, w, h, stones[i % stones.length]);
    rect(p, x, y, w, 1, '#c4bfb5');
  }
  // A charred beam across it.
  for (let i = 0; i < 30; i++) rect(p, 14 + i, 14 - Math.round(i * 0.25), 1, 3, '#3a2e22');
  rect(p, 40, 6, 3, 10, '#4a3a2a');
  outline(p, DARK, 0.8);
  return p;
}
