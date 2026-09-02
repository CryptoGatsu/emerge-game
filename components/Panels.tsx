'use client';

/**
 * Overlay panels: the market, the bank, construction and the $EMERGE layer.
 *
 * These open over the world rather than replacing it — the settlement keeps
 * running behind them, which is the whole point of the thing.
 */

import { useEffect, useState } from 'react';
import { maintenanceCost } from '@/lib/simulation';
import type { Snapshot } from '@/lib/hud';
import {
  ACTIVE_CHAIN, INITIAL_WALLET, TOKEN, chainConfigured, connectWallet,
  shortAddress, switchToEmergeChain, tokenActions, walletAvailable, type WalletState,
} from '@/lib/chain/emerge';

export type PanelKey = 'market' | 'bank' | 'build' | 'connect' | null;

interface PanelsProps {
  panel: PanelKey;
  view: Snapshot;
  onClose: () => void;
  onBuild: (type: string, cost: number) => void;
}

/** Buildable structures. Upkeep is read from the simulation so it never drifts. */
const BUILDABLE: { type: string; cost: number; blurb: string; icon: string }[] = [
  { type: 'House', cost: 100, icon: '⌂', blurb: 'Homes for a growing settlement.' },
  { type: 'Farm', cost: 150, icon: '✣', blurb: 'Wheat and vegetables from the fields.' },
  { type: 'Woodcutter', cost: 125, icon: '♣', blurb: 'Timber from the surrounding forest.' },
  { type: 'Quarry', cost: 175, icon: '◇', blurb: 'Cut stone from the highland.' },
  { type: 'Mine', cost: 250, icon: '◆', blurb: 'Iron ore from deep in the ridge.' },
  { type: 'Mill', cost: 250, icon: '◫', blurb: 'Turns wheat into flour.' },
  { type: 'Bakery', cost: 300, icon: '◈', blurb: 'Turns flour into bread.' },
  { type: 'Carpenter', cost: 275, icon: '▣', blurb: 'Turns wood into furniture.' },
  { type: 'Blacksmith', cost: 400, icon: '⚒', blurb: 'Turns ore into tools.' },
  { type: 'Tailor', cost: 325, icon: '✦', blurb: 'Turns wool into clothing.' },
  { type: 'Storage', cost: 120, icon: '▤', blurb: 'Somewhere to keep the surplus.' },
  { type: 'Tavern', cost: 350, icon: '♨', blurb: 'Where the settlement gathers.' },
];

function Shell({ title, subtitle, onClose, children, wide }: {
  title: string; subtitle: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <section className={`overlay-panel ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2>{title}</h2>
            <p className="muted">{subtitle}</p>
          </div>
          <button className="panel-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="overlay-body">{children}</div>
      </section>
    </div>
  );
}

function MarketPanel({ view, onClose }: { view: Snapshot; onClose: () => void }) {
  const [focus, setFocus] = useState(view.market[0]?.key ?? 'wheat');
  const row = view.market.find((m) => m.key === focus) ?? view.market[0];
  return (
    <Shell title="World Market" subtitle="Households buy food, producers consume inputs, and the market moves to close the gaps." onClose={onClose} wide>
      {row && (
        <div className="market-focus">
          <div>
            <span className="eyebrow">FOCUS</span>
            <h3>{row.label}</h3>
            <strong>{row.quote.price.toFixed(2)} <small>GOLD / UNIT</small></strong>
          </div>
          <div><span>SUPPLY</span><b>{Math.floor(row.quote.supply)}</b></div>
          <div><span>DEMAND</span><b>{Math.floor(row.quote.demand)}</b></div>
          <div><span>TREND</span><b className={row.quote.trend >= 0 ? 'up' : 'down'}>{row.quote.trend >= 0 ? '+' : ''}{row.quote.trend.toFixed(3)}</b></div>
        </div>
      )}
      <div className="market-rows">
        {view.market.map((m) => (
          <button key={m.key} className={`market-row ${focus === m.key ? 'focused' : ''}`} onClick={() => setFocus(m.key)}>
            <span>{m.label}</span>
            <b>{m.quote.price.toFixed(2)}</b>
            <span className={m.quote.demand > m.quote.supply ? 'buy' : 'sell'}>
              {m.quote.demand > m.quote.supply ? 'BUY PRESSURE' : 'SELL PRESSURE'}
            </span>
            <span>{Math.floor(view.resources.find((r) => r.key === m.key)?.amount ?? 0)} in store</span>
          </button>
        ))}
      </div>
    </Shell>
  );
}

function BankPanel({ view, onClose }: { view: Snapshot; onClose: () => void }) {
  return (
    <Shell title="Bank" subtitle="Gold circulates between the treasury, workers, households and the market." onClose={onClose}>
      <div className="bank-balance">{Math.floor(view.treasury).toLocaleString()} <small>GOLD</small></div>
      <div className="bank-grid">
        <div><span>HOUSEHOLD WEALTH</span><b>{Math.floor(view.householdWealth).toLocaleString()}</b></div>
        <div><span>WAGES PER DAY</span><b>{Math.floor(view.dailyWages).toLocaleString()}</b></div>
        <div><span>FAMILIES</span><b>{view.familyCount}</b></div>
        <div><span>BUILDINGS ON UPKEEP</span><b>{view.upkeep}</b></div>
      </div>
      <h4>Stores</h4>
      <div className="resource-grid">
        {view.resources.map((r) => (
          <div key={r.key} className="resource-cell">
            <span>{r.label}</span>
            <b>{Math.floor(r.amount)}</b>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function BuildPanel({ view, onClose, onBuild }: { view: Snapshot; onClose: () => void; onBuild: (t: string, c: number) => void }) {
  return (
    <Shell title="Build" subtitle="Invest Gold into the settlement. New places become part of the citizens' routines." onClose={onClose} wide>
      <div className="build-grid">
        {BUILDABLE.map((option) => {
          const affordable = view.treasury >= option.cost;
          return (
            <div key={option.type} className={`build-card ${affordable ? '' : 'locked'}`}>
              <div className="build-icon">{option.icon}</div>
              <h3>{option.type}</h3>
              <p>{option.blurb}</p>
              <div className="build-cost">
                <b>{option.cost} Gold</b>
                <small>{maintenanceCost(option.type)}/day upkeep</small>
              </div>
              <button disabled={!affordable} onClick={() => onBuild(option.type, option.cost)}>
                {affordable ? 'Place' : 'Not enough Gold'}
              </button>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function ConnectPanel({ view, onClose }: { view: Snapshot; onClose: () => void }) {
  const [wallet, setWallet] = useState<WalletState>(INITIAL_WALLET);
  const [notice, setNotice] = useState<string | null>(null);
  const configured = chainConfigured();

  useEffect(() => {
    if (!walletAvailable()) setWallet({ status: 'unsupported', address: null, chainId: null, error: null });
  }, []);

  const connect = async () => {
    setWallet((w) => ({ ...w, status: 'connecting' }));
    setWallet(await connectWallet());
  };

  const switchChain = async () => setNotice(await switchToEmergeChain());

  return (
    <Shell title="Connect" subtitle={`Emerge is a hybrid world: the settlement runs off-chain, and ${TOKEN.ticker} on ${ACTIVE_CHAIN.label} carries ownership and value.`} onClose={onClose} wide>
      <div className="connect-grid">
        <div className="connect-card">
          <span className="eyebrow">WALLET</span>
          {wallet.status === 'connected' ? (
            <>
              <h3>{shortAddress(wallet.address)}</h3>
              <p className="muted">Connected on chain {wallet.chainId ?? '—'}.</p>
              {ACTIVE_CHAIN.chainId !== null && wallet.chainId !== ACTIVE_CHAIN.chainId && (
                <button onClick={switchChain}>Switch to {ACTIVE_CHAIN.label}</button>
              )}
            </>
          ) : wallet.status === 'unsupported' ? (
            <>
              <h3>No wallet detected</h3>
              <p className="muted">Install a browser wallet to link this world to {TOKEN.ticker}.</p>
            </>
          ) : (
            <>
              <h3>Not connected</h3>
              <p className="muted">Connecting is optional. The world keeps running either way.</p>
              <button onClick={connect} disabled={wallet.status === 'connecting'}>
                {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
              </button>
            </>
          )}
          {wallet.error && <p className="warn">{wallet.error}</p>}
          {notice && <p className="warn">{notice}</p>}
        </div>

        <div className="connect-card">
          <span className="eyebrow">THIS WORLD</span>
          <h3>Seed {view.seed}</h3>
          <p className="muted">Day {view.day} · {view.population} beings · {view.familyCount} families</p>
          <ul className="area-list">
            {view.unlockedAreas.map((area) => <li key={area}>{area}</li>)}
          </ul>
          {view.projects.length > 0 && (
            <>
              <span className="eyebrow">IN PROGRESS</span>
              <ul className="area-list">
                {view.projects.map((p) => <li key={p.id}>{p.owner} — {p.name}</li>)}
              </ul>
            </>
          )}
        </div>
      </div>

      <h4>{TOKEN.ticker} on {ACTIVE_CHAIN.label}</h4>
      {!configured && (
        <p className="muted small">
          Chain details are not wired into this deployment yet. Set the Robinhood Chain RPC, chain id and token
          address in the environment to enable settlement; until then these are the actions the economy layer is
          designed around.
        </p>
      )}
      <div className="token-grid">
        {tokenActions().map((action) => (
          <div key={action.id} className={`token-card ${action.ready ? '' : 'pending'}`}>
            <b>{action.label}</b>
            <span>{action.detail}</span>
            <em>{action.ready ? 'Ready' : 'Awaiting chain config'}</em>
          </div>
        ))}
      </div>
    </Shell>
  );
}

export function Panels({ panel, view, onClose, onBuild }: PanelsProps) {
  if (panel === 'market') return <MarketPanel view={view} onClose={onClose} />;
  if (panel === 'bank') return <BankPanel view={view} onClose={onClose} />;
  if (panel === 'build') return <BuildPanel view={view} onClose={onClose} onBuild={onBuild} />;
  if (panel === 'connect') return <ConnectPanel view={view} onClose={onClose} />;
  return null;
}
