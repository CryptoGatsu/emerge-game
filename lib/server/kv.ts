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

/** Empty a list. */
export async function clear(key: string): Promise<void> {
  if (!shared()) {
    memory().lists.delete(key);
    return;
  }
  await redis(['DEL', key]);
}

/* ------------------------------------------------------------------ *
 * Hashes — the plot registry, discoveries, presence
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

/**
 * Write one field of a hash **only if it is not already there**, and say
 * whether we were the one who wrote it.
 *
 * The whole point is that the check and the write are one operation. Used to
 * make crediting a deposit idempotent: two requests replaying the same
 * transaction hash both pass a separate read, and exactly one passes this.
 */
export async function hsetnx(key: string, field: string, value: string): Promise<boolean> {
  if (!shared()) {
    const store = memory().hashes;
    const hash = store.get(key) ?? new Map<string, string>();
    if (hash.has(field)) return false;
    hash.set(field, value);
    store.set(key, hash);
    return true;
  }
  return (await redis(['HSETNX', key, field, value])) === 1;
}

/**
 * Write one field of a hash and push the whole hash's expiry back.
 *
 * For a hash that is a rolling window of live readings rather than a record:
 * as long as somebody is writing to it, it stays; once everybody stops, it goes
 * on its own rather than being a key nobody deletes. Individual stale fields
 * are the reader's problem, since a hash cannot expire its fields separately.
 */
export async function hsetWindow(key: string, field: string, value: string, ttlSeconds: number): Promise<void> {
  const ttl = Math.max(1, Math.round(ttlSeconds));
  if (!shared()) {
    const store = memory().hashes;
    const hash = store.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    store.set(key, hash);
    return;
  }
  await redis(['HSET', key, field, value]);
  await redis(['EXPIRE', key, ttl]);
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

/* ------------------------------------------------------------------ *
 * Counters and locks — the settlement ledger
 *
 * Everything above this line can tolerate a lost write. Nothing below it
 * can: these are what stop the same payout being sent twice and what keeps
 * a day's emission a day's emission, so they are the atomic operations
 * rather than read-modify-write, which two concurrent requests interleave.
 * ------------------------------------------------------------------ */

/**
 * Add to a counter and return what it now holds.
 *
 * Counters here hold **whole tokens**, never base units. That is deliberate:
 * INCRBY is a 64-bit integer operation, and a hundred thousand tokens at
 * eighteen decimals is already past 2^63, so a base-unit counter would have to
 * be a string moved by read-modify-write — which is exactly the race these
 * exist to avoid. Whole tokens leave room for more of them than will ever be
 * minted, and the conversion to base units happens once, at the moment of
 * sending.
 */
export async function incrBy(key: string, amount: number): Promise<number> {
  const step = Math.round(amount);
  if (!shared()) {
    const store = memory().values;
    const next = (Number(store.get(key) ?? '0') || 0) + step;
    store.set(key, String(next));
    return next;
  }
  const raw = await redis(['INCRBY', key, step]);
  return Number(raw) || 0;
}

/** What a counter holds, in whole tokens. */
export async function counter(key: string): Promise<number> {
  const raw = await getValue(key);
  const value = Number(raw ?? '0');
  return Number.isFinite(value) ? value : 0;
}

/**
 * Take a lock, or find somebody else holding it.
 *
 * Held for as long as it takes to read a nonce, sign and broadcast — the one
 * stretch where two concurrent payouts would otherwise build two transactions
 * on the same nonce, and the chain would keep exactly one of them.
 *
 * The time to live is the safety net: a request that dies mid-payout must not
 * wedge the vault for ever.
 */
export async function takeLock(key: string, ttlSeconds: number): Promise<boolean> {
  if (!shared()) {
    const store = memory().values;
    const held = store.get(key);
    if (held && Number(held) > Date.now()) return false;
    store.set(key, String(Date.now() + ttlSeconds * 1000));
    return true;
  }
  const got = await redis(['SET', key, String(Date.now()), 'NX', 'EX', Math.max(1, Math.round(ttlSeconds))]);
  return got !== null;
}

/** Give a lock back. */
export async function releaseLock(key: string): Promise<void> {
  if (!shared()) {
    memory().values.delete(key);
    return;
  }
  await redis(['DEL', key]);
}

/**
 * Add to a counter that expires.
 *
 * Rate limits and per-day tallies both want this: a counter that lives for
 * exactly as long as the window it measures, so it cannot leak a key per
 * address per day for ever. The expiry is set only when the counter is
 * created, so a busy window does not keep pushing its own deadline back.
 */
export async function incrWindow(key: string, amount: number, ttlSeconds: number): Promise<number> {
  const step = Math.round(amount);
  if (!shared()) {
    const store = memory().values;
    const expiry = memory().values.get(`${key}:until`);
    if (expiry && Number(expiry) < Date.now()) { store.delete(key); store.delete(`${key}:until`); }
    const next = (Number(store.get(key) ?? '0') || 0) + step;
    store.set(key, String(next));
    if (!expiry || Number(expiry) < Date.now()) store.set(`${key}:until`, String(Date.now() + ttlSeconds * 1000));
    return next;
  }
  const next = Number(await redis(['INCRBY', key, step])) || 0;
  if (next === step) await redis(['EXPIRE', key, Math.max(1, Math.round(ttlSeconds))]);
  return next;
}
