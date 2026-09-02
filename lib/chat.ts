/**
 * Player chat.
 *
 * Two channels: one that follows the player wherever they go, and one attached
 * to the world they are standing in, so a message about Fernrest is read by the
 * people looking at Fernrest.
 *
 * Messages go to `/api/chat` and come back from it by polling. The local copy
 * is a cache, not the record: it keeps the last thing you saw on screen through
 * a reload and while the network is down, and the relay is what other players
 * actually read.
 *
 * Polling rather than a socket, at a few seconds a tick. At the volume a
 * settlement game's chat runs at, that is indistinguishable from a push, and it
 * survives a serverless deployment — which a long-lived connection does not.
 */

const KEY = 'emerge.chat.v1';

/** How many messages a channel keeps. Older ones fall off the top. */
const HISTORY = 120;

/** The longest a single message may be. */
export const MESSAGE_LIMIT = 240;

/** The shortest gap between two messages from the same player, in milliseconds. */
const RATE_LIMIT_MS = 1200;

export type ChannelKind = 'global' | 'world';

export interface ChatMessage {
  id: string;
  /** 'global', or `world:<seed>`. */
  channel: string;
  /** The wallet address when one is connected, else a local handle. */
  author: string;
  /** Whether `author` is a real wallet address. */
  wallet: boolean;
  text: string;
  at: number;
}

export interface ChatState {
  /** Messages across every channel, oldest first. */
  messages: ChatMessage[];
}

/** The channel id for a world, so each settlement has its own room. */
export const worldChannel = (seed: number) => `world:${seed}`;

function read(): ChatState {
  if (typeof window === 'undefined') return { messages: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ChatState>) : null;
    const messages = Array.isArray(parsed?.messages)
      ? parsed!.messages!.filter((m): m is ChatMessage =>
        !!m && typeof m.text === 'string' && typeof m.channel === 'string')
      : [];
    return { messages };
  } catch {
    // A corrupt entry should cost the player their history, not the game.
    return { messages: [] };
  }
}

function write(state: ChatState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* private browsing and full quotas both land here */ }
}

export const loadChat = read;

/** Messages on one channel, oldest first. */
export function channelOf(state: ChatState, channel: string) {
  return state.messages.filter((m) => m.channel === channel);
}

let lastSent = 0;

export interface SendResult {
  state: ChatState;
  /** Why the message did not go, when it did not. */
  refused: string | null;
}

/**
 * Post a message.
 *
 * The client checks the same three things the server does — empty, too long,
 * too fast — so an obvious mistake costs a round trip rather than a rejection,
 * and the server checks them again because a client's word is not evidence.
 */
export async function send(
  state: ChatState,
  channel: string,
  text: string,
  address: string | null,
  name: string,
): Promise<SendResult> {
  const body = text.trim().replace(/\s+/g, ' ');
  if (!body) return { state, refused: null };
  if (body.length > MESSAGE_LIMIT) {
    return { state, refused: `Keep it under ${MESSAGE_LIMIT} characters.` };
  }
  const now = Date.now();
  if (now - lastSent < RATE_LIMIT_MS) {
    return { state, refused: 'Slow down a moment.' };
  }
  lastSent = now;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, author: address ?? name, wallet: !!address, text: body }),
    });
    const json = (await response.json()) as { message?: ChatMessage; error?: string };
    if (!response.ok || !json.message) {
      return { state, refused: json.error ?? 'The message did not go.' };
    }
    return { state: receive(state, json.message), refused: null };
  } catch {
    return { state, refused: 'Could not reach the relay. Check your connection.' };
  }
}

export interface PollResult {
  state: ChatState;
  /** True when the relay has a shared store behind it and can reach other players. */
  shared: boolean;
  /** True when the relay could not be reached at all. */
  offline: boolean;
}

/**
 * Ask the relay for anything newer than what we already hold on a channel.
 *
 * Sending the newest timestamp we have rather than a page number means the
 * usual answer is an empty list, and two clients that have drifted apart
 * converge without either of them having to know it happened.
 */
export async function poll(state: ChatState, channel: string): Promise<PollResult> {
  const held = channelOf(state, channel);
  const newest = held.length ? held[held.length - 1].at : 0;
  try {
    const response = await fetch(`/api/chat?channel=${encodeURIComponent(channel)}&since=${newest}`, {
      cache: 'no-store',
    });
    if (!response.ok) return { state, shared: false, offline: true };
    const json = (await response.json()) as { messages?: ChatMessage[]; shared?: boolean };
    let next = state;
    for (const message of json.messages ?? []) next = receive(next, message);
    return { state: next, shared: json.shared === true, offline: false };
  } catch {
    return { state, shared: false, offline: true };
  }
}

/** Fold a message in, keeping the channel in order and free of duplicates. */
export function receive(state: ChatState, message: ChatMessage): ChatState {
  if (state.messages.some((m) => m.id === message.id)) return state;
  const next: ChatState = {
    ...state,
    messages: [...state.messages, message].sort((a, b) => a.at - b.at).slice(-HISTORY * 4),
  };
  write(next);
  return next;
}

/** How often the panel asks the relay for new messages, in milliseconds. */
export const POLL_INTERVAL = 4_000;
