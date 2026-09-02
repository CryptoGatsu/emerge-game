/**
 * Player chat.
 *
 * Two channels: one that follows the player wherever they go, and one attached
 * to the world they are standing in, so a message about Fernrest is read by the
 * people looking at Fernrest.
 *
 * **What this actually reaches.** Messages are held in this browser. There is
 * no chat server in this build, and there is no honest way to fake one: two
 * browsers share no storage, so a message typed here cannot appear anywhere
 * else. The transport is the one thing in this module that is stubbed, and it
 * is stubbed behind a seam — `deliver` is where a websocket or a relay goes —
 * rather than being papered over with invented replies from players who are not
 * there. The panel says so in as many words.
 *
 * What is real: the channels, the history, the identity a message is signed
 * with (a connected wallet address, or a local handle when there is none), the
 * ordering, the persistence across sessions, and the moderation floor of a
 * length cap and a rate limit.
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
  /** A name for this player when no wallet is connected. */
  handle: string;
}

/** The channel id for a world, so each settlement has its own room. */
export const worldChannel = (seed: number) => `world:${seed}`;

const HANDLE_WORDS = [
  'Sparrow', 'Ember', 'Harbour', 'Thistle', 'Lantern', 'Quarry', 'Willow', 'Ridge',
  'Beacon', 'Hollow', 'Kestrel', 'Marsh', 'Anvil', 'Cinder', 'Pike', 'Larch',
];

/** A stable, friendly name for a player with no wallet connected. */
function newHandle() {
  const word = HANDLE_WORDS[Math.floor(Math.random() * HANDLE_WORDS.length)];
  return `${word}${Math.floor(Math.random() * 900) + 100}`;
}

function read(): ChatState {
  if (typeof window === 'undefined') return { messages: [], handle: 'Guest' };
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ChatState>) : null;
    const messages = Array.isArray(parsed?.messages)
      ? parsed!.messages!.filter((m): m is ChatMessage =>
        !!m && typeof m.text === 'string' && typeof m.channel === 'string')
      : [];
    return { messages, handle: typeof parsed?.handle === 'string' ? parsed.handle : newHandle() };
  } catch {
    // A corrupt entry should cost the player their history, not the game.
    return { messages: [], handle: newHandle() };
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
 * Refuses an empty message, one over the length cap, and one sent faster than
 * the rate limit — the three things that make a shared room unreadable, and the
 * three worth enforcing at the client whether or not a server ever does.
 */
export function send(state: ChatState, channel: string, text: string, address: string | null): SendResult {
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

  const message: ChatMessage = {
    id: `m${now}-${Math.floor(Math.random() * 1e6)}`,
    channel,
    author: address ?? state.handle,
    wallet: !!address,
    text: body,
    at: now,
  };
  const next: ChatState = {
    ...state,
    messages: [...state.messages, message].slice(-HISTORY * 4),
  };
  write(next);
  deliver(message);
  return { state: next, refused: null };
}

/**
 * Hand a message to whatever carries it to other players.
 *
 * This is the seam. Today there is nothing on the other side of it, and the
 * interface says as much rather than implying an audience. When a relay exists,
 * this is the one function that changes — and the receiving half calls
 * `receive` below, which is already wired to the panel.
 */
function deliver(message: ChatMessage) {
  void message;
}

/** Accept a message from elsewhere. Used by the transport when there is one. */
export function receive(state: ChatState, message: ChatMessage): ChatState {
  if (state.messages.some((m) => m.id === message.id)) return state;
  const next: ChatState = {
    ...state,
    messages: [...state.messages, message].sort((a, b) => a.at - b.at).slice(-HISTORY * 4),
  };
  write(next);
  return next;
}

/** Change the name a player posts under when they have no wallet. */
export function setHandle(state: ChatState, handle: string): ChatState {
  const trimmed = handle.trim().slice(0, 18);
  if (!trimmed) return state;
  const next = { ...state, handle: trimmed };
  write(next);
  return next;
}

/** True once messages typed here can actually reach anybody else. */
export const chatConnected = () => false;
