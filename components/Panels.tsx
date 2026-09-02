'use client';

/**
 * Overlay panels: the market, the bank, construction and the $EMERGE layer.
 *
 * These open over the world rather than replacing it — the settlement keeps
 * running behind them, which is the whole point of the thing.
 */

import { useEffect, useRef, useState } from 'react';
import type { ClaimedWorld, PlayerRecord } from '@/lib/world/plots';
import { buildMaterials, maintenanceCost } from '@/lib/simulation';
import type { Snapshot } from '@/lib/hud';
import { ACTIVE_CHAIN, TOKEN, shortAddress, tokenActions, tokenLive } from '@/lib/chain/emerge';
import {
  EMERGE_PER_GOLD, PROSPECT_COST_EMERGE, RENAME_CITIZEN_EMERGE, RENAME_COST_EMERGE, WITHDRAW_BURN_RATE,
  claimEarnings, deposit, quoteWithdraw, withdraw, type VaultLedger,
} from '@/lib/chain/vault';
import { Sparkline } from './Sparkline';
import {
  MESSAGE_LIMIT, channelOf, chatConnected, loadChat, send, setHandle, worldChannel,
  type ChannelKind, type ChatState,
} from '@/lib/chat';
import { WalletPicker, useWallet } from './WalletPicker';

export type PanelKey = 'market' | 'bank' | 'build' | 'guide' | 'chat' | 'connect' | null;

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
  /** Give the plot up entirely, as opposed to stepping out of it. */
  onRelease: () => void;
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
  { type: 'Bank', cost: 450, icon: '◈', blurb: 'A counting house for the treasury.' },
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
            // Six columns do not fit a phone, so each cell carries its own
            // label and the row reflows into two lines rather than being
            // squeezed into six unreadable slivers.
            <button key={m.key} className={`market-row ${focus === m.key ? 'focused' : ''}`} onClick={() => setFocus(m.key)}>
              <span className="cell name">{m.label}</span>
              <b className="cell price"><i>price</i>{m.quote.price.toFixed(2)}</b>
              <span className="cell spark"><Sparkline values={m.quote.history} width={78} height={18} subtle /></span>
              <span className={`cell ${pressure > 0 ? 'buy' : 'sell'}`}>
                <i>pressure</i>{pressure > 0 ? 'WANTED' : 'SURPLUS'} {Math.abs(Math.round(pressure))}
              </span>
              <span className="cell store"><i>in store</i>{store(m.key)}</span>
              <span className={`cell ${flow >= 0 ? 'buy' : 'sell'}`}><i>flow</i>{flow >= 0 ? '+' : ''}{flow}/day</span>
            </button>
          );
        })}
      </div>
    </Shell>
  );
}


/**
 * The game guide.
 *
 * Everything a player needs to understand what they are looking at and how to
 * make anything happen, written as sections they can read in any order. It is
 * long on purpose: the settlement runs itself in a dozen interlocking ways and
 * none of them are self-evident from watching.
 */
function GuidePanel({ view, onClose }: { view: Snapshot; onClose: () => void }) {
  const steward = view.stewardship;
  return (
    <Shell
      title="Game Guide"
      subtitle="What everything here does, and how to earn from it."
      onClose={onClose}
      wide
    >
      <div className="guide">
        <section className="opening">
          <h4>You are not the mayor</h4>
          <p>
            Nobody here takes orders. The people on your plot have their own hunger, their own
            trades, their own friends and their own grudges, and they get up in the morning and
            decide for themselves where to go. You cannot tell Maren to go and cut timber. You can
            build her a woodcutter&rsquo;s hut and watch her work out that somebody ought to.
          </p>
          <p>
            That is the whole game: <b>you shape the place, they decide what to do about it.</b> The
            settlement will feed itself, argue with itself, throw a feast, catch fire and bury its
            dead whether or not you are watching — and how well it does that is what pays you.
          </p>
        </section>

        <section>
          <h4>The first ten minutes</h4>
          <p>Your plot opens as a camp: a handful of families, a market, a shed, and not much Gold.</p>
          <ol>
            <li>Watch. Tap somebody and follow them around for a day — it will tell you more than this panel does.</li>
            <li>Open the <b>Bank</b>. That opening treasury will not last a week; wages come out of it every single day.</li>
            <li>Deposit some {TOKEN.ticker} to buy Gold. This is the one thing only you can do.</li>
            <li>Open <b>Build</b> and raise a house. Somewhere to live is what makes a camp somewhere people move to.</li>
            <li>Now do nothing for a bit and see who turns up on the road.</li>
          </ol>
        </section>

        <section>
          <h4>Time moves fast here</h4>
          <p>
            A day passes in a few minutes; the speed control at the top runs it at 1×, 2× or 6×. But
            half a <em>year</em> passes each of those days, which is the part that catches people
            out: children born while you are reading this will be old enough to work by tomorrow
            evening, and the farmer you got attached to on Monday has a name on the feed by Friday.
          </p>
          <p>
            A year is twenty-four days and four seasons. Winter is not decorative — it gets cold
            enough to kill people who have nowhere warm to be.
          </p>
        </section>

        <section>
          <h4>The people, and their opinions of each other</h4>
          <p>
            Everyone keeps their own hours. Tap somebody and you get their trade, their family, who
            they are friends with, and what they are actually thinking — the speech bubbles are not
            decoration, they name the building somebody is walking to and what they mean to do when
            they arrive. Two people standing together hold a real conversation, taking turns on one
            subject, about something they both have reason to raise.
          </p>
          <ul>
            <li><b>Friendship is remembered.</b> Once two people are friends they stay friends, even if they do not cross paths for a fortnight.</li>
            <li><b>Not everyone likes everyone.</b> About one pair in six simply does not get on, and — this is the interesting part — spending time together makes it <em>worse</em>. Watch two of them get stuck at the same market stall.</li>
            <li><b>Sometimes they swing for each other.</b> Two people who have fallen out, in the same place, one of them tired or hungry: it happens, it is in the feed, and everyone who saw it goes home in a mood.</li>
            <li><b>You can pick them up.</b> Drag anybody. Put them anywhere. Drop one in the river and they will swim for the bank, get out, and be cold and unimpressed about it.</li>
            <li><b>You can rename them</b> from their card, for {RENAME_CITIZEN_EMERGE.toLocaleString()} {TOKEN.ticker}. Name one after somebody and then watch what happens to them.</li>
          </ul>
        </section>

        <section>
          <h4>Where people come from</h4>
          <p>
            Two ways, and both of them are downstream of you. Families have children when they have
            a home, food and reason to be cheerful. And <b>settlers arrive on the road</b> — but only
            somewhere with a spare roof, food in the store, wages it can actually meet, and people
            who look content.
          </p>
          <p>
            That list is the entire growth loop. Build a house, keep the granary full, keep the
            treasury solvent, and strangers walk in from the edge of the map. Let any of it slip and
            they stop coming.
          </p>
        </section>

        <section>
          <h4>Work and the market</h4>
          <p>
            Nine trades turn the land into goods: farmers and woodcutters and miners take raw
            material, millers and bakers and carpenters and smiths and tailors turn it into
            something better. Each trade needs its building, and a building supports two workers
            (three down a mine). People change trade on their own when they are unhappy or their
            trade is overfull — and immediately when you raise a building nobody is working in.
          </p>
          <p>
            The market buys what the settlement cannot make and sells what it has too much of, at
            prices that move with real scarcity. The Market panel shows every price, its trend, and
            what actually moved yesterday.
          </p>
        </section>

        <section>
          <h4>Building</h4>
          <p>
            The Build panel places new buildings. Each costs Gold <em>and</em> materials — timber and
            stone out of the yard — so what you can raise depends on what the settlement has cut and
            quarried. Buildings placed off the road network get a lane cut through to them, and one
            placed across water will have a bridge started toward it.
          </p>
          <p>
            Anything except the market and a lived-in house can be <b>pulled down</b> from its card.
            You get half the timber and stone back. The Gold does not come back: it went on wages
            and haulage and those were spent.
          </p>
        </section>

        <section>
          <h4>Gatherings</h4>
          <p>
            Every evening at seven the settlement holds one gathering, and each does something real:
          </p>
          <ul>
            <li><b>Town meeting</b> — the town resolves on what it most needs, and that resolution outranks what the settlement would otherwise build for three days.</li>
            <li><b>Art showcase</b> — somebody makes a piece, named and titled, kept in the settlement&rsquo;s body of work.</li>
            <li><b>Market day</b> — over the middle of the day, every fifth day: stock moves nearly twice as fast and the stalls take real Gold.</li>
            <li><b>Harvest feast</b> — when the larder can carry one. It eats real food and everybody goes home fed and warm.</li>
          </ul>
        </section>

        <section>
          <h4>Danger</h4>
          <p>
            Four things can go wrong, each out of the world&rsquo;s own state, and each with a defence
            you can build. One at a time, never in the first five days.
          </p>
          <ul>
            <li><b>Fire</b> — dry heat and hearths. Answered by wells and by having enough people about.</li>
            <li><b>Blight</b> — a growing season and fields. Answered by a granary and food put by.</li>
            <li><b>Wolves</b> — a cold night near woodland. Answered by fires burning and by numbers.</li>
            <li><b>Flood</b> — a storm on a river. Answered by building back from the bank.</li>
          </ul>
          <p>
            Readiness decides what a hazard <em>costs</em>, not whether it happens. At full readiness a
            fire is out the same day and the wolves turn back at the treeline. Readiness is measured
            against the size of the settlement, so a town that builds fast outgrows its wells until
            the next one goes in. The bars are in the rail whether or not anything is wrong.
          </p>
        </section>

        <section className="earn">
          <h4>How you actually get paid</h4>
          <p>
            Read this bit twice. <b>The settlement&rsquo;s Gold is not your money.</b> Gold is what the
            town pays its people and buys its grain with. It does not convert into tokens, and it
            never will — an earlier version let it, and a settlement nobody was watching minted
            eighty million {TOKEN.ticker} in two months. That is a faucet, not a game, and it would
            have buried the token.
          </p>
          <p>There are two doors, and they are different sizes:</p>
          <ul>
            <li>
              <b>Principal.</b> {EMERGE_PER_GOLD.toLocaleString()} {TOKEN.ticker} buys 1 Gold for the
              treasury, and the same Gold can be taken back out, minus a {Math.round(WITHDRAW_BURN_RATE * 100)}%
              burn. That is your own money; moving it mints nothing.
            </li>
            <li>
              <b>Stewardship yield.</b> The only new {TOKEN.ticker}. Up to {steward.cap.toLocaleString()} a
              day, multiplied by two things.
            </li>
          </ul>
          <p>The two multipliers are the whole game:</p>
          <ul>
            <li>
              <b>How the place is run</b> — everyone housed, everyone fed, everyone employed, people
              content, and no hazard the settlement was unready for. Weighted and then squared, so
              running a place <em>well</em> is worth much more than running it.
            </li>
            <li>
              <b>Your attention</b> — this decays from full to eight per cent over three days in which
              you do nothing. Building, pulling down, moving somebody, funding the treasury and
              renaming all count.
            </li>
          </ul>
          <p>
            So: a world you leave running earns a trickle. A world you actually run earns about ten
            times as much. Collect it in the Bank panel whenever you like.
          </p>
          <p>
            <b>You are being paid for judgement, not for uptime.</b> Nobody gets rich here by opening
            a tab and going to lunch.
          </p>
        </section>

        <section>
          <h4>Land</h4>
          <p>
            The land office is a chart of islands, and there are six charts to sail between. Each
            holds fifteen to seventeen plots and no more: when a chart is fully surveyed, prospecting
            there is refused and you have to go elsewhere. Surveying costs
            {' '}{PROSPECT_COST_EMERGE.toLocaleString()} {TOKEN.ticker} and turns up a brand-new seed, so no
            two prospected plots are the same land.
          </p>
          <p>
            A claim is a purchase and it is yours. Leaving a world does not release it — your plots
            are marked on the chart and you can walk back into any of them. Giving one up is a
            separate, deliberate action.
          </p>
        </section>

        <section>
          <h4>The chain</h4>
          <p>
            Emerge is hybrid by design. The living world runs off-chain so it is always responsive;
            {' '}{ACTIVE_CHAIN.label} carries ownership and value. This build reaches the network and your
            wallet can switch to it. What does not exist yet is the {TOKEN.ticker} contract and the
            land registry — so balances, claims and listings are recorded in this browser, every
            panel says so, and you are never shown a transaction that did not happen.
          </p>
        </section>
      </div>
    </Shell>
  );
}

/**
 * Player chat.
 *
 * A channel that follows the player between worlds and one attached to the
 * world they are in. The panel is honest about its reach: there is no relay in
 * this build, so what is typed here stays in this browser, and saying so is
 * better than a room that looks populated and is not.
 */
function ChatPanel({ view, claimed, onClose }: { view: Snapshot; claimed: ClaimedWorld; onClose: () => void }) {
  const [state, setState] = useState<ChatState | null>(null);
  const [kind, setKind] = useState<ChannelKind>('world');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const { wallet } = useWallet();
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setState(loadChat()); }, []);

  const channel = kind === 'global' ? 'global' : worldChannel(claimed.seed);
  const messages = state ? channelOf(state, channel) : [];

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, kind]);

  if (!state) return null;

  const post = () => {
    const result = send(state, channel, draft, wallet.address);
    setNotice(result.refused);
    if (!result.refused) { setState(result.state); setDraft(''); }
  };

  const who = wallet.address ? shortAddress(wallet.address) : state.handle;

  return (
    <Shell
      title="Chat"
      subtitle={`Posting as ${who}${wallet.address ? '' : ' — connect a wallet to post under your address'}.`}
      onClose={onClose}
      wide
    >
      <div className="chat-tabs">
        <button className={kind === 'world' ? 'on' : ''} onClick={() => setKind('world')}>
          {view.name}
          <em>{state ? channelOf(state, worldChannel(claimed.seed)).length : 0}</em>
        </button>
        <button className={kind === 'global' ? 'on' : ''} onClick={() => setKind('global')}>
          Global
          <em>{state ? channelOf(state, 'global').length : 0}</em>
        </button>
        {!wallet.address && (
          <button className="ghost handle" onClick={() => setNaming((n) => !n)}>Change name</button>
        )}
      </div>

      {naming && !wallet.address && (
        <div className="rename-row">
          <input
            defaultValue={state.handle}
            maxLength={18}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              setState(setHandle(state, (e.target as HTMLInputElement).value));
              setNaming(false);
            }}
          />
          <span className="muted small">Press enter</span>
        </div>
      )}

      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted small">
            {kind === 'global'
              ? 'Nothing on the global channel yet.'
              : `Nothing said about ${view.name} yet.`}
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-row ${m.wallet ? 'wallet' : ''}`}>
            <b>{m.wallet ? shortAddress(m.author) : m.author}</b>
            <span>{m.text}</span>
            <em>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</em>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="chat-compose">
        <input
          value={draft}
          maxLength={MESSAGE_LIMIT}
          placeholder={kind === 'global' ? 'Say something to everyone' : `Say something about ${view.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') post(); }}
        />
        <button onClick={post} disabled={!draft.trim()}>Send</button>
      </div>
      {notice && <p className="warn">{notice}</p>}

      {!chatConnected() && (
        <p className="muted small">
          There is no chat relay in this build, so what you post is kept in this browser and nobody
          else can see it yet. The channels, your identity, the history and the limits are all real —
          only the wire between players is missing, and it is a single function
          ({'`'}deliver{'`'} in {'`'}lib/chat.ts{'`'}) away from being connected.
        </p>
      )}
    </Shell>
  );
}

function BankPanel({ view, player, onClose, onVault }: {
  view: Snapshot; player: PlayerRecord; onClose: () => void;
  onVault: (ledger: VaultLedger, goldDelta: number, note: string) => void;
}) {
  const [depositAmount, setDepositAmount] = useState('100000');
  const [withdrawAmount, setWithdrawAmount] = useState('50');
  const [claimAmount, setClaimAmount] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const ledger = player.ledger;
  const steward = view.stewardship;

  const depositGold = Math.floor((Number(depositAmount) || 0) / EMERGE_PER_GOLD * 100) / 100;
  const quote = quoteWithdraw(Math.floor(Number(withdrawAmount) || 0));

  const doDeposit = () => {
    const result = deposit(ledger, Number(depositAmount) || 0);
    setMessage(result.message);
    if (result.ok) onVault(result.ledger, depositGold, `${depositGold} Gold arrived from the ${TOKEN.ticker} vault.`);
  };

  const netYesterday = view.earnedYesterday - view.spentYesterday;

  const doWithdraw = () => {
    const result = withdraw(ledger, Math.floor(Number(withdrawAmount) || 0), view.treasury);
    setMessage(result.message);
    if (result.ok) onVault(result.ledger, -quote.gold, `${quote.gold} Gold of principal was withdrawn to ${TOKEN.ticker}.`);
  };

  const doClaim = () => {
    const amount = Math.floor(Number(claimAmount) || 0) || Math.floor(ledger.earnedEmerge);
    const result = claimEarnings(ledger, amount);
    setMessage(result.message);
    // Collecting earnings does not touch the treasury: the settlement's Gold is
    // the settlement's, and what the player earned is for their work.
    if (result.ok) onVault(result.ledger, 0, `${amount.toLocaleString()} ${TOKEN.ticker} of earnings was collected.`);
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

      <h4>The day's books</h4>
      <p className="muted small">
        Every Gold in or out of the treasury is booked under a heading, and the headings add up to
        the change in the balance above. Yesterday closed {netYesterday >= 0 ? 'up' : 'down'}
        {' '}{Math.abs(Math.round(netYesterday)).toLocaleString()} Gold.
      </p>
      <div className="books">
        <div className="books-col earning">
          <div className="books-head">
            <span>EARNED</span>
            <b>+{Math.round(view.earnedYesterday).toLocaleString()}</b>
          </div>
          {view.incomeLines.length ? view.incomeLines.map((line) => (
            <div key={line.key} className="books-line">
              <span>{line.label}</span><b>{Math.round(line.amount).toLocaleString()}</b>
            </div>
          )) : <div className="books-line empty"><span>Nothing came in</span></div>}
          <div className="books-line today"><span>So far today</span><b>+{Math.round(view.earnedToday).toLocaleString()}</b></div>
        </div>
        <div className="books-col spending">
          <div className="books-head">
            <span>SPENT</span>
            <b>−{Math.round(view.spentYesterday).toLocaleString()}</b>
          </div>
          {view.outgoingLines.length ? view.outgoingLines.map((line) => (
            <div key={line.key} className="books-line">
              <span>{line.label}</span><b>{Math.round(line.amount).toLocaleString()}</b>
            </div>
          )) : <div className="books-line empty"><span>Nothing went out</span></div>}
          <div className="books-line today"><span>So far today</span><b>−{Math.round(view.spentToday).toLocaleString()}</b></div>
        </div>
      </div>

      <h4>What you are earning</h4>
      <p className="muted small">
        Gold is the settlement&rsquo;s money and stays in the settlement. The {TOKEN.ticker} you earn is minted
        against how well you run the place: a daily ceiling of {steward.cap.toLocaleString()}, multiplied by how
        the settlement is doing and by how recently you did anything about it. A world nobody touches earns a
        fraction of one that is being run.
      </p>
      <div className="steward-grid">
        <div>
          <span>HOW IT IS RUN</span>
          <b>{Math.round(steward.score * 100)}%</b>
          <em>Housed, fed, employed, content and safe</em>
        </div>
        <div className={steward.attention < 0.5 ? 'fading' : ''}>
          <span>YOUR ATTENTION</span>
          <b>{Math.round(steward.attention * 100)}%</b>
          <em>
            {steward.idleDays === 0
              ? 'Acted on today'
              : `Nothing done for ${steward.idleDays} ${steward.idleDays === 1 ? 'day' : 'days'}`}
          </em>
        </div>
        <div>
          <span>EARNING PER DAY</span>
          <b>{steward.dailyYield.toLocaleString()}</b>
          <em>{TOKEN.ticker}, of {steward.cap.toLocaleString()} possible</em>
        </div>
        <div>
          <span>EARNED HERE</span>
          <b>{Math.floor(ledger.lifetimeEarned).toLocaleString()}</b>
          <em>{Math.floor(ledger.earnedEmerge).toLocaleString()} uncollected</em>
        </div>
      </div>

      <div className="vault-card claim-card">
        <span className="eyebrow">COLLECT EARNINGS</span>
        <label className="name-field">
          <span>{TOKEN.ticker} TO COLLECT</span>
          <input
            value={claimAmount}
            inputMode="numeric"
            placeholder={String(Math.floor(ledger.earnedEmerge))}
            onChange={(e) => setClaimAmount(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
        <div className="vault-line"><span>Available</span><b>{Math.floor(ledger.earnedEmerge).toLocaleString()} {TOKEN.ticker}</b></div>
        <div className="vault-line burn"><span>Burn</span><b>{Math.round(WITHDRAW_BURN_RATE * 100)}%</b></div>
        <button onClick={doClaim} disabled={ledger.earnedEmerge < 1}>Collect</button>
      </div>

      <h4>{TOKEN.ticker} vault</h4>
      <p className="muted small">
        {EMERGE_PER_GOLD.toLocaleString()} {TOKEN.ticker} buys 1 Gold, so 1,000,000 {TOKEN.ticker} is 100 Gold.
        Deposits fund the treasury, and the same Gold can be taken back out — that is your own money and moving
        it mints nothing. Withdrawals burn {Math.round(WITHDRAW_BURN_RATE * 100)}%. The settlement&rsquo;s own
        surplus is not withdrawable: it is what the town pays its people with.
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
          <div className="vault-line"><span>Principal standing</span><b>{Math.floor(ledger.principalGold).toLocaleString()} Gold</b></div>
          <button
            onClick={doWithdraw}
            disabled={quote.gold < 1 || quote.gold > Math.floor(view.treasury) || quote.gold > Math.floor(ledger.principalGold)}
          >
            Withdraw
          </button>
        </div>
      </div>

      {message && <p className="warn">{message}</p>}
      <div className="vault-ledger">
        <span>Deposited {ledger.depositedGold.toLocaleString()} Gold</span>
        <span>Earned {Math.floor(ledger.lifetimeEarned).toLocaleString()} {TOKEN.ticker}</span>
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
  const stock = (key: 'wood' | 'stone') => view.resources.find((r) => r.key === key)?.amount ?? 0;
  const wood = stock('wood');
  const stone = stock('stone');
  return (
    <Shell
      title="Build"
      subtitle="Gold and materials both. A building takes timber and stone out of the yard, so what the settlement can raise depends on what it has cut and quarried."
      onClose={onClose}
      wide
    >
      <div className="build-stores">
        <span>IN THE YARD</span>
        <b>{Math.floor(wood)} wood</b>
        <b>{Math.floor(stone)} stone</b>
      </div>
      <div className="build-grid">
        {BUILDABLE.map((option) => {
          const need = buildMaterials(option.type);
          const paid = view.treasury >= option.cost;
          const stocked = wood >= need.wood && stone >= need.stone;
          const ready = paid && stocked;
          return (
            <div key={option.type} className={`build-card ${ready ? '' : 'locked'}`}>
              <div className="build-icon">{option.icon}</div>
              <h3>{option.type}</h3>
              <p>{option.blurb}</p>
              <div className="build-cost">
                <b>{option.cost} Gold</b>
                <small>{maintenanceCost(option.type)}/day upkeep</small>
              </div>
              <div className="build-materials">
                <span className={wood >= need.wood ? '' : 'short'}>{need.wood} wood</span>
                <span className={stone >= need.stone ? '' : 'short'}>{need.stone} stone</span>
              </div>
              <button disabled={!ready} onClick={() => onBuild(option.type, option.cost)}>
                {ready ? 'Place' : !paid ? 'Not enough Gold' : 'Not enough materials'}
              </button>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function ConnectPanel({ view, claimed, player, onClose, onRenameWorld, onLeave, onRelease, onList }: {
  view: Snapshot; claimed: ClaimedWorld; player: PlayerRecord; onClose: () => void;
  onRenameWorld: (name: string) => void; onLeave: () => void; onRelease: () => void;
  onList: (price: number | null) => void;
}) {
  const [releasing, setReleasing] = useState(false);
  const [draftName, setDraftName] = useState(view.name);
  const [askPrice, setAskPrice] = useState(String(Math.round(claimed.price * 1.25)));
  const configured = tokenLive();
  const affordable = player.ledger.balance >= RENAME_COST_EMERGE;
  const changed = draftName.trim().length > 0 && draftName.trim() !== view.name;
  const listing = player.listings.find((l) => l.seed === claimed.seed);

  return (
    <Shell
      title="On-Chain"
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
          {/* Leaving is not selling. It used to be: stepping out of a world
              deleted the claim, so a player who wanted a look at the map had to
              buy their own land back. */}
          <button className="ghost" onClick={onLeave}>Back to the land office</button>
          <button className="danger" onClick={() => {
            if (releasing) onRelease();
            else setReleasing(true);
          }}>
            {releasing ? 'Give it up for good — tap again' : 'Give up this plot'}
          </button>
          {releasing && (
            <p className="muted small">
              {claimed.region} goes back on the market and the {claimed.price.toLocaleString()} {TOKEN.ticker}
              {' '}is not refunded. Your world keeps running until you do.
            </p>
          )}
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

export function Panels({ panel, view, claimed, player, onClose, onBuild, onRenameWorld, onLeave, onRelease, onVault, onList }: PanelsProps) {
  if (panel === 'market') return <MarketPanel view={view} onClose={onClose} />;
  if (panel === 'bank') return <BankPanel view={view} player={player} onClose={onClose} onVault={onVault} />;
  if (panel === 'guide') return <GuidePanel view={view} onClose={onClose} />;
  if (panel === 'chat') return <ChatPanel view={view} claimed={claimed} onClose={onClose} />;
  if (panel === 'build') return <BuildPanel view={view} onClose={onClose} onBuild={onBuild} />;
  if (panel === 'connect') {
    return (
      <ConnectPanel
        view={view} claimed={claimed} player={player} onClose={onClose}
        onRenameWorld={onRenameWorld} onLeave={onLeave} onRelease={onRelease} onList={onList}
      />
    );
  }
  return null;
}
