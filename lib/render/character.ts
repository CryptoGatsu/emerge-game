/**
 * Citizen character sprites.
 *
 * Characters are built as a set of greyscale part masks — legs, boots, body,
 * trim, hands, head, hair, hat, tool — that the renderer tints per citizen.
 * Shading is baked into the mask as darker greys, so a multiply tint yields a
 * properly shaded pixel character rather than a flat silhouette. One shared
 * mask set therefore dresses an entire population, and a citizen's appearance
 * is just a palette derived from their `look` seed.
 *
 * The proportions are the reference's: a big round head on a short body, so a
 * person reads as a person from across the whole settlement, with the face
 * and the hair doing most of the work of telling one from another. Clothes
 * are dark and carry one bright band of trim — collar and belt — which is the
 * second thing the eye picks up after the hair.
 *
 * Directions `s`, `n` and `e` are drawn; `w` is `e` mirrored by the renderer.
 * Animation frames are addressed by state, and the renderer advances them on its
 * own clock so walking never depends on the simulation tick rate.
 */

import { outline, rect, surface, type Pixels } from './pixelCanvas';

export const CHAR_W = 24;
export const CHAR_H = 32;
export const CHAR_GROUND = 30;

export type Dir = 's' | 'n' | 'e';
export type CharState = 'walk' | 'idle' | 'work' | 'sit' | 'sleep';
export type LayerName = 'outline' | 'legs' | 'boots' | 'body' | 'trim' | 'hands' | 'head' | 'hair' | 'hat' | 'tool';

export const LAYER_ORDER: LayerName[] = ['outline', 'legs', 'boots', 'body', 'trim', 'hands', 'head', 'hair', 'hat', 'tool'];

/** Frames per animation state. Walk is a four-step cycle; work is a three-beat swing. */
export const STATE_FRAMES: Record<CharState, number> = { walk: 4, idle: 2, work: 3, sit: 1, sleep: 1 };

// Mask greys. Multiplying a colour by these gives highlight / base / shadow / line.
const HI = '#fbfbfb';
const BASE = '#dedede';
const MID = '#b4b4b4';
const LOW = '#7e7e7e';
const LINE = '#2a2a2a';

interface Pose {
  /** Horizontal swing of each leg, in pixels. */
  leg: [number, number];
  /** Vertical lift of each leg. */
  legLift: [number, number];
  /** Horizontal swing of each arm. */
  arm: [number, number];
  /** Vertical swing of each arm; negative raises the hand. */
  armLift: [number, number];
  /** Whole-body vertical bob. */
  bob: number;
  /** Forward lean, applied to the upper body only. */
  lean: number;
  /** How far the body sinks, for sitting and sleeping. */
  crouch: number;
}

function poseFor(state: CharState, frame: number): Pose {
  const flat: Pose = { leg: [0, 0], legLift: [0, 0], arm: [0, 0], armLift: [0, 0], bob: 0, lean: 0, crouch: 0 };
  switch (state) {
    case 'walk': {
      // Contact, pass, contact, pass — the two pass frames carry the body bob.
      const swing: [number, number][] = [[2, -2], [0, 0], [-2, 2], [0, 0]];
      const lift: [number, number][] = [[0, 0], [0, -1], [0, 0], [-1, 0]];
      const f = frame % 4;
      return { ...flat, leg: swing[f], legLift: lift[f], arm: [-swing[f][0], -swing[f][1]], bob: f % 2 === 1 ? -1 : 0 };
    }
    case 'idle':
      return { ...flat, bob: frame % 2 === 0 ? 0 : -1, armLift: frame % 2 === 0 ? [0, 0] : [-1, -1] };
    case 'work': {
      // Raise, strike, follow through.
      const lifts: [number, number][] = [[-5, -5], [1, 1], [-2, -2]];
      return { ...flat, armLift: lifts[frame % 3], lean: 1, bob: frame % 3 === 1 ? 1 : 0 };
    }
    case 'sit':
      return { ...flat, crouch: 4, leg: [3, 3], legLift: [-3, -3] };
    case 'sleep':
      return { ...flat, crouch: 7, leg: [4, 4], legLift: [-4, -4], lean: 2, armLift: [2, 2] };
  }
}

/**
 * Body metrics per direction. `e` is a narrower profile view.
 *
 * Roughly two and a half heads tall: the head is a third of the figure, the
 * torso is short and the legs are shorter still. That is what makes a crowd
 * read as characters rather than as stick figures at map scale.
 */
function metrics(dir: Dir) {
  const front = dir !== 'e';
  return {
    torsoX: front ? 8 : 9,
    torsoW: front ? 8 : 6,
    torsoTop: 14,
    torsoH: 7,
    headX: front ? 7 : 8,
    headW: front ? 10 : 9,
    headTop: 3,
    headH: 10,
    legW: 3,
    legLX: front ? 8 : 9,
    legRX: front ? 13 : 11,
    legTop: 21,
    legH: 5,
    armLX: front ? 6 : 8,
    armRX: front ? 16 : 13,
    armTop: 15,
    armH: 5,
    front,
  };
}

function drawLegs(p: Pixels, dir: Dir, pose: Pose) {
  const m = metrics(dir);
  const top = m.legTop + pose.crouch;
  const legs: [number, number, number][] = [
    [m.legLX + pose.leg[0], top + pose.legLift[0], 0],
    [m.legRX + pose.leg[1], top + pose.legLift[1], 1],
  ];
  // Back leg first so the front leg reads on top in the profile view.
  const order = dir === 'e' ? [1, 0] : [0, 1];
  for (const i of order) {
    const [x, y, idx] = legs[i];
    const tone = dir === 'e' && idx === 1 ? MID : BASE;
    rect(p, x, y, m.legW, m.legH, tone);
    rect(p, x, y, 1, m.legH, dir === 'e' && idx === 1 ? LOW : MID);
    rect(p, x + m.legW - 1, y, 1, m.legH, LOW);
  }
}

function drawBoots(p: Pixels, dir: Dir, pose: Pose) {
  const m = metrics(dir);
  const top = m.legTop + pose.crouch + m.legH;
  const feet: [number, number][] = [
    [m.legLX + pose.leg[0], top + pose.legLift[0]],
    [m.legRX + pose.leg[1], top + pose.legLift[1]],
  ];
  for (const [x, y] of feet) {
    const w = m.legW + (dir === 'e' ? 2 : 1);
    rect(p, x, y, w, 2, BASE);
    rect(p, x, y + 1, w, 1, LOW);
  }
}

function drawBody(p: Pixels, dir: Dir, pose: Pose) {
  const m = metrics(dir);
  const top = m.torsoTop + pose.bob + pose.crouch;
  const x = m.torsoX + (dir === 'e' ? pose.lean : 0);
  rect(p, x, top, m.torsoW, m.torsoH, BASE);
  rect(p, x, top, 1, m.torsoH, MID);
  rect(p, x + m.torsoW - 1, top, 1, m.torsoH, LOW);
  rect(p, x + 1, top, m.torsoW - 2, 1, HI);
  // Hem, and a fold down the middle so a coat is a coat rather than a block.
  rect(p, x, top + m.torsoH - 1, m.torsoW, 1, LOW);
  if (m.front) rect(p, x + Math.floor(m.torsoW / 2), top + 2, 1, m.torsoH - 3, MID);

  // Sleeves.
  const arms: [number, number, number][] = [
    [m.armLX + pose.arm[0] + (dir === 'e' ? pose.lean : 0), m.armTop + pose.bob + pose.crouch + pose.armLift[0], 0],
    [m.armRX + pose.arm[1] + (dir === 'e' ? pose.lean : 0), m.armTop + pose.bob + pose.crouch + pose.armLift[1], 1],
  ];
  const order = dir === 'e' ? [1, 0] : [0, 1];
  for (const i of order) {
    const [ax, ay, idx] = arms[i];
    if (dir === 'e' && idx === 1) {
      rect(p, ax, ay, 2, 4, MID);
    } else {
      rect(p, ax, ay, 2, 4, BASE);
      rect(p, ax, ay, 1, 4, MID);
    }
  }
}

/**
 * The one bright thing on a dark coat: a collar and a belt, tinted with the
 * citizen's accent colour. Drawn as a separate mask so the tint is its own.
 */
function drawTrim(p: Pixels, dir: Dir, pose: Pose) {
  const m = metrics(dir);
  const top = m.torsoTop + pose.bob + pose.crouch;
  const x = m.torsoX + (dir === 'e' ? pose.lean : 0);
  // Collar: a band across the shoulders, notched in the middle on the front.
  rect(p, x, top, m.torsoW, 1, HI);
  if (m.front) rect(p, x + Math.floor(m.torsoW / 2) - 1, top + 1, 2, 1, BASE);
  // Belt.
  rect(p, x, top + m.torsoH - 3, m.torsoW, 1, BASE);
  if (m.front) rect(p, x + Math.floor(m.torsoW / 2) - 1, top + m.torsoH - 3, 2, 1, HI);
}

function drawHands(p: Pixels, dir: Dir, pose: Pose) {
  const m = metrics(dir);
  const hands: [number, number, number][] = [
    [m.armLX + pose.arm[0] + (dir === 'e' ? pose.lean : 0), m.armTop + 4 + pose.bob + pose.crouch + pose.armLift[0], 0],
    [m.armRX + pose.arm[1] + (dir === 'e' ? pose.lean : 0), m.armTop + 4 + pose.bob + pose.crouch + pose.armLift[1], 1],
  ];
  const order = dir === 'e' ? [1, 0] : [0, 1];
  for (const i of order) {
    const [hx, hy, idx] = hands[i];
    rect(p, hx, hy, 2, 2, dir === 'e' && idx === 1 ? MID : BASE);
  }
}

function drawHead(p: Pixels, dir: Dir, pose: Pose) {
  const m = metrics(dir);
  const top = m.headTop + pose.bob + pose.crouch + (pose.lean > 1 ? 1 : 0);
  const x = m.headX + (dir === 'e' ? pose.lean : 0);
  // A rounded block: the corners are knocked off so the head reads as a head.
  rect(p, x + 1, top, m.headW - 2, m.headH, BASE);
  rect(p, x, top + 1, m.headW, m.headH - 2, BASE);
  rect(p, x, top + 1, 1, m.headH - 2, MID);
  rect(p, x + m.headW - 1, top + 1, 1, m.headH - 2, LOW);
  rect(p, x + 1, top + m.headH - 1, m.headW - 2, 1, MID);
  rect(p, x + 2, top, m.headW - 4, 1, HI);
  // Neck.
  rect(p, x + Math.floor(m.headW / 2) - 1, top + m.headH, 2, 1, LOW);

  if (dir === 's') {
    // Big eyes, set wide, with a brow line over each; a small mouth under.
    rect(p, x + 2, top + 5, 2, 2, LINE);
    rect(p, x + m.headW - 4, top + 5, 2, 2, LINE);
    rect(p, x + 3, top + 5, 1, 1, MID);
    rect(p, x + m.headW - 3, top + 5, 1, 1, MID);
    rect(p, x + Math.floor(m.headW / 2) - 1, top + 8, 2, 1, MID);
    // Cheeks.
    rect(p, x + 1, top + 7, 1, 1, HI);
    rect(p, x + m.headW - 2, top + 7, 1, 1, HI);
  } else if (dir === 'e') {
    // Profile: nose bump and a single eye.
    rect(p, x + m.headW, top + 5, 1, 2, BASE);
    rect(p, x + m.headW - 3, top + 5, 2, 2, LINE);
    rect(p, x + m.headW - 2, top + 5, 1, 1, MID);
    rect(p, x + m.headW - 4, top + 8, 2, 1, MID);
  }
}

function drawHair(p: Pixels, dir: Dir, pose: Pose, style: number) {
  const m = metrics(dir);
  const top = m.headTop + pose.bob + pose.crouch + (pose.lean > 1 ? 1 : 0);
  const x = m.headX + (dir === 'e' ? pose.lean : 0);
  const kind = style % HAIR_STYLES;

  // Cap over the crown, always present and generous: hair is a third of the
  // silhouette at this scale.
  rect(p, x - 1, top - 2, m.headW + 2, 5, BASE);
  rect(p, x, top - 3, m.headW, 1, BASE);
  rect(p, x, top - 2, m.headW, 1, HI);
  rect(p, x - 1, top + 3, 1, 2, MID);
  rect(p, x + m.headW, top + 2, 1, 3, MID);

  if (dir === 'n') {
    // Back of the head is all hair.
    rect(p, x - 1, top - 2, m.headW + 2, m.headH + 1, BASE);
    rect(p, x, top - 3, m.headW, 1, BASE);
    rect(p, x, top - 2, m.headW, 1, HI);
    rect(p, x + m.headW, top, 1, m.headH - 1, LOW);
  }

  switch (kind) {
    case 0: {
      // Long: falls past the shoulders on both sides.
      const len = dir === 'n' ? 9 : 7;
      rect(p, x - 1, top + 2, 2, len, BASE);
      rect(p, x + m.headW - 1, top + 2, 2, len, MID);
      rect(p, x - 1, top + 2 + len - 1, 2, 1, LOW);
      break;
    }
    case 1:
      // Fringe: a straight line of hair over the brow.
      if (dir !== 'n') {
        rect(p, x, top + 3, m.headW - 1, 1, MID);
        rect(p, x + 1, top + 4, 2, 1, MID);
      }
      break;
    case 2:
      // Tied back: a tail behind.
      if (dir !== 's') rect(p, x + (dir === 'n' ? m.headW - 1 : -2), top + 3, 2, 6, MID);
      if (dir === 'n') rect(p, x + m.headW - 1, top + 8, 2, 2, LOW);
      break;
    case 3:
      // Spiky: tufts standing up off the crown.
      for (const dx of [0, 3, 6]) {
        rect(p, x + dx, top - 5, 2, 3, BASE);
        rect(p, x + dx, top - 5, 1, 1, HI);
      }
      if (dir !== 'n') rect(p, x + m.headW - 3, top - 4, 2, 2, BASE);
      break;
    default:
      // Bob: rounded, flaring out at the jaw.
      rect(p, x - 2, top + 2, 2, 6, BASE);
      rect(p, x + m.headW, top + 2, 2, 6, MID);
      rect(p, x - 2, top + 7, 3, 1, LOW);
      rect(p, x + m.headW - 1, top + 7, 3, 1, LOW);
      break;
  }
}

function drawHat(p: Pixels, dir: Dir, pose: Pose, kind: 'straw' | 'helmet' | 'cap' | 'hood') {
  const m = metrics(dir);
  const top = m.headTop + pose.bob + pose.crouch + (pose.lean > 1 ? 1 : 0);
  const x = m.headX + (dir === 'e' ? pose.lean : 0);
  if (kind === 'straw') {
    rect(p, x - 4, top, m.headW + 8, 2, BASE);
    rect(p, x - 4, top + 1, m.headW + 8, 1, LOW);
    rect(p, x, top - 4, m.headW, 5, BASE);
    rect(p, x + 1, top - 4, m.headW - 2, 1, HI);
  } else if (kind === 'helmet') {
    rect(p, x - 1, top - 3, m.headW + 2, 6, BASE);
    rect(p, x, top - 4, m.headW, 1, BASE);
    rect(p, x, top - 3, m.headW, 1, HI);
    rect(p, x - 2, top + 2, m.headW + 4, 1, LOW);
    if (dir !== 'n') rect(p, x + Math.floor(m.headW / 2) - 1, top - 2, 2, 2, HI);
  } else if (kind === 'cap') {
    rect(p, x - 1, top - 3, m.headW + 2, 5, BASE);
    rect(p, x, top - 3, m.headW, 1, HI);
    if (dir !== 'n') rect(p, x + m.headW - 1, top + 1, 4, 1, MID);
  } else {
    rect(p, x - 2, top - 3, m.headW + 4, 9, BASE);
    rect(p, x - 1, top - 3, m.headW + 2, 1, HI);
    if (dir !== 'n') rect(p, x + 1, top + 3, m.headW - 2, 5, LINE);
  }
}

function drawTool(p: Pixels, dir: Dir, pose: Pose, state: CharState) {
  if (state !== 'work') return;
  const m = metrics(dir);
  const hx = m.armRX + pose.arm[1] + (dir === 'e' ? pose.lean : 0);
  const hy = m.armTop + 4 + pose.bob + pose.armLift[1];
  // A haft angled out of the working hand, with a head on the end.
  for (let i = 0; i < 9; i++) rect(p, hx + 1 + i, hy - Math.round(i * 0.7), 1, 1, MID);
  rect(p, hx + 8, hy - 6, 4, 3, BASE);
  rect(p, hx + 8, hy - 6, 4, 1, HI);
}

/** Layers that make up the body, independent of hair and headwear. */
export const BODY_LAYERS: LayerName[] = ['outline', 'legs', 'boots', 'body', 'trim', 'hands', 'head', 'tool'];

/** Mask grey used for the dark edge baked into hair and hats. */
const EDGE = '#242424';

/**
 * Body parts for one animation frame.
 *
 * Hair and hats are generated separately (`hairFrame`, `hatFrame`) so the mask
 * set stays small: 3 directions x 11 frames covers every citizen, and silhouette
 * variety comes from mixing in one of five hair styles and five hats.
 */
export function bodyFrame(dir: Dir, state: CharState, frame: number): Record<LayerName, Pixels> {
  const layers = Object.fromEntries(BODY_LAYERS.map((n) => [n, surface(CHAR_W, CHAR_H)])) as Record<LayerName, Pixels>;
  const pose = poseFor(state, frame);

  drawLegs(layers.legs, dir, pose);
  drawBoots(layers.boots, dir, pose);
  drawBody(layers.body, dir, pose);
  drawTrim(layers.trim, dir, pose);
  drawHands(layers.hands, dir, pose);
  drawHead(layers.head, dir, pose);
  drawTool(layers.tool, dir, pose, state);

  // A single silhouette ring behind every part, so parts are never outlined
  // against each other. Hair and hats carry their own edge on top of this.
  const merged = surface(CHAR_W, CHAR_H);
  for (const name of BODY_LAYERS) {
    if (name === 'outline') continue;
    merged.ctx.drawImage(layers[name].canvas, 0, 0);
  }
  outline(merged, '#ffffff', 1);
  const ring = layers.outline;
  ring.ctx.drawImage(merged.canvas, 0, 0);
  ring.ctx.globalCompositeOperation = 'destination-out';
  for (const name of BODY_LAYERS) {
    if (name === 'outline') continue;
    ring.ctx.drawImage(layers[name].canvas, 0, 0);
  }
  ring.ctx.globalCompositeOperation = 'source-over';

  return layers;
}

export function hairFrame(dir: Dir, state: CharState, frame: number, style: number): Pixels {
  const p = surface(CHAR_W, CHAR_H);
  drawHair(p, dir, poseFor(state, frame), style);
  outline(p, EDGE, 1);
  return p;
}

export function hatFrame(dir: Dir, state: CharState, frame: number, kind: Exclude<HatKind, 'none'>): Pixels {
  const p = surface(CHAR_W, CHAR_H);
  drawHat(p, dir, poseFor(state, frame), kind);
  outline(p, EDGE, 1);
  return p;
}

/** Every (direction, state, frame) combination the renderer can ask for. */
export function characterFrameKeys(): { dir: Dir; state: CharState; frame: number }[] {
  const out: { dir: Dir; state: CharState; frame: number }[] = [];
  for (const dir of ['s', 'n', 'e'] as Dir[]) {
    for (const state of Object.keys(STATE_FRAMES) as CharState[]) {
      for (let f = 0; f < STATE_FRAMES[state]; f++) out.push({ dir, state, frame: f });
    }
  }
  return out;
}

/** Silhouette variants. Combining hair style and hat keeps a crowd from cloning. */
export const HAIR_STYLES = 5;
export const HATS = ['none', 'straw', 'helmet', 'cap', 'hood'] as const;
export type HatKind = (typeof HATS)[number];

/** Work hats follow the job, which makes professions readable on the map. */
export function hatForJob(job: string, look: number): HatKind {
  switch (job) {
    case 'farmer': return 'straw';
    case 'miner': return 'helmet';
    case 'quarry': return 'helmet';
    case 'baker': return 'cap';
    case 'blacksmith': return 'cap';
    case 'woodcutter': return look % 2 ? 'cap' : 'none';
    case 'fisher': return look % 3 ? 'cap' : 'hood';
    case 'hunter': return 'hood';
    case 'forager': return look % 2 ? 'straw' : 'none';
    default: return look % 5 === 0 ? 'hood' : 'none';
  }
}
