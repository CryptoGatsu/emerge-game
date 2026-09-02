/**
 * EmergeScene — the window onto the living world.
 *
 * The simulation is the brain and never imports this file. The scene reads world
 * state each frame and draws it: baked terrain, animated water, depth-sorted
 * props, buildings that light up after dark, and citizens that walk, work and
 * talk. Camera, weather, time-of-day light and picking all live here.
 *
 * Layer order, bottom to top:
 *   worldRoot   terrain, cliffs, water, then the depth-sorted object layer
 *   ambient     one screen-space multiply pass for time of day and weather
 *   lightsRoot  additive window glow, lanterns and forge light
 *   weather     screen-space rain and snow
 *   hudRoot     screen-space speech bubbles and building activity badges
 */

import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture, TilingSprite, type FederatedPointerEvent } from 'pixi.js';
import {
  ACTIVITY_LABELS, JOB_LABELS, type Building, type Citizen, type World,
} from '../simulation';
import { speechFor } from '../speech';
import { AMBIENT, SEASON_TINT, UI, WEATHER_TINT } from './palette';
import { backdropTexture, loadAssets, type AssetLibrary } from './assets';
import { buildingArtKey } from './buildings';
import { CitizenSprite } from './citizenSprite';
import { ELEVATION, GRID, SCENE_BOUNDS, TILE_H, TILE_W, depthOf, screenToWorld, tileToScreen, worldToScreen } from '../world/iso';
import { TILE_ART, TILE_COLOR, Tile, generateWorldMap, type PropInstance, type WorldMap } from '../world/terrain';
import type { ShoreEdge } from './tiles';
import type { BiomeKind } from '../world/biomes';

export type PickTarget = { kind: 'citizen' | 'building'; id: string } | null;

export interface SceneCallbacks {
  onHover?: (target: PickTarget) => void;
  onSelect?: (target: PickTarget) => void;
  onCamera?: (zoom: number) => void;
}

interface BuildingView {
  building: Building;
  base: Sprite;
  lit: Sprite;
  glow?: Sprite;
  badge: Container;
  badgeIcon: Sprite;
  badgeText: Text;
  wheel?: Sprite;
  artKey: string;
  door: { x: number; y: number };
  chimney?: { x: number; y: number };
  height: number;
}

interface Bubble {
  root: Container;
  bg: Graphics;
  label: Text;
  citizenId: string | null;
  text: string;
  life: number;
}

interface Particle { sprite: Sprite; vx: number; vy: number; life: number; max: number }

/**
 * A tree the woodcutters can actually fell.
 *
 * Felling is driven by the wood the simulation really produced yesterday, so a
 * settlement with no woodcutters never loses a tree, and a busy one visibly
 * clears the ground around its camps. Stumps put out saplings and grow back.
 */
interface TreeEntry {
  sprite: Sprite;
  wx: number;
  wy: number;
  texture: Texture;
  scale: number;
  state: 'standing' | 'falling' | 'stump' | 'sapling';
  /** Seconds of fall animation left, or game days until the next growth stage. */
  timer: number;
}

/** Foliage colour through the year. Autumn turns the woods; winter greys them. */
const FOLIAGE_SEASON: Record<string, number> = {
  Spring: 0xffffff,
  Summer: 0xf0ffe0,
  Autumn: 0xe0a055,
  Winter: 0xc4d6dd,
};

/**
 * Gentle large-scale shading of the ground, driven by smooth noise. Varying the
 * tone gradually across tens of tiles gives the terrain depth; varying it per
 * tile would just draw the isometric grid.
 */
/**
 * What the country beyond the plot looks like, per biome.
 *
 * The backdrop is one tiling forest texture; tinting it is enough to place it,
 * because at that distance only the overall colour reads.
 */
const BACKDROP_TINT: Record<BiomeKind, number> = {
  valley: 0xffffff,
  woodland: 0xd6e8cc,
  highland: 0xb9c4c2,
  wetland: 0xcfe0cf,
  steppe: 0xd8cf96,
  coast: 0xc8dcd2,
  desert: 0xd9b478,
  swamp: 0x9fb69c,
  grassland: 0xd8ecbe,
};

function groundTint(tone: number) {
  const t = Math.max(0, Math.min(1, tone));
  const level = Math.round(214 + t * 41);
  const warm = Math.round(210 + t * 45);
  return (warm << 16) | (level << 8) | Math.round(206 + t * 40);
}

/** Tile kinds drawn over grass so their ragged edges blend into it. */
const BLENDED = new Set<Tile>([Tile.Path, Tile.Plaza, Tile.Sand, Tile.Tilled, Tile.CropWheat, Tile.CropVeg]);

/** How long a tree takes to go over. */
const FALL_SECONDS = 1.15;

const MAX_BUBBLES = 6;
const BUBBLE_ROTATE = 5.5;
const SMOKE_POOL = 70;
const WEATHER_POOL = 320;

export class EmergeScene {
  readonly app = new Application();
  private assets!: AssetLibrary;
  private map!: WorldMap;
  private world!: World;

  private worldRoot = new Container();
  private backdrop: TilingSprite | null = null;
  private groundLayer = new Container();
  private waterLayer = new Container();
  private objectLayer = new Container();
  private fxLayer = new Container();
  private lightsRoot = new Container();
  private hudRoot = new Container();
  private weatherLayer = new Container();
  private ambient = new Sprite(Texture.WHITE);
  private vignette = new Sprite();
  private seasonWash = new Sprite(Texture.WHITE);

  private citizens = new Map<string, CitizenSprite>();
  private buildings = new Map<string, BuildingView>();
  private propSprites: { sprite: Sprite; prop: PropInstance; phase: number; cleared?: boolean }[] = [];
  private waterSprites: { sprite: Sprite; kind: 'water' | 'shore' }[] = [];
  private waterfallSprites: Sprite[] = [];
  private campfires: Sprite[] = [];
  private bubbles: Bubble[] = [];
  private smoke: Particle[] = [];
  private weatherParticles: Particle[] = [];
  private motes: Particle[] = [];
  private splashes: Particle[] = [];
  private selectRing!: Sprite;
  private hoverRing!: Sprite;

  private camera = { x: 0, y: 0, zoom: 1 };
  private minZoom = 0.5;
  private maxZoom = 2.4;
  private time = 0;
  private bubbleTimer = 0;
  private beat = 0;
  private cullTimer = 0;

  private selected: PickTarget = null;
  private hovered: PickTarget = null;
  private dragging = false;
  private dragMoved = 0;
  private lastPointer = { x: 0, y: 0 };
  private callbacks: SceneCallbacks = {};
  private disposed = false;

  /** Boot the renderer into `host` and build the world's visual layer. */
  async init(host: HTMLElement, world: World, callbacks: SceneCallbacks = {}) {
    this.world = world;
    this.callbacks = callbacks;

    await this.app.init({
      resizeTo: host,
      antialias: false,
      backgroundColor: 0x0a1610,
      // Render at the device pixel grid. With a backing store smaller than the
      // display, the browser upscales the canvas with smoothing and every sprite
      // goes soft — the one thing pixel art cannot survive.
      resolution: Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1),
      autoDensity: true,
      preference: 'webgl',
      sharedTicker: false,
    });
    if (this.disposed) { this.app.destroy(true); return; }
    host.appendChild(this.app.canvas);
    this.app.canvas.style.display = 'block';
    this.app.canvas.style.imageRendering = 'pixelated';
    this.app.canvas.style.touchAction = 'none';
    this.app.canvas.style.cursor = 'grab';

    this.assets = loadAssets();
    this.map = generateWorldMap(world);

    this.vignette.texture = this.assets.get('fx.vignette');
    this.vignette.blendMode = 'multiply';
    this.vignette.alpha = 0.5;
    this.app.stage.addChild(this.worldRoot, this.vignette, this.ambient, this.lightsRoot, this.weatherLayer, this.hudRoot);
    // Distant forest behind everything, so the diamond edge of the tile field
    // never shows as empty space at the corners of the viewport.
    const pad = 900;
    this.backdrop = new TilingSprite({
      texture: backdropTexture(),
      x: SCENE_BOUNDS.minX - pad,
      y: SCENE_BOUNDS.minY - pad,
      width: SCENE_BOUNDS.maxX - SCENE_BOUNDS.minX + pad * 2,
      height: SCENE_BOUNDS.maxY - SCENE_BOUNDS.minY + pad * 2,
    });
    // The distant land belongs to the same biome as the map: an unbroken green
    // forest ringing a desert made the plot look like a diorama on a lawn.
    this.backdrop.tint = BACKDROP_TINT[this.world.biome];
    this.worldRoot.addChild(this.backdrop, this.groundLayer, this.waterLayer, this.objectLayer, this.fxLayer);
    this.objectLayer.sortableChildren = true;
    this.lightsRoot.blendMode = 'add';

    this.ambient.blendMode = 'multiply';
    this.ambient.alpha = 0;
    this.seasonWash.blendMode = 'multiply';
    this.seasonWash.alpha = 0;
    this.app.stage.addChildAt(this.seasonWash, this.app.stage.children.indexOf(this.ambient));

    this.buildTerrain();
    this.buildProps();
    this.buildRings();
    this.syncBuildings();
    this.syncCitizens();
    this.buildBubbles();
    this.buildParticles();

    this.centreOn(50, 49, 1.05);
    this.attachInput();

    this.app.ticker.add((ticker) => this.update(ticker.deltaMS / 1000));
    this.app.renderer.on('resize', () => this.onResize());
    this.onResize();
  }

  /* ---------------------------------------------------------------- *
   * Construction
   * ---------------------------------------------------------------- */

  private buildTerrain() {
    const { map, assets } = this;
    for (let ty = 0; ty < map.grid; ty++) {
      for (let tx = 0; tx < map.grid; tx++) {
        const i = ty * map.grid + tx;
        const kind = map.tiles[i] as Tile;
        const step = map.steps[i];
        const pos = tileToScreen(tx, ty, step);

        // Cliff face first, so the raised tile sits on top of its own rock wall.
        if (map.cliffs[i]) {
          const cliff = new Sprite(assets.get('tile.cliff.0'));
          cliff.position.set(pos.x - TILE_W / 2, pos.y);
          this.groundLayer.addChild(cliff);
        }

        const art = TILE_ART[kind];
        if (kind === Tile.Water || kind === Tile.WaterShore) {
          const sprite = new Sprite(assets.get(`${art.key}.0`));
          sprite.position.set(pos.x - TILE_W / 2, pos.y);
          this.waterLayer.addChild(sprite);
          sprite.tint = groundTint(map.tone[i]);
          this.waterSprites.push({ sprite, kind: kind === Tile.Water ? 'water' : 'shore' });
          continue;
        }

        // Surfaces with ragged edges sit on a grass tile so the notches reveal
        // ground rather than the backdrop.
        if (BLENDED.has(kind)) {
          const under = new Sprite(assets.get(`tile.grass.${(tx + ty) % 4}`));
          under.position.set(pos.x - TILE_W / 2, pos.y);
          under.tint = groundTint(map.tone[i]);
          this.groundLayer.addChild(under);
        }

        const key = art.variants ? `${art.key}.${map.variants[i]}` : art.key;
        const sprite = new Sprite(assets.get(key));
        sprite.position.set(pos.x - TILE_W / 2, pos.y);
        sprite.tint = groundTint(map.tone[i]);
        this.groundLayer.addChild(sprite);
      }
    }

    for (const { tx, ty } of map.waterfalls) {
      const pos = tileToScreen(tx, ty, 1);
      const sprite = new Sprite(assets.get('tile.waterfall.0'));
      sprite.position.set(pos.x - TILE_W / 2, pos.y);
      this.waterLayer.addChild(sprite);
      this.waterfallSprites.push(sprite);
    }
  }

  private buildProps() {
    for (const prop of this.map.props) {
      if (!this.assets.has(prop.name)) continue;
      const sprite = new Sprite(this.assets.get(prop.name));
      sprite.anchor.set(0.5, 1);
      const h = this.map.heightAt(prop.wx, prop.wy);
      const pos = worldToScreen(prop.wx, prop.wy, h);
      sprite.position.set(pos.x, pos.y);
      sprite.zIndex = depthOf(prop.wx, prop.wy);
      const size = prop.scale ?? 1;
      sprite.scale.set(prop.flip ? -size : size, size);
      this.objectLayer.addChild(sprite);
      this.propSprites.push({ sprite, prop, phase: (prop.wx * 7.3 + prop.wy * 3.1) % (Math.PI * 2) });

      if (prop.sway >= 0.4) this.foliage.push({ sprite, baseTint: sprite.tint as number });
      if (prop.name.startsWith('prop.tree.') && prop.name !== 'prop.tree.dead') {
        this.trees.push({
          sprite, wx: prop.wx, wy: prop.wy, texture: sprite.texture,
          scale: size, state: 'standing', timer: 0,
        });
      }

      if (prop.name.startsWith('prop.campfire')) this.campfires.push(sprite);
      if (prop.glow) {
        const glow = new Sprite(this.assets.get('fx.lampglow'));
        glow.anchor.set(0.5, 0.5);
        glow.position.set(pos.x, pos.y - 22);
        glow.alpha = 0;
        glow.scale.set(prop.name.includes('campfire') ? 1.5 : 1);
        this.lightsRoot.addChild(glow);
        this.lampGlows.push(glow);
      }
    }
  }

  private lampGlows: Sprite[] = [];
  private trees: TreeEntry[] = [];
  private foliage: { sprite: Sprite; baseTint: number }[] = [];
  private birds: Particle[] = [];
  private lastDay = 0;
  private lastSeason = '';
  private followId: string | null = null;

  private buildRings() {
    this.selectRing = new Sprite(this.assets.get('fx.select'));
    this.hoverRing = new Sprite(this.assets.get('fx.hover'));
    for (const ring of [this.hoverRing, this.selectRing]) {
      ring.anchor.set(0.5, 0.5);
      ring.visible = false;
      ring.zIndex = -1;
      this.objectLayer.addChild(ring);
    }
  }

  /** Create sprites for any building that does not have one yet. */
  syncBuildings() {
    this.world.buildings.forEach((building) => {
      if (this.buildings.has(building.id)) {
        this.buildings.get(building.id)!.building = building;
        return;
      }
      const artKey = buildingArtKey(building.type, building.id);
      const meta = this.assets.buildingMeta.get(artKey);
      if (!meta) return;
      const height = this.map.heightAt(building.x, building.y);
      const pos = worldToScreen(building.x, building.y, height);

      const base = new Sprite(this.assets.get(`building.${artKey}`));
      base.anchor.set(0.5, meta.anchorY);
      base.position.set(pos.x, pos.y);
      // Slight bias so citizens standing at the door sort in front of the wall.
      base.zIndex = depthOf(building.x, building.y, -0.35);
      base.eventMode = 'static';
      base.cursor = 'pointer';
      base.on('pointerover', () => this.setHover({ kind: 'building', id: building.id }));
      base.on('pointerout', () => this.setHover(null));
      base.on('pointertap', () => this.tap({ kind: 'building', id: building.id }));
      this.objectLayer.addChild(base);

      const lit = new Sprite(this.assets.get(`building.${artKey}.lit`));
      lit.anchor.set(0.5, meta.anchorY);
      lit.position.set(pos.x, pos.y);
      lit.alpha = 0;
      this.lightsRoot.addChild(lit);

      let glow: Sprite | undefined;
      if (['Tavern', 'Bakery', 'Blacksmith', 'Market', 'Bank'].includes(building.type)) {
        glow = new Sprite(this.assets.get('fx.lampglow'));
        glow.anchor.set(0.5, 0.5);
        glow.position.set(pos.x, pos.y - meta.height * 0.35);
        glow.scale.set(2.2);
        glow.alpha = 0;
        this.lightsRoot.addChild(glow);
      }

      let wheel: Sprite | undefined;
      if (building.type === 'Mill') {
        wheel = new Sprite(this.assets.get('overlay.mill.wheel.0'));
        wheel.anchor.set(0.5, 0.5);
        wheel.position.set(pos.x - meta.width * 0.36, pos.y - 22);
        wheel.zIndex = depthOf(building.x, building.y, -0.3);
        this.objectLayer.addChild(wheel);
      }

      const { badge, icon, text } = this.makeBadge();
      this.hudRoot.addChild(badge);

      // Construction clears the ground it stands on, so a new building never
      // grows a tree through its roof.
      for (const entry of this.propSprites) {
        if (entry.cleared) continue;
        const dx = entry.prop.wx - building.x;
        const dy = entry.prop.wy - building.y;
        if (dx * dx + dy * dy < 30) { entry.cleared = true; entry.sprite.visible = false; entry.sprite.renderable = false; }
      }

      const doorWorld = screenToWorld(meta.door[0], meta.door[1]);
      this.buildings.set(building.id, {
        building, base, lit, glow, wheel, artKey, height,
        badge, badgeIcon: icon, badgeText: text,
        door: { x: building.x + doorWorld.x, y: building.y + doorWorld.y },
        chimney: meta.chimney ? { x: meta.chimney[0], y: meta.chimney[1] } : undefined,
      });
    });
  }

  private makeBadge() {
    const badge = new Container();
    badge.visible = false;
    const bg = new Graphics();
    bg.roundRect(-19, -11, 38, 22, 11).fill({ color: 0x0b1a10, alpha: 0.88 }).stroke({ width: 1, color: 0x3f6b46 });
    const icon = new Sprite(this.assets.get('icon.work'));
    icon.anchor.set(0.5, 0.5);
    icon.position.set(-7, 0);
    icon.scale.set(1.1);
    const text = new Text({
      text: '0',
      style: { fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 12, fontWeight: '700', fill: 0xd9f3c4 },
    });
    text.anchor.set(0.5, 0.5);
    text.position.set(8, 0);
    badge.addChild(bg, icon, text);
    return { badge, icon, text };
  }

  /** Create and retire citizen sprites so the scene matches the population. */
  syncCitizens() {
    const seen = new Set<string>();
    for (const citizen of this.world.citizens) {
      seen.add(citizen.id);
      if (this.citizens.has(citizen.id)) continue;
      const sprite = new CitizenSprite(this.assets, citizen);
      sprite.container.eventMode = 'static';
      sprite.container.cursor = 'pointer';
      sprite.container.hitArea = new Rectangle(-9, -32, 18, 34);
      sprite.container.on('pointerover', () => this.setHover({ kind: 'citizen', id: citizen.id }));
      sprite.container.on('pointerout', () => this.setHover(null));
      sprite.container.on('pointertap', () => this.tap({ kind: 'citizen', id: citizen.id }));
      this.objectLayer.addChild(sprite.container);
      this.citizens.set(citizen.id, sprite);
    }
    for (const [id, sprite] of this.citizens) {
      if (seen.has(id)) continue;
      sprite.destroy();
      this.citizens.delete(id);
    }
  }

  private buildBubbles() {
    for (let i = 0; i < MAX_BUBBLES; i++) {
      const root = new Container();
      root.visible = false;
      const bg = new Graphics();
      const label = new Text({
        text: '',
        style: {
          fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 12,
          fill: 0x22331f, wordWrap: true, wordWrapWidth: 150, lineHeight: 15,
        },
      });
      label.position.set(9, 7);
      root.addChild(bg, label);
      this.hudRoot.addChild(root);
      this.bubbles.push({ root, bg, label, citizenId: null, text: '', life: 0 });
    }
  }

  private buildParticles() {
    for (let i = 0; i < SMOKE_POOL; i++) {
      const sprite = new Sprite(this.assets.get('fx.smoke'));
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      this.fxLayer.addChild(sprite);
      this.smoke.push({ sprite, vx: 0, vy: 0, life: 0, max: 1 });
    }
    for (let i = 0; i < WEATHER_POOL; i++) {
      const sprite = new Sprite(this.assets.get('fx.rain'));
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      this.weatherLayer.addChild(sprite);
      this.weatherParticles.push({ sprite, vx: 0, vy: 0, life: 0, max: 1 });
    }
    for (let i = 0; i < 7; i++) {
      const sprite = new Sprite(this.assets.get('fx.bird.0'));
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      this.fxLayer.addChild(sprite);
      this.birds.push({ sprite, vx: 0, vy: 0, life: 0, max: 1 });
    }
    for (let i = 0; i < 40; i++) {
      const sprite = new Sprite(this.assets.get('fx.splash.0'));
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      this.fxLayer.addChild(sprite);
      this.splashes.push({ sprite, vx: 0, vy: 0, life: 0, max: 1 });
    }
    for (let i = 0; i < 46; i++) {
      const sprite = new Sprite(this.assets.get('fx.firefly'));
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      this.fxLayer.addChild(sprite);
      this.motes.push({ sprite, vx: 0, vy: 0, life: 0, max: 1 });
    }
  }

  /* ---------------------------------------------------------------- *
   * Camera
   * ---------------------------------------------------------------- */

  private onResize() {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    const sceneW = SCENE_BOUNDS.maxX - SCENE_BOUNDS.minX;
    const sceneH = SCENE_BOUNDS.maxY - SCENE_BOUNDS.minY;
    // Never zoom out past the point where the world stops filling the viewport.
    this.minZoom = Math.max(w / sceneW, h / sceneH, 0.35);
    this.ambient.width = w; this.ambient.height = h;
    this.vignette.width = w; this.vignette.height = h;
    this.seasonWash.width = w; this.seasonWash.height = h;
    this.applyCamera();
  }

  /** Clamp the camera so the viewport can never show outside the world. */
  private applyCamera() {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom));
    const halfW = w / (2 * zoom);
    const halfH = h / (2 * zoom);
    const { minX, maxX, minY, maxY } = SCENE_BOUNDS;

    this.camera.zoom = zoom;
    this.camera.x = maxX - minX <= halfW * 2 ? (minX + maxX) / 2 : Math.max(minX + halfW, Math.min(maxX - halfW, this.camera.x));
    this.camera.y = maxY - minY <= halfH * 2 ? (minY + maxY) / 2 : Math.max(minY + halfH, Math.min(maxY - halfH, this.camera.y));

    // Snap the world to whole device pixels. A fractional offset makes every
    // texel straddle two pixels, which reads as a permanent shimmer.
    const res = this.app.renderer.resolution || 1;
    const snap = (v: number) => Math.round(v * res) / res;
    const px = snap(w / 2 - this.camera.x * zoom);
    const py = snap(h / 2 - this.camera.y * zoom);
    for (const root of [this.worldRoot, this.lightsRoot]) {
      root.position.set(px, py);
      root.scale.set(zoom);
    }
    this.callbacks.onCamera?.(zoom);
  }

  /** Point the camera at a world position. */
  centreOn(wx: number, wy: number, zoom?: number) {
    const pos = worldToScreen(wx, wy, this.map?.heightAt(wx, wy) ?? 0);
    this.camera.x = pos.x;
    this.camera.y = pos.y;
    if (zoom !== undefined) this.camera.zoom = zoom;
    this.applyCamera();
  }

  panBy(dx: number, dy: number) {
    // Taking the camera by hand means you want to look somewhere else.
    if (Math.abs(dx) + Math.abs(dy) > 2) this.followId = null;
    this.camera.x -= dx / this.camera.zoom;
    this.camera.y -= dy / this.camera.zoom;
    this.applyCamera();
  }

  zoomBy(factor: number, anchorX?: number, anchorY?: number) {
    const w = this.app.renderer.width, h = this.app.renderer.height;
    const ax = anchorX ?? w / 2, ay = anchorY ?? h / 2;
    const before = this.screenToScene(ax, ay);
    this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom * factor));
    this.applyCamera();
    const after = this.screenToScene(ax, ay);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.applyCamera();
  }

  get zoom() { return this.camera.zoom; }
  get zoomRange() { return { min: this.minZoom, max: this.maxZoom }; }

  private screenToScene(sx: number, sy: number) {
    return {
      x: (sx - this.worldRoot.position.x) / this.camera.zoom,
      y: (sy - this.worldRoot.position.y) / this.camera.zoom,
    };
  }

  /** Scene pixels to screen pixels, for placing HUD elements over the world. */
  private sceneToScreen(x: number, y: number) {
    return {
      x: x * this.camera.zoom + this.worldRoot.position.x,
      y: y * this.camera.zoom + this.worldRoot.position.y,
    };
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  /**
   * Pan, zoom and pick, from a mouse or from fingers.
   *
   * Every live pointer is tracked rather than just the last one, because that is
   * what pinch needs: with two down, the distance between them drives the zoom
   * and their midpoint drives the pan, so the world scales about the point
   * being pinched the way a map does.
   */
  private attachInput() {
    const canvas = this.app.canvas;
    const points = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;
    let pinchCentre = { x: 0, y: 0 };

    const centreOfPoints = () => {
      let x = 0, y = 0;
      for (const p of points.values()) { x += p.x; y += p.y; }
      return { x: x / points.size, y: y / points.size };
    };
    const spreadOfPoints = () => {
      const [a, b] = [...points.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    canvas.addEventListener('pointerdown', (e) => {
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (points.size === 2) {
        pinchDistance = spreadOfPoints();
        pinchCentre = centreOfPoints();
        // A pinch is not a tap, and it is not a drag either.
        this.dragging = false;
        this.dragMoved = 99;
        return;
      }
      this.dragging = true;
      this.dragMoved = 0;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (points.size >= 2) {
        const spread = spreadOfPoints();
        const centre = centreOfPoints();
        const rect = canvas.getBoundingClientRect();
        if (pinchDistance > 0 && spread > 0) {
          this.zoomBy(spread / pinchDistance, centre.x - rect.left, centre.y - rect.top);
        }
        // Two fingers moving together pan as well as scale.
        this.panBy(centre.x - pinchCentre.x, centre.y - pinchCentre.y);
        pinchDistance = spread;
        pinchCentre = centre;
        return;
      }

      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.panBy(dx, dy);
    });

    const end = (e: PointerEvent) => {
      points.delete(e.pointerId);
      if (points.size < 2) pinchDistance = 0;
      if (points.size === 1) {
        // Lifting one finger of a pinch resumes a one-finger drag from where
        // the remaining finger actually is, rather than jumping the camera.
        const [only] = [...points.values()];
        this.lastPointer = { x: only.x, y: only.y };
        this.dragging = true;
      } else if (points.size === 0) {
        this.dragging = false;
        canvas.style.cursor = 'grab';
      }
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.zoomBy(e.deltaY > 0 ? 0.9 : 1.1, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    // Safari answers a pinch with gesture events and no second pointer, so it
    // needs its own path or the world simply will not zoom on an iPhone.
    const gestureCapable = canvas as HTMLCanvasElement & { addEventListener: HTMLCanvasElement['addEventListener'] };
    let gestureScale = 1;
    gestureCapable.addEventListener('gesturestart', ((e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    }) as EventListener);
    gestureCapable.addEventListener('gesturechange', ((e: Event & { scale?: number }) => {
      e.preventDefault();
      const scale = e.scale ?? 1;
      if (gestureScale > 0 && scale > 0) this.zoomBy(scale / gestureScale);
      gestureScale = scale;
    }) as EventListener);
  }

  private setHover(target: PickTarget) {
    if (this.dragging) return;
    this.hovered = target;
    this.callbacks.onHover?.(target);
  }

  private tap(target: PickTarget) {
    // A tap that ended a pan is a camera move, not a selection.
    if (this.dragMoved > 6) return;
    this.selected = target;
    this.callbacks.onSelect?.(target);
  }

  /** Selection driven from the UI rather than a click on the map. */
  select(target: PickTarget) {
    this.selected = target;
  }

  /** Move the camera to a citizen or building and select it. */
  focus(target: PickTarget) {
    if (!target) return;
    const source = target.kind === 'citizen'
      ? this.world.citizens.find((c) => c.id === target.id)
      : this.world.buildings.find((b) => b.id === target.id);
    if (!source) return;
    this.selected = target;
    this.centreOn(source.x, source.y, Math.max(this.camera.zoom, 1.3));
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  /** Swap in a new world object without rebuilding the app. */
  setWorld(world: World) {
    this.world = world;
  }

  /**
   * Point the renderer at a different world.
   *
   * The Pixi application, its WebGL context and the generated texture atlas are
   * all kept: destroying and recreating a renderer leaves the cached textures
   * holding released GPU resources, and browsers cap how many live WebGL
   * contexts a page may have. So the scene graph is emptied and rebuilt instead.
   */
  reset(world: World) {
    this.world = world;
    this.map = generateWorldMap(world);
    // The backdrop survives the teardown below, so it is re-tinted here rather
    // than rebuilt — otherwise a desert claimed after a woodland keeps the
    // woodland's horizon.
    if (this.backdrop) this.backdrop.tint = BACKDROP_TINT[world.biome];

    for (const layer of [this.groundLayer, this.waterLayer, this.objectLayer, this.fxLayer, this.lightsRoot, this.hudRoot, this.weatherLayer]) {
      for (const child of layer.removeChildren()) child.destroy({ children: true });
    }

    this.citizens.clear();
    this.buildings.clear();
    this.propSprites = [];
    this.trees = [];
    this.foliage = [];
    this.waterSprites = [];
    this.waterfallSprites = [];
    this.campfires = [];
    this.lampGlows = [];
    this.bubbles = [];
    this.smoke = [];
    this.weatherParticles = [];
    this.motes = [];
    this.splashes = [];
    this.birds = [];
    this.minimapBase = null;
    this.selected = null;
    this.hovered = null;
    this.followId = null;
    this.lastDay = 0;
    this.lastSeason = '';
    this.waterFrame = -1;
    this.time = 0;

    this.buildTerrain();
    this.buildProps();
    this.buildRings();
    this.syncBuildings();
    this.syncCitizens();
    this.buildBubbles();
    this.buildParticles();
    this.centreOn(50, 49, 1.05);
  }

  /** How many bridges the drawn map was built with. */
  private bridgeCount = 0;

  /**
   * Repaint the ground, the water and the props without disturbing anything
   * else. Unlike `reset`, the camera, the citizens and the selection all
   * survive: this runs while the player is watching.
   */
  private rebuildGround() {
    if (!this.world) return;
    this.map = generateWorldMap(this.world);
    for (const layer of [this.groundLayer, this.waterLayer]) {
      for (const child of layer.removeChildren()) child.destroy({ children: true });
    }
    // Props live in the shared object layer alongside buildings and citizens,
    // and their glows live in the lights layer, so each is destroyed by hand
    // rather than by emptying a container.
    for (const entry of this.propSprites) entry.sprite.destroy();
    for (const glow of this.lampGlows) glow.destroy();
    for (const puff of this.smoke) puff.sprite.destroy();
    this.propSprites = [];
    this.trees = [];
    this.foliage = [];
    this.waterSprites = [];
    this.waterfallSprites = [];
    this.campfires = [];
    this.lampGlows = [];
    this.smoke = [];
    this.minimapBase = null;
    this.waterFrame = -1;
    this.buildTerrain();
    this.buildProps();
    this.lastSeason = '';
  }

  private update(dt: number) {
    if (!this.world) return;
    const clamped = Math.min(dt, 0.1);
    this.time += clamped;

    // A settlement that finishes a bridge changes the shape of its own map: a
    // new deck, a new road, new ground opened on the far shore. Repaint the
    // ground when that happens, and only then — it is a few tens of
    // milliseconds and it happens once every several game weeks.
    if (this.world.layout.bridges.length !== this.bridgeCount) {
      this.bridgeCount = this.world.layout.bridges.length;
      this.rebuildGround();
    }

    this.updateWater();
    this.updateProps(clamped);
    this.updateBuildings(clamped);
    this.updateCitizens(clamped);
    this.updateRings();
    this.updateLighting();
    this.updateSmoke(clamped);
    this.updateWeather(clamped);
    this.updateMotes(clamped);
    this.updateSplashes(clamped);
    this.updateBirds(clamped);
    this.updateForestry(clamped);
    this.updateSeason();
    this.updateFollow(clamped);
    this.updateBubbles(clamped);

    this.cullTimer += clamped;
    if (this.cullTimer > 0.25) { this.cullTimer = 0; this.cullStatic(); }
  }

  private updateWater() {
    const frame = Math.floor(this.time * 5) % 4;
    if (frame === this.waterFrame) return;
    this.waterFrame = frame;
    for (const { sprite, kind } of this.waterSprites) {
      sprite.texture = this.assets.get(kind === 'water' ? `tile.water.${frame}` : `tile.watershore.${frame}`);
    }
    for (const sprite of this.waterfallSprites) sprite.texture = this.assets.get(`tile.waterfall.${frame}`);
    for (const sprite of this.campfires) sprite.texture = this.assets.get(`prop.campfire.${frame % 2}`);
  }
  private waterFrame = -1;

  private updateProps(dt: number) {
    void dt;
    // Only the canopy responds to wind; trunks, rocks and timber stay put.
    const wind = this.world.weather === 'Storm' ? 3.2 : this.world.weather === 'Rain' ? 1.6 : 1;
    for (const entry of this.propSprites) {
      if (entry.prop.sway < 0.5 || !entry.sprite.visible) continue;
      entry.sprite.rotation = Math.sin(this.time * 1.3 + entry.phase) * 0.012 * entry.prop.sway * wind;
    }
  }

  private updateBuildings(dt: number) {
    void dt;
    const wheelFrame = Math.floor(this.time * 6) % 4;
    const byId = new Map(this.world.citizens.map((c) => [c.id, c]));
    for (const view of this.buildings.values()) {
      const occupants = view.building.workers.length;
      if (occupants > 0) {
        const first = byId.get(view.building.workers[0]);
        const icon = view.building.production ? 'work'
          : first?.activity === 'eating' ? 'eat'
            : first?.activity === 'resting' ? 'sleep'
              : view.building.type === 'Market' ? 'trade' : 'social';
        view.badgeIcon.texture = this.assets.get(`icon.${icon}`);
        view.badgeText.text = String(occupants);
        const anchor = this.sceneToScreen(view.base.x, view.base.y - view.base.height * view.base.anchor.y - 12);
        view.badge.position.set(anchor.x, anchor.y);
        view.badge.visible = this.camera.zoom > 0.6;
      } else {
        view.badge.visible = false;
      }
      if (view.wheel) view.wheel.texture = this.assets.get(`overlay.mill.wheel.${wheelFrame}`);
    }
  }

  private updateCitizens(dt: number) {
    for (const citizen of this.world.citizens) {
      const sprite = this.citizens.get(citizen.id);
      if (!sprite) continue;
      let door: { x: number; y: number } | undefined;
      if (citizen.inside && citizen.targetBuildingId) {
        door = this.buildings.get(citizen.targetBuildingId)?.door;
      }
      const height = this.map.heightAt(sprite.wx, sprite.wy);
      sprite.update(citizen, dt, height, door);
      sprite.container.zIndex = depthOf(sprite.wx, sprite.wy, 0.1);
    }
  }

  private updateRings() {
    const place = (ring: Sprite, target: PickTarget) => {
      if (!target) { ring.visible = false; return; }
      if (target.kind === 'citizen') {
        const sprite = this.citizens.get(target.id);
        if (!sprite) { ring.visible = false; return; }
        const h = this.map.heightAt(sprite.wx, sprite.wy);
        const pos = worldToScreen(sprite.wx, sprite.wy, h);
        ring.position.set(pos.x, pos.y);
        ring.scale.set(0.55);
        ring.zIndex = depthOf(sprite.wx, sprite.wy, -0.05);
      } else {
        const view = this.buildings.get(target.id);
        if (!view) { ring.visible = false; return; }
        const b = view.building;
        const pos = worldToScreen(b.x, b.y, view.height);
        ring.position.set(pos.x, pos.y);
        ring.scale.set(1.5);
        ring.zIndex = depthOf(b.x, b.y, -0.5);
      }
      ring.visible = true;
    };
    place(this.selectRing, this.selected);
    place(this.hoverRing, this.hovered && (!this.selected || this.hovered.id !== this.selected.id) ? this.hovered : null);
    this.selectRing.alpha = 0.55 + Math.sin(this.time * 3) * 0.25;
  }

  /** Time-of-day and weather wash, plus everything that lights up after dark. */
  private updateLighting() {
    const hour = this.world.hour;
    let a = AMBIENT[0], b = AMBIENT[AMBIENT.length - 1];
    for (let i = 0; i < AMBIENT.length - 1; i++) {
      if (hour >= AMBIENT[i].hour && hour <= AMBIENT[i + 1].hour) { a = AMBIENT[i]; b = AMBIENT[i + 1]; break; }
    }
    const t = b.hour === a.hour ? 0 : (hour - a.hour) / (b.hour - a.hour);
    const lerp = (x: number, y: number) => x + (y - x) * t;
    const mixChannel = (shift: number) => lerp((a.color >> shift) & 255, (b.color >> shift) & 255);
    const color = (Math.round(mixChannel(16)) << 16) | (Math.round(mixChannel(8)) << 8) | Math.round(mixChannel(0));
    const alpha = lerp(a.alpha, b.alpha);

    const weather = WEATHER_TINT[this.world.weather] ?? WEATHER_TINT.Clear;
    this.ambient.tint = color;
    this.ambient.alpha = Math.min(0.72, alpha + weather.alpha * 0.6);
    this.seasonWash.tint = SEASON_TINT[this.world.season] ?? 0xffffff;
    this.seasonWash.alpha = this.world.season === 'Spring' ? 0 : 0.2;

    // Full-screen passes are the most expensive thing the renderer does, so any
    // that would contribute nothing this frame is switched off outright.
    this.ambient.visible = this.ambient.alpha > 0.01;
    this.seasonWash.visible = this.seasonWash.alpha > 0.01;

    // Lights come up as the ambient wash darkens.
    const night = Math.max(0, Math.min(1, (alpha - 0.1) / 0.34));
    this.lightsRoot.visible = night > 0.02;
    this.weatherLayer.visible = ['Rain', 'Storm', 'Snow'].includes(this.world.weather);
    for (const view of this.buildings.values()) {
      view.lit.alpha = night * 0.95;
      if (view.glow) view.glow.alpha = night * 0.45;
    }
    for (const glow of this.lampGlows) glow.alpha = night * 0.6;
    this.nightAmount = night;
  }
  private nightAmount = 0;

  private updateSmoke(dt: number) {
    // Emit from any chimney whose building is actively producing.
    for (const view of this.buildings.values()) {
      if (!view.chimney || !view.building.production) continue;
      if (Math.random() > dt * 3.2) continue;
      const particle = this.smoke.find((p) => p.life <= 0);
      if (!particle) break;
      particle.sprite.visible = true;
      particle.sprite.position.set(view.base.x + view.chimney.x, view.base.y + view.chimney.y);
      particle.sprite.scale.set(0.35);
      particle.vx = 6 + Math.random() * 8;
      particle.vy = -16 - Math.random() * 8;
      particle.max = 2.6 + Math.random();
      particle.life = particle.max;
    }
    for (const p of this.smoke) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = 1 - p.life / p.max;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.scale.set(0.35 + k * 1.1);
      p.sprite.alpha = Math.max(0, 0.5 * (1 - k));
      if (p.life <= 0) p.sprite.visible = false;
    }
  }

  private updateWeather(dt: number) {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    const weather = this.world.weather;
    const raining = weather === 'Rain' || weather === 'Storm';
    const snowing = weather === 'Snow';
    const target = raining ? (weather === 'Storm' ? WEATHER_POOL : 180) : snowing ? 150 : 0;

    let active = 0;
    for (const p of this.weatherParticles) {
      if (p.life > 0) {
        active++;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.y += p.vy * dt;
        if (p.sprite.position.y > h + 20 || p.sprite.position.x < -30 || p.sprite.position.x > w + 30) p.life = 0;
        if (p.life <= 0) p.sprite.visible = false;
        continue;
      }
      if (active >= target) continue;
      active++;
      p.sprite.texture = this.assets.get(snowing ? 'fx.snow' : 'fx.rain');
      p.sprite.visible = true;
      p.sprite.alpha = snowing ? 0.85 : 0.55;
      p.sprite.position.set(Math.random() * (w + 200) - 100, -Math.random() * h);
      if (snowing) {
        p.vx = -12 + Math.random() * 24;
        p.vy = 42 + Math.random() * 34;
        p.sprite.scale.set(0.7 + Math.random() * 0.8);
      } else {
        p.vx = weather === 'Storm' ? -180 : -70;
        p.vy = weather === 'Storm' ? 900 : 620;
        p.sprite.scale.set(1, 0.8 + Math.random() * 0.7);
      }
      p.life = 12;
    }
  }

  /**
   * Splashes where rain lands. Weather that only falls in front of the camera
   * never quite convinces; a few rings on the ground tie it to the world.
   */
  private updateSplashes(dt: number) {
    const raining = this.world.weather === 'Rain' || this.world.weather === 'Storm';
    for (const p of this.splashes) {
      if (p.life > 0) {
        p.life -= dt;
        const k = 1 - p.life / p.max;
        p.sprite.texture = this.assets.get(`fx.splash.${Math.min(2, Math.floor(k * 3))}`);
        p.sprite.alpha = 0.7 * (1 - k);
        if (p.life <= 0) p.sprite.visible = false;
        continue;
      }
      if (!raining || Math.random() > dt * (this.world.weather === 'Storm' ? 26 : 12)) continue;
      const wx = 4 + Math.random() * 92;
      const wy = 6 + Math.random() * 88;
      const pos = worldToScreen(wx, wy, this.map.heightAt(wx, wy));
      p.sprite.visible = true;
      p.sprite.position.set(pos.x, pos.y);
      p.max = 0.45;
      p.life = p.max;
    }
  }

  /** Fireflies after dark in the warm seasons; drifting leaves in autumn. */
  private updateMotes(dt: number) {
    const autumn = this.world.season === 'Autumn';
    const active = autumn || this.nightAmount > 0.35;
    for (const p of this.motes) {
      if (p.life > 0) {
        p.life -= dt;
        p.sprite.position.x += p.vx * dt;
        p.sprite.position.y += p.vy * dt + Math.sin(this.time * 2 + p.max) * 6 * dt;
        const k = p.life / p.max;
        p.sprite.alpha = Math.sin(Math.min(1, k) * Math.PI) * (autumn ? 0.9 : 0.75);
        if (p.life <= 0) p.sprite.visible = false;
        continue;
      }
      if (!active || Math.random() > dt * 2) continue;
      p.sprite.texture = this.assets.get(autumn ? `fx.leaf.${Math.floor(Math.random() * 3)}` : 'fx.firefly');
      p.sprite.visible = true;
      const wx = 10 + Math.random() * 80;
      const wy = 10 + Math.random() * 80;
      const pos = worldToScreen(wx, wy, this.map.heightAt(wx, wy));
      p.sprite.position.set(pos.x, pos.y - 20 - Math.random() * 60);
      p.vx = autumn ? -22 - Math.random() * 26 : -8 + Math.random() * 16;
      p.vy = autumn ? 12 + Math.random() * 10 : -4 + Math.random() * 8;
      p.max = 6 + Math.random() * 5;
      p.life = p.max;
    }
  }

  /**
   * Speech bubbles. A handful of visible, outdoor citizens are given a line at a
   * time and the set rotates, which keeps the settlement chattering without
   * turning the screen into a wall of text.
   */
  private updateBubbles(dt: number) {
    this.bubbleTimer -= dt;
    if (this.bubbleTimer <= 0) {
      this.bubbleTimer = BUBBLE_ROTATE;
      this.beat++;
      this.assignBubbles();
    }
    const w = this.app.renderer.width, h = this.app.renderer.height;
    // Where the bubbles already placed this frame are sitting, so the next one
    // can be lifted clear of them. Two people talking to each other stand a
    // few paces apart by definition, which put their two bubbles in exactly
    // the same piece of sky and made an exchange unreadable.
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    for (const bubble of this.bubbles) {
      if (!bubble.citizenId) { bubble.root.visible = false; continue; }
      const sprite = this.citizens.get(bubble.citizenId);
      const citizen = this.world.citizens.find((c) => c.id === bubble.citizenId);
      if (!sprite || !citizen) { bubble.root.visible = false; continue; }
      const height = this.map.heightAt(sprite.wx, sprite.wy);
      const scene = worldToScreen(sprite.wx, sprite.wy, height);
      const pos = this.sceneToScreen(scene.x, scene.y + sprite.headOffset * this.camera.zoom / this.camera.zoom);
      const bw = bubble.root.width, bh = bubble.root.height;
      const x = pos.x - bw / 2;
      let y = pos.y - 34 * this.camera.zoom - bh;

      // Lift it above anything it would land on, up to a few tries. Overlapping
      // is preferred to flying off the top of the screen, so the search stops
      // rather than climbing forever.
      for (let attempt = 0; attempt < 4; attempt++) {
        const clash = taken.find((t) =>
          x < t.x + t.w + 6 && x + bw + 6 > t.x && y < t.y + t.h + 4 && y + bh + 4 > t.y);
        if (!clash) break;
        y = clash.y - bh - 6;
      }
      taken.push({ x, y, w: bw, h: bh });

      bubble.root.position.set(Math.round(x), Math.round(y));
      // Hide rather than let a bubble slide under the side panels or off screen.
      const clearOfPanels = x > 24 && x + bw < w - 296;
      bubble.root.visible = clearOfPanels && y > 96 && y < h - 190 && this.camera.zoom > 0.55;
      bubble.life -= dt;
    }
  }

  private assignBubbles() {
    const candidates = this.world.citizens.filter((c) => !c.inside && c.age >= 10);
    // Prefer whoever is selected, then citizens nearest the middle of the view.
    const centre = this.screenToScene(this.app.renderer.width / 2, this.app.renderer.height / 2);
    // Anyone mid-conversation is worth showing over anyone musing to
    // themselves: an exchange only reads as one if both sides of it are on
    // screen, and there are only so many bubbles.
    const talking = new Set<string>();
    for (const talk of this.world.conversations) { talking.add(talk.a); talking.add(talk.b); }
    const scored = candidates.map((c) => {
      const sprite = this.citizens.get(c.id);
      const pos = sprite ? worldToScreen(sprite.wx, sprite.wy) : { x: 0, y: 0 };
      const d = Math.hypot(pos.x - centre.x, pos.y - centre.y);
      const priority = this.selected?.kind === 'citizen' && this.selected.id === c.id
        ? -1e6
        : talking.has(c.id) ? d - 5000 : d;
      return { c, priority };
    }).sort((a, b) => a.priority - b.priority);

    let index = 0;
    const spoken = new Set<string>();
    for (const bubble of this.bubbles) {
      let assigned = false;
      while (index < scored.length) {
        const citizen = scored[index++].c;
        const line = speechFor(this.world, citizen, this.beat);
        if (!line) continue;
        // Two citizens saying the same thing at once reads as a bug, not a crowd.
        if (spoken.has(line)) continue;
        spoken.add(line);
        if (bubble.citizenId !== citizen.id || bubble.text !== line) {
          bubble.citizenId = citizen.id;
          bubble.text = line;
          bubble.label.text = line;
          const bw = Math.ceil(bubble.label.width) + 18;
          const bh = Math.ceil(bubble.label.height) + 14;
          bubble.bg.clear();
          bubble.bg.roundRect(0, 0, bw, bh, 7).fill({ color: 0xf1f3e4, alpha: 0.95 });
          bubble.bg.moveTo(bw / 2 - 6, bh).lineTo(bw / 2, bh + 7).lineTo(bw / 2 + 6, bh).fill({ color: 0xf1f3e4, alpha: 0.95 });
        }
        bubble.life = BUBBLE_ROTATE;
        bubble.root.visible = true;
        assigned = true;
        break;
      }
      if (!assigned) { bubble.citizenId = null; bubble.root.visible = false; }
    }
  }

  /** Hide anything outside the viewport so offscreen props cost nothing. */
  private cullStatic() {
    const pad = 220;
    const topLeft = this.screenToScene(-pad, -pad);
    const bottomRight = this.screenToScene(this.app.renderer.width + pad, this.app.renderer.height + pad);
    const inView = (x: number, y: number) => x > topLeft.x && x < bottomRight.x && y > topLeft.y && y < bottomRight.y;

    for (const entry of this.propSprites) entry.sprite.visible = !entry.cleared && inView(entry.sprite.x, entry.sprite.y);
    for (const entry of this.waterSprites) entry.sprite.visible = inView(entry.sprite.x + TILE_W / 2, entry.sprite.y + TILE_H / 2);
    for (const child of this.groundLayer.children) child.visible = inView(child.x + TILE_W / 2, child.y + TILE_H / 2);
  }

  /* ---------------------------------------------------------------- *
   * Forestry
   * ---------------------------------------------------------------- */

  /**
   * Fell and regrow trees.
   *
   * Once per game day the woodcutters' actual output decides how many trees
   * come down, and they come down nearest the camps that cut them. A felled
   * tree tips over, leaves a stump, puts out a sapling and eventually grows
   * back, so a worked wood visibly thins and recovers.
   */
  private updateForestry(dt: number) {
    if (this.world.day !== this.lastDay) {
      const newDay = this.lastDay !== 0;
      this.lastDay = this.world.day;
      if (newDay) {
        this.fellTrees(this.world.flow.produced.wood ?? 0);
        this.growTrees();
      }
    }

    for (const tree of this.trees) {
      if (tree.state !== 'falling') continue;
      tree.timer -= dt;
      const t = Math.max(0, Math.min(1, 1 - tree.timer / FALL_SECONDS));
      // Slow start, fast finish: a tree hesitates before it goes over.
      tree.sprite.rotation = (t * t) * 1.45 * (tree.wx % 2 === 0 ? 1 : -1);
      if (tree.timer <= 0) {
        tree.sprite.rotation = 0;
        tree.sprite.texture = this.assets.get('prop.stump');
        tree.sprite.scale.set(tree.scale);
        tree.state = 'stump';
        tree.timer = 4 + (Math.abs(tree.wx * 7) % 4);
        this.burstLeaves(tree.wx, tree.wy);
      }
    }
  }

  private fellTrees(woodProduced: number) {
    const camps = this.world.buildings.filter((b) => b.type === 'Woodcutter' && b.active);
    if (!camps.length || woodProduced <= 0) return;
    // One tree for roughly every cartload of timber.
    const count = Math.min(6, Math.round(woodProduced / 14));
    if (count <= 0) return;

    const camp = camps[this.world.day % camps.length];
    const standing = this.trees
      .filter((t) => t.state === 'standing')
      .map((t) => ({ t, d: (t.wx - camp.x) ** 2 + (t.wy - camp.y) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count * 4);

    for (let i = 0; i < count && standing.length; i++) {
      // Pick from the nearest cluster rather than always the single closest, so
      // a camp does not eat a perfect circle out of the wood.
      const pick = standing.splice(Math.floor((this.world.counter + i * 7) % standing.length), 1)[0];
      pick.t.state = 'falling';
      pick.t.timer = FALL_SECONDS;
      pick.t.sprite.visible = true;
    }
  }

  private growTrees() {
    for (const tree of this.trees) {
      if (tree.state === 'standing' || tree.state === 'falling') continue;
      tree.timer -= 1;
      if (tree.timer > 0) continue;
      if (tree.state === 'stump') {
        tree.state = 'sapling';
        tree.sprite.texture = this.assets.get('prop.sapling');
        tree.sprite.scale.set(tree.scale * 0.8);
        tree.timer = 4 + (Math.abs(tree.wy * 5) % 4);
      } else {
        tree.state = 'standing';
        tree.sprite.texture = tree.texture;
        tree.sprite.scale.set(tree.scale);
      }
    }
  }

  private burstLeaves(wx: number, wy: number) {
    const pos = worldToScreen(wx, wy, this.map.heightAt(wx, wy));
    for (let i = 0; i < 7; i++) {
      const p = this.motes.find((m) => m.life <= 0);
      if (!p) break;
      p.sprite.texture = this.assets.get(`fx.leaf.${i % 3}`);
      p.sprite.visible = true;
      p.sprite.position.set(pos.x + (Math.random() - 0.5) * 30, pos.y - 30 - Math.random() * 30);
      p.vx = (Math.random() - 0.5) * 40;
      p.vy = 14 + Math.random() * 20;
      p.max = 1.6 + Math.random();
      p.life = p.max;
    }
  }

  /* ---------------------------------------------------------------- *
   * Seasons, birds and the follow camera
   * ---------------------------------------------------------------- */

  /** Turn the woods with the year. Only runs when the season actually changes. */
  private updateSeason() {
    if (this.world.season === this.lastSeason) return;
    this.lastSeason = this.world.season;
    const tint = FOLIAGE_SEASON[this.world.season] ?? 0xffffff;
    for (const leaf of this.foliage) leaf.sprite.tint = tint;
  }

  private updateBirds(dt: number) {
    const frame = Math.floor(this.time * 7) % 2;
    for (const b of this.birds) {
      if (b.life > 0) {
        b.life -= dt;
        b.sprite.position.x += b.vx * dt;
        b.sprite.position.y += b.vy * dt + Math.sin(this.time * 2.4 + b.max) * 9 * dt;
        b.sprite.texture = this.assets.get(`fx.bird.${frame}`);
        if (b.life <= 0) b.sprite.visible = false;
        continue;
      }
      // Birds are a daytime thing, and rare enough to feel like a moment.
      if (this.nightAmount > 0.4 || Math.random() > dt * 0.16) continue;
      const fromLeft = Math.random() < 0.5;
      const start = worldToScreen(fromLeft ? 4 : 96, 8 + Math.random() * 70);
      b.sprite.visible = true;
      b.sprite.alpha = 0.85;
      b.sprite.scale.set(0.8 + Math.random() * 0.7);
      b.sprite.position.set(start.x, start.y - 150 - Math.random() * 90);
      b.vx = (fromLeft ? 1 : -1) * (90 + Math.random() * 70);
      b.vy = -10 + Math.random() * 26;
      b.sprite.scale.x = Math.abs(b.sprite.scale.x) * (fromLeft ? 1 : -1);
      b.max = 14 + Math.random() * 8;
      b.life = b.max;
    }
  }

  /** Keep the camera on one citizen as they go about their day. */
  private updateFollow(dt: number) {
    if (!this.followId) return;
    const sprite = this.citizens.get(this.followId);
    if (!sprite) { this.followId = null; return; }
    const pos = worldToScreen(sprite.wx, sprite.wy, this.map.heightAt(sprite.wx, sprite.wy));
    const k = Math.min(1, dt * 3.2);
    this.camera.x += (pos.x - this.camera.x) * k;
    this.camera.y += (pos.y - this.camera.y) * k;
    this.applyCamera();
  }

  /**
   * The state of the woodland. Surfaced so the interface can show the forest
   * shrinking and recovering as the woodcutters work it.
   */
  woodland() {
    let standing = 0, stumps = 0, saplings = 0;
    for (const tree of this.trees) {
      if (tree.state === 'standing') standing++;
      else if (tree.state === 'sapling') saplings++;
      else stumps++;
    }
    return { standing, stumps, saplings, total: this.trees.length };
  }

  /** Follow a citizen, or pass null to stop. */
  setFollow(id: string | null) {
    this.followId = id;
    if (id) this.camera.zoom = Math.max(this.camera.zoom, 1.35);
  }

  get following() { return this.followId; }

  /* ---------------------------------------------------------------- *
   * Minimap
   * ---------------------------------------------------------------- */

  private minimapBase: HTMLCanvasElement | null = null;

  /** Bake the terrain into a small isometric image once. */
  private buildMinimapBase() {
    const scale = 4;
    const w = this.map.grid * scale;
    const h = this.map.grid * (scale / 2) + scale;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const half = w / 2;
    for (let ty = 0; ty < this.map.grid; ty++) {
      for (let tx = 0; tx < this.map.grid; tx++) {
        const kind = this.map.tiles[ty * this.map.grid + tx] as Tile;
        ctx.fillStyle = TILE_COLOR[kind];
        const x = half + (tx - ty) * (scale / 2) - scale / 2;
        const y = (tx + ty) * (scale / 4) - this.map.steps[ty * this.map.grid + tx] * 1.5;
        ctx.fillRect(x, y, scale, scale / 2 + 1);
      }
    }
    this.minimapBase = canvas;
  }

  /** Draw the world map plus live citizens, buildings and the viewport frame. */
  drawMinimap(target: HTMLCanvasElement) {
    if (!this.map) return;
    if (!this.minimapBase) this.buildMinimapBase();
    const ctx = target.getContext('2d');
    if (!ctx || !this.minimapBase) return;
    const w = target.width, h = target.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.minimapBase, 0, 0, w, h);

    const project = (wx: number, wy: number) => {
      const p = worldToScreen(wx, wy);
      const sceneW = SCENE_BOUNDS.maxX - SCENE_BOUNDS.minX;
      return {
        x: ((p.x - SCENE_BOUNDS.minX) / sceneW) * w,
        y: (p.y / (GRID * TILE_H)) * h,
      };
    };

    ctx.fillStyle = '#e8c169';
    for (const b of this.world.buildings) {
      const p = project(b.x, b.y);
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    ctx.fillStyle = '#c9ffab';
    for (const sprite of this.citizens.values()) {
      const p = project(sprite.wx, sprite.wy);
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }

    // Viewport frame.
    const tl = this.screenToScene(0, 0);
    const br = this.screenToScene(this.app.renderer.width, this.app.renderer.height);
    const sceneW = SCENE_BOUNDS.maxX - SCENE_BOUNDS.minX;
    const x0 = ((tl.x - SCENE_BOUNDS.minX) / sceneW) * w;
    const x1 = ((br.x - SCENE_BOUNDS.minX) / sceneW) * w;
    const y0 = (tl.y / (GRID * TILE_H)) * h;
    const y1 = (br.y / (GRID * TILE_H)) * h;
    ctx.strokeStyle = 'rgba(232,240,214,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
  }

  /** Move the camera to the point clicked on the minimap. */
  minimapJump(u: number, v: number) {
    const sceneW = SCENE_BOUNDS.maxX - SCENE_BOUNDS.minX;
    this.camera.x = SCENE_BOUNDS.minX + u * sceneW;
    this.camera.y = v * (GRID * TILE_H);
    this.applyCamera();
  }

  /* ---------------------------------------------------------------- *
   * Build placement
   * ---------------------------------------------------------------- */

  private ghost: Sprite | null = null;
  private placement: { type: string; onPlace: (x: number, y: number) => void } | null = null;
  private placementValid = false;

  /**
   * Enter placement mode. A translucent ghost of the building follows the
   * cursor, snapped to the tile grid and tinted by whether the ground will take
   * it, and clicking commits. Escape or `cancelPlacement()` backs out.
   */
  startPlacement(type: string, onPlace: (x: number, y: number) => void) {
    this.cancelPlacement();
    const artKey = buildingArtKey(type, 'ghost');
    const meta = this.assets.buildingMeta.get(artKey);
    if (!meta) return;
    const ghost = new Sprite(this.assets.get(`building.${artKey}`));
    ghost.anchor.set(0.5, meta.anchorY);
    ghost.alpha = 0.7;
    ghost.zIndex = 1e6;
    this.objectLayer.addChild(ghost);
    this.ghost = ghost;
    this.placement = { type, onPlace };
    this.app.canvas.style.cursor = 'copy';

    this.app.canvas.addEventListener('pointermove', this.onPlacementMove);
    this.app.canvas.addEventListener('pointerup', this.onPlacementCommit);
    window.addEventListener('keydown', this.onPlacementKey);
  }

  cancelPlacement() {
    if (!this.placement) return;
    this.app.canvas.removeEventListener('pointermove', this.onPlacementMove);
    this.app.canvas.removeEventListener('pointerup', this.onPlacementCommit);
    window.removeEventListener('keydown', this.onPlacementKey);
    this.ghost?.destroy();
    this.ghost = null;
    this.placement = null;
    this.app.canvas.style.cursor = 'grab';
  }

  get placing() { return this.placement?.type ?? null; }

  private onPlacementMove = (e: PointerEvent) => {
    if (!this.ghost) return;
    const rect = this.app.canvas.getBoundingClientRect();
    const scene = this.screenToScene(e.clientX - rect.left, e.clientY - rect.top);
    const world = screenToWorld(scene.x, scene.y);
    const wx = Math.max(4, Math.min(96, world.x));
    const wy = Math.max(6, Math.min(94, world.y));
    this.placementSpot = { x: wx, y: wy };
    this.placementValid = this.canBuildAt(wx, wy);
    const height = this.map.heightAt(wx, wy);
    const pos = worldToScreen(wx, wy, height);
    this.ghost.position.set(pos.x, pos.y);
    this.ghost.zIndex = depthOf(wx, wy, 1000);
    this.ghost.tint = this.placementValid ? 0xa8ff9a : 0xff8a7a;
  };
  private placementSpot = { x: 50, y: 50 };

  private onPlacementCommit = () => {
    if (!this.placement || this.dragMoved > 6) return;
    if (!this.placementValid) return;
    const { onPlace } = this.placement;
    const { x, y } = this.placementSpot;
    this.cancelPlacement();
    onPlace(x, y);
  };

  private onPlacementKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.cancelPlacement();
  };

  /** Ground has to be dry, clear of other buildings and off the roads. */
  canBuildAt(wx: number, wy: number) {
    const tile = this.map.tileAt(wx, wy);
    if (tile === Tile.Water || tile === Tile.WaterShore) return false;
    if (tile === Tile.Path || tile === Tile.Plaza) return false;
    return !this.world.buildings.some((b) => (b.x - wx) ** 2 + (b.y - wy) ** 2 < 64);
  }

  /** Tooltip text for the currently hovered thing. */
  describe(target: PickTarget): { title: string; lines: string[] } | null {
    if (!target) return null;
    if (target.kind === 'citizen') {
      const c = this.world.citizens.find((x) => x.id === target.id);
      if (!c) return null;
      const family = this.world.families.find((f) => f.id === c.familyId);
      return {
        title: c.name,
        lines: [`${JOB_LABELS[c.job]} · ${ACTIVITY_LABELS[c.activity]}`, `${family?.name ?? 'Unknown'} family · age ${Math.floor(c.age)}`],
      };
    }
    const b = this.world.buildings.find((x) => x.id === target.id);
    if (!b) return null;
    return { title: b.type, lines: [b.workers.length ? `${b.workers.length} inside` : 'Quiet right now'] };
  }

  destroy() {
    this.disposed = true;
    this.cancelPlacement();
    // Drop our own references but do not destroy the display objects here: the
    // application owns the scene graph and destroying it twice throws on the
    // second pass, which is what used to crash the app on leaving a world.
    this.citizens.clear();
    this.buildings.clear();
    this.propSprites = [];
    this.trees = [];
    this.foliage = [];
    this.waterSprites = [];
    this.waterfallSprites = [];
    this.campfires = [];
    this.lampGlows = [];
    this.bubbles = [];
    this.smoke = [];
    this.weatherParticles = [];
    this.motes = [];
    this.splashes = [];
    this.birds = [];
    if (this.app.renderer) this.app.destroy({ removeView: true }, { children: true });
  }
}

export const SCENE_CONSTANTS = { GRID, TILE_W, TILE_H, ELEVATION, UI };
export type { FederatedPointerEvent };
