/**
 * What this wallet is called, told to the relay.
 *
 * Chat used to show a hexadecimal address for anybody with a wallet connected,
 * because the address was all a message carried. A player who had named
 * themselves — and paid to do it — never saw that name in a conversation.
 *
 * The name goes to the relay separately from any message, against the address
 * the session proved, so it can be looked up for anybody talking and cannot be
 * asserted in a message body about somebody else's address.
 *
 * Like the rest of `lib/net`, every call answers rather than throwing: a name
 * that did not reach the relay is a cosmetic loss and never a reason to stop
 * somebody playing.
 */

import { withSession } from './session';

/** Every name the relay knows, by lower-cased address. */
export async function fetchNames(): Promise<Record<string, string>> {
  try {
    const response = await fetch('/api/names', { cache: 'no-store' });
    if (!response.ok) return {};
    const json = (await response.json()) as { names?: Record<string, string> };
    return json.names ?? {};
  } catch {
    return {};
  }
}

/**
 * What this browser has already told the relay, so a name is published when it
 * changes rather than on a timer.
 */
let published: string | null = null;

/** Forget what we think the relay knows, after a disconnect or a wallet change. */
export function forgetPublishedName(): void {
  published = null;
}

/**
 * Tell the relay what this wallet is called.
 *
 * A no-op without a wallet — there is no address to attach a name to — and a
 * no-op when the relay already has this exact name, which is almost always.
 */
export async function publishName(address: string | null, name: string): Promise<void> {
  const wanted = name.replace(/\s+/g, ' ').trim();
  if (!address || !wanted) return;
  const key = `${address.toLowerCase()}:${wanted}`;
  if (published === key) return;
  try {
    const response = await withSession(
      address,
      () => fetch('/api/names', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: wanted }),
      }),
      async (r) => r,
    );
    // Only remembered on success, so a failed publish is retried next time
    // rather than silently never happening again.
    if (response.ok) published = key;
  } catch {
    // Offline. The name is still right locally and will go up later.
  }
}
