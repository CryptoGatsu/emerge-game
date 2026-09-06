/** The game's public ledger, as the landing page reads it. */
export interface GameStats {
  at: number;
  used: number;
  burned: number;
  awaitingBurn: number;
  withdrawn: number;
  payouts: number;
}

export async function fetchGameStats(): Promise<GameStats | null> {
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as GameStats;
  } catch {
    return null;
  }
}
