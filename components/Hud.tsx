'use client';

/**
 * The floating interface.
 *
 * Everything here sits over the live world rather than beside it: the world is
 * the page, and the panels are windows onto it. Panels are deliberately sparse —
 * status, what is happening, what just happened, where you are, who you are
 * looking at, and what you can do.
 */

import { useEffect, useRef } from 'react';
import { FEED_ICON, WEATHER_ICON, type Focus, type Snapshot } from '@/lib/hud';
import type { PickTarget } from '@/lib/render/scene';
import type { PanelKey } from './Panels';
import { SPEEDS, type Speed } from './EmergeClient';

interface HudProps {
  view: Snapshot;
  paused: boolean;
  speed: Speed;
  placing: string | null;
  hover: { title: string; lines: string[] } | null;
  activePanel: PanelKey;
  onTogglePause: () => void;
  onSpeed: (speed: Speed) => void;
  onPanel: (panel: PanelKey) => void;
  onInspire: () => void;
  onFocus: (target: PickTarget) => void;
  onClearSelection: () => void;
  onZoom: (factor: number) => void;
  onResetView: () => void;
  onMinimapJump: (u: number, v: number) => void;
  drawMinimap: (canvas: HTMLCanvasElement) => void;
  onCancelBuild: () => void;
}

function Meter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: tone }} />
      </span>
      <span className="meter-value">{Math.round(value)}</span>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="stat-row">
      <span className="stat-icon">{icon}</span>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

/** The world map. Redrawn on a timer from the renderer rather than from React. */
function Minimap({ draw, onJump }: { draw: (c: HTMLCanvasElement) => void; onJump: (u: number, v: number) => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 240) return;
      last = now;
      if (ref.current) draw(ref.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  return (
    <canvas
      ref={ref}
      width={232}
      height={124}
      className="minimap-canvas"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onJump((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
      }}
    />
  );
}

/** Tooltip that follows the cursor without re-rendering React on every move. */
function HoverTip({ hover }: { hover: HudProps['hover'] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      el.style.transform = `translate3d(${e.clientX + 16}px, ${e.clientY + 18}px, 0)`;
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);
  if (!hover) return null;
  return (
    <div ref={ref} className="hover-tip">
      <b>{hover.title}</b>
      {hover.lines.map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}

function BeingCard({ focus, onClear, onFocus }: { focus: Focus; onClear: () => void; onFocus: (t: PickTarget) => void }) {
  if (focus.kind === 'building') {
    return (
      <section className="panel being-card">
        <button className="panel-close" onClick={onClear} aria-label="Clear selection">×</button>
        <div className="being-head">
          <div className="being-portrait building">⌂</div>
          <div>
            <div className="being-eyebrow">PLACE</div>
            <h2>{focus.type}</h2>
            <p>{focus.production ? `Producing · ${focus.production}` : focus.occupants ? `${focus.occupants} inside` : 'Quiet right now'}</p>
          </div>
        </div>
        <div className="being-people">
          {focus.people.length === 0 && <span className="muted">Nobody here at the moment.</span>}
          {focus.people.map((p) => (
            <button key={p.id} className="person-chip" onClick={() => onFocus({ kind: 'citizen', id: p.id })}>
              {p.name} <em>{p.doing}</em>
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="panel being-card">
      <button className="panel-close" onClick={onClear} aria-label="Clear selection">×</button>
      <div className="being-head">
        <div className="being-portrait">{focus.name.slice(0, 1)}</div>
        <div>
          <h2>{focus.name}</h2>
          <div className="being-handle">{focus.handle}</div>
          <p className="muted">{focus.job} · age {focus.age} · {focus.family} family</p>
        </div>
      </div>
      <div className="being-meters">
        <Meter label="Mood" value={focus.mood} tone="linear-gradient(90deg,#4f9a3f,#8bf16b)" />
        <Meter label="Energy" value={focus.energy} tone="linear-gradient(90deg,#b08a2c,#f0d05e)" />
        <Meter label="Purpose" value={focus.purpose} tone="linear-gradient(90deg,#6d4f9a,#b98ce8)" />
      </div>
      <div className="being-status">
        <span className="pulse" />
        {focus.status}
      </div>
      {focus.project && <div className="being-note">Working on {focus.project}</div>}
      {focus.friends.length > 0 && (
        <div className="being-people">
          <span className="muted">Friends</span>
          {focus.friends.map((f) => (
            <button key={f.id} className="person-chip" onClick={() => onFocus({ kind: 'citizen', id: f.id })}>{f.name}</button>
          ))}
        </div>
      )}
    </section>
  );
}

const ACTIONS: { key: Exclude<PanelKey, null> | 'observe' | 'inspire'; icon: string; label: string; blurb: string }[] = [
  { key: 'observe', icon: '◎', label: 'OBSERVE', blurb: 'Watch the world and its stories' },
  { key: 'inspire', icon: '✧', label: 'INSPIRE', blurb: 'Spark new ideas and events' },
  { key: 'build', icon: '⚒', label: 'BUILD', blurb: 'Create places and resources' },
  { key: 'connect', icon: '◈', label: 'CONNECT', blurb: 'Support and be part of the world' },
];

export function Hud(props: HudProps) {
  const { view, paused, speed, placing, activePanel } = props;

  return (
    <div className="hud">
      <HoverTip hover={props.hover} />

      <header className="brand-block">
        <div className="brand-line">
          <div className="brand-mark">✦</div>
          <div>
            <div className="wordmark">EMERGE</div>
            <div className="tagline">THE AI WORLD</div>
          </div>
        </div>
        <p className="brand-copy">A living world of autonomous AI beings. They think. They socialise. They build. They evolve.</p>
        <p className="brand-copy accent">You don&apos;t control them.<br />You discover them.<br />You shape the world they live in.</p>
      </header>

      <div className="top-centre">
        <div className="beings-pill">
          <span className="spark">✦</span>
          <b>AI BEINGS</b>
          <em>{view.population} online</em>
        </div>
        <div className="time-controls">
          <button className={paused ? 'live paused' : 'live'} onClick={props.onTogglePause}>
            {paused ? '▶ Resume' : '❙❙ Pause'}
          </button>
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'sel' : ''} onClick={() => props.onSpeed(s)}>{s}×</button>
          ))}
        </div>
      </div>

      <aside className="right-rail">
        <section className="panel">
          <h3>WORLD STATUS <span>✦</span></h3>
          <Stat icon="◍" label="Population" value={`${view.population}`} />
          <Stat icon="♥" label="Happiness" value={`${view.happiness}%`} />
          <Stat icon="⚡" label="Energy" value={`${view.energy}%`} />
          <Stat icon={WEATHER_ICON[view.weather] ?? '☀'} label="Day" value={`${view.day} · ${view.clock}`} />
          <div className="status-foot">
            <span>{view.season} · {view.weather}</span>
            <span>{view.employed} working · {view.outdoors} outdoors</span>
          </div>
        </section>

        <section className="panel">
          <h3>ACTIVE EVENTS</h3>
          {view.events.length === 0 && <p className="muted small">Nothing scheduled today.</p>}
          {view.events.map((e) => (
            <div key={e.id} className={`event-row ${e.status}`}>
              <span>{e.name}</span>
              <b>{e.time}</b>
            </div>
          ))}
        </section>

        <section className="panel feed-panel">
          <h3>WORLD FEED <span>✦</span></h3>
          <div className="feed-scroll">
            {view.feed.map((entry) => (
              <div key={entry.id} className={`feed-row kind-${entry.kind}`}>
                <i>{FEED_ICON[entry.kind]}</i>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        </section>
      </aside>

      <div className="bottom-left">
        {view.focus
          ? <BeingCard focus={view.focus} onClear={props.onClearSelection} onFocus={props.onFocus} />
          : (
            <section className="panel hint-card">
              <div className="being-eyebrow">OBSERVE</div>
              <p>Click any being or place to follow their story. Drag to pan, scroll to zoom.</p>
            </section>
          )}
      </div>

      <nav className="action-bar">
        <div className="action-title">WHAT WILL YOU DO?</div>
        <div className="action-row">
          {ACTIONS.map((action) => {
            const active = action.key === activePanel;
            return (
              <button
                key={action.key}
                className={`action ${active ? 'active' : ''} ${action.key}`}
                onClick={() => {
                  if (action.key === 'observe') { props.onPanel(null); props.onResetView(); }
                  else if (action.key === 'inspire') { props.onPanel(null); props.onInspire(); }
                  else props.onPanel(active ? null : (action.key as PanelKey));
                }}
              >
                <b>{action.icon}</b>
                <span>{action.label}</span>
                <small>{action.blurb}</small>
              </button>
            );
          })}
        </div>
      </nav>

      <aside className="bottom-right">
        <section className="panel minimap-panel">
          <h3>WORLD MAP</h3>
          <Minimap draw={props.drawMinimap} onJump={props.onMinimapJump} />
          <div className="map-tools">
            <button onClick={() => props.onZoom(1.18)} aria-label="Zoom in">+</button>
            <button onClick={() => props.onZoom(0.85)} aria-label="Zoom out">−</button>
            <button onClick={props.onResetView} aria-label="Reset view">⌂</button>
            <span>{view.unlockedAreas.length} areas</span>
          </div>
        </section>
        <div className="economy-row">
          <button className="treasury-chip" onClick={() => props.onPanel(activePanel === 'bank' ? null : 'bank')}>
            <span>TREASURY</span>
            <b>{Math.floor(view.treasury).toLocaleString()}</b>
            <em>GOLD</em>
          </button>
          <button className="market-chip" onClick={() => props.onPanel(activePanel === 'market' ? null : 'market')}>
            <span>MARKET</span>
            <b>{view.food}</b>
            <em>FOOD IN STORE</em>
          </button>
        </div>
      </aside>

      {placing && (
        <div className="placement-bar">
          <span>Placing <b>{placing}</b> — click open ground to build, Esc to cancel.</span>
          <button onClick={props.onCancelBuild}>Cancel</button>
        </div>
      )}
    </div>
  );
}
