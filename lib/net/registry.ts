/**
 * The client half of the land registry.
 *
 * Thin wrappers over `/api/plots`, `/api/worlds` and `/api/presence`. Every one
 * of them answers rather than throwing: the game stays playable when the relay
 * is down, and the interface says what it could not reach instead of showing an
 * error where a settlement should be.
 */

export interface Claim {
  seed: number;
  region: string;
  worldName: string;
  owner: string;
  ownerName: string;
  price: number;
  at: number;
}

export interface PublishedWorld {
  seed: number;
  owner: string;
  ownerName: string;
  worldName: string;
  day: number;
  population: number;
  at: number;
  snapshot: unknown;
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

export interface ClaimsResult {
  claims: Claim[];
  /** True when the registry can actually see other players' claims. */
  shared: boolean;
  offline: boolean;
}

/** Every plot anybody holds. */
export async function fetchClaims(): Promise<ClaimsResult> {
  try {
    const response = await fetch('/api/plots', { cache: 'no-store' });
    if (!response.ok) return { claims: [], shared: false, offline: true };
    const json = (await response.json()) as { claims?: Claim[]; shared?: boolean };
    return { claims: json.claims ?? [], shared: json.shared === true, offline: false };
  } catch {
    return { claims: [], shared: false, offline: true };
  }
}

export type TakeResult =
  | { ok: true; claim: Claim }
  | { ok: false; reason: string; taken?: Claim };

/**
 * Take a plot.
 *
 * The server decides. A refusal here is the whole reason this call exists, so
 * the caller must not treat a failure as "claim it locally anyway" — that is
 * exactly the behaviour that let two players own the same land.
 */
export async function takePlot(input: {
  seed: number; region: string; worldName: string; owner: string; ownerName: string; price: number;
}): Promise<TakeResult> {
  try {
    const response = await fetch('/api/plots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = (await response.json()) as { claim?: Claim; error?: string; taken?: Claim };
    if (!response.ok || !json.claim) {
      return { ok: false, reason: json.error ?? 'The registry refused the claim.', taken: json.taken };
    }
    return { ok: true, claim: json.claim };
  } catch {
    return { ok: false, reason: 'Could not reach the land registry. Check your connection.' };
  }
}

/** Give a plot up. */
export async function releasePlot(seed: number, owner: string): Promise<boolean> {
  try {
    const response = await fetch('/api/plots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, owner, release: true }),
    });
    const json = (await response.json()) as { released?: boolean };
    return json.released === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Worlds
 * ------------------------------------------------------------------ */

/** Put this world up so visitors see the real settlement. */
export async function publishWorld(input: {
  seed: number; owner: string; ownerName: string; worldName: string;
  day: number; population: number; snapshot: unknown;
}): Promise<boolean> {
  try {
    const response = await fetch('/api/worlds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Somebody's settlement, or a sentence saying why there is nothing to show. */
export async function fetchWorld(seed: number): Promise<{ world: PublishedWorld | null; reason?: string }> {
  try {
    const response = await fetch(`/api/worlds?seed=${seed}`, { cache: 'no-store' });
    if (!response.ok) return { world: null, reason: 'Could not reach that world.' };
    return (await response.json()) as { world: PublishedWorld | null; reason?: string };
  } catch {
    return { world: null, reason: 'Could not reach that world.' };
  }
}

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

/** How often a client says it is still watching, in milliseconds. */
export const HEARTBEAT_INTERVAL = 15_000;

/** Say you are here, and find out how many others are. */
export async function heartbeat(seed: number, who: string): Promise<number> {
  try {
    const response = await fetch('/api/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, who }),
    });
    const json = (await response.json()) as { count?: number };
    return Math.max(0, json.count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Say you are leaving.
 *
 * Sent with `keepalive` so it still goes when the page is being torn down,
 * which is the only moment it is ever useful.
 */
export function departWorld(seed: number, who: string) {
  try {
    fetch('/api/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, who, leaving: true }),
      keepalive: true,
    }).catch(() => { /* leaving is best effort; presence times out anyway */ });
  } catch { /* as above */ }
}

/**
 * A stable id for a browser that has no wallet connected.
 *
 * Presence needs something to count, and counting by address alone would make
 * every wallet-less visitor invisible. Kept for the session only.
 */
export function visitorId(): string {
  if (typeof window === 'undefined') return 'server';
  const KEY = 'emerge.visitor.v1';
  try {
    const held = window.sessionStorage.getItem(KEY);
    if (held) return held;
    const made = `v${Math.random().toString(36).slice(2, 12)}`;
    window.sessionStorage.setItem(KEY, made);
    return made;
  } catch {
    return `v${Math.random().toString(36).slice(2, 12)}`;
  }
}
