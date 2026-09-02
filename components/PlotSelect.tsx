'use client';

/**
 * The land office.
 *
 * Shown before any world exists. Players browse plots — each one previewed by
 * running the real terrain generator on its seed — pick one, name the world
 * that will grow there, and claim it with $EMERGE.
 *
 * Claims are honest about where they stand: with no registry contract deployed,
 * the plot is recorded in this browser and the panel says so rather than
 * showing a transaction that bought nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultWorldName } from '@/lib/simulation';
import {
  catalogue, drawPlotPreview, type ClaimedWorld, type Plot,
} from '@/lib/world/plots';
import {
  ACTIVE_CHAIN, INITIAL_WALLET, TOKEN, chainConfigured, claimPlot, connectWallet,
  shortAddress, walletAvailable, type WalletState,
} from '@/lib/chain/emerge';

function PlotPreview({ seed, size = 240 }: { seed: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Generation is a few tens of milliseconds; yielding a frame first keeps the
    // grid from appearing all at once after a visible stall.
    const id = requestAnimationFrame(() => drawPlotPreview(canvas, seed));
    return () => cancelAnimationFrame(id);
  }, [seed]);
  return <canvas ref={ref} width={size} height={Math.round(size * 0.56)} className="plot-canvas" />;
}

export default function PlotSelect({ onEnter }: { onEnter: (world: ClaimedWorld) => void }) {
  const plots = useMemo(() => catalogue(), []);
  const [selected, setSelected] = useState<Plot>(plots[0]);
  const [name, setName] = useState('');
  const [wallet, setWallet] = useState<WalletState>(INITIAL_WALLET);
  const [claiming, setClaiming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const configured = chainConfigured();

  useEffect(() => {
    if (!walletAvailable()) setWallet({ status: 'unsupported', address: null, chainId: null, error: null });
  }, []);

  const connect = useCallback(async () => {
    setWallet((w) => ({ ...w, status: 'connecting' }));
    setWallet(await connectWallet());
  }, []);

  const claim = useCallback(async () => {
    setClaiming(true);
    setNotice(null);
    const worldName = name.trim() || defaultWorldName(selected.seed);
    const result = await claimPlot({
      seed: selected.seed,
      region: selected.region,
      worldName,
      price: selected.price,
      address: wallet.address,
    });
    setClaiming(false);
    if (result.reason) setNotice(result.reason);
    onEnter({
      seed: selected.seed,
      name: worldName,
      region: selected.region,
      price: selected.price,
      claimedAt: Date.now(),
      owner: wallet.address,
      txHash: result.txHash,
    });
  }, [name, selected, wallet.address, onEnter]);

  return (
    <main className="land-office">
      <div className="land-inner">
        <header className="land-head">
          <div className="brand-line">
            <div className="brand-mark">✦</div>
            <div>
              <div className="wordmark">EMERGE</div>
              <div className="tagline">THE AI WORLD</div>
            </div>
          </div>
          <p>
            Every plot is a world waiting to happen. Claim one with {TOKEN.ticker}, give it a name,
            and the beings who live there will call it that.
          </p>
        </header>

        <div className="land-body">
          <section className="plot-list">
            {plots.map((plot) => (
              <button
                key={plot.id}
                className={`plot-card ${selected.id === plot.id ? 'selected' : ''}`}
                onClick={() => setSelected(plot)}
              >
                <PlotPreview seed={plot.seed} />
                <div className="plot-meta">
                  <h3>{plot.region}</h3>
                  <p>{plot.blurb}</p>
                  <div className="plot-facts">
                    <span>{plot.population} beings</span>
                    <span>{plot.families} families</span>
                    <b>{plot.price} {TOKEN.ticker}</b>
                  </div>
                </div>
              </button>
            ))}
          </section>

          <aside className="land-claim">
            <span className="eyebrow">CLAIM</span>
            <h2>{selected.region}</h2>
            <div className="plot-traits">
              {[...new Set(selected.terrain)].map((t) => <span key={t}>{t}</span>)}
            </div>
            <p className="muted">{selected.blurb}</p>

            <label className="name-field">
              <span>NAME YOUR WORLD</span>
              <input
                value={name}
                maxLength={24}
                placeholder={defaultWorldName(selected.seed)}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <div className="claim-price">
              <span>PRICE</span>
              <b>{selected.price}</b>
              <em>{TOKEN.ticker}</em>
            </div>

            <div className="claim-wallet">
              {wallet.status === 'connected' ? (
                <span className="wallet-ok">◈ {shortAddress(wallet.address)}</span>
              ) : wallet.status === 'unsupported' ? (
                <span className="muted small">No browser wallet detected — you can still claim and play.</span>
              ) : (
                <button className="ghost" onClick={connect} disabled={wallet.status === 'connecting'}>
                  {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
            </div>

            <button className="claim-button" onClick={claim} disabled={claiming}>
              {claiming ? 'Claiming…' : `Claim ${selected.region}`}
            </button>

            {!configured && (
              <p className="muted small">
                {ACTIVE_CHAIN.label} is not configured in this build, so claims are recorded in this
                browser rather than on chain. Your world is yours to play either way.
              </p>
            )}
            {notice && <p className="warn">{notice}</p>}
          </aside>
        </div>
      </div>
    </main>
  );
}
