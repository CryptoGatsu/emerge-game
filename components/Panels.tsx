'use client';

/**
 * Overlay panels: the market, the bank, construction and the $EMERGE layer.
 *
 * These open over the world rather than replacing it — the settlement keeps
 * running behind them, which is the whole point of the thing.
 */

import { useState } from 'react';
import type { ClaimedWorld } from '@/lib/world/plots';
import { maintenanceCost } from '@/lib/simulation';
import type { Snapshot } from '@/lib/hud';
import { ACTIVE_CHAIN, TOKEN, chainConfigured, tokenActions } from '@/lib/chain/emerge';
import {
  EMERGE_PER_GOLD, RENAME_COST_EMERGE, WITHDRAW_BURN_RATE,
  deposit, quoteWithdraw, withdraw, type VaultLedger,
} from '@/lib/chain/vault';
import { WalletPicker } from './WalletPicker';

export type PanelKey = 'market' | 'bank' | 'build' | 'connect' | null;

interface PanelsProps {
  panel: PanelKey;
  view: Snapshot;
  claimed: ClaimedWorld;
  onClose: () => void;
  onBuild: (type: string, cost: number) => void;
  onRename: (name: string) => void;
  onLeave: () => void;
  /** Move Gold in or out of the treasury and record it against the world. */
  onVault: (ledger: VaultLedger, goldDelta: number, note: string) => void;
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

function BankPanel({ view, claimed, onClose, onVault }: {
  view: Snapshot; claimed: ClaimedWorld; onClose: () => void;
  onVault: (ledger: VaultLedger, goldDelta: number, note: string) => void;
}) {
  const [depositAmount, setDepositAmount] = useState('100000');
  const [withdrawAmount, setWithdrawAmount] = useState('50');
  const [message, setMessage] = useState<string | null>(null);
  const ledger = claimed.ledger;

  const depositGold = Math.floor((Number(depositAmount) || 0) / EMERGE_PER_GOLD * 100) / 100;
  const quote = quoteWithdraw(Math.floor(Number(withdrawAmount) || 0));

  const doDeposit = () => {
    const result = deposit(ledger, Number(depositAmount) || 0);
    setMessage(result.message);
    if (result.ok) onVault(result.ledger, depositGold, `${depositGold} Gold arrived from the ${TOKEN.ticker} vault.`);
  };

  const doWithdraw = () => {
    const result = withdraw(ledger, Math.floor(Number(withdrawAmount) || 0), view.treasury);
    setMessage(result.message);
    if (result.ok) onVault(result.ledger, -quote.gold, `${quote.gold} Gold was withdrawn to ${TOKEN.ticker}.`);
  };

  return (
    <Shell title="Bank" subtitle="Gold circulates between the treasury, workers, households and the market." onClose={onClose} wide>
      <div className="bank-balance">{Math.floor(view.treasury).toLocaleString()} <small>GOLD</small></div>
      <div className="bank-grid">
        <div><span>HOUSEHOLD WEALTH</span><b>{Math.floor(view.householdWealth).toLocaleString()}</b></div>
        <div><span>WAGES PER DAY</span><b>{Math.floor(view.dailyWages).toLocaleString()}</b></div>
        <div><span>FAMILIES</span><b>{view.familyCount}</b></div>
        <div><span>BUILDINGS ON UPKEEP</span><b>{view.upkeep}</b></div>
      </div>

      <h4>{TOKEN.ticker} vault</h4>
      <p className="muted small">
        {EMERGE_PER_GOLD.toLocaleString()} {TOKEN.ticker} buys 1 Gold, so 1,000,000 {TOKEN.ticker} is 100 Gold.
        A settlement that runs a surplus can be drawn back out; withdrawals burn {Math.round(WITHDRAW_BURN_RATE * 100)}%.
      </p>

      <div className="vault-grid">
        <div className="vault-card">
          <span className="eyebrow">DEPOSIT</span>
          <label className="name-field">
            <span>{TOKEN.ticker} TO DEPOSIT</span>
            <input value={depositAmount} inputMode="numeric" onChange={(e) => setDepositAmount(e.target.value.replace(/[^0-9]/g, ''))} />
          </label>
          <div className="vault-line"><span>Buys</span><b>{depositGold} Gold</b></div>
          <div className="vault-line"><span>Balance</span><b>{Math.floor(ledger.balance).toLocaleString()} {TOKEN.ticker}</b></div>
          <button onClick={doDeposit} disabled={depositGold < 0.01 || Number(depositAmount) > ledger.balance}>
            Deposit
          </button>
        </div>

        <div className="vault-card">
          <span className="eyebrow">WITHDRAW</span>
          <label className="name-field">
            <span>GOLD TO WITHDRAW</span>
            <input value={withdrawAmount} inputMode="numeric" onChange={(e) => setWithdrawAmount(e.target.value.replace(/[^0-9]/g, ''))} />
          </label>
          <div className="vault-line"><span>You receive</span><b>{quote.received.toLocaleString()} {TOKEN.ticker}</b></div>
          <div className="vault-line burn"><span>Burned</span><b>{quote.burned.toLocaleString()} {TOKEN.ticker}</b></div>
          <button onClick={doWithdraw} disabled={quote.gold < 1 || quote.gold > Math.floor(view.treasury)}>
            Withdraw
          </button>
        </div>
      </div>

      {message && <p className="warn">{message}</p>}
      <div className="vault-ledger">
        <span>Deposited {ledger.depositedGold.toLocaleString()} Gold</span>
        <span>Withdrawn {ledger.withdrawnEmerge.toLocaleString()} {TOKEN.ticker}</span>
        <span>Burned {ledger.burnedEmerge.toLocaleString()} {TOKEN.ticker}</span>
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

function ConnectPanel({ view, claimed, onClose, onRename, onLeave }: {
  view: Snapshot; claimed: ClaimedWorld; onClose: () => void;
  onRename: (name: string) => void; onLeave: () => void;
}) {
  const [draftName, setDraftName] = useState(view.name);
  const configured = chainConfigured();
  const affordable = claimed.ledger.balance >= RENAME_COST_EMERGE;
  const changed = draftName.trim().length > 0 && draftName.trim() !== view.name;

  return (
    <Shell
      title="Connect"
      subtitle={`Emerge is a hybrid world: the settlement runs off-chain, and ${TOKEN.ticker} on ${ACTIVE_CHAIN.label} carries ownership and value.`}
      onClose={onClose}
      wide
    >
      <div className="connect-grid">
        <div className="connect-card">
          <span className="eyebrow">WALLET</span>
          <WalletPicker />
        </div>

        <div className="connect-card">
          <span className="eyebrow">YOUR PLOT</span>
          <h3>{claimed.region}</h3>
          <p className="muted">
            Claimed for {claimed.price} {TOKEN.ticker} · seed {view.seed} · day {view.day}
          </p>
          <p className="muted small">
            {claimed.txHash
              ? `Settled on chain: ${claimed.txHash}`
              : 'Recorded in this browser. Not settled on chain yet.'}
          </p>
          <label className="name-field">
            <span>WORLD NAME</span>
            <input value={draftName} maxLength={24} onChange={(e) => setDraftName(e.target.value)} />
          </label>
          <p className="muted small">
            Renaming costs {RENAME_COST_EMERGE.toLocaleString()} {TOKEN.ticker}. Balance:{' '}
            {Math.floor(claimed.ledger.balance).toLocaleString()}.
          </p>
          <button onClick={() => onRename(draftName)} disabled={!changed || !affordable}>
            {affordable ? `Rename for ${RENAME_COST_EMERGE.toLocaleString()} ${TOKEN.ticker}` : `Not enough ${TOKEN.ticker}`}
          </button>
          <button className="danger" onClick={onLeave}>Choose another plot</button>
        </div>
      </div>

      <h4>{TOKEN.ticker} on {ACTIVE_CHAIN.label}</h4>
      {!configured && (
        <p className="muted small">
          Chain details are not wired into this deployment yet. Set the Robinhood Chain RPC, chain id and token
          address in the environment to enable settlement; until then these are the actions the economy layer is
          designed around, and vault balances are local to this browser.
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

export function Panels({ panel, view, claimed, onClose, onBuild, onRename, onLeave, onVault }: PanelsProps) {
  if (panel === 'market') return <MarketPanel view={view} onClose={onClose} />;
  if (panel === 'bank') return <BankPanel view={view} claimed={claimed} onClose={onClose} onVault={onVault} />;
  if (panel === 'build') return <BuildPanel view={view} onClose={onClose} onBuild={onBuild} />;
  if (panel === 'connect') {
    return <ConnectPanel view={view} claimed={claimed} onClose={onClose} onRename={onRename} onLeave={onLeave} />;
  }
  return null;
}
