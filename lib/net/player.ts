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

export async function fetchPlayerRecord(address: string): Promise<PlayerRecord | null> {
  const read = async () => fetch('/api/player', { cache: 'no-store' });
  try {
    let response = await read();
    if (response.status === 401) {
      if (!(await ensureSession(address))) return null;
      response = await read();
    }
    if (!response.ok) return null;
    const json = (await response.json()) as { record?: PlayerRecord | null };
    return json.record ?? null;
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
