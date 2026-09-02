/**
 * Where chat messages live on the server.
 *
 * Two backings, picked at runtime by what the environment offers:
 *
 * **Upstash Redis over REST**, when `KV_REST_API_URL` and `KV_REST_API_TOKEN`
 * are set — which is what Vercel KV provides, under those exact names. This is
 * the one that works in production, because a serverless deployment runs each
 * request in a different instance and anything held in a process is invisible
 * to the next caller.
 *
 * **Process memory** otherwise. Correct on a single long-lived server
 * (`next start`, a container, a local dev machine) and honestly labelled as
 * partial anywhere else, because on serverless it degrades to "you can see
 * your own messages and sometimes other people's" — which is worse than either
 * working or not, so the interface says which one is running.
 *
 * The REST calls are plain `fetch` against Upstash's HTTP API rather than a
 * client library: it is three commands, the wire format is JSON, and a
 * dependency that exists to save nine lines is a dependency that has to be
 * kept up to date.
 */

export interface RelayMessage {
  id: string;
  channel: string;
  author: string;
  /** True when `author` is a wallet address rather than a chosen name. */
  wallet: boolean;
  text: string;
  at: number;
}

/** The longest a channel's history is kept. Older messages fall off the end. */
const HISTORY = 200;

const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

/** True when messages typed by one player can actually reach another. */
export const relayShared = () => !!(url() && token());

/* ------------------------------------------------------------------ *
 * Process memory
 * ------------------------------------------------------------------ */

/**
 * Held on `globalThis` rather than in a module variable so it survives the
 * module re-evaluation that hot reload and route bundling both cause — without
 * it, every code change in development silently empties every channel.
 */
const memory = (): Map<string, RelayMessage[]> => {
  const g = globalThis as typeof globalThis & { __emergeChat?: Map<string, RelayMessage[]> };
  if (!g.__emergeChat) g.__emergeChat = new Map();
  return g.__emergeChat;
};

/* ------------------------------------------------------------------ *
 * Upstash over REST
 * ------------------------------------------------------------------ */

async function redis(command: unknown[]): Promise<unknown> {
  const response = await fetch(url(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`relay store: ${response.status}`);
  const json = (await response.json()) as { result?: unknown };
  return json.result;
}

const keyFor = (channel: string) => `emerge:chat:${channel}`;

/* ------------------------------------------------------------------ *
 * The two operations the routes need
 * ------------------------------------------------------------------ */

/** Append a message and trim the channel back to its limit. */
export async function append(message: RelayMessage): Promise<void> {
  if (!relayShared()) {
    const store = memory();
    const list = store.get(message.channel) ?? [];
    list.push(message);
    if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
    store.set(message.channel, list);
    return;
  }
  const key = keyFor(message.channel);
  await redis(['RPUSH', key, JSON.stringify(message)]);
  // Keep the newest HISTORY entries. Negative indices count from the end, so
  // this is "the last HISTORY of them" and costs one round trip.
  await redis(['LTRIM', key, -HISTORY, -1]);
}

/**
 * Everything on a channel newer than `since`, oldest first.
 *
 * Clients poll with the timestamp of the newest message they hold, so the
 * usual reply is an empty array and the usual cost is one small read.
 */
export async function since(channel: string, after: number): Promise<RelayMessage[]> {
  if (!relayShared()) {
    return (memory().get(channel) ?? []).filter((m) => m.at > after);
  }
  const raw = (await redis(['LRANGE', keyFor(channel), 0, -1])) as string[] | null;
  if (!Array.isArray(raw)) return [];
  const out: RelayMessage[] = [];
  for (const entry of raw) {
    try {
      const message = JSON.parse(entry) as RelayMessage;
      if (message?.at > after) out.push(message);
    } catch {
      // A malformed entry is skipped rather than failing the whole read.
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
