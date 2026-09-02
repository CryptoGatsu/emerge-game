/**
 * The one piece of storage the server has.
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
 * your own writes and sometimes other people's" — which is worse than either
 * working or not, so every interface built on this says which one is running.
 *
 * The REST calls are plain `fetch` against Upstash's HTTP API rather than a
 * client library: it is a handful of commands, the wire format is JSON, and a
 * dependency that exists to save twenty lines is a dependency that has to be
 * kept up to date.
 */

const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

/** True when what one player writes can actually be read by another. */
export const shared = () => !!(url() && token());

/**
 * Held on `globalThis` rather than in a module variable so it survives the
 * module re-evaluation that hot reload and route bundling both cause — without
 * it, every code change in development silently empties every store.
 */
type Memory = {
  lists: Map<string, string[]>;
  hashes: Map<string, Map<string, string>>;
  values: Map<string, string>;
};

const memory = (): Memory => {
  const g = globalThis as typeof globalThis & { __emergeKv?: Memory };
  if (!g.__emergeKv) g.__emergeKv = { lists: new Map(), hashes: new Map(), values: new Map() };
  return g.__emergeKv;
};

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
  if (!response.ok) throw new Error(`store: ${response.status}`);
  const json = (await response.json()) as { result?: unknown };
  return json.result;
}

/* ------------------------------------------------------------------ *
 * Lists — chat history
 * ------------------------------------------------------------------ */

/** Append to a list and trim it back to the newest `keep` entries. */
export async function push(key: string, entry: string, keep: number): Promise<void> {
  if (!shared()) {
    const store = memory().lists;
    const list = store.get(key) ?? [];
    list.push(entry);
    if (list.length > keep) list.splice(0, list.length - keep);
    store.set(key, list);
    return;
  }
  await redis(['RPUSH', key, entry]);
  // Negative indices count from the end, so this is "the last `keep` of them".
  await redis(['LTRIM', key, -keep, -1]);
}

/** Everything in a list, oldest first. */
export async function range(key: string): Promise<string[]> {
  if (!shared()) return [...(memory().lists.get(key) ?? [])];
  const raw = (await redis(['LRANGE', key, 0, -1])) as string[] | null;
  return Array.isArray(raw) ? raw : [];
}

/* ------------------------------------------------------------------ *
 * Hashes — the plot registry, presence
 * ------------------------------------------------------------------ */

/** Write one field of a hash. */
export async function hset(key: string, field: string, value: string): Promise<void> {
  if (!shared()) {
    const store = memory().hashes;
    const hash = store.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    store.set(key, hash);
    return;
  }
  await redis(['HSET', key, field, value]);
}

/** Read one field of a hash, or null when it is not there. */
export async function hget(key: string, field: string): Promise<string | null> {
  if (!shared()) return memory().hashes.get(key)?.get(field) ?? null;
  const raw = await redis(['HGET', key, field]);
  return typeof raw === 'string' ? raw : null;
}

/** Every field of a hash. */
export async function hgetall(key: string): Promise<Record<string, string>> {
  if (!shared()) {
    const hash = memory().hashes.get(key);
    return hash ? Object.fromEntries(hash) : {};
  }
  const raw = await redis(['HGETALL', key]);
  // Upstash answers HGETALL as a flat [field, value, field, value] array.
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
    return out;
  }
  if (raw && typeof raw === 'object') return raw as Record<string, string>;
  return {};
}

/** Remove one field of a hash. */
export async function hdel(key: string, field: string): Promise<void> {
  if (!shared()) {
    memory().hashes.get(key)?.delete(field);
    return;
  }
  await redis(['HDEL', key, field]);
}

/* ------------------------------------------------------------------ *
 * Values — published world snapshots
 * ------------------------------------------------------------------ */

/** Write a value with a time to live, in seconds. */
export async function setValue(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!shared()) {
    memory().values.set(key, value);
    return;
  }
  await redis(['SET', key, value, 'EX', Math.max(1, Math.round(ttlSeconds))]);
}

/** Read a value, or null when it is not there or has expired. */
export async function getValue(key: string): Promise<string | null> {
  if (!shared()) return memory().values.get(key) ?? null;
  const raw = await redis(['GET', key]);
  return typeof raw === 'string' ? raw : null;
}
