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
import { PEOPLE, PEOPLE_AI, PEOPLE_INDUSTRIAL, PEOPLE_MODERN, PEOPLE_TOWNSHIP } from './palette';
import { appearanceFor, type Appearance, type AssetLibrary } from './assets';
import { BODY_LAYERS, CHAR_GROUND, CHAR_H, STATE_FRAMES, hatForJob, type CharState, type Dir, type HatKind, type LayerName } from './character';
import { ELEVATION, worldToScreen } from '../world/iso';

const OUTLINE_TINT = 0x0c130d;
const TOOL_TINT = 0x9aa0a8;
const HAT_TINTS: Record<Exclude<HatKind, 'none'>, number> = {
  straw: 0xc9ad5e,
  helmet: 0x7d8490,
  cap: 0x3a4a3a,
  hood: 0x2e2a36,
};

/** How far a citizen has to travel for one full four-frame walk cycle. */
const STRIDE = 2.6;

/** What each trade hauls between its workplace and the store. */
const CARRIED: Record<string, string> = {
  farmer: 'sack', woodcutter: 'log', miner: 'crate', quarry: 'crate',
  miller: 'sack', baker: 'loaf', carpenter: 'crate', blacksmith: 'crate', tailor: 'cloth',
  fisher: 'fish', hunter: 'game', forager: 'basket',
};
/** Trades whose load only exists on the way back: nobody walks *to* the water with a fish. */
const CARRY_ON_ERRAND = new Set(['fisher', 'hunter', 'forager']);
/** What the outdoor trades hold while they work. */
const TOOLS: Record<string, string> = { fisher: 'fx.rod', hunter: 'fx.bow' };

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
  /** The cart or the boat under them, when they are on one. */
  private readonly vehicle: Sprite;
  private vehicleKind: string | null = null;
  private readonly era: number;
  private readonly body: Partial<Record<LayerName, Sprite>> = {};
  private readonly hair: Sprite;
  private readonly hat: Sprite;
  private readonly carry: Sprite;
  private carryKind: string | null = null;
  /** A rod or a bow, held while working out of doors. */
  private readonly tool: Sprite;
  /** A torch, carried by somebody who has turned on the settlement. */
  private readonly torch: Sprite;
  /** The look last applied for trouble: rogue, sick, or neither. */
  private moodShown = '';
  /** The trade the load, the tool and the hat were last set for. */
  private jobShown = '';
  private readonly stack = new Container();
  private readonly appearance: Appearance;
  private hatKind: HatKind;
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

  constructor(private readonly assets: AssetLibrary, citizen: Citizen, era = 1) {
    this.id = citizen.id;
    this.wx = citizen.x;
    this.wy = citizen.y;
    // The same person, dressed for the era the plot is in.
    this.appearance = appearanceFor(citizen.look, citizen.age, era >= 5 ? PEOPLE_AI : era >= 4 ? PEOPLE_MODERN : era >= 3 ? PEOPLE_INDUSTRIAL : era >= 2 ? PEOPLE_TOWNSHIP : PEOPLE);
    this.era = era;
    this.hatKind = hatForJob(citizen.job, citizen.look);

    this.shadow = new Sprite(assets.get('fx.shadow'));
    this.shadow.anchor.set(0.5, 0.5);
    this.shadow.alpha = 0.5;
    this.container.addChild(this.shadow);

    // Under the body and over the shadow, so the person sits in it.
    this.vehicle = new Sprite();
    this.vehicle.anchor.set(0.5, 0.7);
    this.vehicle.visible = false;
    this.container.addChild(this.vehicle);

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

    this.tool = new Sprite();
    this.tool.anchor.set(0.2, 0.9);
    this.tool.visible = false;

    this.torch = new Sprite(assets.get('fx.torch.0'));
    this.torch.anchor.set(0.5, 0.95);
    this.torch.visible = false;

    this.hat = new Sprite();
    this.hat.anchor.set(0.5, CHAR_GROUND / CHAR_H);
    stack.addChild(this.hat);
    stack.addChild(this.carry);
    stack.addChild(this.tool);
    stack.addChild(this.torch);

    this.container.addChild(stack);
    this.dressFor(citizen);
    this.applyFrame();
  }

  /**
   * The load, the tool and the hat for the trade this person is in now.
   *
   * People change trade, and a sprite dressed once at birth kept carrying a
   * log to the fishing hut for the rest of its life. Cheap to re-run, so it
   * runs whenever the job changes.
   */
  private dressFor(citizen: Citizen) {
    if (this.jobShown === citizen.job) return;
    this.jobShown = citizen.job;
    const load = CARRIED[citizen.job];
    if (load) this.carry.texture = this.assets.get(`fx.carry.${load}`);
    this.carryKind = load ?? null;
    const tool = TOOLS[citizen.job];
    if (tool) this.tool.texture = this.assets.get(tool);
    this.tool.visible = false;
    this.hatKind = hatForJob(citizen.job, citizen.look);
    this.hat.visible = this.hatKind !== 'none';
    if (this.hatKind !== 'none') this.hat.tint = HAT_TINTS[this.hatKind];
    this.appliedKey = '';
  }

  /**
   * Trouble shows on a person: a rogue wears their trim red and carries a
   * torch; somebody sick has gone a bad colour.
   */
  private moodFor(citizen: Citizen) {
    const mood = citizen.rogue ? 'rogue' : citizen.sick ? 'sick' : '';
    if (mood === this.moodShown) return;
    this.moodShown = mood;
    const trim = this.body.trim, head = this.body.head, hands = this.body.hands, body = this.body.body;
    if (trim) trim.tint = mood === 'rogue' ? 0xe0402a : this.appearance.accent;
    const skin = mood === 'sick' ? 0xb8d8a8 : this.appearance.skin;
    if (head) head.tint = skin;
    if (hands) hands.tint = skin;
    if (body) body.tint = mood === 'rogue' ? 0x4a2a28 : this.appearance.shirt;
  }

  private tintFor(layer: LayerName): number {
    switch (layer) {
      case 'outline': return OUTLINE_TINT;
      case 'legs': return this.appearance.pants;
      case 'boots': return this.appearance.shoes;
      case 'body': return this.appearance.shirt;
      case 'trim': return this.appearance.accent;
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
    // The outdoor trades: a fisher stands with the rod, a hunter with the
    // bow, a forager crouches over the ground. The swing of an axe is wrong
    // for all three.
    if (citizen.activity === 'working' && !citizen.inside) {
      if (citizen.job === 'fisher' || citizen.job === 'hunter') return 'idle';
      if (citizen.job === 'forager') return 'sit';
    }
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
  update(citizen: Citizen, dt: number, height: number, doorPoint?: { x: number; y: number }, face?: { dir: Dir; flipped: boolean }): CitizenView {
    this.dressFor(citizen);
    this.moodFor(citizen);
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
    } else if (face) {
      // Told which way to look: a fisher faces the water, not the way they came.
      this.dir = face.dir;
      this.flipped = face.flipped;
    }

    const scuffling = !!citizen.scuffle && citizen.scuffle > 0;
    const nextState = scuffling ? 'work' : this.stateFor(citizen, moving);
    if (nextState !== this.state) { this.state = nextState; this.clock = 0; }

    // Walk cadence comes from distance travelled; everything else runs on time.
    this.clock += this.state === 'walk' ? travelled / STRIDE : dt * (this.state === 'work' ? 2.6 : 1.1);
    const frames = STATE_FRAMES[this.state];
    this.frame = Math.floor(this.clock * frames) % frames;
    this.applyFrame();

    const screen = worldToScreen(this.wx, this.wy, height);
    // A scuffle is people thrown about: the body jitters off its spot.
    const jx = scuffling ? (Math.random() - 0.5) * 5 : 0;
    const jy = scuffling ? (Math.random() - 0.5) * 3 : 0;
    this.container.position.set(screen.x + jx, screen.y + jy);
    this.shadow.position.set(0, -1);
    this.shadow.scale.set(this.appearance.scale * (this.state === 'sleep' ? 1.2 : 1));

    // The ferry's boat while they are on the water, the cart while they ride
    // one. The boat rocks; the cart sits on its wheels and the walker's own
    // bob reads as the road. No shadow on the water.
    // The boat of the era while they are on the water; the ride while they
    // ride one. The boat rocks; the vehicles sit on their wheels and the
    // walker's own bob reads as the road. No shadow on the water.
    const boat = citizen.afloat;
    const vehicle: string | null = boat
      ? (this.era >= 5 ? 'fx.hydrofoil' : this.era >= 4 ? 'fx.motorboat' : this.era >= 3 ? 'fx.steamboat' : 'fx.boat')
      : citizen.riding
        ? (citizen.ride === 'car' ? `fx.car.${citizen.hash % 3}` : citizen.ride === 'rail' ? 'fx.tram' : citizen.ride === 'bike' ? 'fx.bike' : citizen.ride === 'pod' ? 'fx.pod' : 'fx.cart')
        : null;
    if (vehicle !== this.vehicleKind) {
      this.vehicleKind = vehicle;
      if (vehicle) this.vehicle.texture = this.assets.get(vehicle);
    }
    this.vehicle.visible = vehicle !== null;
    this.shadow.visible = !boat;
    if (vehicle) {
      const s = this.appearance.scale;
      this.vehicle.scale.set(this.flipped ? -s : s, s);
      const rock = boat ? Math.sin(this.clock * 2.4 + this.wx) * (this.era >= 5 ? 0.5 : 1.2) : 0;
      // The boat sits lower than the vehicles so its hull shows past the feet.
      this.vehicle.position.set(0, (boat ? 4 : 1) + rock);
      this.vehicle.rotation = boat ? Math.sin(this.clock * 1.7 + this.wy) * 0.05 : 0;
    }

    // Anyone commuting during the working day is hauling something, held in
    // front of them so it reads at a glance which trade is on the move.
    // Held at waist height in front of them, and out of sight when their back
    // is turned. Centred on the chest it just covers the character up.
    const hauling = this.carryKind !== null && moving && citizen.phase === 'working' && this.dir !== 'n'
      && (!CARRY_ON_ERRAND.has(citizen.job) || citizen.errand);
    this.carry.visible = hauling;
    // The rod is out while the fisher stands at the water; the bow is up
    // while the hunter has something in sight.
    const working = citizen.activity === 'working' && !citizen.inside && !citizen.errand;
    const holding = citizen.job === 'fisher' ? working && !moving : citizen.job === 'hunter' ? !!citizen.hunting && !citizen.inside : false;
    this.tool.visible = holding;
    // The torch: out whenever the rogue is in view, flickering.
    const torching = !!citizen.rogue && !citizen.inside;
    this.torch.visible = torching;
    if (torching) {
      this.torch.texture = this.assets.get(`fx.torch.${Math.floor(this.clock * 6 + this.wx) % 2}`);
      this.torch.position.set(this.dir === 'e' ? 8 : 6, -12);
    }
    if (holding) {
      const scale = 0.9;
      this.tool.scale.set(scale, scale);
      if (this.dir === 'e') this.tool.position.set(6, -9);
      else if (this.dir === 's') this.tool.position.set(4, -8);
      else this.tool.position.set(3, -14);
    }
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
