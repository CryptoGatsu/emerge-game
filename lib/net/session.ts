/**
 * Proving the wallet, once.
 *
 * The server will not pay out, post under a wallet, claim land or send a gift
 * for an address the caller has not proved it holds. Proving it is one
 * signature on a plain sentence: free, not a transaction, and good for a day.
 *
 * The prompt is raised lazily — nothing asks for a signature until the player
 * does something that needs one — and the message is composed by the server so
 * a page cannot ask a wallet to sign something of its own devising and pass it
 * off as a sign-in.
 */

import { currentWallet } from '@/components/WalletPicker';

/** Which address this browser has already proved, so a session is asked for once. */
let proved: string | null = null;
let inFlight: Promise<boolean> | null = null;

/** Forget what we think we know, after a disconnect or a wallet change. */
export function forgetSession(): void {
  proved = null;
  inFlight = null;
}

async function readSession(): Promise<string | null> {
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) return null;
    const json = (await response.json()) as { address?: string | null };
    return json.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Make sure the server knows this wallet is ours.
 *
 * Answers true when it does, false when the player declined the signature or
 * the wallet could not produce one. A refusal is not an error: it means the
 * action does not happen, and the caller says so.
 */
export async function ensureSession(address: string): Promise<boolean> {
  const want = address.toLowerCase();
  if (proved === want) return true;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // Perhaps this browser is already signed in from an earlier visit.
    if ((await readSession()) === want) { proved = want; return true; }

    const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!provider) return false;

    try {
      // The server writes the sentence; we only carry it to the wallet.
      const askResponse = await fetch('/api/session', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!askResponse.ok) return false;
      const { message, issuedAt } = (await askResponse.json()) as { message: string; issuedAt: number };

      const signature = (await provider.request({
        method: 'personal_sign',
        params: [message, address],
      })) as string;

      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, signature, issuedAt }),
      });
      if (!response.ok) return false;
      proved = want;
      return true;
    } catch {
      // A dismissed wallet prompt lands here, and is not worth a red panel.
      return false;
    }
  })();

  const result = await inFlight;
  inFlight = null;
  return result;
}

/** Sign in for whichever wallet is connected, if any. */
export async function ensureCurrentSession(): Promise<boolean> {
  const { address } = currentWallet();
  return address ? ensureSession(address) : false;
}

/**
 * Run a request, signing in first if the server asks for it.
 *
 * Wraps the call rather than being called before it, so every endpoint that
 * might want a session gets the same behaviour: try, and if the answer is
 * "sign in", do that and try once more. One retry, never a loop.
 */
export async function withSession<T>(
  address: string | null | undefined,
  send: () => Promise<Response>,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  let response = await send();
  if (response.status === 401 && address) {
    if (await ensureSession(address)) response = await send();
  }
  return read(response);
}
