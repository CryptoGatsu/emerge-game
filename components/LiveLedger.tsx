'use client';

/*
 * Three numbers that say what the token has done: paid into the game, burned
 * by the vault, and paid back out to players. Live, in the sense that they
 * are read again every half minute and count up to the new figure rather
 * than jumping, so a burn landing while the page is open is seen to land.
 */

import { useEffect, useRef, useState } from 'react';
import { TOKEN } from '@/lib/chain/emerge';
import { fetchGameStats, type GameStats } from '@/lib/net/stats';
import { t, useLocale } from '@/lib/i18n';

const POLL_MS = 30_000;

/** A number that eases toward its target over a second or so. */
function useCountUp(target: number | null): number | null {
  const [shown, setShown] = useState<number | null>(null);
  const from = useRef<number | null>(null);
  useEffect(() => {
    if (target === null) return;
    const start = from.current ?? target;
    const t0 = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 1100);
      const eased = 1 - Math.pow(1 - k, 3);
      const value = Math.round(start + (target - start) * eased);
      setShown(value);
      if (k < 1) frame = requestAnimationFrame(step);
      else from.current = target;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

function Figure({ label, value, note }: { label: string; value: number | null; note?: string }) {
  const shown = useCountUp(value);
  return (
    <div className="ledger-figure">
      <span className="ledger-label">{label}</span>
      <b className="ledger-value">{shown === null ? '—' : shown.toLocaleString()} <small>{TOKEN.ticker}</small></b>
      {note && <span className="ledger-note">{note}</span>}
    </div>
  );
}

export default function LiveLedger() {
  useLocale();
  const [stats, setStats] = useState<GameStats | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const next = await fetchGameStats();
      if (!live) return;
      if (next) { setStats(next); setFailed(false); } else setFailed(true);
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  if (failed && !stats) return null;
  return (
    <section className="live-ledger" aria-label={t('The ledger')}>
      <div className="ledger-head">
        <span className="ledger-live">●</span>
        <h3>{t('The ledger, live')}</h3>
        <span className="muted small">{t('Read from the vault every half minute.')}</span>
      </div>
      <div className="ledger-figures">
        <Figure label={t('Burned by the vault')} value={stats ? stats.burned : null}
          note={stats && stats.awaitingBurn > 0 ? t('+{n} awaiting the next sweep', { n: stats.awaitingBurn.toLocaleString() }) : undefined} />
        <Figure label={t('Paid into the game')} value={stats ? stats.used : null} note={t('Every claim, charter, survey and rename.')} />
        <Figure label={t('Withdrawn to players')} value={stats ? stats.withdrawn : null}
          note={stats ? t('{n} withdrawals', { n: stats.payouts.toLocaleString() }) : undefined} />
      </div>
    </section>
  );
}
