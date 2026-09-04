import { withSession } from './session';

export interface DividendStanding {
  epoch: string; pool: number; registered: boolean; lowBalance: number | null; presentDays: number; landWeight: number;
  claimable: string; paid: { at: number; units: string; txHash: string | null }[];
  settlements: { epoch: string; at: number; pool: number; dev: number; swapped: number; gldUnits: string; landHolders: number; stakers: number; txHash: string | null; simulated: boolean }[];
  gld: string; automatic: boolean;
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
