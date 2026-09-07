import { withSession } from './session';

export interface DividendStanding {
  epoch: string; pool: number; registered: boolean; lowBalance: number | null; presentDays: number; landWeight: number;
  claimable: string; paid: { at: number; units: string; txHash: string | null }[];
  settlements: { epoch: string; at: number; pool: number; dev: number; swapped: number; gldUnits: string; landHolders: number; stakers: number; txHash: string | null; simulated: boolean }[];
  gld: string; automatic: boolean;
}

/**
 * What the soft-stake figure means, in words.
 *
 * The card used to show a bare number — "0" for a registered wallet whose
 * lowest sampled balance this week was nothing — and, because a registered
 * wallet has no register button, a player read it as a stake they could not
 * make. The stake is the balance the wallet holds through the week and it is
 * registered once, so the figure needs its sentence beside it.
 */
export function stakeWords(s: Pick<DividendStanding, 'registered' | 'lowBalance'> | null, min: number, ticker: string): { figure: string; note: string; state: 'unregistered' | 'waiting' | 'short' | 'counting' } {
  if (!s || !s.registered) return { figure: 'not registered', note: 'Register once; the balance your wallet holds through each week is the stake.', state: 'unregistered' };
  if (s.lowBalance === null) return { figure: 'registered', note: 'Counted from the first daily sample, at 03:00 UTC. Nothing more to do.', state: 'waiting' };
  if (s.lowBalance < min) {
    return {
      figure: s.lowBalance.toLocaleString(),
      note: `Registered. The lowest balance sampled in your wallet this week was ${s.lowBalance.toLocaleString()} ${ticker}, under the ${min.toLocaleString()} floor, so this week pays nothing. Hold ${min.toLocaleString()} or more from Monday to Sunday and next week counts; there is nothing to register again.`,
      state: 'short',
    };
  }
  return { figure: s.lowBalance.toLocaleString(), note: `Registered. The lowest balance sampled in your wallet this week; it counts toward Monday's payout.`, state: 'counting' };
}

export async function fetchDividend(address: string | null): Promise<DividendStanding | null> {
  try {
    const get = () => fetch('/api/dividend', { cache: 'no-store' });
    const response = address ? await withSession(address, get, async (r) => r) : await get();
    if (!response.ok) return null;
    return (await response.json()) as DividendStanding;
  } catch {
    return null;
  }
}

async function ask(address: string, body: object): Promise<{ ok: true; standing: DividendStanding; txHash?: string | null; units?: string } | { ok: false; error: string }> {
  try {
    const response = await withSession(address, () => fetch('/api/dividend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), async (r) => r);
    const json = (await response.json()) as { ok?: boolean; error?: string; standing?: DividendStanding; txHash?: string | null; units?: string };
    if (!response.ok || !json.ok || !json.standing) return { ok: false, error: json.error ?? 'The dividend refused.' };
    return { ok: true, standing: json.standing, txHash: json.txHash, units: json.units };
  } catch {
    return { ok: false, error: 'The dividend could not be reached.' };
  }
}
export const registerSoftStake = (address: string) => ask(address, { register: true });
export const claimDividend = (address: string) => ask(address, { claim: true });
