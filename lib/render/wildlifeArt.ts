/**
 * The animals, drawn.
 *
 * One quadruped drawn from a handful of measurements — how long the body is,
 * how tall the legs, the coat, what grows out of the head — covers deer, boar,
 * hare, goat, elk, antelope, gazelle and fox. The duck and the gator are their
 * own shapes. Everything faces east; the renderer mirrors it to face west.
 * Two frames each: the legs swap on the second so an animal walking reads as
 * walking rather than sliding.
 */

import { groundShadow, outline, rect, surface, type Pixels } from './pixelCanvas';
import type { AnimalKind } from '../world/wildlife';

const DARK = '#141c14';

interface Spec {
  /** Body length and depth, in pixels. */
  len: number; depth: number;
  /** Leg height and thickness. */
  legH: number; legW: number;
  coat: string; belly: string; shade: string;
  /** Head block size, and how far the snout runs on from it. */
  head: number; snout: number;
  /** How high the head sits above the back, for a raised neck. */
  neck: number;
  ears: 'tall' | 'short' | 'round';
  crown?: 'antlers' | 'tusks' | 'horns' | 'curl';
  tail: 'stub' | 'bush' | 'long';
  /** Pale patch on the rump, which is what a deer shows you as it goes. */
  rump?: string;
}

const SPECS: Record<Exclude<AnimalKind, 'duck' | 'gator'>, Spec> = {
  deer: { len: 16, depth: 7, legH: 8, legW: 2, coat: '#a5703c', belly: '#d8b688', shade: '#7b4f27', head: 5, snout: 3, neck: 5, ears: 'tall', crown: 'antlers', tail: 'stub', rump: '#e8dcc4' },
  elk: { len: 19, depth: 9, legH: 9, legW: 2, coat: '#6d4a2c', belly: '#a58a68', shade: '#4d321b', head: 6, snout: 4, neck: 5, ears: 'short', crown: 'antlers', tail: 'stub', rump: '#d6c7a8' },
  boar: { len: 15, depth: 8, legH: 4, legW: 2, coat: '#4c3a2c', belly: '#6e5a46', shade: '#2d211a', head: 6, snout: 4, neck: 0, ears: 'short', crown: 'tusks', tail: 'stub' },
  hare: { len: 8, depth: 5, legH: 3, legW: 2, coat: '#9c8460', belly: '#d9cbb0', shade: '#6e5a40', head: 4, snout: 1, neck: 2, ears: 'tall', tail: 'stub' },
  goat: { len: 12, depth: 6, legH: 6, legW: 2, coat: '#d8d2c4', belly: '#ecebe4', shade: '#9a9284', head: 4, snout: 3, neck: 3, ears: 'short', crown: 'curl', tail: 'stub' },
  antelope: { len: 14, depth: 6, legH: 8, legW: 1, coat: '#c29a5c', belly: '#efdfc0', shade: '#8d6a38', head: 4, snout: 3, neck: 6, ears: 'tall', crown: 'horns', tail: 'stub' },
  gazelle: { len: 12, depth: 5, legH: 8, legW: 1, coat: '#d2a969', belly: '#f4ead2', shade: '#9b7640', head: 4, snout: 2, neck: 6, ears: 'tall', crown: 'horns', tail: 'stub' },
  fox: { len: 11, depth: 5, legH: 4, legW: 1, coat: '#c85f2a', belly: '#f0e2cc', shade: '#8f3f18', head: 4, snout: 3, neck: 1, ears: 'tall', tail: 'bush' },
};

function quadruped(spec: Spec, frame: number): Pixels {
  const W = spec.len + spec.head + spec.snout + 8;
  const H = spec.depth + spec.legH + spec.neck + 10;
  const p = surface(W, H);
  const ground = H - 2;
  groundShadow(p, Math.round(W / 2), ground, Math.round(W / 2) - 2, 3, 0.28);

  const bodyL = 3;
  const bodyR = bodyL + spec.len;
  const bodyBottom = ground - spec.legH;
  const bodyTop = bodyBottom - spec.depth;

  // Legs: two pairs, the far pair in shadow, swapped between frames.
  const swing = frame === 0 ? 1 : -1;
  const legs: [number, number, string][] = [
    [bodyL + 2 - swing, ground, spec.shade],
    [bodyR - 4 + swing, ground, spec.shade],
    [bodyL + 3 + swing, ground, spec.coat],
    [bodyR - 3 - swing, ground, spec.coat],
  ];
  for (const [x, foot, color] of legs) {
    rect(p, x, bodyBottom - 1, spec.legW, foot - bodyBottom + 1, color);
    rect(p, x, foot - 1, spec.legW, 1, spec.shade);
  }

  // Body: a rounded block, darker below and along the back edge.
  rect(p, bodyL, bodyTop + 1, spec.len, spec.depth - 1, spec.coat);
  rect(p, bodyL + 1, bodyTop, spec.len - 2, 1, spec.coat);
  rect(p, bodyL + 1, bodyBottom - 1, spec.len - 2, 1, spec.shade);
  rect(p, bodyL + 2, bodyBottom - 2, spec.len - 4, 1, spec.belly);
  if (spec.rump) rect(p, bodyL + 1, bodyTop + 2, 2, spec.depth - 4, spec.rump);

  // Tail at the back.
  if (spec.tail === 'bush') {
    rect(p, bodyL - 3, bodyTop + 2, 4, 3, spec.coat);
    rect(p, bodyL - 3, bodyTop + 3, 2, 2, spec.belly);
  } else if (spec.tail === 'long') {
    rect(p, bodyL - 3, bodyTop + 3, 3, 1, spec.shade);
  } else {
    rect(p, bodyL - 1, bodyTop + 1, 1, 2, spec.shade);
  }

  // Neck and head at the front, raised by `neck`.
  const headX = bodyR - 1;
  const headY = bodyTop - spec.neck;
  if (spec.neck > 0) rect(p, bodyR - 3, headY + 1, 3, spec.neck + 2, spec.coat);
  rect(p, headX, headY, spec.head, spec.head, spec.coat);
  rect(p, headX + spec.head, headY + Math.max(1, spec.head - 3), spec.snout, Math.max(2, spec.head - 2), spec.coat);
  rect(p, headX + spec.head + spec.snout - 1, headY + spec.head - 2, 1, 1, DARK);
  rect(p, headX + spec.head - 2, headY + 1, 1, 1, DARK);

  // Ears.
  if (spec.ears === 'tall') {
    rect(p, headX + 1, headY - 3, 1, 3, spec.coat);
    rect(p, headX + 1, headY - 3, 1, 1, spec.belly);
  } else if (spec.ears === 'short') {
    rect(p, headX + 1, headY - 1, 2, 1, spec.shade);
  } else {
    rect(p, headX, headY - 1, 2, 1, spec.coat);
  }

  // Whatever grows out of the head.
  if (spec.crown === 'antlers') {
    const bx = headX + 2;
    for (let i = 0; i < 4; i++) rect(p, bx + i, headY - 2 - i, 1, 1, '#e6dcc4');
    for (let i = 0; i < 3; i++) rect(p, bx - i, headY - 2 - i, 1, 1, '#e6dcc4');
    rect(p, bx + 2, headY - 5, 1, 2, '#e6dcc4');
    rect(p, bx - 2, headY - 4, 1, 1, '#e6dcc4');
  } else if (spec.crown === 'tusks') {
    rect(p, headX + spec.head + spec.snout - 2, headY + spec.head, 1, 2, '#f0eadc');
  } else if (spec.crown === 'horns') {
    for (let i = 0; i < 4; i++) rect(p, headX + 2, headY - 1 - i, 1, 1, '#3a2c1c');
    rect(p, headX + 3, headY - 4, 1, 1, '#3a2c1c');
  } else if (spec.crown === 'curl') {
    rect(p, headX + 1, headY - 2, 3, 1, '#7d6a4e');
    rect(p, headX, headY - 1, 1, 1, '#7d6a4e');
  }

  outline(p, DARK, 0.8);
  return p;
}

function duck(frame: number): Pixels {
  const p = surface(14, 12);
  groundShadow(p, 7, 10, 5, 2, 0.25);
  const body = '#5a6a3c', pale = '#c8c4a4', head = '#2f6b45';
  rect(p, 2, 5, 9, 4, body);
  rect(p, 3, 8, 7, 1, '#3f4a2a');
  rect(p, 3, 6, 6, 1, pale);
  // Wing, lifted on the second frame.
  rect(p, 4, 5 - frame, 5, 2, '#46542f');
  rect(p, 9, 2, 3, 3, head);
  rect(p, 12, 3, 2, 1, '#e0a030');
  rect(p, 10, 2, 1, 1, DARK);
  rect(p, 9, 4, 1, 2, head);
  rect(p, 1, 5, 2, 1, body);
  rect(p, 5 + frame, 9, 1, 1, '#e0a030');
  rect(p, 8 - frame, 9, 1, 1, '#e0a030');
  outline(p, DARK, 0.8);
  return p;
}

function gator(frame: number): Pixels {
  const p = surface(34, 12);
  groundShadow(p, 17, 10, 15, 2, 0.25);
  const hide = '#4c5e3a', ridge = '#2e3d22', belly = '#8c9a6e';
  // Tail tapering off to the left.
  for (let i = 0; i < 10; i++) rect(p, 2 + i, 6 + Math.round((9 - i) / 4), 1, 2 + Math.floor(i / 4), hide);
  rect(p, 12, 5, 14, 4, hide);
  rect(p, 13, 8, 12, 1, belly);
  for (let i = 0; i < 6; i++) rect(p, 12 + i * 2, 4, 1, 1, ridge);
  // Jaw.
  rect(p, 26, 5, 7, 3, hide);
  rect(p, 27, 7, 6, 1, belly);
  rect(p, 28, 4, 1, 1, DARK);
  for (let i = 0; i < 3; i++) rect(p, 27 + i * 2, 7, 1, 1, '#eae6d2');
  // Legs, splayed, swapped between frames.
  rect(p, 14 + frame, 9, 2, 2, ridge);
  rect(p, 23 - frame, 9, 2, 2, ridge);
  outline(p, DARK, 0.8);
  return p;
}

/** One frame of one animal. */
export function animalFrame(kind: AnimalKind, frame: number): Pixels {
  if (kind === 'duck') return duck(frame);
  if (kind === 'gator') return gator(frame);
  return quadruped(SPECS[kind], frame);
}

/** A fishing rod, held out over the water. */
export function fishingRod(): Pixels {
  const p = surface(22, 16);
  for (let i = 0; i < 17; i++) rect(p, 2 + i, 14 - Math.round(i * 0.75), 1, 1, i > 12 ? '#a88a58' : '#6b4a2e');
  // Line down from the tip, and a float on the end of it.
  for (let i = 0; i < 9; i++) rect(p, 19, 2 + i, 1, 1, '#dfe8ea');
  rect(p, 18, 11, 3, 2, '#d9412f');
  rect(p, 18, 11, 3, 1, '#f0f0e8');
  outline(p, '#1c2a1a', 0.7);
  return p;
}

/** A hunting bow, strung. */
export function huntingBow(): Pixels {
  const p = surface(10, 20);
  for (let i = 0; i < 9; i++) {
    const bend = Math.round(Math.sin((i / 8) * Math.PI) * 4);
    rect(p, 2 + bend, 1 + i * 2, 1, 2, '#7a5230');
  }
  for (let i = 0; i < 18; i++) rect(p, 2, 1 + i, 1, 1, i % 3 === 0 ? '#e8e2d0' : '#c8c2b0');
  // An arrow nocked.
  rect(p, 1, 9, 8, 1, '#d8c8a0');
  rect(p, 8, 8, 1, 3, '#8a8f96');
  outline(p, '#1c2a1a', 0.7);
  return p;
}
