/**
 * CitizenSprite — the visible body of an AI being.
 *
 * The simulation owns a citizen's logical position and activity. This class owns
 * everything about how that reads on screen: a render position that eases toward
 * the logical one, a walk cycle driven by actual travelled distance, the facing
 * direction, and the tinted part stack that gives each citizen their own look.
 *
 * The animation clock is independent of the simulation tick, so citizens keep
 * walking smoothly whatever rate the world is advancing at.
 */

import { Container, Sprite } from 'pixi.js';
import type { Citizen } from '../simulation';
import { PEOPLE } from './palette';
import { appearanceFor, type Appearance, type AssetLibrary } from './assets';
import { BODY_LAYERS, CHAR_GROUND, CHAR_H, STATE_FRAMES, hatForJob, type CharState, type Dir, type HatKind, type LayerName } from './character';
import { ELEVATION, worldToScreen } from '../world/iso';

const OUTLINE_TINT = 0x1c2a1a;
const TOOL_TINT = 0x9aa0a8;
const HAT_TINTS: Record<Exclude<HatKind, 'none'>, number> = {
  straw: 0xd8bb6a,
  helmet: 0x8d94a0,
  cap: 0xe6e2d4,
  hood: 0x4a4438,
};

/** How far a citizen has to travel for one full four-frame walk cycle. */
const STRIDE = 2.6;

/** What each trade hauls between its workplace and the store. */
const CARRIED: Record<string, string> = {
  farmer: 'sack', woodcutter: 'log', miner: 'crate', quarry: 'crate',
  miller: 'sack', baker: 'loaf', carpenter: 'crate', blacksmith: 'crate', tailor: 'cloth',
};

export interface CitizenView {
  /** Interpolated world position used for depth sorting and label anchoring. */
  wx: number;
  wy: number;
  screenX: number;
  screenY: number;
}

export class CitizenSprite {
  readonly container = new Container();
  readonly id: string;
  private readonly shadow: Sprite;
  private readonly body: Partial<Record<LayerName, Sprite>> = {};
  private readonly hair: Sprite;
  private readonly hat: Sprite;
  private readonly carry: Sprite;
  private carryKind: string | null = null;
  private readonly stack = new Container();
  private readonly appearance: Appearance;
  private readonly hatKind: HatKind;
  /** Last applied `dir|state|frame|flip`, so textures are only swapped on change. */
  private appliedKey = '';

  /** Render position, eased toward the simulation position. */
  wx: number;
  wy: number;
  private dir: Dir = 's';
  private flipped = false;
  private state: CharState = 'idle';
  private clock = 0;
  private frame = 0;
  private alpha = 1;

  constructor(private readonly assets: AssetLibrary, citizen: Citizen) {
    this.id = citizen.id;
    this.wx = citizen.x;
    this.wy = citizen.y;
    this.appearance = appearanceFor(citizen.look, citizen.age, PEOPLE);
    this.hatKind = hatForJob(citizen.job, citizen.look);

    this.shadow = new Sprite(assets.get('fx.shadow'));
    this.shadow.anchor.set(0.5, 0.5);
    this.shadow.alpha = 0.5;
    this.container.addChild(this.shadow);

    const stack = this.stack;
    stack.scale.set(this.appearance.scale);
    for (const layer of BODY_LAYERS) {
      const sprite = new Sprite();
      sprite.anchor.set(0.5, CHAR_GROUND / CHAR_H);
      sprite.tint = this.tintFor(layer);
      stack.addChild(sprite);
      this.body[layer] = sprite;
    }
    this.hair = new Sprite();
    this.hair.anchor.set(0.5, CHAR_GROUND / CHAR_H);
    this.hair.tint = this.appearance.hair;
    stack.addChild(this.hair);

    this.carry = new Sprite();
    this.carry.anchor.set(0.5, 0.5);
    this.carry.visible = false;
    const load = CARRIED[citizen.job];
    if (load) this.carry.texture = assets.get(`fx.carry.${load}`);
    this.carryKind = load ?? null;

    this.hat = new Sprite();
    this.hat.anchor.set(0.5, CHAR_GROUND / CHAR_H);
    this.hat.visible = this.hatKind !== 'none';
    if (this.hatKind !== 'none') this.hat.tint = HAT_TINTS[this.hatKind];
    stack.addChild(this.hat);
    stack.addChild(this.carry);

    this.container.addChild(stack);
    this.applyFrame();
  }

  private tintFor(layer: LayerName): number {
    switch (layer) {
      case 'outline': return OUTLINE_TINT;
      case 'legs': return this.appearance.pants;
      case 'boots': return this.appearance.shoes;
      case 'body': return this.appearance.shirt;
      case 'hands':
      case 'head': return this.appearance.skin;
      case 'tool': return TOOL_TINT;
      default: return 0xffffff;
    }
  }

  /** Pick the animation state from what the citizen is actually doing. */
  private stateFor(citizen: Citizen, moving: boolean): CharState {
    if (moving) return 'walk';
    // Actually sat down: on a bench in the square, or crouched at a fire.
    if (citizen.seated) return 'sit';
    switch (citizen.activity) {
      case 'working': return 'work';
      case 'resting': return citizen.phase === 'sleeping' ? 'sleep' : 'sit';
      case 'eating': return 'sit';
      default: return 'idle';
    }
  }

  private applyFrame() {
    const { dir, state, frame } = this;
    const key = `${dir}|${state}|${frame}|${this.flipped ? 1 : 0}`;
    if (key === this.appliedKey) return;
    this.appliedKey = key;
    for (const layer of BODY_LAYERS) {
      const sprite = this.body[layer];
      if (!sprite) continue;
      const key = `char.${dir}.${state}.${frame}.${layer}`;
      sprite.texture = this.assets.get(key);
    }
    this.hair.texture = this.assets.get(`char.hair.${dir}.${state}.${frame}.${this.appearance.hairStyle}`);
    if (this.hatKind !== 'none') {
      this.hat.texture = this.assets.get(`char.hat.${dir}.${state}.${frame}.${this.hatKind}`);
    }
    this.stack.scale.x = (this.flipped ? -1 : 1) * this.appearance.scale;
  }

  /**
   * Advance the sprite by `dt` seconds toward the citizen's current simulation
   * state. `doorPoint` is supplied when the citizen is inside a building, so
   * they walk to the doorway before fading out of sight indoors.
   */
  update(citizen: Citizen, dt: number, height: number, doorPoint?: { x: number; y: number }): CitizenView {
    const targetX = doorPoint ? doorPoint.x : citizen.x;
    const targetY = doorPoint ? doorPoint.y : citizen.y;

    const prevX = this.wx, prevY = this.wy;
    // Ease toward the simulation position. The simulation is authoritative; this
    // only removes the stepping that would otherwise show at low tick rates.
    // Gentler than it was: a correction out of a wall arrives in the simulation
    // as one decisive step, and easing it over about a tenth of a second is
    // what turns it from a snap sideways into a stride.
    const k = Math.min(1, dt * 9);
    this.wx += (targetX - this.wx) * k;
    this.wy += (targetY - this.wy) * k;

    const dx = this.wx - prevX;
    const dy = this.wy - prevY;
    const travelled = Math.hypot(dx, dy);
    const moving = travelled > 0.004 && !citizen.inside;

    // Facing is only ever changed while actually walking, and then held. Reading
    // the simulation's facing while standing still made idle citizens spin on
    // the spot, because steering keeps nudging it as they settle.
    if (moving) {
      if (Math.abs(dx) > Math.abs(dy)) { this.dir = 'e'; this.flipped = dx < 0; }
      else { this.dir = dy > 0 ? 's' : 'n'; this.flipped = false; }
    }

    const nextState = this.stateFor(citizen, moving);
    if (nextState !== this.state) { this.state = nextState; this.clock = 0; }

    // Walk cadence comes from distance travelled; everything else runs on time.
    this.clock += this.state === 'walk' ? travelled / STRIDE : dt * (this.state === 'work' ? 2.6 : 1.1);
    const frames = STATE_FRAMES[this.state];
    this.frame = Math.floor(this.clock * frames) % frames;
    this.applyFrame();

    const screen = worldToScreen(this.wx, this.wy, height);
    this.container.position.set(screen.x, screen.y);
    this.shadow.position.set(0, -1);
    this.shadow.scale.set(this.appearance.scale * (this.state === 'sleep' ? 1.2 : 1));

    // Anyone commuting during the working day is hauling something, held in
    // front of them so it reads at a glance which trade is on the move.
    // Held at waist height in front of them, and out of sight when their back
    // is turned. Centred on the chest it just covers the character up.
    const hauling = this.carryKind !== null && moving && citizen.phase === 'working' && this.dir !== 'n';
    this.carry.visible = hauling;
    if (hauling) {
      const scale = 0.8;
      this.carry.scale.set(this.flipped ? -scale : scale, scale);
      this.carry.position.set(this.dir === 'e' ? 7 : 0, -8 + (this.frame % 2 === 1 ? -1 : 0));
    }

    // Walking into a building means going inside it: the citizen fades out at
    // the doorway and fades back in there when they come out again. The
    // building's occupancy badge carries who is in there meanwhile.
    const wantAlpha = citizen.inside ? 0 : 1;
    this.alpha += (wantAlpha - this.alpha) * Math.min(1, dt * 7);
    if (Math.abs(wantAlpha - this.alpha) < 0.01) this.alpha = wantAlpha;
    this.container.alpha = this.alpha;
    this.container.visible = this.alpha > 0.01;

    return { wx: this.wx, wy: this.wy, screenX: screen.x, screenY: screen.y };
  }

  /** Top of the head in local screen space, for anchoring bubbles and rings. */
  get headOffset() {
    return -CHAR_GROUND * this.appearance.scale - 4;
  }

  /** Vertical lift applied by terrain elevation, for label placement. */
  static liftFor(height: number) { return height * ELEVATION; }

  destroy() {
    this.container.destroy({ children: true });
  }
}
