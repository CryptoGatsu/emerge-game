/**
 * The chat relay.
 *
 * `GET  /api/chat?channel=global&since=<ms>` — everything newer than `since`.
 * `POST /api/chat` — one message.
 *
 * Polling rather than a socket, deliberately. A settlement game's chat carries
 * a few messages a minute, a poll every few seconds is indistinguishable from
 * a push at that rate, and a long-lived connection is exactly the thing that
 * does not survive a serverless deployment. This works the same on a container
 * and on Vercel.
 *
 * Everything a client sends is treated as hostile: the channel name is
 * pattern-matched, the text is length-capped and stripped of control
 * characters, the author is capped, and the timestamp is set here rather than
 * accepted from the caller — a client that could set `at` could bury every
 * other message in the channel forever.
 *
 * **A message badged with a wallet has to be from that wallet.** The interface
 * shows a wallet-backed name differently from a chosen one, and marks the
 * owner of the world a channel belongs to — so an unchecked badge is a way to
 * pose as somebody, which around a token is a way to take money off people.
 * The author of a badged message is therefore not read from the request at
 * all: it is the address the session proved, whatever the client asked for.
 * Anyone may still talk under a plain name; it simply does not carry a badge.
 */

import { NextResponse } from 'next/server';
import { append, relayShared, since, type RelayMessage } from '@/lib/chatStore';
import { holdsAddress, sessionAddress, sessionsAvailable } from '@/lib/server/session';

/** Never cached: the whole point is what arrived a second ago. */
export const dynamic = 'force-dynamic';

/** `global`, or `world:<digits>`. Anything else is refused. */
const CHANNEL = /^(global|world:\d{1,12})$/;

const MAX_TEXT = 240;
const MAX_AUTHOR = 48;

/** Strip control characters and collapse runs of whitespace. */
const clean = (value: string, limit: number) =>
  value
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const channel = params.get('channel') ?? '';
  if (!CHANNEL.test(channel)) {
    return NextResponse.json({ error: 'Unknown channel.' }, { status: 400 });
  }
  const after = Number(params.get('since')) || 0;
  try {
    const messages = await since(channel, after);
    return NextResponse.json({ messages, shared: relayShared() });
  } catch {
    // A store that is unreachable should leave the game playable and the
    // player's own history intact, not throw a red panel at them.
    return NextResponse.json({ messages: [], shared: false, degraded: true });
  }
}

/**
 * How often one caller may post, in milliseconds.
 *
 * Held in process: a rate limit that resets when a serverless instance
 * recycles is weaker than a shared one, and still stops the case this exists
 * for, which is one tab in a loop.
 */
const RATE_MS = 1_000;
const seen = new Map<string, number>();

export async function POST(request: Request) {
  let body: { channel?: string; author?: string; wallet?: boolean; text?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const channel = body.channel ?? '';
  if (!CHANNEL.test(channel)) {
    return NextResponse.json({ error: 'Unknown channel.' }, { status: 400 });
  }
  const text = clean(String(body.text ?? ''), MAX_TEXT);
  let author = clean(String(body.author ?? ''), MAX_AUTHOR);
  if (!text) return NextResponse.json({ error: 'Say something first.' }, { status: 400 });
  if (!author) return NextResponse.json({ error: 'Messages need a name.' }, { status: 400 });

  /*
   * A wallet badge is earned, not asserted.
   *
   * The address is taken from the session rather than the body, so a badged
   * message is from that wallet by construction and cannot be aimed at
   * somebody else's identity.
   */
  let badged = body.wallet === true;
  if (badged) {
    if (!sessionsAvailable()) {
      badged = false;
    } else {
      const proved = sessionAddress(request);
      if (!proved) {
        return NextResponse.json({
          error: 'Sign in with your wallet to post under it.', needsSession: true,
        }, { status: 401 });
      }
      author = proved;
    }
  }

  const who = `${author}|${request.headers.get('x-forwarded-for') ?? ''}`;
  const now = Date.now();
  const last = seen.get(who) ?? 0;
  if (now - last < RATE_MS) {
    return NextResponse.json({ error: 'Slow down a moment.' }, { status: 429 });
  }
  seen.set(who, now);
  // Keep the table from growing without bound on a long-lived server.
  if (seen.size > 5_000) {
    for (const [key, when] of seen) if (now - when > 60_000) seen.delete(key);
  }

  const message: RelayMessage = {
    // The id is ours, not the caller's, so nobody can overwrite or duplicate.
    id: `m${now}-${Math.random().toString(36).slice(2, 10)}`,
    channel,
    author,
    wallet: badged,
    // Anybody talking without a wallet is a spectator, and is shown as one.
    // Set here rather than by the client so the badge cannot be taken off:
    // a landholder's word and a passer-by's look different in a room where
    // land changes hands, and the difference has to be the server's.
    spectator: body.wallet !== true,
    text,
    at: now,
  };

  try {
    await append(message);
  } catch {
    return NextResponse.json({ error: 'The relay is not reachable.' }, { status: 502 });
  }
  return NextResponse.json({ message, shared: relayShared() });
}
