'use client';

/**
 * Things that happened while you were looking at your settlement.
 *
 * Two kinds, and both are about other people: somebody said something, and
 * somebody took a plot. Neither is worth interrupting the world for, and both
 * are worth knowing, so they arrive as a short-lived card in the corner rather
 * than a modal.
 *
 * The rule for whether a notice is shown at all is "would the player otherwise
 * miss it": a message that arrives while the chat panel is open is already on
 * screen, and a claim the player just made themselves is not news to them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchClaims, type Claim } from '@/lib/net/registry';
import { channelOf, loadChat, poll, worldChannel, type ChatState } from '@/lib/chat';
import { shortAddress } from '@/lib/chain/emerge';

export interface Notice {
  id: string;
  kind: 'chat' | 'claim';
  title: string;
  body: string;
  /** What tapping the card does, when there is something useful to do. */
  action?: { label: string; run: () => void };
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
    }, LIFETIME);
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
          action: { label: 'Open chat', run: () => onOpenChatRef.current() },
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

  /* ---- claims ---- */
  useEffect(() => {
    let seen = new Set<number>();
    let primed = false;
    let live = true;

    const tick = async () => {
      const { claims } = await fetchClaims();
      if (!live) return;
      if (!primed) {
        for (const c of claims) seen.add(c.seed);
        primed = true;
        return;
      }
      for (const c of claims) {
        if (seen.has(c.seed)) continue;
        seen.add(c.seed);
        const who = mineRef.current;
        if (who.address && c.owner.toLowerCase() === who.address.toLowerCase()) continue;
        push({
          id: `claim-${c.seed}-${c.at}`,
          kind: 'claim',
          title: 'Land claimed',
          body: `${nameOf(c)} settled ${c.region} and called it ${c.worldName}.`,
        });
      }
    };

    tick();
    const timer = window.setInterval(tick, POLL * 2);
    return () => { live = false; window.clearInterval(timer); };
  }, [push]);

  return { notices, dismiss, announce: push };
}

const nameOf = (claim: Claim) =>
  claim.ownerName?.trim() ? claim.ownerName : shortAddress(claim.owner);

/** The cards themselves. */
export function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: string) => void }) {
  if (!notices.length) return null;
  return (
    <div className="notices">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice ${notice.kind}`}>
          <div className="notice-body">
            <b>{notice.kind === 'chat' ? '✎' : '◈'} {notice.title}</b>
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
          <button className="notice-close" onClick={() => onDismiss(notice.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
