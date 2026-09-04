'use client';

/**
 * The first hour, framed.
 *
 * A new player lands in a working settlement with a helper and a feed and no
 * idea what the game wants of them. This card says it in one line — you are
 * paid for running the place well, up to so much a day — and gives five
 * things to do that each teach a system: a person, a house, the Bank, an
 * improvement, and coming back. Each ticks itself off from what the player
 * actually did, never from a button on this card, and the whole thing can be
 * skipped. Once every step is done it says so and goes.
 */

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { TOKEN } from '@/lib/chain/emerge';

export type FirstStepKey = 'person' | 'house' | 'bank' | 'improve' | 'return';
export type FirstGo = 'person' | 'build' | 'bank';
export interface FirstStep { key: FirstStepKey; done: boolean }

const STEPS: Record<FirstStepKey, { title: string; why: string; go: FirstGo | null; label: string }> = {
  person: { title: 'Tap somebody', why: 'Everyone here has a trade, a home and a day of their own. The settlement is these people.', go: 'person', label: 'Show me' },
  house: { title: 'Raise a house', why: 'Room for the next family. More people means more trades, more Gold and a higher city level.', go: 'build', label: 'Build' },
  bank: { title: 'Open the Bank', why: 'What you are earning and why: the ceiling, how the place is run, and your attention.', go: 'bank', label: 'Bank' },
  improve: { title: 'Improve a building', why: 'Tap a building and improve it. Every improvement does something, and the city level counts them.', go: null, label: '' },
  return: { title: 'Come back tomorrow', why: 'Your yield accrues against the clock, open or closed. It is waiting when you return.', go: null, label: '' },
};

export function FirstDay({ steps, cap, compact, onGo, onDismiss }: {
  steps: FirstStep[];
  cap: number;
  /** A phone: the next step only, unless unfolded. */
  compact: boolean;
  onGo: (go: FirstGo) => void;
  onDismiss: () => void;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const done = steps.filter((s) => s.done).length;
  const all = done === steps.length;
  const next = steps.find((s) => !s.done);
  const shown = compact && !unfolded && next ? [next] : steps;
  return (
    <section className={`panel hint-card first-day ${all ? 'done' : ''}`}>
      <div className="first-day-head">
        <div className="being-eyebrow">{t('FIRST DAY')} · {done}/{steps.length}</div>
        <button className="ghost tiny" onClick={onDismiss}>{all ? t('Done') : t('Skip')}</button>
      </div>
      <p className="first-day-goal">
        {t('You earn {ticker} for running this place well: up to {cap} a day at this level, more as the city grows.', { ticker: TOKEN.ticker, cap: cap.toLocaleString() })}
      </p>
      {all
        ? <p className="first-day-goal">{t('Well begun. The Bank has the rest of the economy, and the Game Guide the whole of it.')}</p>
        : (
          <ol className="first-steps">
            {shown.map((s) => {
              const spec = STEPS[s.key];
              return (
                <li key={s.key} className={s.done ? 'done' : ''} data-step={s.key}>
                  <span className="tick" aria-hidden="true">{s.done ? '✓' : ''}</span>
                  <div>
                    <b>{t(spec.title)}</b>
                    <small>{t(spec.why)}</small>
                  </div>
                  {!s.done && spec.go && <button onClick={() => onGo(spec.go!)}>{t(spec.label)}</button>}
                </li>
              );
            })}
          </ol>
        )}
      {compact && !all && steps.length > 1 && (
        <button className="ghost tiny first-day-more" onClick={() => setUnfolded((u) => !u)}>
          {unfolded ? t('Just the next step') : t('All {n} steps', { n: steps.length })}
        </button>
      )}
    </section>
  );
}
