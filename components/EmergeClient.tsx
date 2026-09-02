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
import { advance, constructBuilding, createWorld, inspireWorld, renameWorld, type World } from '@/lib/simulation';
import { snapshot, type Snapshot } from '@/lib/hud';
import { EmergeScene, type PickTarget } from '@/lib/render/scene';
import { clearClaimedWorld, loadClaimedWorld, saveClaimedWorld, type ClaimedWorld } from '@/lib/world/plots';
import PlotSelect from './PlotSelect';
import { Hud } from './Hud';
import { Panels, type PanelKey } from './Panels';

/** Game hours per real second at 1x. A full day takes a minute. */
const HOURS_PER_SECOND = 0.4;
/** How often the interface refreshes from the world. */
const HUD_INTERVAL = 180;

export const SPEEDS = [1, 2, 6] as const;
export type Speed = (typeof SPEEDS)[number];

export default function EmergeClient() {
  // `undefined` means we have not looked in storage yet, which avoids flashing
  // the land office at a player who already owns a world.
  const [claimed, setClaimed] = useState<ClaimedWorld | null | undefined>(undefined);

  useEffect(() => { setClaimed(loadClaimedWorld()); }, []);

  const enter = useCallback((world: ClaimedWorld) => {
    saveClaimedWorld(world);
    setClaimed(world);
  }, []);

  const leave = useCallback(() => {
    clearClaimedWorld();
    setClaimed(null);
  }, []);

  if (claimed === undefined) return <main className="stage" />;
  if (claimed === null) return <PlotSelect onEnter={enter} />;
  return <WorldView key={`${claimed.seed}`} claimed={claimed} onLeave={leave} onRename={enter} />;
}

function WorldView({ claimed, onLeave, onRename }: {
  claimed: ClaimedWorld;
  onLeave: () => void;
  onRename: (world: ClaimedWorld) => void;
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

  if (!worldRef.current) worldRef.current = createWorld(claimed.seed, claimed.name);

  /* -------------------------------------------------------------- *
   * Boot: renderer, simulation loop and HUD sampling
   * -------------------------------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    const world = worldRef.current;
    if (!host || !world) return;

    const scene = new EmergeScene();
    sceneRef.current = scene;
    let frame = 0;

    scene
      .init(host, world, {
        onHover: setHovered,
        onSelect: (target) => {
          selectedRef.current = target;
          setSelected(target);
        },
      })
      .then(() => {
        setReady(true);
        setView(snapshot(world, selectedRef.current));
      })
      .catch((error) => {
        console.error('Emerge: renderer failed to start', error);
      });

    let last = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const dt = Math.min(0.12, (now - last) / 1000);
      last = now;
      if (!pausedRef.current) advance(world, dt * HOURS_PER_SECOND * speedRef.current);
    };
    frame = requestAnimationFrame(step);

    const hudTimer = window.setInterval(() => {
      setView(snapshot(world, selectedRef.current));
      setWoodland(sceneRef.current?.woodland() ?? null);
    }, HUD_INTERVAL);

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(hudTimer);
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { selectedRef.current = selected; sceneRef.current?.select(selected); }, [selected]);

  /* -------------------------------------------------------------- *
   * Player actions
   * -------------------------------------------------------------- */

  const focusOn = useCallback((target: PickTarget) => {
    setSelected(target);
    sceneRef.current?.focus(target);
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

  const inspire = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    inspireWorld(world);
    setView(snapshot(world, selectedRef.current));
  }, []);

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

  const rename = useCallback((next: string) => {
    const world = worldRef.current;
    if (!world) return;
    renameWorld(world, next);
    onRename({ ...claimed, name: world.name });
    setView(snapshot(world, selectedRef.current));
  }, [claimed, onRename]);

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
    <main className="stage">
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
            hover={hoverInfo}
            activePanel={panel}
            onTogglePause={() => setPaused((p) => !p)}
            onSpeed={setSpeed}
            onPanel={setPanel}
            onInspire={inspire}
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
            onClose={() => setPanel(null)}
            onBuild={beginBuild}
            onRename={rename}
            onLeave={onLeave}
          />
        </>
      )}
    </main>
  );
}
