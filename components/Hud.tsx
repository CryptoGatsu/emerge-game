'use client';

/**
 * The floating interface.
 *
 * Everything here sits over the live world rather than beside it: the world is
 * the page, and the panels are windows onto it. Panels are deliberately sparse —
 * status, what is happening, what just happened, where you are, who you are
 * looking at, and what you can do.
 */

import { useEffect, useRef, useState } from 'react';
import { FEED_ICON, WEATHER_ICON, type Focus, type Snapshot } from '@/lib/hud';
import type { PickTarget } from '@/lib/render/scene';
import type { PlayerRecord } from '@/lib/world/plots';
import { RENAME_CITIZEN_EMERGE } from '@/lib/chain/vault';
import { TOKEN, shortAddress } from '@/lib/chain/emerge';
import { BrandMark } from './Brand';
import type { PanelKey } from './Panels';
import { SPEEDS, type Speed } from './EmergeClient';

interface HudProps {
  view: Snapshot;
  paused: boolean;
  speed: Speed;
  placing: string | null;
  following: string | null;
  woodland: { standing: number; stumps: number; saplings: number; total: number } | null;
  player: PlayerRecord;
  sound: boolean;
  onToggleSound: () => void;
  hover: { title: string; lines: string[] } | null;
  activePanel: PanelKey;
  onTogglePause: () => void;
  onSpeed: (speed: Speed) => void;
  onPanel: (panel: PanelKey) => void;
  onFocus: (target: PickTarget) => void;
  onToggleFollow: () => void;
  onRenameCitizen: (id: string, name: string) => void;
  /** Pull a building down for half its materials. */
  onDemolish: (id: string) => void;
  /** Which building the player is placing, if any. */
  movingBuilding: string | null;
  onUpgradeBuilding: (id: string) => void;
  onMoveBuilding: (id: string | null) => void;
  onClearSelection: () => void;
  onZoom: (factor: number) => void;
  onResetView: () => void;
  onMinimapJump: (u: number, v: number) => void;
  drawMinimap: (canvas: HTMLCanvasElement) => void;
  onCancelBuild: () => void;
  /** How many people have this world open, the player included. */
  watching: number;
  /** People playing Emerge anywhere, or null when the relay has not said. */
  online: number | null;
  /** Set when this is somebody else's settlement, being looked at. */
  visiting: { worldName: string; ownerName: string; owner: string; at: number } | null;
  /** Stop visiting and go back to the world map. */
  onEndVisit: () => void;
}

/**
 * Whether the interface is running on a screen too small for the rail.
 *
 * A media query rather than a width guess, and it drives which layout is
 * *rendered* rather than which one is hidden: the panels below are composed
 * into a right-hand rail on a large screen and into a slide-up sheet on a
 * small one, so neither layout pays for the other's markup.
 *
 * The query must stay identical to the one in `globals.css`. A phone held
 * sideways is wide and short, and when the two disagreed it got the sheet's
 * styling with the rail's markup.
 */
export const COMPACT_QUERY = '(max-width: 780px), (max-height: 520px)';

function useCompact() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const apply = () => setCompact(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
  return compact;
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

function BeingCard({ focus, following, player, readOnly, treasury, moving, onClear, onFocus, onToggleFollow, onRenameCitizen, onDemolish, onUpgrade, onMove }: {
  focus: Focus; following: string | null; player: PlayerRecord;
  /** True on somebody else's world: you can look and follow, not change. */
  readOnly: boolean;
  onClear: () => void; onFocus: (t: PickTarget) => void; onToggleFollow: () => void;
  onRenameCitizen: (id: string, name: string) => void;
  onDemolish: (id: string) => void;
  /** What the settlement has to spend, so the buttons can refuse honestly. */
  treasury: number;
  /** The building the player is currently placing, if any. */
  moving: string | null;
  onUpgrade: (id: string) => void;
  onMove: (id: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const affordable = player.ledger.balance >= RENAME_CITIZEN_EMERGE;
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
            {/* What it has been improved to, and what that is costing every
                day — the second half matters, because upkeep is what makes
                improving everything a decision rather than a free win. */}
            <p className="muted small building-level">
              Level {focus.level} of {focus.maxLevel} · {focus.upkeep} Gold a day to keep
            </p>
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
        {!readOnly && (
          <div className="building-work">
            {focus.upgrade ? (
              <button
                className="improve"
                disabled={treasury < focus.upgrade.gold || !focus.upgrade.stocked}
                onClick={() => onUpgrade(focus.id)}
              >
                Improve · {focus.upgrade.gold} Gold
                <em>
                  {focus.upgrade.wood} timber · {focus.upgrade.stone} stone
                  {focus.upgrade.stocked ? '' : ' — not in the yard'}
                </em>
              </button>
            ) : (
              <span className="muted small">As good as it gets.</span>
            )}
            <button
              className={moving === focus.id ? 'shift armed' : 'shift'}
              disabled={treasury < focus.moveGold}
              onClick={() => onMove(moving === focus.id ? null : focus.id)}
            >
              {moving === focus.id ? 'Tap the ground' : `Move · ${focus.moveGold} Gold`}
            </button>
          </div>
        )}
        {focus.upgrade && !readOnly && (
          <p className="muted small">
            An improved building gets about a fifth more done — and costs half again in
            upkeep for as long as it stands.
          </p>
        )}
        {focus.demolishable && !readOnly && (
          <div className="demolish">
            <button
              className={confirming === focus.id ? 'danger armed' : 'danger'}
              onClick={() => {
                if (confirming === focus.id) { onDemolish(focus.id); setConfirming(null); }
                else setConfirming(focus.id);
              }}
            >
              {confirming === focus.id ? 'Pull it down — tap again' : 'Pull down'}
            </button>
            <span className="muted small">
              Salvages {focus.salvage.wood} timber and {focus.salvage.stone} stone. The Gold does not come back.
            </span>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="panel being-card">
      <button className="panel-close" onClick={onClear} aria-label="Clear selection">×</button>
      <div className="being-head">
        <div className="being-portrait">{focus.name.slice(0, 1)}</div>
        <div>
          <h2>
            {focus.name}
            {!readOnly && (
              <button
                className="rename-pen"
                title={`Rename for ${RENAME_CITIZEN_EMERGE.toLocaleString()} ${TOKEN.ticker}`}
                onClick={() => { setDraft(focus.name); setRenaming((r) => !r); }}
              >
                ✎
              </button>
            )}
          </h2>
          <div className="being-handle">{focus.handle}</div>
          <p className="muted">{focus.job} · age {focus.age} · {focus.family} family</p>
          {/* What they are worth at the work, which is the difference between
              a settlement of strangers and one that has been running a while. */}
          {focus.skill && (
            <div className="being-skill" title={`${focus.skill.days} days at the trade`}>
              <span className="skill-title">{focus.skill.title}</span>
              <span className="skill-pips" aria-label={`Level ${focus.skill.level} of 10`}>
                {Array.from({ length: 10 }, (_, i) => (
                  <i key={i} className={i < focus.skill!.level ? 'on' : ''} />
                ))}
              </span>
              <em>
                {focus.skill.output > 1 ? `+${Math.round((focus.skill.output - 1) * 100)}% output` : 'learning the work'}
                {focus.skill.toNext !== null && ` · ${focus.skill.toNext}d to next`}
              </em>
            </div>
          )}
        </div>
      </div>
      {renaming && (
        <div className="rename-row">
          <input
            value={draft}
            maxLength={18}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && affordable) { onRenameCitizen(focus.id, draft); setRenaming(false); }
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
          <button
            disabled={!affordable || !draft.trim() || draft.trim() === focus.name}
            onClick={() => { onRenameCitizen(focus.id, draft); setRenaming(false); }}
          >
            {affordable ? `${RENAME_CITIZEN_EMERGE.toLocaleString()} ${TOKEN.ticker}` : 'Not enough'}
          </button>
        </div>
      )}
      <div className="being-meters">
        <Meter label="Mood" value={focus.mood} tone="linear-gradient(90deg,#4f9a3f,#8bf16b)" />
        <Meter label="Energy" value={focus.energy} tone="linear-gradient(90deg,#b08a2c,#f0d05e)" />
        <Meter label="Purpose" value={focus.purpose} tone="linear-gradient(90deg,#6d4f9a,#b98ce8)" />
      </div>
      <div className="being-status">
        <span className="pulse" />
        {focus.status}
        <button
          className={`follow-toggle ${following === focus.id ? 'on' : ''}`}
          onClick={onToggleFollow}
          title="Keep the camera on this being (F)"
        >
          {following === focus.id ? 'Following' : 'Follow'}
        </button>
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

/**
 * A rail panel that folds away.
 *
 * The right-hand rail is four stacked panels and it covers a quarter of the
 * world. Each one collapses to its heading, and what is open is remembered
 * between sessions, so a player who wants to just watch the place can have the
 * screen back without losing the panel when they come looking for it.
 */
function Folding({ id, title, badge, children, defaultOpen = true }: {
  id: string;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const key = `emerge.panel.${id}`;
  const [open, setOpen] = useState(defaultOpen);
  // Read the stored state after mount: the server render has no localStorage,
  // and reading it during the first render makes the markup disagree.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
      if (saved !== null) setOpen(saved === '1');
    } catch { /* private browsing: the default stands */ }
  }, [key]);
  const toggle = () => {
    setOpen((was) => {
      const next = !was;
      try { window.localStorage.setItem(key, next ? '1' : '0'); } catch { /* nothing to do */ }
      return next;
    });
  };
  return (
    <section className={`panel folding ${open ? '' : 'shut'}`}>
      <h3>
        <button className="fold" onClick={toggle} aria-expanded={open}>
          <i aria-hidden>{open ? '▾' : '▸'}</i>
          {title}
        </button>
        {badge}
      </h3>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

function StatusPanel({ view, woodland }: { view: Snapshot; woodland: HudProps['woodland'] }) {
  return (
    <Folding id="status" title="WORLD STATUS" badge={<span>✦</span>}>
      <Stat icon="◍" label="Population" value={`${view.population}`} />
      <Stat icon="♥" label="Happiness" value={`${view.happiness}%`} />
      <Stat icon="⚡" label="Energy" value={`${view.energy}%`} />
      <Stat icon={WEATHER_ICON[view.weather] ?? '☀'} label="Day" value={`${view.day} · ${view.clock}`} />
      <Stat
        icon={view.temperature <= 2 ? '❄' : view.temperature >= 30 ? '☼' : '🌡'}
        label="Temperature"
        value={`${Math.round(view.temperature)}°C · ${view.temperatureLabel}`}
      />
      {woodland && (
        <Stat
          icon="♣"
          label="Woodland"
          value={woodland.stumps + woodland.saplings > 0
            ? `${woodland.standing} · ${woodland.stumps + woodland.saplings} regrowing`
            : `${woodland.standing} trees`}
        />
      )}
      <div className="status-foot">
        <span>{view.season} · {view.weather}</span>
        <span>{view.employed} working · {view.outdoors} outdoors{view.seated > 0 ? ` · ${view.seated} sitting` : ''}</span>
        <span>{view.births} born · {view.deaths} died here</span>
      </div>
    </Folding>
  );
}

/**
 * What is going wrong, and how ready the settlement is for the next thing.
 *
 * The readiness bars are here whether or not anything is happening, because
 * the whole point of them is that they are something to act on before the fire
 * rather than a post-mortem after it.
 */
function DangerPanel({ view }: { view: Snapshot }) {
  const worst = view.readiness[0];
  return (
    <Folding id="danger" title="WHAT COULD GO WRONG" defaultOpen={false}>
      {view.hazards.map((h) => (
        <div key={h.id} className={`hazard ${h.kind}`}>
          <div className="hazard-head">
            <span>{h.label}</span>
            <b>{h.days === 1 ? 'today' : `${h.days} days`}</b>
          </div>
          <em>{h.effect}</em>
        </div>
      ))}
      {view.hazards.length === 0 && (
        <p className="muted small">
          Nothing is wrong today.{worst && worst.percent < 60 ? ` The settlement is least ready for ${worst.label.toLowerCase()}.` : ''}
        </p>
      )}
      <div className="readiness">
        {view.readiness.map((r) => (
          <div key={r.kind} className="ready-row" title={r.defence}>
            <span>{r.label}</span>
            <div className="ready-bar"><i style={{ width: `${r.percent}%` }} className={r.percent < 40 ? 'low' : r.percent < 75 ? 'mid' : ''} /></div>
            <b>{r.percent}%</b>
          </div>
        ))}
      </div>
      {worst && worst.percent < 75 && <p className="muted small">{worst.defence}</p>}
    </Folding>
  );
}

function EventsPanel({ view }: { view: Snapshot }) {
  return (
    <Folding id="events" title="ACTIVE EVENTS">
      {view.events.length === 0 && <p className="muted small">Nothing scheduled today.</p>}
      {view.events.map((e) => (
        <div key={e.id} className={`event-row ${e.status}`}>
          <div className="event-head">
            <span>{e.name}</span>
            <b>{e.time}</b>
          </div>
          {/* What actually came of it. A meeting that resolved nothing and a
              showcase nobody attended both say so. */}
          {e.outcome && <em className="event-outcome">{e.outcome}</em>}
          {!e.outcome && e.status === 'now' && e.attendees > 0 && (
            <em className="event-outcome">{e.attendees} there</em>
          )}
        </div>
      ))}
      {view.resolution && (
        <div className="resolution">
          <span>THE TOWN RESOLVED</span>
          <p>{view.resolution.text[0].toUpperCase()}{view.resolution.text.slice(1)}.</p>
          <em>{view.resolution.voters} in the room, day {view.resolution.day}</em>
        </div>
      )}
      {view.artworks.length > 0 && (
        <div className="gallery">
          <span>THE SETTLEMENT&rsquo;S WORK</span>
          {view.artworks.slice(0, 4).map((a) => (
            <div key={a.id} className="gallery-row">
              <span>&ldquo;{a.title}&rdquo;</span>
              <em>{a.maker}</em>
            </div>
          ))}
        </div>
      )}
    </Folding>
  );
}

function FeedPanel({ view }: { view: Snapshot }) {
  return (
    <Folding id="feed" title="WORLD FEED" badge={<span>✦</span>}>
      <div className="feed-scroll">
        {view.feed.map((entry) => (
          <div key={entry.id} className={`feed-row kind-${entry.kind}`}>
            <i>{FEED_ICON[entry.kind]}</i>
            <span>{entry.text}</span>
          </div>
        ))}
      </div>
    </Folding>
  );
}

function EconomyRow({ view, activePanel, onPanel }: {
  view: Snapshot; activePanel: PanelKey; onPanel: (panel: PanelKey) => void;
}) {
  return (
    <div className="economy-row">
      {/* The treasury chip that used to sit here printed the same Gold as the
          purse and opened the same panel — two of the same button, one of them
          always redundant. */}
      <button className="market-chip" onClick={() => onPanel(activePanel === 'market' ? null : 'market')}>
        <span>MARKET</span>
        <b>{view.food}</b>
        <em>FOOD IN STORE</em>
      </button>
    </div>
  );
}

/**
 * What the player has, always on screen.
 *
 * Treasury Gold and earned {TOKEN.ticker} were both a panel away, so the two
 * numbers a player is actually playing for were invisible while they watched
 * the world. Tapping either opens the Bank.
 */
function Purse({ view, player, visiting, onPanel }: {
  view: Snapshot; player: PlayerRecord; visiting: boolean; onPanel: (panel: PanelKey) => void;
}) {
  const uncollected = Math.floor(player.ledger.earnedEmerge);
  return (
    <button
      className="purse"
      onClick={() => onPanel(visiting ? 'gift' : 'bank')}
      title={visiting ? 'Send Gold to this settlement' : 'Open the Bank'}
    >
      {/*
        * A settlement's treasury is its owner's business.
        *
        * The purse reads from whichever world is on screen, so on a visit it
        * was printing somebody else's Gold to anyone who walked in — how much
        * they are holding, and by inference how well they are doing. What a
        * visitor gets instead is the door to give them some.
        */}
      {visiting ? (
        <span className="purse-cell gift">
          <em>THEIR TREASURY</em>
          <b>—</b>
        </span>
      ) : (
        <span className="purse-cell gold">
          <em>GOLD</em>
          <b>{Math.floor(view.treasury).toLocaleString()}</b>
        </span>
      )}
      <span className="purse-cell emerge">
        <em>{TOKEN.ticker} EARNED</em>
        <b>{uncollected.toLocaleString()}</b>
      </span>
      <span className="purse-cell wallet">
        <em>WALLET</em>
        <b>{Math.floor(player.ledger.balance).toLocaleString()}</b>
      </span>
    </button>
  );
}

/**
 * The action bar.
 *
 * `short` is what a phone shows. Six full labels do not fit across 390px at
 * any legible size — they used to run off both edges, with ON-CHAIN half
 * cut off — so the narrow layout uses one word each and drops the blurb.
 */
/**
 * The one thing a visitor can do to somebody else's settlement.
 *
 * Not in the main list, because on your own world it would be a button for
 * sending Gold to yourself.
 */
const VISITOR_GIFT = {
  key: 'gift' as const, icon: '❖', label: 'SEND GOLD', short: 'GIFT',
  blurb: 'Help this settlement along',
};

/** How long ago a visited world was published, in words. */
function sinceWhen(at: number) {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 2) return 'live';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const ACTIONS: { key: Exclude<PanelKey, null>; icon: string; label: string; short: string; blurb: string }[] = [
  { key: 'guide', icon: '◎', label: 'GAME GUIDE', short: 'GUIDE', blurb: 'How all of this works' },
  { key: 'build', icon: '⚒', label: 'BUILD', short: 'BUILD', blurb: 'Places and resources' },
  { key: 'market', icon: '◍', label: 'MARKET', short: 'MARKET', blurb: 'Prices and scarcity' },
  { key: 'chat', icon: '✎', label: 'CHAT', short: 'CHAT', blurb: 'Talk to other players' },
  { key: 'arena', icon: '⚔', label: 'ARENA', short: 'ARENA', blurb: 'Duels and betting' },
  { key: 'gacha', icon: '⛏', label: 'PROSPECT', short: 'DIG', blurb: 'Send a party out' },
  { key: 'connect', icon: '◈', label: 'ON-CHAIN', short: 'CHAIN', blurb: 'Plot, wallet and vault' },
];

export function Hud(props: HudProps) {
  const { view, paused, speed, placing, activePanel } = props;
  const compact = useCompact();
  const [railOpen, setRailOpen] = useState(false);
  // The opening titles have said their piece by the time the world is worth
  // looking at, so they get out of the way.
  const [introShown, setIntroShown] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setIntroShown(false), 7000);
    return () => window.clearTimeout(id);
  }, []);

  /*
   * A visitor gets the doors that make sense from outside.
   *
   * Building, prospecting and the on-chain panel all act on a settlement the
   * visitor does not own. Leaving them on screen greyed out would be six
   * buttons of which three do nothing; leaving them working would be worse.
   */
  const actions = props.visiting
    ? [
      // The colosseum is on the list while visiting because it is an island
      // nobody owns: standing in somebody else's settlement is no reason to be
      // shut out of a public place. Everything else here still belongs to the
      // owner alone.
      ...ACTIONS.filter((a) => a.key === 'guide' || a.key === 'market' || a.key === 'chat' || a.key === 'arena'),
      VISITOR_GIFT,
    ]
    : ACTIONS;

  return (
    <div className={`hud ${props.visiting ? 'is-visiting' : ''}`}>
      <HoverTip hover={props.hover} />

      {!introShown && (
        <button className="world-chip" onClick={() => setIntroShown(true)} title="About Emerge">
          <span>✦</span>
          <b>{view.name}</b>
        </button>
      )}

      <header className={`brand-block ${introShown ? '' : 'hidden'}`} aria-hidden={!introShown}>
        <div className="brand-line">
          <BrandMark />
          <div>
            <div className="wordmark">EMERGE</div>
            <div className="tagline">{view.name === 'Emerge' ? 'THE AI WORLD' : view.name.toUpperCase()}</div>
          </div>
        </div>
        <p className="brand-copy">A living world of autonomous AI beings. They think. They socialise. They build. They evolve.</p>
        <p className="brand-copy accent">You don&apos;t control them.<br />You discover them.<br />You shape the world they live in.</p>
      </header>

      {/* One centred column: population, then the clock, then what the player
          has. Laid out as separate absolute boxes these sat on top of each
          other the moment the window was narrow enough — the purse covered the
          population pill and the speed controls both. */}
      <div className="top-centre">
        <div className="beings-pill">
          <span className="spark">✦</span>
          <b>AI BEINGS</b>
          <em>{view.population} here</em>
          {/* Two different populations, and they are easy to confuse, so they
              are labelled rather than left as two numbers side by side: the
              beings who live on this plot, and the people playing the game. */}
          {props.online !== null && (
            <span className="players-online" title="People playing Emerge right now">
              <i aria-hidden>●</i>
              {props.online.toLocaleString()} {props.online === 1 ? 'player' : 'players'}
            </span>
          )}
        </div>
        <div className="time-controls">
          <button className={paused ? 'live paused' : 'live'} onClick={props.onTogglePause}>
            {paused ? '▶ Resume' : '❙❙ Pause'}
          </button>
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'sel' : ''} onClick={() => props.onSpeed(s)}>{s}×</button>
          ))}
          <button
            className={props.sound ? 'sel' : ''}
            onClick={props.onToggleSound}
            title={props.sound ? 'Mute the world' : 'Listen to the world'}
          >
            {props.sound ? '♪' : '♪̸'}
          </button>
        </div>
        <Purse view={view} player={props.player} visiting={!!props.visiting} onPanel={props.onPanel} />
        {/* Who is looking, not counting you: the count arrives with the owner
            already taken out, so one is one visitor and nothing is nobody. */}
        {props.watching > 0 && (
          <div
            className="watching"
            title={props.watching === 1
              ? 'Somebody else has this world open'
              : `${props.watching} other people have this world open`}
          >
            <span aria-hidden>◉</span>
            <b>{props.watching}</b>
            <em>watching</em>
          </div>
        )}
      </div>

      {/* Somebody else's settlement. Said plainly and permanently, because
          every control on screen behaves differently here and a player who
          forgot where they were would read the difference as a bug. */}
      {props.visiting && (
        <div className="visiting-bar">
          <span className="eyebrow">VISITING</span>
          <b>{props.visiting.worldName}</b>
          <em>
            {props.visiting.ownerName?.trim() ? props.visiting.ownerName : shortAddress(props.visiting.owner)}
            {' · '}{sinceWhen(props.visiting.at)}
          </em>
          <button className="ghost" onClick={props.onEndVisit}>Leave</button>
        </div>
      )}

      {compact
        ? (
          <>
            <button
              className={`rail-toggle ${railOpen ? 'on' : ''}`}
              onClick={() => setRailOpen((open) => !open)}
              aria-expanded={railOpen}
            >
              <span>✦</span>
              <b>{railOpen ? 'CLOSE' : 'WORLD'}</b>
            </button>
            <aside className={`phone-sheet ${railOpen ? 'open' : ''}`} aria-hidden={!railOpen}>
              <div className="sheet-grip" />
              <StatusPanel view={view} woodland={props.woodland} />
              <EconomyRow view={view} activePanel={activePanel} onPanel={props.onPanel} />
              <EventsPanel view={view} />
              <DangerPanel view={view} />
              <FeedPanel view={view} />
            </aside>
          </>
        )
        : (
          <aside className="right-rail">
            <StatusPanel view={view} woodland={props.woodland} />
            <EventsPanel view={view} />
            <DangerPanel view={view} />
            <FeedPanel view={view} />
          </aside>
        )}

      <div className="bottom-left">
        {view.focus
          ? (
            <BeingCard
              focus={view.focus}
              following={props.following}
              player={props.player}
              readOnly={!!props.visiting}
              onClear={props.onClearSelection}
              onFocus={props.onFocus}
              onToggleFollow={props.onToggleFollow}
              onRenameCitizen={props.onRenameCitizen}
              onDemolish={props.onDemolish}
              treasury={view.treasury}
              moving={props.movingBuilding}
              onUpgrade={props.onUpgradeBuilding}
              onMove={props.onMoveBuilding}
            />
          )
          : (
            <section className="panel hint-card">
              <div className="being-eyebrow">OBSERVE</div>
              <p>
                Tap any being or place to follow their story.
                {compact ? ' Drag to pan, pinch to zoom.' : ' Drag to pan, scroll to zoom.'}
              </p>
            </section>
          )}
      </div>

      <nav className="action-bar">
        <div className="action-title">{props.visiting ? 'SOMEBODY ELSE\u2019S WORLD' : 'WHAT WILL YOU DO?'}</div>
        <div className="action-row">
          {actions.map((action) => {
            const active = action.key === activePanel;
            return (
              <button
                key={action.key}
                className={`action ${active ? 'active' : ''} ${action.key}`}
                onClick={() => {
                  props.onPanel(active ? null : (action.key as PanelKey));
                }}
              >
                <b>{action.icon}</b>
                <span>{compact ? action.short : action.label}</span>
                <small>{action.blurb}</small>
              </button>
            );
          })}
        </div>
      </nav>

      {compact
        ? (
          // A minimap is not worth a third of a phone screen, but zoom controls
          // are: not every touch device is comfortable to pinch on.
          <div className="touch-zoom">
            <button onClick={() => props.onZoom(1.25)} aria-label="Zoom in">+</button>
            <button onClick={() => props.onZoom(0.8)} aria-label="Zoom out">−</button>
            <button onClick={props.onResetView} aria-label="Reset view">⌂</button>
          </div>
        )
        : (
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
            <EconomyRow view={view} activePanel={activePanel} onPanel={props.onPanel} />
          </aside>
        )}

      {placing && (
        <div className="placement-bar">
          <span>
            Placing <b>{placing}</b> — {compact ? 'tap open ground to build.' : 'click open ground to build, Esc to cancel.'}
          </span>
          <button onClick={props.onCancelBuild}>Cancel</button>
        </div>
      )}
    </div>
  );
}
