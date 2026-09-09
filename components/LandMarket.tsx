'use client';

/**
 * The land for sale, in one list.
 *
 * On the world map it sits beside the leaderboard; in a world it is the LAND
 * door on the action bar. The same rows either way: what is asked, what has
 * been offered, and what the owner last published about the place — the
 * level, how well it is run, who lives there and what stands. "Show on the
 * map" takes the buyer to the plot, where the buying and the offers already
 * live; "Visit" walks into it.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchLandMarket, type LandListing } from '@/lib/net/registry';
import { shortAddress } from '@/lib/chain/emerge';
import { TOKEN } from '@/lib/chain/emerge';
import { eraName } from '@/lib/world/eras';
import { EMBLEM_GLYPH, isEmblem } from '@/lib/world/emblems';
import { t, tn, useLocale } from '@/lib/i18n';

type Sort = 'price' | 'level' | 'people' | 'newest';

const daysAgo = (ms: number) => Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));

export function LandMarket({ me, onVisit, onShow, embedded = false }: {
  me: string | null;
  onVisit: (seed: number) => Promise<string | null>;
  /** Take the buyer to the plot on the map, where the buying is. */
  onShow: (seed: number) => void;
  /** Inside a panel the list is open from the start; on the map it is a toggle. */
  embedded?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(embedded);
  const [board, setBoard] = useState<{ rows: LandListing[]; total: number } | null | undefined>(undefined);
  const [sort, setSort] = useState<Sort>('price');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!open || board !== undefined) return;
    let live = true;
    void fetchLandMarket().then((b) => { if (live) setBoard(b); });
    return () => { live = false; };
  }, [open, board]);
  const mine = me?.toLowerCase() ?? '';
  const rows = useMemo(() => {
    const list = [...(board?.rows ?? [])];
    const by: Record<Sort, (a: LandListing, b: LandListing) => number> = {
      price: (a, b) => a.price - b.price,
      level: (a, b) => (b.level ?? -1) - (a.level ?? -1) || (b.score ?? 0) - (a.score ?? 0),
      people: (a, b) => (b.population ?? -1) - (a.population ?? -1),
      newest: (a, b) => b.listedAt - a.listedAt,
    };
    return list.sort(by[sort]);
  }, [board, sort]);

  const list = (
    <div className="land-list">
      <p className="muted small">
        {t('Every plot its owner has put up for sale. The price goes to the seller’s wallet and the settlement comes with the land. The level, stewardship, people and buildings are what the owner last published, read by the server, not the seller’s word.')}
      </p>
      {board && board.rows.length > 1 && (
        <div className="land-sort">
          <span className="muted small">{t('Sort by')}</span>
          {(['price', 'level', 'people', 'newest'] as Sort[]).map((k) => (
            <button key={k} className={`ghost small ${sort === k ? 'on' : ''}`} onClick={() => setSort(k)}>
              {k === 'price' ? t('Price') : k === 'level' ? t('Level') : k === 'people' ? t('People') : t('Newest')}
            </button>
          ))}
        </div>
      )}
      {board === undefined && <p className="muted small">{t('Reading the listings…')}</p>}
      {board === null && <p className="muted small">{t('The listings could not be read just now.')}</p>}
      {board && board.rows.length === 0 && <p className="muted small">{t('Nothing is up for sale right now. An owner lists a plot from its card on the world map.')}</p>}
      {rows.map((r) => {
        const yours = r.owner.toLowerCase() === mine;
        const published = r.level !== null;
        return (
          <div key={r.seed} className={`land-row ${yours ? 'mine' : ''}`}>
            <div className="land-who">
              <b>
                {isEmblem(r.banner) && <span className="glyph" aria-hidden="true">{EMBLEM_GLYPH[r.banner]} </span>}
                {r.worldName}{yours ? ` · ${t('yours')}` : ''}
              </b>
              <small className="muted">
                {tn(r.region)} · {tn(r.biome)} · {tn(eraName(r.era))}{r.expanded ? ` · ${t('expanded')}` : ''}
              </small>
              <small className="muted">
                {t('Owner {who}', { who: r.ownerName || shortAddress(r.owner) })} · {t('listed {d} days ago', { d: daysAgo(r.listedAt) })}
              </small>
            </div>
            <div className="land-stats">
              {published ? (
                <>
                  <span><b>{t('Level {n}', { n: r.level ?? 0 })}</b><small>{Math.round((r.score ?? 0) * 100)}% {t('stewardship')}</small></span>
                  <span><b>{r.population ?? 0}</b><small>{t('people')}</small></span>
                  <span><b>{r.buildings ?? '—'}</b><small>{t('buildings')}</small></span>
                  <span><b>{t('Day {n}', { n: r.day ?? 0 })}</b><small>{t('published {d} days ago', { d: daysAgo(r.publishedAt ?? Date.now()) })}</small></span>
                </>
              ) : (
                <span className="muted small">{t('Never published: the owner has not opened it on this build, so there are no figures to show.')}</span>
              )}
            </div>
            <div className="land-price">
              <b>{r.price.toLocaleString()} {TOKEN.ticker}</b>
              <small className="muted">
                {r.offers > 0
                  ? t('{n} offers, the best at {price} {ticker}', { n: r.offers, price: (r.bestOffer ?? 0).toLocaleString(), ticker: TOKEN.ticker })
                  : t('no offers yet')}
                {r.charter ? ` · ${t('chartered')}` : ''}{r.insured ? ` · ${t('insured')}` : ''}
              </small>
            </div>
            <div className="land-actions">
              <button className="ghost small" onClick={async () => { const refused = await onVisit(r.seed); setNote(refused); }}>{t('Visit')}</button>
              {!yours && <button className="claim-button small" onClick={() => onShow(r.seed)}>{t('Show on the map')}</button>}
              {yours && <button className="ghost small" onClick={() => onShow(r.seed)}>{t('Your listing')}</button>}
            </div>
          </div>
        );
      })}
      {note && <p className="warn">{note}</p>}
      {board && board.rows.length > 0 && <p className="muted small">{t('{n} plots for sale.', { n: board.total })}</p>}
    </div>
  );

  if (embedded) return list;
  return (
    <section className={`land-market ${open ? 'open' : ''}`}>
      <button className={`ghost leaders-toggle ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)}>
        {open ? t('Hide the land for sale') : t('Land for sale')}
      </button>
      {open && list}
    </section>
  );
}
