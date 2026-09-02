'use client';

/**
 * Overlay panels: the market, the bank, construction and the $EMERGE layer.
 *
 * These open over the world rather than replacing it — the settlement keeps
 * running behind them, which is the whole point of the thing.
 */

import { useState } from 'react';
import type { ClaimedWorld, PlayerRecord } from '@/lib/world/plots';
import { maintenanceCost } from '@/lib/simulation';
import type { Snapshot } from '@/lib/hud';
import { ACTIVE_CHAIN, TOKEN, tokenActions, tokenLive } from '@/lib/chain/emerge';
import {
  EMERGE_PER_GOLD, RENAME_COST_EMERGE, WITHDRAW_BURN_RATE,
  deposit, quoteWithdraw, withdraw, type VaultLedger,
} from '@/lib/chain/vault';
import { Sparkline } from './Sparkline';
import { WalletPicker } from './WalletPicker';

export type PanelKey = 'market' | 'bank' | 'build' | 'connect' | null;

interface PanelsProps {
  panel: PanelKey;
  view: Snapshot;
  claimed: ClaimedWorld;
  player: PlayerRecord;
  onClose: () => void;
  onBuild: (type: string, cost: number) => void;
  onRenameWorld: (name: string) => void;
  onRenameCitizen: (id: string, name: string) => void;
  onLeave: () => void;
  /** Move Gold in or out of the treasury and record it against the player. */
  onVault: (ledger: VaultLedger, goldDelta: number, note: string) => void;
  /** List this plot for resale at a price, or pass null to withdraw it. */
  onList: (price: number | null) => void;
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
  const store = (key: string) => Math.floor(view.resources.find((r) => r.key === key)?.amount ?? 0);

  return (
    <Shell
      title="World Market"
      subtitle="Households buy food, producers consume inputs, and the market moves to close the gaps."
      onClose={onClose}
      wide
    >
      {row && (
        <div className="market-focus">
          <div>
            <span className="eyebrow">FOCUS</span>
            <h3>{row.label}</h3>
            <strong>{row.quote.price.toFixed(2)} <small>GOLD / UNIT</small></strong>
          </div>
          <div className="market-chart">
            <span className="eyebrow">LAST {row.quote.history.length} DAYS</span>
            <Sparkline values={row.quote.history} width={260} height={54} />
          </div>
          <div className="market-figures">
            <div><span>IN STORE</span><b>{store(row.key)}</b></div>
            <div><span>MADE / DAY</span><b>{Math.round(view.production[row.key] ?? 0)}</b></div>
            <div><span>USED / DAY</span><b>{Math.round(view.consumption[row.key] ?? 0)}</b></div>
            <div>
              <span>TREND</span>
              <b className={row.quote.trend >= 0 ? 'up' : 'down'}>
                {row.quote.trend >= 0 ? '+' : ''}{row.quote.trend.toFixed(3)}
              </b>
            </div>
          </div>
        </div>
      )}

      <div className="market-rows">
        <div className="market-row head">
          <span>RESOURCE</span><span>PRICE</span><span>30 DAYS</span><span>PRESSURE</span><span>IN STORE</span><span>FLOW</span>
        </div>
        {view.market.map((m) => {
          const pressure = m.quote.demand - m.quote.supply;
          const flow = Math.round((view.production[m.key] ?? 0) - (view.consumption[m.key] ?? 0));
          return (
            <button key={m.key} className={`market-row ${focus === m.key ? 'focused' : ''}`} onClick={() => setFocus(m.key)}>
              <span>{m.label}</span>
              <b>{m.quote.price.toFixed(2)}</b>
              <Sparkline values={m.quote.history} width={78} height={18} subtle />
              <span className={pressure > 0 ? 'buy' : 'sell'}>
                {pressure > 0 ? 'WANTED' : 'SURPLUS'} {Math.abs(Math.round(pressure))}
              </span>
              <span>{store(m.key)}</span>
              <span className={flow >= 0 ? 'buy' : 'sell'}>{flow >= 0 ? '+' : ''}{flow}/day</span>
            </button>
          );
        })}
      </div>
    </Shell>
  );
}

function BankPanel({ view, player, onClose, onVault }: {
  view: Snapshot; player: PlayerRecord; onClose: () => void;
  onVault: (ledger: VaultLedger, goldDelta: number, note: string) => void;
}) {
  const [depositAmount, setDepositAmount] = useState('100000');
  const [withdrawAmount, setWithdrawAmount] = useState('50');
  const [message, setMessage] = useState<string | null>(null);
  const ledger = player.ledger;

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

function ConnectPanel({ view, claimed, player, onClose, onRenameWorld, onLeave, onList }: {
  view: Snapshot; claimed: ClaimedWorld; player: PlayerRecord; onClose: () => void;
  onRenameWorld: (name: string) => void; onLeave: () => void; onList: (price: number | null) => void;
}) {
  const [draftName, setDraftName] = useState(view.name);
  const [askPrice, setAskPrice] = useState(String(Math.round(claimed.price * 1.25)));
  const configured = tokenLive();
  const affordable = player.ledger.balance >= RENAME_COST_EMERGE;
  const changed = draftName.trim().length > 0 && draftName.trim() !== view.name;
  const listing = player.listings.find((l) => l.seed === claimed.seed);

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
          <div className="vault-line" style={{ marginTop: 12 }}>
            <span>Balance</span><b>{Math.floor(player.ledger.balance).toLocaleString()} {TOKEN.ticker}</b>
          </div>
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
          <button onClick={() => onRenameWorld(draftName)} disabled={!changed || !affordable}>
            {affordable ? `Rename for ${RENAME_COST_EMERGE.toLocaleString()} ${TOKEN.ticker}` : `Not enough ${TOKEN.ticker}`}
          </button>
        </div>

        <div className="connect-card">
          <span className="eyebrow">SELL THIS PLOT</span>
          {listing ? (
            <>
              <h3>Listed at {listing.price.toLocaleString()} {TOKEN.ticker}</h3>
              <p className="muted small">
                Waiting for a buyer. Resale between players needs the plot registry on
                {' '}{ACTIVE_CHAIN.label}; until it is deployed the listing is local to this browser.
              </p>
              <button onClick={() => onList(null)}>Withdraw listing</button>
            </>
          ) : (
            <>
              <label className="name-field">
                <span>ASKING PRICE ({TOKEN.ticker})</span>
                <input value={askPrice} inputMode="numeric" onChange={(e) => setAskPrice(e.target.value.replace(/[^0-9]/g, ''))} />
              </label>
              <button onClick={() => onList(Number(askPrice) || 0)} disabled={!(Number(askPrice) > 0)}>
                List for sale
              </button>
            </>
          )}
          <button className="danger" onClick={onLeave}>Leave for the land office</button>
        </div>
      </div>

      <h4>{TOKEN.ticker} on {ACTIVE_CHAIN.label}</h4>
      {!configured && (
        <p className="muted small">
          This build reaches {ACTIVE_CHAIN.label} at {ACTIVE_CHAIN.rpcUrl} (chain {ACTIVE_CHAIN.chainId}), and
          your wallet can switch to it. What is missing is the {TOKEN.ticker} contract and the land registry:
          until those are deployed and their addresses set, these are the actions the economy layer is designed
          around, and balances and listings are local to this browser.
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

export function Panels({ panel, view, claimed, player, onClose, onBuild, onRenameWorld, onLeave, onVault, onList }: PanelsProps) {
  if (panel === 'market') return <MarketPanel view={view} onClose={onClose} />;
  if (panel === 'bank') return <BankPanel view={view} player={player} onClose={onClose} onVault={onVault} />;
  if (panel === 'build') return <BuildPanel view={view} onClose={onClose} onBuild={onBuild} />;
  if (panel === 'connect') {
    return (
      <ConnectPanel
        view={view} claimed={claimed} player={player} onClose={onClose}
        onRenameWorld={onRenameWorld} onLeave={onLeave} onList={onList}
      />
    );
  }
  return null;
}
