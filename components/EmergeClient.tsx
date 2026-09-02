'use client';

/**
 * The Emerge client.
 *
 * Owns three things and keeps them deliberately separate:
 *
 *   1. the world, a mutable simulation object advanced on an animation frame
 *      loop and never stored in React state,
 *   2. the scene, a Pixi renderer that reads the world every frame,
 *   3. the interface, which re-renders a few times a second from a plain
 *      snapshot rather than from the simulation's clock.
 *
 * Keeping the world out of React state is what lets thirty citizens walk at
 * sixty frames a second without the interface re-rendering thirty times a
 * second alongside them.
 *
 * Before any of that, a player has to claim a plot. Nothing here boots until
 * they have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { advance, constructBuilding, createWorld, drawFromTreasury, fundTreasury, renameCitizen, renameWorld, type World } from '@/lib/simulation';
import { snapshot, type Snapshot } from '@/lib/hud';
import { EmergeScene, type PickTarget } from '@/lib/render/scene';
import {
  clearClaimedWorld, loadClaimedWorld, loadPlayer, savePlayer, saveClaimedWorld,
  type ClaimedWorld, type PlayerRecord,
} from '@/lib/world/plots';
import { RENAME_CITIZEN_EMERGE, RENAME_COST_EMERGE, charge, type VaultLedger } from '@/lib/chain/vault';
import { Soundscape } from '@/lib/audio/soundscape';
import PlotSelect from './PlotSelect';
import { Hud } from './Hud';
import { Panels, type PanelKey } from './Panels';

/**
 * Game hours per real second at 1x.
 *
 * A day takes about two and a half minutes. It used to be one, and at that rate
 * citizens crossed the settlement in seconds and read as sped-up footage rather
 * than as people going about a day. Everything in the simulation is expressed
 * in game hours, so slowing the clock slows walking, work and trade together
 * and nothing needed rebalancing to match.
 */
const HOURS_PER_SECOND = 0.15;
/** How often the interface refreshes from the world. */
const HUD_INTERVAL = 180;

export const SPEEDS = [1, 2, 6] as const;
export type Speed = (typeof SPEEDS)[number];

export default function EmergeClient() {
  // `undefined` means we have not looked in storage yet, which avoids flashing
  // the land office at a player who already owns a world.
  const [claimed, setClaimed] = useState<ClaimedWorld | null | undefined>(undefined);
  // The last world we rendered. Kept after the player leaves so the renderer,
  // its WebGL context and the generated texture atlas survive a trip back to
  // the land office instead of being torn down and rebuilt.
  const [mounted, setMounted] = useState<ClaimedWorld | null>(null);
  // The $EMERGE balance and everything bought with it belongs to the player,
  // not to whichever plot they happen to be standing on.
  const [player, setPlayer] = useState<PlayerRecord | null>(null);

  useEffect(() => {
    const stored = loadClaimedWorld();
    setClaimed(stored);
    if (stored) setMounted(stored);
    setPlayer(loadPlayer());
  }, []);

  const updatePlayer = useCallback((next: PlayerRecord) => {
    savePlayer(next);
    setPlayer(next);
  }, []);

  const enter = useCallback((world: ClaimedWorld) => {
    saveClaimedWorld(world);
    setClaimed(world);
    setMounted(world);
  }, []);

  const leave = useCallback(() => {
    clearClaimedWorld();
    setClaimed(null);
  }, []);

  if (claimed === undefined || !player) return <main className="stage" />;

  return (
    <>
      {mounted && (
        <WorldView
          claimed={mounted}
          player={player}
          hidden={claimed === null}
          onLeave={leave}
          onRename={enter}
          onPlayer={updatePlayer}
        />
      )}
      {claimed === null && <PlotSelect onEnter={enter} />}
    </>
  );
}

function WorldView({ claimed, player, hidden, onLeave, onRename, onPlayer }: {
  claimed: ClaimedWorld;
  player: PlayerRecord;
  /** True while the land office is open over the top of a running world. */
  hidden: boolean;
  onLeave: () => void;
  onRename: (world: ClaimedWorld) => void;
  onPlayer: (record: PlayerRecord) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<World | null>(null);
  const sceneRef = useRef<EmergeScene | null>(null);
  const pausedRef = useRef(false);
  const speedRef = useRef<Speed>(1);
  const selectedRef = useRef<PickTarget>(null);

  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [selected, setSelected] = useState<PickTarget>(null);
  const [hovered, setHovered] = useState<PickTarget>(null);
  const [panel, setPanel] = useState<PanelKey>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const [view, setView] = useState<Snapshot | null>(null);
  const [woodland, setWoodland] = useState<{ standing: number; stumps: number; saplings: number; total: number } | null>(null);
  const soundRef = useRef<Soundscape | null>(null);
  const [sound, setSound] = useState(false);

  if (!worldRef.current) worldRef.current = createWorld(claimed.seed, claimed.name);

  /* -------------------------------------------------------------- *
   * Boot: renderer, simulation loop and HUD sampling
   * -------------------------------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !worldRef.current) return;

    const scene = new EmergeScene();
    sceneRef.current = scene;
    let frame = 0;

    scene
      .init(host, worldRef.current, {
        onHover: setHovered,
        onSelect: (target) => {
          selectedRef.current = target;
          setSelected(target);
        },
      })
      .then(() => {
        setReady(true);
        const live = worldRef.current;
        if (live) setView(snapshot(live, selectedRef.current));
      })
      .catch((error) => {
        console.error('Emerge: renderer failed to start', error);
      });

    let last = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const dt = Math.min(0.12, (now - last) / 1000);
      last = now;
      // Read the ref every frame rather than closing over the world at mount.
      //
      // This effect runs once, so a captured world would be the one claimed
      // first, for the life of the session. Claiming a second plot swaps
      // `worldRef.current` and points the scene at the new world, but the loop
      // went on advancing the old one — so the new settlement stood perfectly
      // still until the page was reloaded.
      const live = worldRef.current;
      if (live && !pausedRef.current) advance(live, dt * HOURS_PER_SECOND * speedRef.current);
    };
    frame = requestAnimationFrame(step);

    const hudTimer = window.setInterval(() => {
      const live = worldRef.current;
      if (live) setView(snapshot(live, selectedRef.current));
      setWoodland(sceneRef.current?.woodland() ?? null);
    }, HUD_INTERVAL);

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(hudTimer);
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  // The soundscape follows the world's conditions, and only ever after the
  // player has asked for it: browsers will not start audio unprompted, and a
  // world that makes noise on its own is worse than a silent one.
  useEffect(() => {
    if (!sound) return;
    const scape = soundRef.current ?? new Soundscape();
    soundRef.current = scape;
    let cancelled = false;
    scape.start().catch(() => { /* refused, stay silent */ });
    const id = window.setInterval(() => {
      const world = worldRef.current;
      if (cancelled || !world) return;
      scape.update({
        hour: world.hour,
        weather: world.weather,
        activity: Math.min(1, world.citizens.filter((c) => !c.inside).length / 20),
      }, 0.25);
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      scape.stop().catch(() => { /* nothing to stop */ });
    };
  }, [sound]);

  useEffect(() => () => { soundRef.current?.destroy(); soundRef.current = null; }, []);

  const seedRef = useRef(claimed.seed);
  useEffect(() => {
    if (seedRef.current === claimed.seed) return;
    seedRef.current = claimed.seed;
    const scene = sceneRef.current;
    if (!scene) return;
    const next = createWorld(claimed.seed, claimed.name);
    worldRef.current = next;
    setSelected(null);
    setFollowing(null);
    scene.reset(next);
    setView(snapshot(next, null));
  }, [claimed.seed, claimed.name]);

  // The world keeps running behind the land office, but there is no reason to
  // spend frames drawing it while nobody can see it.
  useEffect(() => {
    const app = sceneRef.current?.app;
    if (!app?.renderer) return;
    if (hidden) app.stop(); else app.start();
  }, [hidden]);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { selectedRef.current = selected; sceneRef.current?.select(selected); }, [selected]);

  /* -------------------------------------------------------------- *
   * Player actions
   * -------------------------------------------------------------- */

  const focusOn = useCallback((target: PickTarget) => {
    setSelected(target);
    sceneRef.current?.focus(target);
    soundRef.current?.tick('select');
  }, []);

  const toggleFollow = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const target = selectedRef.current;
    if (!target || target.kind !== 'citizen') return;
    const next = scene.following === target.id ? null : target.id;
    scene.setFollow(next);
    setFollowing(next);
  }, []);

  // A hand on the camera cancels the follow inside the scene; mirror that here.
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      const live = sceneRef.current?.following ?? null;
      setFollowing((current) => (current === live ? current : live));
    }, 400);
    return () => window.clearInterval(id);
  }, [ready]);

  const beginBuild = useCallback((type: string, cost: number) => {
    const world = worldRef.current;
    const scene = sceneRef.current;
    if (!world || !scene || world.treasury < cost) return;
    setPanel(null);
    setPlacing(type);
    scene.startPlacement(type, (x, y) => {
      const building = constructBuilding(world, type, cost, x, y);
      setPlacing(null);
      if (building) {
        scene.syncBuildings();
        setSelected({ kind: 'building', id: building.id });
      }
      setView(snapshot(world, selectedRef.current));
    });
  }, []);

  const cancelBuild = useCallback(() => {
    sceneRef.current?.cancelPlacement();
    setPlacing(null);
  }, []);

  const refresh = useCallback(() => {
    const world = worldRef.current;
    if (world) setView(snapshot(world, selectedRef.current));
  }, []);

  /** Naming costs tokens, so refuse rather than rename for free. */
  const renameWorldFor = useCallback((next: string) => {
    const world = worldRef.current;
    if (!world) return;
    const paid = charge(player.ledger, RENAME_COST_EMERGE);
    if (!paid) return;
    renameWorld(world, next);
    onPlayer({ ...player, ledger: paid });
    onRename({ ...claimed, name: world.name });
    refresh();
  }, [claimed, onRename, onPlayer, player, refresh]);

  const renameCitizenFor = useCallback((id: string, next: string) => {
    const world = worldRef.current;
    if (!world) return;
    const paid = charge(player.ledger, RENAME_CITIZEN_EMERGE);
    if (!paid) return;
    if (!renameCitizen(world, id, next)) return;
    onPlayer({ ...player, ledger: paid });
    refresh();
  }, [onPlayer, player, refresh]);

  /** Move Gold in or out of the treasury and persist the vault ledger. */
  const vault = useCallback((ledger: VaultLedger, goldDelta: number, note: string) => {
    const world = worldRef.current;
    if (!world) return;
    if (goldDelta > 0) fundTreasury(world, goldDelta, note);
    else if (goldDelta < 0 && !drawFromTreasury(world, -goldDelta, note)) return;
    onPlayer({ ...player, ledger });
    refresh();
  }, [onPlayer, player, refresh]);

  /** Put this plot up for resale, or take it back off the market. */
  const listPlot = useCallback((price: number | null) => {
    const listings = player.listings.filter((l) => l.seed !== claimed.seed);
    if (price !== null && price > 0) {
      listings.push({ seed: claimed.seed, region: claimed.region, price: Math.round(price), listedAt: Date.now() });
    }
    onPlayer({ ...player, listings });
  }, [claimed.region, claimed.seed, onPlayer, player]);

  const zoom = useCallback((factor: number) => sceneRef.current?.zoomBy(factor), []);
  const resetView = useCallback(() => sceneRef.current?.centreOn(50, 49, 1.05), []);
  const minimapJump = useCallback((u: number, v: number) => sceneRef.current?.minimapJump(u, v), []);
  const drawMinimap = useCallback((canvas: HTMLCanvasElement) => sceneRef.current?.drawMinimap(canvas), []);

  /* -------------------------------------------------------------- *
   * Keyboard
   * -------------------------------------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') { e.preventDefault(); setPaused((p) => !p); }
      else if (e.key === '1') setSpeed(1);
      else if (e.key === '2') setSpeed(2);
      else if (e.key === '3') setSpeed(6);
      else if (e.key === 'f' || e.key === 'F') toggleFollow();
      else if (e.key === 'Escape') { setPanel(null); cancelBuild(); setSelected(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelBuild, toggleFollow]);

  const hoverInfo = useMemo(() => (hovered ? sceneRef.current?.describe(hovered) ?? null : null), [hovered]);

  return (
    <main className="stage" aria-hidden={hidden} style={hidden ? { visibility: 'hidden' } : undefined}>
      <div ref={hostRef} className="canvas-host" aria-label={`${claimed.name} settlement`} />

      {!ready && (
        <div className="boot">
          <div className="boot-mark">✦</div>
          <div className="boot-word">{claimed.name.toUpperCase()}</div>
          <p>Painting a world…</p>
        </div>
      )}

      {ready && view && (
        <>
          <Hud
            view={view}
            paused={paused}
            speed={speed}
            placing={placing}
            following={following}
            woodland={woodland}
            sound={sound}
            onToggleSound={() => setSound((on) => !on)}
            player={player}
            onRenameCitizen={renameCitizenFor}
            hover={hoverInfo}
            activePanel={panel}
            onTogglePause={() => setPaused((p) => !p)}
            onSpeed={setSpeed}
            onPanel={setPanel}
            onFocus={focusOn}
            onToggleFollow={toggleFollow}
            onClearSelection={() => setSelected(null)}
            onZoom={zoom}
            onResetView={resetView}
            onMinimapJump={minimapJump}
            drawMinimap={drawMinimap}
            onCancelBuild={cancelBuild}
          />
          <Panels
            panel={panel}
            view={view}
            claimed={claimed}
            player={player}
            onClose={() => setPanel(null)}
            onBuild={beginBuild}
            onRenameWorld={renameWorldFor}
            onRenameCitizen={renameCitizenFor}
            onLeave={onLeave}
            onVault={vault}
            onList={listPlot}
          />
        </>
      )}
    </main>
  );
}
