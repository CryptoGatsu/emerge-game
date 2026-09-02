/**
 * The client half of the settlement queue.
 *
 * Thin wrappers over `/api/payouts`. Like the rest of `lib/net`, every call
 * answers rather than throwing: a relay that is down must leave the panel
 * usable and say what it could not reach.
 */

export interface Payout {
  id: string;
  address: string;
  name: string;
  seed: number;
  worldName: string;
  kind: 'principal' | 'earnings';
  gold: number;
  gross: number;
  burned: number;
  net: number;
  at: number;
  paidAt: number | null;
  txHash: string | null;
}

export interface PayoutRequest {
  address: string;
  name: string;
  seed: number;
  worldName: string;
  kind: 'principal' | 'earnings';
  /** Gold leaving the treasury, for a principal withdrawal. */
  gold: number;
  /** $EMERGE before the burn share, for an earnings collection. */
  gross: number;
}

export type PayoutResult =
  | { ok: true; payout: Payout }
  | { ok: false; reason: string };

/** Ask to be paid out of the vault. */
export async function askForPayout(request: PayoutRequest): Promise<PayoutResult> {
  try {
    const response = await fetch('/api/payouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const json = (await response.json()) as { payout?: Payout; error?: string };
    if (!response.ok || !json.payout) {
      return { ok: false, reason: json.error ?? 'The settlement queue refused the request.' };
    }
    return { ok: true, payout: json.payout };
  } catch {
    return { ok: false, reason: 'Could not reach the settlement queue. Nothing was taken.' };
  }
}

/** Where one wallet's requests stand. */
export async function fetchPayouts(address: string): Promise<Payout[]> {
  try {
    const response = await fetch(`/api/payouts?address=${encodeURIComponent(address)}`, { cache: 'no-store' });
    if (!response.ok) return [];
    const json = (await response.json()) as { payouts?: Payout[] };
    return json.payouts ?? [];
  } catch {
    return [];
  }
}
