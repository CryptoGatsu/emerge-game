/**
 * The player's record, kept on the server as well as here.
 *
 * Every device reads it when the wallet connects and writes it whenever it
 * changes, so the name you chose and the earnings you have not yet collected
 * follow the wallet rather than the browser. A device with no session yet is
 * asked to sign once, the same signature a claim needs.
 */

import type { PlayerRecord } from '../world/plots';
import { ensureSession } from './session';

/**
 * The server's copy of this wallet's record.
 *
 * `{ record: null }` is an answer — the server has nothing for this wallet;
 * `null` is no answer — not signed in yet, or the store unreachable. The two
 * used to look the same, and a fresh browser that could not read yet pushed
 * its empty record over the one the server held: a player who moved from
 * Edge to Chrome lost every $EMERGE they had earned.
 */
export async function fetchPlayerRecord(address: string): Promise<{ record: PlayerRecord | null } | null> {
  const read = async () => fetch('/api/player', { cache: 'no-store' });
  try {
    let response = await read();
    if (response.status === 401) {
      if (!(await ensureSession(address))) return null;
      response = await read();
    }
    if (!response.ok) return null;
    const json = (await response.json()) as { record?: PlayerRecord | null; reason?: string };
    if (json.reason) return null;
    return { record: json.record ?? null };
  } catch {
    return null;
  }
}

export async function pushPlayerRecord(address: string, record: PlayerRecord): Promise<boolean> {
  const write = async () => fetch('/api/player', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ record }),
  });
  try {
    let response = await write();
    if (response.status === 401) {
      if (!(await ensureSession(address))) return false;
      response = await write();
    }
    return response.ok;
  } catch {
    return false;
  }
}
