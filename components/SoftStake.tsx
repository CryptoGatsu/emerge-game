'use client';

/*
 * The soft stake, from the world map.
 *
 * A share of every charge is swapped into GLD each week and part of it goes
 * to wallets that registered a soft stake, weighted by the lowest $EMERGE
 * balance they held through the week. Nothing about that needs land, but
 * until now the only place to register was the Bank inside a settlement,
 * which a wallet without a plot never sees. This card sits on the map,
 * where every connected wallet lands first.
 */

import { useEffect, useState } from 'react';
import { TOKEN } from '@/lib/chain/emerge';
import { DIVIDEND_STAKE_SHARE, STAKE_MIN_EMERGE, STAKE_CAP_EMERGE } from '@/lib/chain/vault';
import { claimDividend, fetchDividend, registerSoftStake, stakeWords, type DividendStanding } from '@/lib/net/dividend';
import { t, tx, useLocale } from '@/lib/i18n';

const gld = (units: string) => (Number(BigInt(units) / 1_000_000_000_000n) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function SoftStake({ address, balance, hasLand }: { address: string | null; balance: number; hasLand: boolean }) {
  useLocale();
  const [standing, setStanding] = useState<DividendStanding | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setStanding(null);
    void fetchDividend(address).then((d) => { if (live && d) setStanding(d); });
    return () => { live = false; };
  }, [address]);

  const register = async () => {
    if (!address || busy) return;
    setBusy(true); setNote(null);
    const r = await registerSoftStake(address);
    setBusy(false);
    if (!r.ok) { setNote(tx(r.error)); return; }
    setStanding(r.standing);
    setNote(r.standing.lowBalance === null
      ? t('Registered. Your lowest balance each week counts, from the next daily sample.')
      : t('Registered, and sampled now: {n} {ticker}. The lowest balance sampled each week is the stake.', { n: r.standing.lowBalance.toLocaleString(), ticker: TOKEN.ticker }));
  };

  const claim = async () => {
    if (!address || busy) return;
    setBusy(true); setNote(null);
    const r = await claimDividend(address);
    setBusy(false);
    if (!r.ok) { setNote(tx(r.error)); return; }
    setStanding(r.standing);
    setNote(r.txHash ? t('Sent from the vault: {tx}…', { tx: r.txHash.slice(0, 10) }) : t('Claimed. This build has no live token, so the GLD is booked rather than sent.'));
  };

  const short = balance < STAKE_MIN_EMERGE;
  const words = address && standing ? stakeWords(standing, STAKE_MIN_EMERGE, TOKEN.ticker) : null;
  return (
    <section className="soft-stake" aria-label={t('Soft stake')}>
      <div className="soft-stake-text">
        <span className="eyebrow">{t('SOFT STAKE · NO PLOT NEEDED')}</span>
        <p className="muted small">
          {t('Hold {min} {ticker} or more in your wallet and register once: {share}% of every week’s GLD dividend is shared among soft stakes by the lowest balance held through the week, up to {cap}. Nothing is locked; selling mid-week forfeits the week.', { min: STAKE_MIN_EMERGE.toLocaleString(), ticker: TOKEN.ticker, share: Math.round(DIVIDEND_STAKE_SHARE * 100), cap: STAKE_CAP_EMERGE.toLocaleString() })}
          {hasLand && ` ${t('Land earns its own share as well.')}`}
        </p>
      </div>
      {/*
        * Three figures, and the sentence that explains one of them underneath
        * rather than inside it. The note ran to forty words in a column a
        * third of a phone wide, so it drew as a ribbon two words across and
        * the length of the screen, with the other two cards stretched empty
        * beside it. A figure card holds a figure; the prose goes below, where
        * it has the whole width to be read in.
        */}
      <div className="soft-stake-figures">
        <div><span>{t('YOUR SOFT STAKE')}</span><b>{!address ? '—' : !standing ? '…' : tx(words!.figure)}</b></div>
        <div><span>{t('THIS WEEK’S POOL')}</span><b>{standing ? `${standing.pool.toLocaleString()} ${TOKEN.ticker}` : '…'}</b></div>
        <div><span>{t('GLD TO CLAIM')}</span><b>{standing ? gld(standing.claimable) : '…'}</b></div>
      </div>
      {words && <p className="muted small soft-stake-hint">{tx(words.note)}</p>}
      <div className="soft-stake-actions">
        {!address ? (
          <span className="muted small">{t('Connect a wallet to register.')}</span>
        ) : standing && !standing.registered ? (
          <button onClick={() => void register()} disabled={busy}>
            {busy ? t('Registering…') : t('Register a soft stake')}
          </button>
        ) : standing ? (
          <span className="muted small">{t('Soft stake registered · once per wallet, and it stays registered')}</span>
        ) : null}
        <button onClick={() => void claim()} disabled={busy || !address || !standing || standing.claimable === '0'}>{t('Claim GLD')}</button>
        {address && short && <span className="muted small">{t('Your wallet holds {n} {ticker}; a stake counts from {min}.', { n: Math.floor(balance).toLocaleString(), ticker: TOKEN.ticker, min: STAKE_MIN_EMERGE.toLocaleString() })}</span>}
      </div>
      {note && <p className="muted small soft-stake-note">{note}</p>}
    </section>
  );
}
