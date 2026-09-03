import 'server-only';

/**
 * Proving a wallet is yours.
 *
 * Everything before this round took an address in a request body at face
 * value. That was survivable while the server only wrote rows; it stopped
 * being survivable the moment the vault could sign, because "pay this address"
 * with no proof means anybody can drain the day's emission budget on somebody
 * else's behalf, on their own schedule, at the vault's expense in gas. The
 * tokens would go to real players, which is not theft — and is still an
 * attacker deciding when the vault empties.
 *
 * So: a wallet signs one plain message, once, and gets a cookie. The cookie is
 * `address.expiry.hmac`, signed with a server secret, `HttpOnly` so no script
 * can read it and `SameSite=Lax` so another site cannot spend it. Nothing in it
 * is secret — it is an assertion the server can check it made itself.
 *
 * Signing is free, is not a transaction, and happens once a day rather than
 * once an action, because a wallet prompt on every chat message is a game
 * nobody plays.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { verifyMessage } from 'viem';

const COOKIE = 'emerge_session';

/** How long a signature is good for. */
const SESSION_HOURS = 24;

/** How stale a signed message may be when it arrives. */
const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

/**
 * The signing key for session cookies.
 *
 * `EMERGE_SESSION_SECRET` when set. Otherwise derived from the vault key,
 * which is server-only, high-entropy and the same on every instance — so a
 * deployment that can pay people can always issue sessions, and one variable
 * does not have to be remembered separately. Never the vault key itself: this
 * is a one-way derivation, and the cookie could not reveal it either way.
 */
function secret(): Buffer | null {
  const explicit = process.env.EMERGE_SESSION_SECRET;
  if (explicit && explicit.length >= 16) return Buffer.from(explicit, 'utf8');
  const vault = process.env.EMERGE_VAULT_PRIVATE_KEY;
  if (vault && vault.length >= 32) {
    return createHmac('sha256', vault).update('emerge:session:v1').digest();
  }
  return null;
}

/** True when this deployment can issue and check sessions at all. */
export const sessionsAvailable = () => secret() !== null;

/**
 * The exact words a wallet is asked to sign.
 *
 * Bound to the host, so a signature harvested by another site is useless here,
 * and to a timestamp, so an old one cannot be replayed for ever. Written to be
 * read: somebody looking at a wallet prompt should be able to tell this is a
 * sign-in and not an approval.
 */
export function sessionMessage(address: string, host: string, issuedAt: number): string {
  return [
    'Emerge — sign in',
    '',
    `Wallet:  ${address.toLowerCase()}`,
    `Site:    ${host}`,
    `Issued:  ${new Date(issuedAt).toISOString()}`,
    '',
    'Signing proves this wallet is yours. It is not a transaction, it moves',
    'nothing, and it costs nothing.',
  ].join('\n');
}

/** Check a signature and mint a cookie value, or explain the refusal. */
export async function openSession(
  address: string,
  signature: string,
  issuedAt: number,
  host: string,
): Promise<{ ok: true; cookie: string; maxAge: number } | { ok: false; reason: string }> {
  const key = secret();
  if (!key) return { ok: false, reason: 'This deployment cannot issue sessions.' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, reason: 'That is not a wallet address.' };
  if (!/^0x[0-9a-fA-F]{130,}$/.test(signature)) return { ok: false, reason: 'That is not a signature.' };

  const age = Date.now() - issuedAt;
  if (!Number.isFinite(issuedAt) || age > SIGNATURE_WINDOW_MS || age < -60_000) {
    return { ok: false, reason: 'That signature is too old. Try again.' };
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: sessionMessage(address, host, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'That signature does not match the wallet.' };

  const expires = Date.now() + SESSION_HOURS * 3600_000;
  return { ok: true, cookie: sign(address.toLowerCase(), expires, key), maxAge: SESSION_HOURS * 3600 };
}

function sign(address: string, expires: number, key: Buffer): string {
  const body = `${address}.${expires}`;
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

/**
 * Which wallet this request has proved it holds, or null.
 *
 * Compared with `timingSafeEqual` — a byte-at-a-time comparison of a signature
 * is a way to guess one.
 */
export function sessionAddress(request: Request): string | null {
  const key = secret();
  if (!key) return null;
  const raw = readCookie(request, COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [address, expires, mac] = parts;
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  if (!(Number(expires) > Date.now())) return null;

  const expected = createHmac('sha256', key).update(`${address}.${expires}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return address;
}

/** True when the request proved it holds this exact address. */
export const holdsAddress = (request: Request, address: string) => {
  const proved = sessionAddress(request);
  return proved !== null && proved === address.toLowerCase();
};

export const SESSION_COOKIE = COOKIE;

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
