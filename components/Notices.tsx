'use client';

/**
 * Things that happened while you were looking at your settlement.
 *
 * Three kinds. Two are about other people — somebody said something, somebody
 * took a plot — and one is about your own settlement getting on with it: the
 * market sold something. None is worth interrupting the world for, and all are
 * worth knowing, so they arrive as a short-lived card in the corner rather
 * than a modal.
 *
 * The rule for whether a notice is shown at all is "would the player otherwise
 * miss it": a message that arrives while the chat panel is open is already on
 * screen, and a claim the player just made themselves is not news to them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchClaims, type Claim } from '@/lib/net/registry';
import { fetchGldWins, gldAmount } from '@/lib/net/casino';
import { fetchWarFeed, type WarEvent } from '@/lib/net/war';
import { OCCUPIER_SHARE } from '@/lib/world/war';
import { channelOf, loadChat, poll, worldChannel, type ChatState } from '@/lib/chat';
import { TOKEN, shortAddress } from '@/lib/chain/emerge';
import { t } from '@/lib/i18n';

export interface Notice {
  id: string;
  kind: 'chat' | 'claim' | 'sale' | 'sync' | 'danger' | 'win';
  title: string;
  body: string;
  /** What tapping the card does, when there is something useful to do. */
  action?: { label: string; run: () => void };
  /** How long it stays, in milliseconds. A hand-off deserves longer than a chat line. */
  lifetime?: number;
}

/** How often the world is asked what happened, in milliseconds. */
const POLL = 6_000;

/** How long one card stays on screen. */
const LIFETIME = 9_000;

/** The most cards at once. Beyond this the oldest goes to make room. */
const MAX_ON_SCREEN = 3;

/**
 * Whether chat raises a card, remembered between sessions.
 *
 * A busy global channel is a card every few seconds over the top of a world
 * somebody is trying to watch, and the answer to that is a switch rather than
 * an argument about the right rate. Claims and gifts are rare enough to stay
 * on either way — the setting is about chat, and says so.
 */
const CHAT_NOTICES = 'emerge.notices.chat.v1';

export function chatNoticesOn(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(CHAT_NOTICES) !== 'off';
  } catch {
    return true;
  }
}

export function setChatNotices(on: boolean) {
  try {
    window.localStorage.setItem(CHAT_NOTICES, on ? 'on' : 'off');
  } catch { /* private browsing; the setting simply will not persist */ }
}

/**
 * Watch chat and the land registry, and hand back notices worth showing.
 *
 * `mine` is the player's own address and chat name, so their own messages and
 * their own claims are not announced back to them. `announce` comes back out
 * so the caller can raise a card for something only it knows about — a gift
 * landing in the treasury, say.
 */
export function useNotices({ seed, chatOpen, chatNotices, mine, onOpenChat }: {
  seed: number;
  chatOpen: boolean;
  /** Whether a message should raise a card at all. */
  chatNotices: boolean;
  mine: { address: string | null; name: string };
  onOpenChat: () => void;
}) {
  const [notices, setNotices] = useState<Notice[]>([]);
  // Refs, because the poll loop is set up once and must read the current
  // values rather than the ones that existed at mount.
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;
  const chatNoticesRef = useRef(chatNotices);
  chatNoticesRef.current = chatNotices;

  const push = useCallback((notice: Notice) => {
    setNotices((held) => {
      if (held.some((n) => n.id === notice.id)) return held;
      return [...held, notice].slice(-MAX_ON_SCREEN);
    });
    window.setTimeout(() => {
      setNotices((held) => held.filter((n) => n.id !== notice.id));
    }, notice.lifetime ?? LIFETIME);
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotices((held) => held.filter((n) => n.id !== id));
  }, []);

  /* ---- chat ---- */
  useEffect(() => {
    // Everything already in the log is old news: a player opening a world
    // should not be met with a stack of cards for yesterday's conversation.
    let seen = new Set<string>();
    let primed = false;
    let live = true;

    const mark = (state: ChatState, channel: string) => {
      const messages = channelOf(state, channel);
      if (!primed) {
        for (const m of messages) seen.add(m.id);
        return;
      }
      for (const m of messages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const who = mineRef.current;
        // Your own message, coming back off the relay.
        if (m.author === who.name || (who.address && m.author.toLowerCase() === who.address.toLowerCase())) continue;
        // Already on screen in the panel, or switched off entirely.
        if (chatOpenRef.current || !chatNoticesRef.current) continue;
        push({
          id: `chat-${m.id}`,
          kind: 'chat',
          title: m.wallet ? shortAddress(m.author) : m.author,
          body: m.text,
          action: { label: t('Open chat'), run: () => onOpenChatRef.current() },
        });
      }
      // The set only ever grows while a tab is open; a settlement session is
      // hours and a channel holds two hundred, so this stays small.
      if (seen.size > 600) seen = new Set([...seen].slice(-300));
    };

    const tick = async () => {
      const held = loadChat();
      const world = await poll(held, worldChannel(seed));
      const both = await poll(world.state, 'global');
      if (!live) return;
      mark(both.state, worldChannel(seed));
      mark(both.state, 'global');
      primed = true;
    };

    tick();
    const timer = window.setInterval(tick, POLL);
    return () => { live = false; window.clearInterval(timer); };
  }, [seed, push]);

  /* ---- claims, and offers on them ---- */
  useEffect(() => {
    let seen = new Set<number>();
    // Who held each plot at the last look, so a change of hands is noticed.
    const ownerOf = new Map<number, string>();
    // Offers already known, so only a new one — or one newly accepted — is news.
    let offersSeen = new Set<string>();
    let primed = false;
    let live = true;

    const offerKey = (seed: number, o: { buyer: string; price: number; acceptedUntil?: number }) =>
      `${seed}:${o.buyer}:${o.price}:${o.acceptedUntil ? 'held' : 'open'}`;

    const tick = async () => {
      const { claims } = await fetchClaims();
      if (!live) return;
      if (!primed) {
        for (const c of claims) {
          seen.add(c.seed);
          ownerOf.set(c.seed, c.owner.toLowerCase());
          for (const o of c.offers ?? []) offersSeen.add(offerKey(c.seed, o));
        }
        primed = true;
        return;
      }
      const who = mineRef.current;
      const me = who.address?.toLowerCase() ?? null;
      for (const c of claims) {
        // A plot that changed hands is news to everybody: the sale went
        // wallet to wallet, and the map now has a new name on it.
        const before = ownerOf.get(c.seed);
        const now = c.owner.toLowerCase();
        if (before && before !== now) {
          push({
            id: `sold-${c.seed}-${c.at}`,
            kind: 'claim',
            title: t('Land changed hands'),
            body: now === me
              ? t('{region} is yours. {price} {ticker} went to its last owner.', { region: c.region, price: c.price.toLocaleString(), ticker: TOKEN.ticker })
              : t('{who} bought {region} ({world}) for {price} {ticker}, paid to its last owner.', { who: nameOf(c), region: c.region, world: c.worldName, price: c.price.toLocaleString(), ticker: TOKEN.ticker }),
            lifetime: 20_000,
          });
        }
        ownerOf.set(c.seed, now);
        // Offers: one card when somebody bids on your plot, one when an owner
        // accepts yours. Both are things worth walking to the map for.
        for (const o of c.offers ?? []) {
          const key = offerKey(c.seed, o);
          if (offersSeen.has(key)) continue;
          offersSeen.add(key);
          if (me && c.owner.toLowerCase() === me && !o.acceptedUntil) {
            push({
              id: `offer-${key}`,
              kind: 'claim',
              title: t('An offer on {region}', { region: c.region }),
              body: t('{who} offers {price} {ticker} for {world}. Answer it from the On-Chain panel.', { who: o.buyerName || shortAddress(o.buyer), price: o.price.toLocaleString(), ticker: TOKEN.ticker, world: c.worldName }),
              lifetime: 20_000,
            });
          } else if (me && o.buyer === me && o.acceptedUntil) {
            push({
              id: `accepted-${key}`,
              kind: 'claim',
              title: t('Your offer was accepted'),
              body: t('{region} is held for you at {price} {ticker} for two days. Pay from the world map to take it.', { region: c.region, price: o.price.toLocaleString(), ticker: TOKEN.ticker }),
              lifetime: 30_000,
            });
          }
        }
        if (seen.has(c.seed)) continue;
        seen.add(c.seed);
        if (me && c.owner.toLowerCase() === me) continue;
        push({
          id: `claim-${c.seed}-${c.at}`,
          kind: 'claim',
          title: t('Land claimed'),
          body: t('{who} settled {region} and called it {world}.', { who: nameOf(c), region: c.region, world: c.worldName }),
        });
      }
      if (offersSeen.size > 600) offersSeen = new Set([...offersSeen].slice(-300));
    };

    tick();
    const timer = window.setInterval(tick, POLL * 2);
    return () => { live = false; window.clearInterval(timer); };
  }, [push]);

  useGldWinNotices(push, () => mineRef.current.address);
  useWarNotices(push, () => mineRef.current.address);

  return { notices, dismiss, announce: push };
}

/** What a war event says on a card, to everybody. */
export function warCard(e: WarEvent): { title: string; body: string } {
  const actor = e.actorName || shortAddress(e.actor);
  const other = e.otherName || shortAddress(e.other);
  const where = e.worldName || e.region;
  switch (e.kind) {
    case 'invaded': return { title: t('{who} invaded {where}', { who: actor, where }), body: t('{who}’s army holds {where} now. {other} keeps {pct}% of its yield until they throw them out; the rest goes to the invader.', { who: actor, where, other, pct: Math.round((1 - OCCUPIER_SHARE) * 100) }) };
    case 'held': return { title: t('{where} held', { where }), body: t('{other}’s garrison threw {who}’s army back from {where}.', { who: actor, other, where }) };
    case 'retaken': return { title: t('{who} retook {where}', { who: actor, where }), body: t('{other}’s army was thrown out of {where}. The plot is shielded for a day.', { other, where }) };
    case 'ambushed': return { title: t('{who} ambushed {where}', { who: actor, where }), body: t('{who}’s army fell on {other}’s garrison holding {where}, and holds it now.', { who: actor, other, where }) };
    case 'withdrew': return { title: t('{who} withdrew from {where}', { who: actor, where }), body: t('{who}’s army marched home from {where}.', { who: actor, where }) };
    case 'lapsed': return { title: t('{where} is free again', { where }), body: t('{who}’s army went home from {where}: nobody paid for another day.', { who: actor, where }) };
    default: return { title: t('{who} opened a base', { who: actor }), body: t('{where} can raise an army now.', { where }) };
  }
}

/** How far back a war event still counts as news when a screen opens. */
const WAR_FRESH = 180_000;

/**
 * Watch the war and raise a card for every fight, on every screen: an
 * invasion is news to the whole map, whoever it happened to. The people
 * in it see the cards too — an owner away from their plot learns it is
 * held from here.
 */
export function useWarNotices(push: (notice: Notice) => void, mine: () => string | null) {
  const mineRef = useRef(mine);
  mineRef.current = mine;
  useEffect(() => {
    let since = Date.now() - WAR_FRESH;
    const seen = new Set<string>();
    let live = true;
    const tick = async () => {
      const { events, now } = await fetchWarFeed(since);
      if (!live) return;
      since = Math.max(since, now - 5_000);
      for (const e of [...events].reverse()) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        // A base opened is the owner's own business.
        const me = mineRef.current()?.toLowerCase() ?? null;
        if (e.kind === 'base' && (!me || e.actor.toLowerCase() !== me)) continue;
        const card = warCard(e);
        push({ id: `war-${e.id}`, kind: 'danger', title: card.title, body: card.body, lifetime: 18_000 });
      }
      if (seen.size > 400) { for (const id of [...seen].slice(0, 200)) seen.delete(id); }
    };
    tick();
    const timer = window.setInterval(tick, WIN_POLL);
    return () => { live = false; window.clearInterval(timer); };
  }, [push]);
}

/** How often the tables are asked who won, in milliseconds. A win is minutes apart at best. */
const WIN_POLL = 15_000;

/** How far back a win still counts as news when a screen opens: a player arriving a moment later still hears about it. */
const WIN_FRESH = 90_000;

/**
 * Watch the GLD table and raise a card for every win it pays, on every
 * screen: a real token leaving the vault for a player's wallet is the kind
 * of thing the whole game should see. The winner sees the result on the
 * table itself, so the card is not raised for them.
 */
export function useGldWinNotices(push: (notice: Notice) => void, mine: () => string | null) {
  // The caller's `mine` may be a fresh function every render; the watch is
  // set up once and reads the latest through a ref, or a settlement's
  // constant re-rendering would restart it before any poll could answer.
  const mineRef = useRef(mine);
  mineRef.current = mine;
  useEffect(() => {
    const mine = () => mineRef.current();
    let since = Date.now() - WIN_FRESH;
    const seen = new Set<string>();
    let live = true;
    const tick = async () => {
      const { wins, now } = await fetchGldWins(since);
      if (!live) return;
      // The server's clock, so a device that is a minute out never misses a win or repeats one.
      since = Math.max(since, now - 5_000);
      const me = mine()?.toLowerCase() ?? null;
      for (const w of [...wins].reverse()) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        if (me && w.address.toLowerCase() === me) continue;
        push({
          id: `win-${w.id}`,
          kind: 'win',
          title: t('GLD won at the tables'),
          body: w.stake
            ? t('{who} won {gld} GLD on a {stake} {ticker} stake.', { who: w.name?.trim() || shortAddress(w.address), gld: gldAmount(w.gld), stake: w.stake.toLocaleString(), ticker: TOKEN.ticker })
            : t('{who} won {gld} GLD at the tables.', { who: w.name?.trim() || shortAddress(w.address), gld: gldAmount(w.gld) }),
          lifetime: 15_000,
        });
      }
      if (seen.size > 400) { for (const id of [...seen].slice(0, 200)) seen.delete(id); }
    };
    tick();
    const timer = window.setInterval(tick, WIN_POLL);
    return () => { live = false; window.clearInterval(timer); };
  }, [push]);
}

/**
 * The GLD-win cards on their own, for a screen that has no chat or registry
 * watch of its own — the world map.
 */
export function GldWinNotices({ address }: { address: string | null }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const addressRef = useRef(address);
  addressRef.current = address;
  const push = useCallback((notice: Notice) => {
    setNotices((held) => (held.some((n) => n.id === notice.id) ? held : [...held, notice].slice(-MAX_ON_SCREEN)));
    window.setTimeout(() => setNotices((held) => held.filter((n) => n.id !== notice.id)), notice.lifetime ?? LIFETIME);
  }, []);
  const mine = useCallback(() => addressRef.current, []);
  useGldWinNotices(push, mine);
  useWarNotices(push, mine);
  return <Notices notices={notices} onDismiss={(id) => setNotices((held) => held.filter((n) => n.id !== id))} />;
}

const nameOf = (claim: Claim) =>
  claim.ownerName?.trim() ? claim.ownerName : shortAddress(claim.owner);

/** One mark per kind, so a glance says what a card is before it is read. */
const NOTICE_ICON: Record<Notice['kind'], string> = { chat: '✎', claim: '◈', sale: '◎', sync: '⇄', danger: '⚠', win: '✦' };

/** The cards themselves. */
export function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: string) => void }) {
  if (!notices.length) return null;
  return (
    <div className="notices">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice ${notice.kind}`}>
          <div className="notice-body">
            <b>{NOTICE_ICON[notice.kind]} {notice.title}</b>
            <p>{notice.body}</p>
            {notice.action && (
              <button
                className="ghost"
                onClick={() => { notice.action?.run(); onDismiss(notice.id); }}
              >
                {notice.action.label}
              </button>
            )}
          </div>
          <button className="notice-close" onClick={() => onDismiss(notice.id)} aria-label={t('Dismiss')}>×</button>
        </div>
      ))}
    </div>
  );
}
