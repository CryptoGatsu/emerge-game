'use client';

/**
 * The world's pulse, on the front page.
 *
 * One line under the title that says the world is running right now — how
 * many settlements are awake and how many players are in them — with the
 * same heartbeat the population pill carries over the world. Read from the
 * leaderboard and the presence relay; if either cannot be read the line is
 * not shown, because a front page that says nobody is here is worse than one
 * that says nothing.
 */

import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';

interface Pulse { settlements: number; players: number | null }

export function WorldPulse() {
  const [pulse, setPulse] = useState<Pulse | null>(null);
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const [board, presence] = await Promise.all([
          fetch('/api/leaderboard', { cache: 'no-store' }).then((r) => r.json()) as Promise<{ total?: number; degraded?: boolean }>,
          fetch('/api/presence?seed=1', { cache: 'no-store' }).then((r) => r.json()) as Promise<{ online?: number; degraded?: boolean }>,
        ]);
        if (!live) return;
        const settlements = board.degraded ? 0 : Number(board.total) || 0;
        if (!settlements) { setPulse(null); return; }
        setPulse({ settlements, players: presence.degraded ? null : (typeof presence.online === 'number' ? presence.online : null) });
      } catch {
        if (live) setPulse(null);
      }
    };
    void read();
    const timer = window.setInterval(read, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  if (!pulse) return null;
  return (
    <p className="world-pulse" aria-live="polite">
      <span className="spark" aria-hidden />
      <span>{t('{n} settlements awake', { n: pulse.settlements.toLocaleString() })}</span>
      {pulse.players !== null && pulse.players > 0 && (
        <>
          <span className="dot" aria-hidden>·</span>
          <span>{t('{n} players here now', { n: pulse.players.toLocaleString() })}</span>
        </>
      )}
    </p>
  );
}
