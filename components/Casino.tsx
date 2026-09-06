'use client';

/*
 * The casino.
 *
 * Two games of chance for the settlement's Gold: a coin, and a coin under
 * one of three cups. The draw is the server's, never the browser's; the
 * browser only shows it. A win pays Gold, or $EMERGE that the Bank pays out
 * under the same daily room and burn share as stewardship. Three plays a
 * day are free; a pass of five more is bought in $EMERGE or ETH.
 *
 * The GLD table is the same two games staked in $EMERGE: the stake goes
 * into the vault before the draw, a loss is burned and kept like a charge,
 * and a win is swapped for GLD and sent to the wallet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { buyPass, fetchCasino, playCasino, settleGldWins, type CasinoInfo, type GldPayout, type PlayResult } from '@/lib/net/casino';
import { pay } from '@/lib/chain/spend';
import { ACTIVE_CHAIN, VAULT_ADDRESS, TOKEN, sendEth, tokenLive } from '@/lib/chain/emerge';
import type { VaultLedger } from '@/lib/chain/vault';
import { t, tx, useLocale } from '@/lib/i18n';

type Game = 'coin' | 'cups';
type Prize = 'gold' | 'emerge' | 'gld';

interface Props {
  address: string | null;
  treasury: number;
  ledger: VaultLedger;
  onLedger: (ledger: VaultLedger) => void;
  /** Book Gold against the treasury: a negative delta stakes, a positive one pays. False when the treasury cannot cover a stake. */
  onGold: (delta: number, note: string) => boolean;
  onCue: (kind: 'win' | 'lose' | 'tick') => void;
  onClose: () => void;
  spectating: boolean;
}

const ethText = (wei: string) => (Number(BigInt(wei) / 1_000_000_000_000n) / 1e6).toFixed(5);
/** GLD from base units, to four places. */
const gldText = (units: string) => (Number(BigInt(units) / 1_000_000_000_000n) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 });
const short = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

export default function Casino({ address, treasury, ledger, onLedger, onGold, onCue, onClose, spectating }: Props) {
  useLocale();
  const [info, setInfo] = useState<CasinoInfo | null>(null);
  const [game, setGame] = useState<Game>('coin');
  const [pick, setPick] = useState(0);
  const [bet, setBet] = useState(100);
  const [prize, setPrize] = useState<Prize>('gold');
  const [busy, setBusy] = useState(false);
  const [spin, setSpin] = useState<'idle' | 'spinning' | 'shown'>('idle');
  const [result, setResult] = useState<PlayResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [buying, setBuying] = useState<'emerge' | 'eth' | null>(null);
  const [passes, setPasses] = useState(1);
  const [emergeStake, setEmergeStake] = useState(5000);
  const [gldPayout, setGldPayout] = useState<GldPayout | null>(null);
  const [settling, setSettling] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void (async () => { const next = await fetchCasino(address); if (live.current) setInfo(next); })();
    return () => { live.current = false; };
  }, [address]);

  const rules = info?.rules;
  const gldTable = prize === 'gld';
  const min = rules ? (gldTable ? rules.minStakeEmerge : prize === 'emerge' ? rules.minBetEmerge : rules.minBet) : 100;
  const max = rules ? (gldTable ? rules.maxStakeEmerge : prize === 'emerge' ? rules.maxBetEmerge : rules.maxBet) : 5000;
  const playsLeft = info?.plays ? info.plays.free + info.plays.extra : 0;
  const stake = Math.floor(gldTable ? emergeStake : bet);
  const preview = rules
    ? prize === 'gold'
      ? t('A win pays {n} Gold', { n: Math.floor(stake * rules.goldPays[game]).toLocaleString() })
      : prize === 'emerge'
        ? t('A win pays {n} {ticker}', { n: (stake * rules.emergePerGold[game]).toLocaleString(), ticker: TOKEN.ticker })
        : t('A win pays {n} {ticker} worth of GLD, sent to your wallet', { n: Math.floor(stake * rules.goldPays[game]).toLocaleString(), ticker: TOKEN.ticker })
    : '';

  /** Refresh the standing figures without disturbing the table. */
  const refresh = useCallback(async () => {
    const next = await fetchCasino(address);
    if (live.current && next) setInfo(next);
  }, [address]);

  /** Ask the vault to pay what is waiting, a few times, until it is in the wallet. */
  const chase = useCallback(async (id: string | null) => {
    if (!address) return;
    setSettling(true);
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await settleGldWins(address);
      if (!live.current) return;
      if (r) {
        const done = id ? r.done.find((p) => p.id === id) : r.done[0];
        const still = id ? r.waiting.find((p) => p.id === id) : null;
        if (done) { setGldPayout(done); break; }
        if (still) setGldPayout(still);
        if (!still && !done) break;
      }
      await new Promise((res) => setTimeout(res, 4000));
    }
    setSettling(false);
    void refresh();
  }, [address, refresh]);

  const playGld = useCallback(async () => {
    if (!address || !info || busy || spectating) return;
    if (stake < min) { setMessage(t('The GLD table takes {n} {ticker} at least.', { n: min.toLocaleString(), ticker: TOKEN.ticker })); return; }
    if (stake > max) { setMessage(t('The GLD table takes {n} {ticker} at most.', { n: max.toLocaleString(), ticker: TOKEN.ticker })); return; }
    setBusy(true); setMessage(null); setResult(null); setGldPayout(null); setSpin('idle');
    const paid = await pay(ledger, stake, address, VAULT_ADDRESS);
    if (!paid.ok) { setMessage(paid.refused ? tx(paid.refused) : t('The stake did not go through.')); setBusy(false); return; }
    onLedger(paid.ledger);
    setSpin('spinning');
    // The chain takes a few seconds to confirm the stake; ask until it has.
    let r: Awaited<ReturnType<typeof playCasino>> | null = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      r = await playCasino(address, { game, pick, prize: 'gld', stake, txHash: paid.txHash });
      if (!live.current) return;
      if (r.ok || !r.settling) break;
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (!r || !r.ok) {
      setSpin('idle'); setBusy(false);
      setMessage(r && !r.settling ? tx(r.error) : t('The chain is slow to confirm the stake. Open the casino again in a minute; a confirmed stake is played when it lands.'));
      return;
    }
    await new Promise((res) => setTimeout(res, 1500));
    if (!live.current) return;
    setResult(r.result); setSpin('shown');
    if (r.result.won) {
      onCue('win');
      const payout = r.result.gldPayout ?? null;
      setGldPayout(payout);
      setBusy(false);
      if (payout && !payout.settledAt) void chase(payout.id);
    } else { onCue('lose'); setBusy(false); }
    void refresh();
  }, [address, info, busy, spectating, stake, min, max, ledger, onLedger, game, pick, onCue, chase, refresh]);

  const play = useCallback(async () => {
    if (!address || !info || busy || spectating) return;
    if (stake < min) { setMessage(t('The smallest stake here is {n} Gold.', { n: min })); return; }
    if (stake > max) { setMessage(t('The table takes {n} Gold at most.', { n: max.toLocaleString() })); return; }
    if (stake > treasury || !onGold(-stake, t('{n} Gold went on the tables at the casino.', { n: stake.toLocaleString() }))) {
      setMessage(t('The treasury cannot cover that stake.'));
      return;
    }
    setBusy(true); setMessage(null); setResult(null); setSpin('spinning');
    const r = await playCasino(address, { game, pick, bet: stake, prize });
    if (!r.ok) {
      onGold(stake, t('The casino returned a stake.'));
      setSpin('idle'); setBusy(false);
      setMessage(tx(r.error));
      if (r.plays) setInfo((i) => (i ? { ...i, plays: r.plays! } : i));
      return;
    }
    await new Promise((res) => setTimeout(res, 1500));
    if (!live.current) return;
    setResult(r.result); setSpin('shown');
    if (r.result.won) {
      onCue('win');
      if (r.result.gold > 0) onGold(r.result.gold, t('{n} Gold came off the tables at the casino.', { n: r.result.gold.toLocaleString() }));
      if (r.result.emerge > 0) onLedger({ ...ledger, earnedEmerge: ledger.earnedEmerge + r.result.emerge });
    } else onCue('lose');
    setInfo((i) => (i ? { ...i, plays: r.result.plays, wonToday: i.wonToday + r.result.emerge, credit: i.credit + r.result.emerge } : i));
    setBusy(false);
  }, [address, info, busy, spectating, stake, min, max, treasury, onGold, game, pick, prize, onCue, onLedger, ledger]);

  const buy = useCallback(async (method: 'emerge' | 'eth') => {
    if (!address || !info || buying) return;
    setBuying(method); setMessage(null);
    let txHash: string | null = null;
    if (method === 'emerge') {
      const paid = await pay(ledger, info.prices.emerge * passes, address, VAULT_ADDRESS);
      if (!paid.ok) { setMessage(paid.refused ? tx(paid.refused) : t('The payment did not go through.')); setBuying(null); return; }
      txHash = paid.txHash;
      onLedger(paid.ledger);
    } else {
      const sent = await sendEth(address, VAULT_ADDRESS, BigInt(info.prices.ethWei) * BigInt(passes));
      if (!sent.ok) { setMessage(tx(sent.message)); setBuying(null); return; }
      txHash = sent.txHash;
    }
    // The chain takes a few seconds to confirm; ask again until it has.
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = await buyPass(address, method, txHash, passes);
      if (r.ok) { setInfo((i) => (i ? { ...i, plays: r.plays } : i)); setMessage(t('{n} more plays are yours.', { n: info.rules.passPlays * passes })); onCue('tick'); setBuying(null); return; }
      if (!r.settling) { setMessage(tx(r.error)); setBuying(null); return; }
      await new Promise((res) => setTimeout(res, 3000));
    }
    setMessage(t('The chain is slow to confirm the pass. It will be credited when it does; open the casino again in a minute.'));
    setBuying(null);
  }, [address, info, buying, ledger, onLedger, onCue, passes]);

  const picks = game === 'coin' ? [t('Heads'), t('Tails')] : [t('Left'), t('Middle'), t('Right')];

  return (
    <div className="overlay" onClick={onClose}>
      <section className="overlay-panel wide casino" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h3>{t('The Casino')}</h3>
            <p className="muted">{t('A coin, and a coin under a cup. The draw is made in the vault, not in your browser. Play for Gold, for {ticker} paid by the Bank under its usual rules, or stake {ticker} at the GLD table and take a win home in GLD.', { ticker: TOKEN.ticker })}</p>
          </div>
          <button className="panel-close" onClick={onClose} aria-label={t('Close')}>×</button>
        </header>
        <div className="overlay-body">
          {spectating && <p className="muted">{t('Spectators watch; the tables take Gold from a settlement of your own.')}</p>}
          {!address && !spectating && <p className="muted">{t('Connect a wallet to play.')}</p>}
          {!info && <p className="muted">{t('Setting the tables…')}</p>}
          {info && (
            <>
              <div className="casino-top">
                <div className="casino-stat">
                  <span>{t('PLAYS')}</span>
                  <b>{info.plays ? t('{free} free · {extra} bought', { free: info.plays.free, extra: info.plays.extra }) : '—'}</b>
                  <small>{t('{n} free plays a day, from midnight UTC', { n: info.rules.freePlays })}</small>
                </div>
                <div className="casino-stat">
                  <span>{t('{ticker} WON TODAY', { ticker: TOKEN.ticker })}</span>
                  <b>{info.wonToday.toLocaleString()} / {info.rules.maxEmergeDay.toLocaleString()}</b>
                  <small>{t('{n} waiting to be collected at the Bank', { n: info.credit.toLocaleString() })}</small>
                </div>
                <div className="casino-stat">
                  <span>{t('GLD TABLE TODAY')}</span>
                  <b>{info.gld ? `${info.gld.wonToday.toLocaleString()} / ${info.rules.maxGldDay.toLocaleString()}` : '—'} <small>{TOKEN.ticker}</small></b>
                  <small>
                    {info.gld && info.gld.waiting.length > 0
                      ? t('{n} wins waiting to be sent', { n: info.gld.waiting.length })
                      : t('won before the swap; paid in GLD')}
                    {info.gld && info.gld.waiting.length > 0 && !settling && (
                      <> · <button className="link" onClick={() => void chase(null)}>{t('Send now')}</button></>
                    )}
                  </small>
                </div>
              </div>

              <div className="casino-games">
                <button className={game === 'coin' ? 'sel' : ''} disabled={busy} onClick={() => { setGame('coin'); setPick(0); setResult(null); setSpin('idle'); }}>
                  <b>{t('Coin flip')}</b><small>{t('pays {n} to 1', { n: info.rules.goldPays.coin })}</small>
                </button>
                <button className={game === 'cups' ? 'sel' : ''} disabled={busy} onClick={() => { setGame('cups'); setPick(1); setResult(null); setSpin('idle'); }}>
                  <b>{t('Three cups')}</b><small>{t('pays {n} to 1', { n: info.rules.goldPays.cups })}</small>
                </button>
              </div>

              <div className="casino-table">
                {game === 'coin' ? (
                  <div className={`casino-coin ${spin} ${result ? (result.drawn === 0 ? 'heads' : 'tails') : ''}`}>
                    <div className="face heads">{t('H')}</div>
                    <div className="face tails">{t('T')}</div>
                  </div>
                ) : (
                  <div className={`casino-cups ${spin}`}>
                    {[0, 1, 2].map((i) => (
                      <button key={i} className={`cup ${pick === i ? 'picked' : ''} ${result && spin === 'shown' && result.drawn === i ? 'lifted' : ''}`} disabled={busy} onClick={() => setPick(i)} aria-label={picks[i]}>
                        <span className="cup-coin" />
                        <span className="cup-body" />
                      </button>
                    ))}
                  </div>
                )}
                <div className="casino-picks">
                  {picks.map((label, i) => (
                    <button key={label} className={pick === i ? 'sel' : ''} disabled={busy} onClick={() => setPick(i)}>{label}</button>
                  ))}
                </div>
                {result && spin === 'shown' && (
                  <p className={`casino-result ${result.won ? 'won' : 'lost'}`}>
                    {result.won
                      ? result.prize === 'gld'
                        ? t('You won {n} {ticker} worth of GLD.', { n: result.emerge.toLocaleString(), ticker: TOKEN.ticker })
                        : result.gold > 0
                          ? t('You won {n} Gold.', { n: result.gold.toLocaleString() })
                          : t('You won {n} {ticker}. It is waiting at the Bank.', { n: result.emerge.toLocaleString(), ticker: TOKEN.ticker })
                      : game === 'coin'
                        ? t('It came up {face}. The house takes it.', { face: result.drawn === 0 ? t('heads') : t('tails') })
                        : t('The coin was under the {cup} cup. The house takes it.', { cup: [t('left'), t('middle'), t('right')][result.drawn] })}
                    {result.capped && <small> {t('Your {ticker} for today is capped; the rest of that win was not paid.', { ticker: TOKEN.ticker })}</small>}
                    {result.won && result.prize === 'gld' && (
                      <small className="gld-status">
                        {gldPayout?.settledAt && gldPayout.units
                          ? <>
                            {t('{n} GLD is in your wallet.', { n: gldText(gldPayout.units) })}
                            {gldPayout.sendTx && ACTIVE_CHAIN.explorerUrl && <> <a href={`${ACTIVE_CHAIN.explorerUrl}/tx/${gldPayout.sendTx}`} target="_blank" rel="noreferrer">{short(gldPayout.sendTx)}</a></>}
                            {gldPayout.simulated && <> {t('(a test build: nothing was sent on chain)')}</>}
                          </>
                          : settling
                            ? t('The vault is swapping it for GLD and sending it…')
                            : gldPayout?.problem
                              ? t('Not sent yet: {why} The vault will try again; open the casino later to check.', { why: tx(gldPayout.problem) })
                              : t('The vault will send the GLD shortly.')}
                      </small>
                    )}
                  </p>
                )}
              </div>

              <div className="casino-bet">
                <label>
                  <span>{gldTable ? t('STAKE, IN {ticker}', { ticker: TOKEN.ticker }) : t('STAKE, IN GOLD')}</span>
                  {gldTable
                    ? <input type="number" min={min} max={max} step={1000} value={emergeStake} disabled={busy} onChange={(e) => setEmergeStake(Number(e.target.value) || 0)} />
                    : <input type="number" min={min} max={max} step={50} value={bet} disabled={busy} onChange={(e) => setBet(Number(e.target.value) || 0)} />}
                </label>
                <div className="casino-quick">
                  {gldTable
                    ? [5000, 10000, 25000, 50000, 100000].map((v) => <button key={v} disabled={busy} onClick={() => setEmergeStake(v)}>{v.toLocaleString()}</button>)
                    : [100, 250, 500, 1000, 2500].map((v) => <button key={v} disabled={busy} onClick={() => setBet(v)}>{v.toLocaleString()}</button>)}
                </div>
                <div className="casino-prize">
                  <button className={prize === 'gold' ? 'sel' : ''} disabled={busy} onClick={() => setPrize('gold')}>{t('Win Gold')}</button>
                  <button className={prize === 'emerge' ? 'sel' : ''} disabled={busy} onClick={() => { setPrize('emerge'); if (bet < info.rules.minBetEmerge) setBet(info.rules.minBetEmerge); }}>{t('Win {ticker}', { ticker: TOKEN.ticker })}</button>
                  <button className={prize === 'gld' ? 'sel' : ''} disabled={busy} onClick={() => { setPrize('gld'); if (emergeStake < info.rules.minStakeEmerge) setEmergeStake(info.rules.minStakeEmerge); }}>{t('Win GLD')}</button>
                </div>
                <p className="casino-odds">
                  {preview} · {gldTable
                    ? t('stake {min} to {max} {ticker}', { min: min.toLocaleString(), max: max.toLocaleString(), ticker: TOKEN.ticker })
                    : t('stake {min} to {max} Gold', { min: min.toLocaleString(), max: max.toLocaleString() })}
                </p>
                {gldTable && (
                  <p className="muted small casino-gld-note">
                    {t('The stake goes into the vault before the draw and does not use a play. Lose, and it is burned and kept like every charge. Win, and the vault swaps your winnings for GLD and sends it to your wallet. Your wallet holds {n} {ticker}.', { n: Math.floor(ledger.balance).toLocaleString(), ticker: TOKEN.ticker })}
                  </p>
                )}
                {gldTable ? (
                  <button className="casino-play" disabled={busy || !address || spectating} onClick={playGld}>
                    {busy ? t('Playing…') : t('Stake {n} {ticker}', { n: stake.toLocaleString(), ticker: TOKEN.ticker })}
                  </button>
                ) : (
                  <button className="casino-play" disabled={busy || !address || spectating || playsLeft === 0} onClick={play}>
                    {busy ? t('Playing…') : playsLeft === 0 ? t('No plays left today') : t('Play')}
                  </button>
                )}
              </div>

              {message && <p className="casino-message">{message}</p>}

              <div className="casino-pass">
                <div>
                  <h4>{t('Out of plays?')}</h4>
                  <p className="muted small">{t('Every {n} plays are about ${usd}; buy as many as you like. {ticker} passes go into the vault and are burned and kept like every charge; ETH passes go to the vault too, with a share to development.', { n: info.rules.passPlays, usd: info.rules.passUsd, ticker: TOKEN.ticker })}</p>
                </div>
                <div className="casino-buy-block">
                  <div className="casino-passes">
                    {[1, 2, 5, 10].map((n) => (
                      <button key={n} className={passes === n ? 'sel' : ''} disabled={buying !== null} onClick={() => setPasses(n)}>
                        {t('{n} plays', { n: n * info.rules.passPlays })}
                      </button>
                    ))}
                  </div>
                  <div className="casino-buy">
                    <button disabled={!address || buying !== null} onClick={() => buy('emerge')}>
                      {buying === 'emerge' ? t('Paying…') : `${(info.prices.emerge * passes).toLocaleString()} ${TOKEN.ticker}`}
                    </button>
                    {tokenLive() && (
                      <button disabled={!address || buying !== null} onClick={() => buy('eth')}>
                        {buying === 'eth' ? t('Paying…') : `${ethText((BigInt(info.prices.ethWei) * BigInt(passes)).toString())} ETH`}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <p className="muted small casino-fine">
                {t('The house keeps an edge on every game. {ticker} won is paid by the Bank under the same daily room and burn share as stewardship, and no wallet wins more than {cap} {ticker} a day at the tables. Never stake more than the settlement can spare.', { ticker: TOKEN.ticker, cap: info.rules.maxEmergeDay.toLocaleString() })}
                {' '}
                {t('At the GLD table a win is worth up to {cap} {ticker} a wallet a day before the swap, and what the swap returns is what the market gives at that moment.', { ticker: TOKEN.ticker, cap: info.rules.maxGldDay.toLocaleString() })}
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
