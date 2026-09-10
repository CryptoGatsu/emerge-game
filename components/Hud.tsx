'use client';
import { DISMISS_GOLD } from '@/lib/simulation';
import { FirstDay, type FirstGo, type FirstStep } from './FirstDay';
import { EMBLEM_GLYPH, EMBLEM_NAME, isEmblem } from '@/lib/world/emblems';

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
import { RENAME_CITIZEN_EMERGE, HAND_SHARE } from '@/lib/chain/vault';
import { TOKEN, shortAddress } from '@/lib/chain/emerge';
import { BrandMark } from './Brand';
import type { PanelKey } from './Panels';
import { SPEEDS, type Speed } from './EmergeClient';
import { t, tj, tn, tx, useLocale } from '@/lib/i18n';
import { LanguageSwitch } from './LanguageSwitch';

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
  /** Send somebody away for a few days' pay. */
  onDismiss: (id: string) => void;
  /** Raise a ruin again, for Gold and materials. */
  onRebuild: (id: string) => void;
  /** Spend Gold against a hazard. */
  onFight: (id: string) => void;
  /** Which building the player is placing, if any. */
  movingBuilding: string | null;
  onUpgradeBuilding: (id: string) => void;
  onUpgradeAll: (type: string) => void;
  onMoveBuilding: (id: string | null) => void;
  onClearSelection: () => void;
  onZoom: (factor: number) => void;
  onResetView: () => void;
  /** Hide the whole interface for a clean screenshot. */
  onPhoto: () => void;
  /** The planning grid, and its toggle. */
  grid: boolean;
  onGrid: () => void;
  /** The frame's grade and bloom, and its toggle. */
  effects: boolean;
  onEffects: () => void;
  onMinimapJump: (u: number, v: number) => void;
  drawMinimap: (canvas: HTMLCanvasElement) => void;
  onCancelBuild: () => void;
  /** How many people have this world open, the player included. */
  watching: number;
  /** People playing Emerge anywhere, or null when the relay has not said. */
  online: number | null;
  /** Set when this is somebody else's settlement, being looked at. */
  visiting: { worldName: string; ownerName: string; owner: string; at: number; hand?: boolean; unpublished?: boolean } | null;
  /** Stop visiting and go back to the world map. */
  onEndVisit: () => void;
  /** The first-day card, while there is one to show. */
  firstDay: { steps: FirstStep[]; cap: number } | null;
  onFirstDayGo: (go: FirstGo) => void;
  onFirstDayDismiss: () => void;
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
/** An age's name in the middle of a sentence: lower-cased, unless it is an acronym. */
const soft = (name: string) => (name === name.toUpperCase() ? name : name.toLowerCase());

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
      <b>{tx(hover.title)}</b>
      {hover.lines.map((line) => <span key={line}>{tx(line)}</span>)}
    </div>
  );
}

function BeingCard({ focus, following, player, readOnly, treasury, moving, onClear, onFocus, onToggleFollow, onRenameCitizen, onDemolish, onDismiss, onRebuild, onUpgrade, onUpgradeAll, onMove }: {
  focus: Focus; following: string | null; player: PlayerRecord;
  /** True on somebody else's world: you can look and follow, not change. */
  readOnly: boolean;
  onClear: () => void; onFocus: (t: PickTarget) => void; onToggleFollow: () => void;
  onRenameCitizen: (id: string, name: string) => void;
  onDismiss: (id: string) => void;
  onDemolish: (id: string) => void;
  onRebuild: (id: string) => void;
  /** What the settlement has to spend, so the buttons can refuse honestly. */
  treasury: number;
  /** The building the player is currently placing, if any. */
  moving: string | null;
  onUpgrade: (id: string) => void;
  onUpgradeAll: (type: string) => void;
  onMove: (id: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const affordable = player.ledger.balance >= RENAME_CITIZEN_EMERGE;
  useLocale();
  if (focus.kind === 'building') {
    return (
      <section className="panel being-card">
        <button className="panel-close" onClick={onClear} aria-label={t('Clear selection')}>×</button>
        <div className="being-head">
          <div className="being-portrait building">⌂</div>
          <div>
            <div className="being-eyebrow">{focus.ruined ? t('IN RUINS') : t('PLACE')}</div>
            <h2>{tn(focus.type)}</h2>
            {focus.ruined && <p className="ruined-line">{t('Wrecked. Nobody can use it until it is rebuilt.')}</p>}
            {!focus.ruined && focus.damage > 0 && <p className="muted small">{t('{n}% damaged. The carpenters are patching it.', { n: focus.damage })}</p>}
            <p>{focus.production ? t('Producing · {what}', { what: tx(focus.production) }) : focus.occupants ? t('{n} inside', { n: focus.occupants }) : t('Quiet right now')}</p>
            {focus.crew && (
              <p className="muted small">
                {focus.crew.posted === 0
                  ? t('Nobody is posted here. Train somebody to the trade on the People panel.')
                  : t('{n} of {posts} posts filled', { n: focus.crew.posted, posts: focus.crew.posts })}
                {focus.crew.over > 0 && ` · ${t('{n} more carry the trade with no post to fill', { n: focus.crew.over })}`}
              </p>
            )}
            {focus.keeper && ('name' in focus.keeper
              ? <p className="muted small keeper-line">{t('Kept by {name}, {tier} {role}.', { name: focus.keeper.name, tier: tx(focus.keeper.tier), role: tx(focus.keeper.role).toLowerCase() })}</p>
              : <p className="muted small keeper-line">{t('No {role} keeps it: it runs at {base}%. Engage one on the People panel.', { role: tx(focus.keeper.wants).toLowerCase(), base: focus.keeper.base })}</p>)}
            {focus.idle && <p className="muted small idle-line">{tx(focus.idle)}</p>}
            {/* What it has been improved to, and what that is costing every
                day — the second half matters, because upkeep is what makes
                improving everything a decision rather than a free win. */}
            <p className="muted small building-level">
              {t('Level {level} of {max} · {upkeep} Gold a day to keep', { level: focus.level, max: focus.maxLevel, upkeep: focus.upkeep })}
              {/* A workplace with empty posts is charged less, so the card says
                  what it would cost full rather than leaving the figure looking
                  wrong against the guide's table. */}
              {focus.upkeepFull > focus.upkeep && ` · ${t('{n} with its posts full', { n: focus.upkeepFull })}`}
            </p>
            {focus.beds && (
              <p className="muted small building-level building-beds">
                {t('Sleeps {n} of {room}', { n: focus.beds.sleeping, room: focus.beds.room })}
                {focus.beds.next !== null && <> · {t('{n} beds when improved', { n: focus.beds.next })}</>}
              </p>
            )}
            {focus.herd && (
              <p className="muted small building-level building-herd">
                {focus.herd.land === 0
                  ? t('The herd is thinned out; it comes back a little each day. The snares still bring some in.')
                  : t('{n} animals on the land, {m} in reach · the snares bring in the rest', { n: focus.herd.land, m: focus.herd.reach })}
              </p>
            )}
          </div>
        </div>
        <div className="being-people">
          {focus.people.length === 0 && <span className="muted">{t('Nobody here at the moment.')}</span>}
          {focus.people.map((p) => (
            <button key={p.id} className="person-chip" onClick={() => onFocus({ kind: 'citizen', id: p.id })}>
              {p.name} <em>{tx(p.doing)}</em>
            </button>
          ))}
        </div>
        {!readOnly && focus.ruined && (
          <div className="building-work">
            <button
              className="improve rebuild"
              disabled={treasury < focus.rebuild.gold || !focus.rebuild.stocked}
              onClick={() => onRebuild(focus.id)}
            >
              {t('Rebuild · {gold} Gold', { gold: focus.rebuild.gold })}
              <em>
                {t('{wood} timber · {stone} stone', { wood: focus.rebuild.wood, stone: focus.rebuild.stone })}
                {focus.rebuild.stocked ? '' : t(' — not in the yard')}
              </em>
            </button>
          </div>
        )}
        {!readOnly && !focus.ruined && (
          <div className="building-work">
            {focus.upgrade ? (
              <button
                className="improve"
                disabled={treasury < focus.upgrade.gold || !focus.upgrade.stocked}
                onClick={() => onUpgrade(focus.id)}
              >
                {t('Improve · {gold} Gold', { gold: focus.upgrade.gold })}
                <em>
                  {t('{wood} timber · {stone} stone', { wood: focus.upgrade.wood, stone: focus.upgrade.stone })}
                  {focus.upgrade.stocked ? '' : t(' — not in the yard')}
                  {' · '}{tx(focus.improves)}
                </em>
              </button>
            ) : (
              <span className="muted small">
                {focus.cap.next
                  ? t('Level {n} is the most a {era} can raise. The {next} opens one more.', { n: focus.maxLevel, era: soft(tx(focus.cap.era)), next: soft(tx(focus.cap.next)) })
                  : t('As good as it gets.')}
              </span>
            )}
            <button
              className={moving === focus.id ? 'shift armed' : 'shift'}
              disabled={treasury < focus.moveGold}
              onClick={() => onMove(moving === focus.id ? null : focus.id)}
            >
              {moving === focus.id ? t('Tap the ground') : t('Move · {gold} Gold', { gold: focus.moveGold })}
            </button>
          </div>
        )}
        {focus.upgradeAll && !readOnly && !focus.ruined && (
          <div className="building-work improve-all">
            <button
              className="improve"
              disabled={focus.upgradeAll.affordable === 0}
              onClick={() => onUpgradeAll(focus.buildingType)}
            >
              {focus.upgradeAll.affordable >= focus.upgradeAll.count
                ? t('Improve every {type} · {n} for {gold} Gold', { type: tn(focus.kindName).toLowerCase(), n: focus.upgradeAll.count, gold: focus.upgradeAll.gold.toLocaleString() })
                : t('Improve {n} of {total} {type}s · as far as the treasury goes', { n: focus.upgradeAll.affordable, total: focus.upgradeAll.count, type: tn(focus.kindName).toLowerCase() })}
              <em>
                {t('{wood} timber · {stone} stone', { wood: focus.upgradeAll.wood, stone: focus.upgradeAll.stone })}
                {focus.upgradeAll.affordable === 0 ? t(' — not yet') : t(' · one level each, cheapest first')}
              </em>
            </button>
          </div>
        )}
        {focus.upgrade && !readOnly && !focus.ruined && (
          <p className="muted small">
            {t('An improved building gets about a fifth more done — and costs half again in upkeep for as long as it stands.')}
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
              {confirming === focus.id ? t('Pull it down — tap again') : t('Pull down')}
            </button>
            <span className="muted small">
              {t('Salvages {wood} timber and {stone} stone. The Gold does not come back.', { wood: focus.salvage.wood, stone: focus.salvage.stone })}
              {focus.household && <> {t('The {family} family moves to another house with room, or sleeps rough until one is raised.', { family: focus.household })}</>}
            </span>
          </div>
        )}
        {focus.keeps && !readOnly && !focus.ruined && (
          <p className="muted small demolish-keeps">{t(focus.keeps)}</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel being-card">
      <button className="panel-close" onClick={onClear} aria-label={t('Clear selection')}>×</button>
      <div className="being-head">
        <div className="being-portrait">{focus.name.slice(0, 1)}</div>
        <div>
          <h2>
            {focus.name}
            {!readOnly && (
              <button
                className="rename-pen"
                title={t('Rename for {cost} {ticker}', { cost: RENAME_CITIZEN_EMERGE.toLocaleString(), ticker: TOKEN.ticker })}
                onClick={() => { setDraft(focus.name); setRenaming((r) => !r); }}
              >
                ✎
              </button>
            )}
          </h2>
          <div className="being-handle">{focus.handle}</div>
          <p className="muted">{tj(focus.job)} · {t('age {age}', { age: focus.age })} · {t('{family} family', { family: focus.family })}</p>
          {focus.traits.length > 0 && <p className="muted small being-traits">{focus.traits.map((w) => tx(w)).join(', ')}</p>}
          {/* What they are worth at the work, which is the difference between
              a settlement of strangers and one that has been running a while. */}
          {focus.skill && (
            <div className="being-skill" title={t('{days} days at the trade', { days: focus.skill.days })}>
              <span className="skill-title">{tn(focus.skill.title)}</span>
              <span className="skill-pips" aria-label={t('Level {level} of 10', { level: focus.skill.level })}>
                {Array.from({ length: 10 }, (_, i) => (
                  <i key={i} className={i < focus.skill!.level ? 'on' : ''} />
                ))}
              </span>
              <em>
                {focus.skill.output > 1 ? t('+{pct}% output', { pct: Math.round((focus.skill.output - 1) * 100) }) : t('learning the work')}
                {focus.skill.toNext !== null && ` · ${t('{days}d to next', { days: focus.skill.toNext })}`}
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
            {affordable ? `${RENAME_CITIZEN_EMERGE.toLocaleString()} ${TOKEN.ticker}` : t('Not enough')}
          </button>
        </div>
      )}
      <div className="being-meters">
        <Meter label={t('Mood')} value={focus.mood} tone="linear-gradient(90deg,#4f9a3f,#8bf16b)" />
        <Meter label={t('Energy')} value={focus.energy} tone="linear-gradient(90deg,#b08a2c,#f0d05e)" />
        <Meter label={t('Purpose')} value={focus.purpose} tone="linear-gradient(90deg,#6d4f9a,#b98ce8)" />
      </div>
      <div className="being-status">
        <span className="pulse" />
        {tx(focus.status)}
        {focus.trouble && <b className="trouble">{tx(focus.trouble)}</b>}
        <button
          className={`follow-toggle ${following === focus.id ? 'on' : ''}`}
          onClick={onToggleFollow}
          title={t('Keep the camera on this being (F)')}
        >
          {following === focus.id ? t('Following') : t('Follow')}
        </button>
      </div>
      {focus.project && <div className="being-note">{t('Working on {project}', { project: tx(focus.project) })}</div>}
      {/* What they want is the thread of their story: the thing to watch for,
          and often the thing the player can do something about. */}
      {focus.want && (
        <div className="being-want">
          <span className="muted">{t('Wants')}</span>
          <b>{tx(focus.want.what)}</b>
          {focus.want.days > 0 && <em>{focus.want.days === 1 ? t('for a day') : t('for {n} days', { n: focus.want.days })}</em>}
        </div>
      )}
      {focus.lately.length > 0 && (
        <div className="being-lately">
          <span className="muted">{t('Lately')}</span>
          <ul>{focus.lately.map((line, i) => <li key={i}>{tx(line)}</li>)}</ul>
        </div>
      )}
      {focus.heard.length > 0 && (
        <div className="being-lately being-heard">
          <span className="muted">{t('Heard')}</span>
          <ul>{focus.heard.map((line, i) => <li key={i}>{tx(line)}</li>)}</ul>
        </div>
      )}
      {focus.lastTalk && (
        <div className="being-note being-talk">
          {focus.lastTalk.daysAgo <= 0
            ? t('Talked with {name} today about {topic}.', { name: focus.lastTalk.name, topic: tx(focus.lastTalk.topic) })
            : t('Talked with {name} {n} days ago about {topic}.', { name: focus.lastTalk.name, n: focus.lastTalk.daysAgo, topic: tx(focus.lastTalk.topic) })}
        </div>
      )}
      {focus.friends.length > 0 && (
        <div className="being-people">
          <span className="muted">{t('Friends')}</span>
          {focus.friends.map((f) => (
            <button key={f.id} className="person-chip" onClick={() => onFocus({ kind: 'citizen', id: f.id })}>{f.name}</button>
          ))}
        </div>
      )}
      {!readOnly && focus.age >= 16 && (
        <div className="demolish dismiss">
          <button
            className={confirming === focus.id ? 'danger armed' : 'danger'}
            onClick={() => {
              if (confirming === focus.id) { onDismiss(focus.id); setConfirming(null); }
              else setConfirming(focus.id);
            }}
          >
            {confirming === focus.id ? t('Send them away — tap again') : t('Send away · {gold} Gold', { gold: DISMISS_GOLD })}
          </button>
          <span className="muted small">{t('They leave on the road with a few days’ pay. Their bed and their post are free the same day.')}</span>
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
  const [open, setOpen] = useState(defaultOpen !== false);
  // A panel that asks to be open — the danger panel while something is
  // wrong — opens whatever the player folded it to last week.
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
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

function StatusPanel({ view, woodland, activePanel, onPanel }: {
  view: Snapshot; woodland: HudProps['woodland']; activePanel: PanelKey; onPanel: (panel: PanelKey) => void;
}) {
  useLocale();
  return (
    <Folding id="status" title={t('WORLD')} badge={<span title={tn(view.weather)}>{WEATHER_ICON[view.weather] ?? '☀'}</span>}>
      <Stat icon="◍" label={t('Population')} value={`${view.population}`} />
      <Stat icon="♥" label={t('Happiness')} value={`${view.happiness}%`} />
      <Stat icon="⚡" label={t('Energy')} value={`${view.energy}%`} />
      <Stat icon={WEATHER_ICON[view.weather] ?? '☀'} label={t('Day')} value={`${view.day} · ${view.clock}`} />
      <Stat icon="⚑" label={t('Era')} value={view.era.gate.next ? t('{era} · {n} days', { era: tn(view.era.name), n: view.era.days }) : tn(view.era.name)} />
      <Stat icon="◆" label={t('City')} value={t('Level {n}', { n: view.city.level })} />
      <Stat
        icon={view.temperature <= 2 ? '❄' : view.temperature >= 30 ? '☼' : '🌡'}
        label={t('Temperature')}
        value={`${Math.round(view.temperature)}°C · ${tn(view.temperatureLabel)}`}
      />
      {woodland && (
        <Stat
          icon="♣"
          label={t('Woodland')}
          value={woodland.stumps + woodland.saplings > 0
            ? t('{standing} · {regrowing} regrowing', { standing: woodland.standing, regrowing: woodland.stumps + woodland.saplings })
            : t('{standing} trees', { standing: woodland.standing })}
        />
      )}
      <div className="status-foot">
        <span>{tn(view.season)} · {tn(view.weather)}</span>
        <span>{t('{n} working', { n: view.employed })} · {t('{n} outdoors', { n: view.outdoors })}{view.seated > 0 ? ` · ${t('{n} sitting', { n: view.seated })}` : ''}</span>
        <span>{t('{born} born · {died} died here', { born: view.births, died: view.deaths })}</span>
      </div>
      {/* The food figure, and the door to the market. It was a floating card
          of its own under the minimap, saying one number. */}
      <button className="food-row" onClick={() => onPanel(activePanel === 'market' ? null : 'market')}>
        <span className="stat-icon">◍</span>
        <span className="stat-label">{t('FOOD IN STORE')}</span>
        <b>{view.food}</b>
        <em>{t('MARKET')}</em>
      </button>
    </Folding>
  );
}

/**
 * Everything asking for the player, in one place and in order: what is going
 * wrong, what to build, and what is on today. These were three cards — the
 * helper, the dangers and the events — and between them they took most of the
 * rail while saying, on a quiet day, that nothing was happening three times.
 */
function AttentionPanel({ view, visiting, onPanel, onRebuild, onFight }: {
  view: Snapshot; visiting: boolean; onPanel: (panel: PanelKey) => void; onRebuild: (id: string) => void; onFight: (id: string) => void;
}) {
  useLocale();
  const worst = view.readiness[0];
  const advice = visiting ? [] : view.advice;
  const count = view.hazards.length + advice.length + view.events.filter((e) => e.status === 'now').length;
  const quiet = view.hazards.length === 0 && advice.length === 0 && view.events.length === 0;
  return (
    <Folding id="attention" title={t('ATTENTION')} badge={count > 0 ? <span>{count}</span> : undefined} defaultOpen={view.hazards.length > 0 || undefined}>
      {quiet && <p className="attention-empty">{t('Nothing is asking for you. Watch the world, or improve what stands.')}</p>}

      {view.hazards.length > 0 && (
        <div className="attention-section">
          {view.hazards.map((h) => (
            <div key={h.id} className={`hazard ${h.kind} ${DIRE.has(h.kind) ? 'dire' : ''}`}>
              <div className="hazard-head">
                <span>{tn(h.label)}</span>
                <b>{h.hours ? t('{n}h more', { n: h.hours }) : h.days === 1 ? t('today') : t('{n} days', { n: h.days })}</b>
              </div>
              <em>{tx(h.effect)}</em>
              {h.wrecked > 0 && <em className="wrecked">{t('{n} in ruins — rebuild from the building card.', { n: h.wrecked })}</em>}
              {!visiting && h.severity > 0 && (
                h.fought ? (
                  <em className="fought">{t('{what} — done.', { what: tn(h.fight.title) })}</em>
                ) : (
                  <button className="fight" disabled={view.treasury < h.fight.gold} onClick={() => onFight(h.id)} title={tx(h.fight.blurb)}>
                    {t('{what} · {gold} Gold', { what: tn(h.fight.title), gold: h.fight.gold.toLocaleString() })}
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}

      {advice.length > 0 && (
        <div className="attention-section">
          <span className="eyebrow">{t('TO BUILD')}</span>
          {advice.map((a, i) => (
            <div key={`${a.kind}-${a.type ?? ''}-${i}`} className={`advice ${a.kind}`}>
              <div className="advice-head">
                <b>{tx(a.title)}</b>
                {a.kind === 'build' && <button className="ghost small" onClick={() => onPanel('build')}>{t('Build')}</button>}
                {a.kind === 'rebuild' && a.buildingId && <button className="ghost small rebuild" onClick={() => onRebuild(a.buildingId!)}>{t('Rebuild')}</button>}
              </div>
              <span>{tx(a.why)}</span>
              <em>{tx(a.gain)}</em>
            </div>
          ))}
        </div>
      )}

      {(view.events.length > 0 || view.resolution || view.artworks.length > 0) && (
        <div className="attention-section">
          <span className="eyebrow">{t('TODAY')}</span>
          {view.events.map((e) => (
            <div key={e.id} className={`event-row ${e.status}`}>
              <div className="event-head">
                <span>{tn(e.name)}</span>
                <b>{tx(e.time)}</b>
              </div>
              {e.outcome && <em className="event-outcome">{tx(e.outcome)}</em>}
              {!e.outcome && e.status === 'now' && e.attendees > 0 && (
                <em className="event-outcome">{t('{n} there', { n: e.attendees })}</em>
              )}
            </div>
          ))}
          {view.resolution && (
            <div className="resolution">
              <span>{t('THE TOWN RESOLVED')}</span>
              <p>{tx(view.resolution.text[0].toUpperCase() + view.resolution.text.slice(1))}.</p>
              <em>{t('{n} in the room, day {day}', { n: view.resolution.voters, day: view.resolution.day })}</em>
            </div>
          )}
          {view.artworks.length > 0 && (
            <div className="gallery">
              <span>{t('THE SETTLEMENT’S WORK')}</span>
              {view.artworks.slice(0, 4).map((a) => (
                <div key={a.id} className="gallery-row">
                  <span>&ldquo;{a.title}&rdquo;</span>
                  <em>{a.maker}</em>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Readiness only when it is worth acting on: a settlement ready for
          everything has nothing to read here. */}
      {worst && worst.percent < 75 && (
        <div className="attention-section">
          <span className="eyebrow">{t('READINESS')}</span>
          <div className="readiness">
            {view.readiness.filter((r) => r.percent < 75).map((r) => (
              <div key={r.kind} className="ready-row" title={tx(r.defence)}>
                <span>{tn(r.label)}</span>
                <div className="ready-bar"><i style={{ width: `${r.percent}%` }} className={r.percent < 40 ? 'low' : 'mid'} /></div>
                <b>{r.percent}%</b>
              </div>
            ))}
          </div>
          <p className="muted small readiness-note">{tx(worst.defence)}</p>
        </div>
      )}
    </Folding>
  );
}

/** The kinds that put the whole settlement in danger, and earn the banner. */
const DIRE = new Set(['earthquake', 'tornado', 'flood', 'plague', 'fire']);

/**
 * The red bar under the clock while the settlement is in danger.
 *
 * A disaster in a folded panel is a line of text; one across the top of the
 * screen, with the one thing the player can do about it next to it, is a
 * settlement in danger.
 */
function DangerBanner({ view, onFight, readOnly }: { view: Snapshot; onFight: (id: string) => void; readOnly: boolean }) {
  useLocale();
  // A hazard at nought severity is one the settlement was ready for: news, not danger.
  const h = view.hazards.find((x) => DIRE.has(x.kind) && x.severity > 0) ?? null;
  const rogue = view.rogue;
  if (!h && !rogue) return null;
  return (
    <div className={`danger-banner ${h ? h.kind : 'rogue'}`} role="status">
      <span className="danger-mark" aria-hidden>⚠</span>
      <div className="danger-text">
        <b>{h ? tn(h.label) : t('Somebody has turned on the settlement')}</b>
        <span>{h ? tx(h.effect) : rogue ?? ''}</span>
      </div>
      {h && !readOnly && !h.fought && (
        <button className="fight" disabled={view.treasury < h.fight.gold} onClick={() => onFight(h.id)} title={tx(h.fight.blurb)}>
          {t('{what} · {gold} Gold', { what: tn(h.fight.title), gold: h.fight.gold.toLocaleString() })}
        </button>
      )}
      {h && h.fought && <em>{t('{what} — done.', { what: tn(h.fight.title) })}</em>}
    </div>
  );
}

function FeedPanel({ view }: { view: Snapshot }) {
  useLocale();
  return (
    <Folding id="feed" title={t('WORLD FEED')} badge={<span>✦</span>}>
      <div className="feed-scroll">
        {view.feed.map((entry) => (
          <div key={entry.id} className={`feed-row kind-${entry.kind}`}>
            <i>{FEED_ICON[entry.kind]}</i>
            <span>{tx(entry.text)}</span>
          </div>
        ))}
      </div>
    </Folding>
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
      title={visiting ? t('Send Gold to this settlement') : t('Open the Bank')}
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
          <em>{t('THEIR TREASURY')}</em>
          <b>—</b>
        </span>
      ) : (
        <span className={`purse-cell gold${view.treasury + view.frozen >= view.goldCap ? ' full' : ''}`}>
          <em>{t('GOLD')}</em>
          {/* What it holds of what it may hold: the answer to "how much can I
              keep?" belongs next to the Gold, not in a guide.
              The big figure is what can be spent. Gold standing in an order is
              still the town's and still counts against the ceiling, so it is
              said here rather than left to look like Gold that went missing —
              which is exactly what players took it for. */}
          <b>{Math.floor(view.treasury).toLocaleString()}<i> / {view.goldCap.toLocaleString()}</i></b>
          {view.frozen > 0 && <u>{t('+{n} listed', { n: view.frozen.toLocaleString() })}</u>}
        </span>
      )}
      <span className="purse-cell emerge">
        <em>{t('{ticker} EARNED', { ticker: TOKEN.ticker })}</em>
        <b>{uncollected.toLocaleString()}</b>
      </span>
      <span className="purse-cell wallet">
        <em>{t('WALLET')}</em>
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
  if (minutes < 2) return t('live');
  if (minutes < 60) return t('{n} minutes ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? t('1 hour ago') : t('{n} hours ago', { n: hours });
  const days = Math.round(hours / 24);
  return days === 1 ? t('1 day ago') : t('{n} days ago', { n: days });
}

/*
 * The doors, in three groups: the settlement, other people, and the chain.
 * `group` marks the first door of a group, which the strip draws a hairline
 * before. The guide is not here: it is about the interface rather than the
 * world, and lives beside the language switch.
 */
const ACTIONS: { key: Exclude<PanelKey, null>; icon: string; label: string; short: string; blurb: string; group?: boolean }[] = [
  { key: 'build', icon: '⚒', label: 'BUILD', short: 'BUILD', blurb: 'Places and resources' },
  { key: 'people', icon: '☺', label: 'PEOPLE', short: 'PEOPLE', blurb: 'Trades, posts and training' },
  { key: 'market', icon: '◍', label: 'MARKET', short: 'SHOP', blurb: 'Prices and scarcity' },
  { key: 'land', icon: '⌂', label: 'LAND', short: 'LAND', blurb: 'Plots for sale' },
  { key: 'exchange', icon: '⇄', label: 'TRADE', short: 'TRADE', blurb: 'Buy and sell with other players', group: true },
  { key: 'chat', icon: '✎', label: 'CHAT', short: 'CHAT', blurb: 'Talk to other players' },
  { key: 'arena', icon: '⚔', label: 'ARENA', short: 'ARENA', blurb: 'Duels and betting' },
  { key: 'casino', icon: '⚄', label: 'CASINO', short: 'CASINO', blurb: 'Coin, cups, Gold or $EMERGE' },
  { key: 'gacha', icon: '⛏', label: 'PROSPECT', short: 'DIG', blurb: 'Send a party out', group: true },
  { key: 'connect', icon: '◈', label: 'ON-CHAIN', short: 'CHAIN', blurb: 'Plot, wallet and vault' },
];

export function Hud(props: HudProps) {
  const { view, paused, speed, placing, activePanel } = props;
  useLocale();
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
      ...ACTIONS.filter((a) => a.key === 'market' || a.key === 'chat' || a.key === 'arena').map((a) => ({ ...a, group: false })),
      VISITOR_GIFT,
    ]
    : ACTIONS;

  return (
    <div className={`hud ${props.visiting ? 'is-visiting' : ''}`}>
      <HoverTip hover={props.hover} />
      {!introShown && (
        <div className="hud-corner">
          <LanguageSwitch className="hud-lang" />
          <button
            className={`hud-guide ${activePanel === 'guide' ? 'on' : ''}`}
            onClick={() => props.onPanel(activePanel === 'guide' ? null : 'guide')}
            title={t('How all of this works')}
            aria-label={t('Game guide')}
          >?</button>
        </div>
      )}

      {!introShown && (
        <button className="world-chip" onClick={() => setIntroShown(true)} title={t('About Emerge')}>
          <span>✦</span>
          <b>{view.banner && isEmblem(view.banner) && <i className="banner-glyph" title={EMBLEM_NAME[view.banner]}>{EMBLEM_GLYPH[view.banner]}</i>}{view.name}</b>
        </button>
      )}

      <header className={`brand-block ${introShown ? '' : 'hidden'}`} aria-hidden={!introShown}>
        <div className="brand-line">
          <BrandMark />
          <div>
            <div className="wordmark">EMERGE</div>
            <div className="tagline">{view.name === 'Emerge' ? t('THE AI WORLD') : view.name.toUpperCase()}</div>
          </div>
        </div>
        <p className="brand-copy">{t('A living world of autonomous AI beings. They think. They socialise. They build. They evolve.')}</p>
        <p className="brand-copy accent">{t('You don’t control them.')}<br />{t('You discover them.')}<br />{t('You shape the world they live in.')}</p>
      </header>

      {/* One centred column: population, then the clock, then what the player
          has. Laid out as separate absolute boxes these sat on top of each
          other the moment the window was narrow enough — the purse covered the
          population pill and the speed controls both. */}
      <div className="top-centre">
        <div className="beings-pill" title={t('A living world of autonomous AI beings. They think. They socialise. They build. They evolve.')}>
          <span className="spark" aria-hidden />
          <b>{t('AI BEINGS')}</b>
          <em>{t('{n} here', { n: view.population })}</em>
          {/* Two different populations, and they are easy to confuse, so they
              are labelled rather than left as two numbers side by side: the
              beings who live on this plot, and the people playing the game. */}
          {props.online !== null && (
            <span className="players-online" title={t('People playing Emerge right now')}>
              <i aria-hidden>●</i>
              {props.online === 1 ? t('1 player') : t('{n} players', { n: props.online.toLocaleString() })}
            </span>
          )}
        </div>
        <div className="time-controls">
          <button className={paused ? 'live paused' : 'live'} onClick={props.onTogglePause}>
            {paused ? t('▶ Resume') : t('❙❙ Pause')}
          </button>
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'sel' : ''} onClick={() => props.onSpeed(s)}>{s}×</button>
          ))}
          <button
            className={props.sound ? 'sel' : ''}
            onClick={props.onToggleSound}
            title={props.sound ? t('Mute the world') : t('Listen to the world')}
          >
            {props.sound ? '♪' : '♪̸'}
          </button>
          <button className={props.grid ? 'sel' : ''} onClick={props.onGrid} title={t('Show a tile grid over the ground, for planning (G)')} aria-label={t('Grid')}>
            ⌗
          </button>
          <button className={props.effects ? 'sel' : ''} onClick={props.onEffects} title={t('The look: bloom, warmth and vignette over the frame (V)')} aria-label={t('Look')}>
            ✧
          </button>
          <button onClick={props.onPhoto} title={t('Photo mode: hide the interface for a clean screenshot (P)')} aria-label={t('Photo mode')}>
            ◉
          </button>
        </div>
        <DangerBanner view={view} onFight={props.onFight} readOnly={!!props.visiting} />
        <Purse view={view} player={props.player} visiting={!!props.visiting} onPanel={props.onPanel} />
        {/* Who is looking, not counting you: the count arrives with the owner
            already taken out, so one is one visitor and nothing is nobody. */}
        {props.watching > 0 && (
          <div
            className="watching"
            title={props.watching === 1
              ? t('Somebody else has this world open')
              : t('{n} other people have this world open', { n: props.watching })}
          >
            <span aria-hidden>◉</span>
            <b>{props.watching}</b>
            <em>{t('watching')}</em>
          </div>
        )}
      </div>

      {/* Somebody else's settlement. Said plainly and permanently, because
          every control on screen behaves differently here and a player who
          forgot where they were would read the difference as a bug. */}
      {props.visiting && (
        <div className={`visiting-bar ${props.visiting.hand ? 'at-work' : ''}`}>
          <span className="eyebrow">{props.visiting.hand ? t('AT WORK') : t('VISITING')}</span>
          <b>{props.visiting.worldName}</b>
          <em>
            {props.visiting.ownerName?.trim() ? props.visiting.ownerName : shortAddress(props.visiting.owner)}
            {' · '}{props.visiting.hand
              ? t('hired hand · about {n} {ticker}/day', { n: Math.round(view.stewardship.dailyYield * HAND_SHARE).toLocaleString(), ticker: TOKEN.ticker })
              : props.visiting.unpublished
                ? t('never published · grown from its seed, running on its own')
                : sinceWhen(props.visiting.at)}
          </em>
          <button className="ghost" onClick={props.onEndVisit}>{t('Leave')}</button>
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
              <b>{railOpen ? t('CLOSE') : t('WORLD')}</b>
            </button>
            <aside className={`phone-sheet ${railOpen ? 'open' : ''}`} aria-hidden={!railOpen}>
              <div className="sheet-grip" />
              <StatusPanel view={view} woodland={props.woodland} activePanel={activePanel} onPanel={props.onPanel} />
              <AttentionPanel view={view} visiting={!!props.visiting} onPanel={props.onPanel} onRebuild={props.onRebuild} onFight={props.onFight} />
              <FeedPanel view={view} />
            </aside>
          </>
        )
        : (
          <aside className="right-rail">
            <StatusPanel view={view} woodland={props.woodland} activePanel={activePanel} onPanel={props.onPanel} />
            <AttentionPanel view={view} visiting={!!props.visiting} onPanel={props.onPanel} onRebuild={props.onRebuild} onFight={props.onFight} />
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
              onDismiss={props.onDismiss}
              onRebuild={props.onRebuild}
              treasury={view.treasury}
              moving={props.movingBuilding}
              onUpgrade={props.onUpgradeBuilding}
              onUpgradeAll={props.onUpgradeAll}
              onMove={props.onMoveBuilding}
            />
          )
          : props.firstDay && !props.visiting
            ? <FirstDay steps={props.firstDay.steps} cap={props.firstDay.cap} compact={compact} onGo={props.onFirstDayGo} onDismiss={props.onFirstDayDismiss} />
            : (
            <div className="whisper" aria-label={t('OBSERVE')}>
              <i aria-hidden />
              <p>
                {t('Tap any being or place to follow their story.')}
                {compact ? ` ${t('Drag to pan, pinch to zoom.')}` : ` ${t('Drag to pan, scroll to zoom.')}`}
              </p>
            </div>
          )}
      </div>

      <nav className="action-bar" aria-label={props.visiting ? t('SOMEBODY ELSE’S WORLD') : t('WHAT WILL YOU DO?')}>
        <div className="action-row">
          {actions.map((action) => {
            const active = action.key === activePanel;
            return (
              <button
                key={action.key}
                className={`action ${active ? 'active' : ''} ${action.key} ${'group' in action && action.group ? 'group-start' : ''}`}
                title={t(action.blurb)}
                onClick={() => {
                  props.onPanel(active ? null : (action.key as PanelKey));
                }}
              >
                <b>{action.icon}</b>
                <span>{t(compact ? action.short : action.label)}</span>
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
            <button onClick={() => props.onZoom(1.25)} aria-label={t('Zoom in')}>+</button>
            <button onClick={() => props.onZoom(0.8)} aria-label={t('Zoom out')}>−</button>
            <button onClick={props.onResetView} aria-label={t('Reset view')}>⌂</button>
          </div>
        )
        : (
          <aside className="bottom-right">
            <section className="panel minimap-panel">
              <h3>{t('WORLD MAP')}</h3>
              <Minimap draw={props.drawMinimap} onJump={props.onMinimapJump} />
              <div className="map-tools">
                <button onClick={() => props.onZoom(1.18)} aria-label={t('Zoom in')}>+</button>
                <button onClick={() => props.onZoom(0.85)} aria-label={t('Zoom out')}>−</button>
                <button onClick={props.onResetView} aria-label={t('Reset view')}>⌂</button>
                <span>{t('{n} areas', { n: view.unlockedAreas.length })}</span>
              </div>
            </section>
          </aside>
        )}

      {placing && (
        <div className="placement-bar">
          <span>
            {placing === 'Clear trees'
              ? <>{t('Clearing trees')} — {compact ? t('tap the wood to fell everything within reach.') : t('click the wood to fell everything within reach, Esc to cancel.')}</>
              : placing === 'Bridge'
                ? <>{t('Bridge')} — {compact ? t('tap the water you want bridged, or the land across it.') : t('click the water you want bridged, or the land across it; Esc to cancel.')}</>
              : placing === 'Unbridge'
                ? <>{t('Take a crossing down')} — {compact ? t('tap the deck you want taken down.') : t('click the deck you want taken down; Esc to cancel.')}</>
              : placing === 'Dig'
                ? <>{t('Dig a pond')} — {compact ? t('tap open ground where the ring is green.') : t('click open ground where the ring is green; Esc to cancel.')}</>
              : placing === 'Fill'
                ? <>{t('Fill a pond in')} — {compact ? t('tap a pond you dug.') : t('click a pond you dug; Esc to cancel.')}</>
                : <>{t('Placing')} <b>{tn(placing)}</b> — {compact ? t('tap open ground to build.') : t('click open ground to build, Esc to cancel.')}</>}
          </span>
          <button onClick={props.onCancelBuild}>{t('Cancel')}</button>
        </div>
      )}
    </div>
  );
}
