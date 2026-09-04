/** The front page's read of `/api/token`. Never throws: a blank is a blank. */

export interface PricePoint { at: number; price: number }
export interface TokenStats {
  available: boolean;
  reason?: string;
  at: number;
  priceUsd: number | null;
  change24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  pairUrl: string | null;
  dex: string | null;
  history: PricePoint[];
}

export async function fetchTokenStats(): Promise<TokenStats | null> {
  try {
    const response = await fetch('/api/token', { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as TokenStats;
  } catch {
    return null;
  }
}
