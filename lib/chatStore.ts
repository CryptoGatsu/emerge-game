/**
 * Where chat messages live on the server.
 *
 * The two backings — Upstash over REST in production, process memory on a
 * single long-lived server — are `lib/server/kv`, shared with the land
 * registry. This file is only the shape of a message and the two operations
 * the chat route needs.
 */

import { serverKey } from './limits';
import { push, range, shared } from './server/kv';

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

/** True when messages typed by one player can actually reach another. */
export const relayShared = shared;

const keyFor = (channel: string) => serverKey(`chat:${channel}`);

/** Append a message and trim the channel back to its limit. */
export async function append(message: RelayMessage): Promise<void> {
  await push(keyFor(message.channel), JSON.stringify(message), HISTORY);
}

/**
 * Everything on a channel newer than `since`, oldest first.
 *
 * Clients poll with the timestamp of the newest message they hold, so the
 * usual reply is an empty array and the usual cost is one small read.
 */
export async function since(channel: string, after: number): Promise<RelayMessage[]> {
  const raw = await range(keyFor(channel));
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
