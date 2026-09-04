'use client';

/**
 * Overlay panels: the market, the bank, construction and the $EMERGE layer.
 *
 * These open over the world rather than replacing it — the settlement keeps
 * running behind them, which is the whole point of the thing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClaimedWorld, PlayerRecord } from '@/lib/world/plots';
import {
  BUILDING_CATEGORIES, BUILDING_CATEGORY, BUILDING_ERA, BUILD_COSTS, CLEAR_TREE_GOLD, CLEAR_TREE_WOOD, WAGE_MAX, WAGE_MIN, WAGE_STANDARD, buildMaterials, maintenanceCost,
  wageEffort, worldMarketState, type BuildingCategory, TRAIN_HOLD_DAYS } from '@/lib/simulation';
import { eraName } from '@/lib/world/eras';
import type { Snapshot } from '@/lib/hud';
import {
  ACTIVE_CHAIN, TOKEN, VAULT_ADDRESS, shortAddress, tokenActions, tokenLive,
} from '@/lib/chain/emerge';
import {
  ADVANCE_COST_EMERGE, DAILY_EARN_CEILING, EARNING_PLOT_LIMIT, EMERGE_PER_GOLD, EXPAND_COST_EMERGE, HAND_DAILY_CEILING, HAND_MIN_EMERGE, HAND_SHARE, PROSPECT_COST_EMERGE, RENAME_CITIZEN_EMERGE,
  RENAME_COST_EMERGE, RENAME_PLAYER_EMERGE, WITHDRAW_BURN_RATE,
  claimEarnings, creditPendingDeposits, deposit, liveToken, quoteWithdraw, withdraw,
  type VaultLedger,
} from '@/lib/chain/vault';
import { Sparkline } from './Sparkline';
import {
  MESSAGE_LIMIT, POLL_INTERVAL, channelOf, loadChat, poll, send, worldChannel,
  type ChannelKind, type ChatState,
} from '@/lib/chat';
import { DIG_COST_EMERGE, odds, type Prize } from '@/lib/chain/gacha';
import { fetchNames } from '@/lib/net/names';
import { answerOffer, fetchClaims, quitJob, setHiring, type Claim, type Offer } from '@/lib/net/registry';
import { fetchPayouts, type PayoutHistory } from '@/lib/net/payouts';
import { onChainClaimsLive } from '@/lib/chain/registry';
import { MAX_GIFT_GOLD } from '@/lib/limits';
import { spend } from '@/lib/chain/spend';
import { WalletPicker, useWallet } from './WalletPicker';
import { t, tn, tx, useLocale } from '@/lib/i18n';
import { GuideZh } from './GuideZh';

export type PanelKey = 'market' | 'bank' | 'build' | 'people' | 'guide' | 'chat' | 'gacha' | 'gift' | 'connect' | 'arena' | null;

interface PanelsProps {
  panel: PanelKey;
  view: Snapshot;
  claimed: ClaimedWorld;
  player: PlayerRecord;
  onClose: () => void;
  onBuild: (type: string, cost: number) => void;
  /** Retrain one person into a trade, for Gold. Returns a refusal, or null. */
  onTrain: (id: string, job: string) => string | null;
  /** Fill open posts in a trade by retraining the people who can best be spared. Returns a refusal, or null. */
  onTrainTrade: (job: string, count: number) => string | null;
  /** Arm the clearing cursor. */
  onClearTrees: () => void;
  onRenameWorld: (name: string) => void;
  /** Open the plot's outer belt, once, for $EMERGE. Resolves to a refusal, or null. */
  onExpand: () => Promise<string | null>;
  /** Advance the plot to the next era, for $EMERGE. Resolves to a refusal, or null. */
  onAdvance: () => Promise<string | null>;
  onRenameCitizen: (id: string, name: string) => void;
  onLeave: () => void;
  /** Give the plot up entirely, as opposed to stepping out of it. */
  onRelease: () => void;
  /** Move Gold in or out of the treasury and record it against the player. */
  onVault: (ledger: VaultLedger, goldDelta: number, note: string) => void;
  /** What the settlement pays its people, as a multiple of the going rate. */
  onWages: (rate: number) => void;
  /** List this plot for resale at a price, or pass null to withdraw it. */
  onList: (price: number | null) => void;
  /** Record a change to the player themselves — their name, their name tokens. */
  onPlayer: (record: PlayerRecord) => void;
  /**
   * Spend on one dig. Returns what the party found, or a sentence explaining
   * why they did not go.
   */
  onDig: () => Promise<{ prize: Prize; story: string } | string>;
  /** Travel to somebody else's settlement. Resolves to a refusal, or null. */
  onVisit: (seed: number) => Promise<string | null>;
  /** True when this is somebody else's world, being looked at. */
  spectating: boolean;
  /** Whose world it is, when spectating. */
  visit?: { worldName: string; ownerName: string; owner: string } | null;
  /** Burn $EMERGE to put Gold in this settlement's treasury. */
  onGift: (gold: number) => Promise<string | null>;
  /** Whether a chat message raises a card when the panel is closed. */
  chatNotices: boolean;
  onToggleNotices: () => void;
}

/** Clock strings per message id. A message's time never changes, so neither does this. */
const TIMES = new Map<string, string>();
function timeOf(id: string, at: number): string {
  const held = TIMES.get(id);
  if (held) return held;
  const text = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (TIMES.size > 2000) TIMES.clear();
  TIMES.set(id, text);
  return text;
}

/** Buildable structures. Cost and upkeep are read from the simulation so they never drift. */
const BUILDABLE: { type: string; cost: number; blurb: string; icon: string }[] = [
  { type: 'House', cost: BUILD_COSTS['House'], icon: '⌂', blurb: 'Homes for a growing settlement.' },
  { type: 'Farm', cost: BUILD_COSTS['Farm'], icon: '✣', blurb: 'Wheat and vegetables from the fields.' },
  { type: 'Woodcutter', cost: BUILD_COSTS['Woodcutter'], icon: '♣', blurb: 'Timber from the surrounding forest.' },
  { type: 'Fishery', cost: BUILD_COSTS['Fishery'], icon: '≋', blurb: 'Fish from the shore, so build it by the water. Bait costs Gold, and a snapped rod costs timber.' },
  { type: 'Lodge', cost: BUILD_COSTS['Lodge'], icon: '➶', blurb: 'Hunters stalk the wild ground for game and hides. Arrows cost timber.' },
  { type: 'Forager', cost: BUILD_COSTS['Forager'], icon: '❀', blurb: 'Berries and herbs gathered from the wild ground.' },
  { type: 'Quarry', cost: BUILD_COSTS['Quarry'], icon: '◇', blurb: 'Cut stone from the highland.' },
  { type: 'Mine', cost: BUILD_COSTS['Mine'], icon: '◆', blurb: 'Iron ore from deep in the ridge.' },
  { type: 'Mill', cost: BUILD_COSTS['Mill'], icon: '◫', blurb: 'Turns wheat into flour.' },
  { type: 'Bakery', cost: BUILD_COSTS['Bakery'], icon: '◈', blurb: 'Turns flour into bread.' },
  { type: 'Carpenter', cost: BUILD_COSTS['Carpenter'], icon: '▣', blurb: 'Turns wood into furniture.' },
  { type: 'Blacksmith', cost: BUILD_COSTS['Blacksmith'], icon: '⚒', blurb: 'Turns ore into tools.' },
  { type: 'Tailor', cost: BUILD_COSTS['Tailor'], icon: '✦', blurb: 'Turns wool into clothing.' },
  { type: 'Storage', cost: BUILD_COSTS['Storage'], icon: '▤', blurb: 'Somewhere to keep the surplus.' },
  { type: 'Tavern', cost: BUILD_COSTS['Tavern'], icon: '♨', blurb: 'Where the settlement gathers.' },
  { type: 'Cafe', cost: BUILD_COSTS['Cafe'], icon: '☕', blurb: 'Tables on the terrace. People come out of themselves here.' },
  { type: 'School', cost: BUILD_COSTS['School'], icon: '◬', blurb: 'Everyone learns their trade faster, children most of all.' },
  { type: 'Library', cost: BUILD_COSTS['Library'], icon: '▥', blurb: 'Quiet and purpose. A little learning for everybody.' },
  { type: 'Studio', cost: BUILD_COSTS['Studio'], icon: '✎', blurb: 'Somewhere to make things. Purpose, and showcases.' },
  { type: 'Lab', cost: BUILD_COSTS['Lab'], icon: '⚗', blurb: 'Better methods for every trade, and warning of trouble.' },
  { type: 'Clinic', cost: BUILD_COSTS['Clinic'], icon: '✚', blurb: 'People survive what would have killed them.' },
  { type: 'Jail', cost: BUILD_COSTS['Jail'], icon: '▦', blurb: 'Somewhere to hold anyone who turns on the settlement. Fewer do, with one standing.' },
  { type: 'Bank', cost: BUILD_COSTS['Bank'], icon: '◈', blurb: 'A counting house for the treasury.' },
  // The township.
  { type: 'Chapel', cost: BUILD_COSTS['Chapel'], icon: '⛪', blurb: 'Somewhere to be quiet together. Company and purpose for everybody, a little each day.' },
  { type: 'Guildhall', cost: BUILD_COSTS['Guildhall'], icon: '⚒', blurb: 'The trades organised. Everybody learns their craft faster.' },
  { type: 'Brewery', cost: BUILD_COSTS['Brewery'], icon: '🍺', blurb: 'An evening with everybody in it. Company, more than the tavern gives.' },
  { type: 'Printer', cost: BUILD_COSTS['Printer'], icon: '▤', blurb: 'Something to read. Purpose for everybody, and trades learned a little faster.' },
  { type: 'Stables', cost: BUILD_COSTS['Stables'], icon: '🐎', blurb: 'Carts and horses. Everybody moves faster along the roads.' },
  { type: 'Harbour', cost: BUILD_COSTS['Harbour'], icon: '⚓', blurb: 'A ferry across the water. Every shore counts as reached, bridge or no bridge. Build it on the bank.' },
  // The industrial era.
  { type: 'Factory', cost: BUILD_COSTS['Factory'], icon: '🏭', blurb: 'Machines for every trade. Everything the town makes, it makes more of.' },
  { type: 'Foundry', cost: BUILD_COSTS['Foundry'], icon: '🔥', blurb: 'Iron poured rather than hammered. More from every trade, on top of the factory.' },
  { type: 'Railway Station', cost: BUILD_COSTS['Railway Station'], icon: '🚂', blurb: 'Rail on the roads. Everybody working rides it, faster than any cart.' },
  { type: 'Telegraph', cost: BUILD_COSTS['Telegraph'], icon: '📡', blurb: 'News from everywhere. Company and purpose for everybody, and trades learned a little faster.' },
  { type: 'Gasworks', cost: BUILD_COSTS['Gasworks'], icon: '🕯', blurb: 'Gas for the lamps and the stoves. Clears the smog that an industrial town lives under without it.' },
  // The modern era.
  { type: 'Hospital', cost: BUILD_COSTS['Hospital'], icon: '🏥', blurb: 'A clinic with wards. Takes most of the risk out of a bad week, and out of a plague.' },
  { type: 'Stadium', cost: BUILD_COSTS['Stadium'], icon: '🏟', blurb: 'A crowd every evening. Company for everybody, more than anything else gives.' },
  { type: 'Supermarket', cost: BUILD_COSTS['Supermarket'], icon: '🛒', blurb: 'Everything under one roof. Nobody goes to bed hungry.' },
  { type: 'Office', cost: BUILD_COSTS['Office'], icon: '🏢', blurb: 'Work that means something. Purpose for everybody, every day.' },
  { type: 'Bus Depot', cost: BUILD_COSTS['Bus Depot'], icon: '🚗', blurb: 'Cars and bikes on the roads. Everybody working moves faster than the rails.' },
  { type: 'Power Plant', cost: BUILD_COSTS['Power Plant'], icon: '⚡', blurb: 'Electricity for every workshop. More from every trade.' },
  // The AI era.
  { type: 'Data Centre', cost: BUILD_COSTS['Data Centre'], icon: '🗄', blurb: 'The town thinks faster. Trades are learned far quicker.' },
  { type: 'Research Campus', cost: BUILD_COSTS['Research Campus'], icon: '🔬', blurb: 'Better methods for everything, and everybody learns. The best of the lab and the school.' },
  { type: 'Vertical Farm', cost: BUILD_COSTS['Vertical Farm'], icon: '🌱', blurb: 'Food grown in tiers, all year. Nobody is ever hungry.' },
  { type: 'Pod Hub', cost: BUILD_COSTS['Pod Hub'], icon: '🛸', blurb: 'Autonomous pods on the roads. Everybody working rides them, fastest of all.' },
  { type: 'Drone Port', cost: BUILD_COSTS['Drone Port'], icon: '🚁', blurb: 'Things brought to the door. Company and purpose for everybody.' },
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
          <button className="panel-close" onClick={onClose} aria-label={t('Close')}>×</button>
        </header>
        <div className="overlay-body">{children}</div>
      </section>
    </div>
  );
}

function MarketPanel({ view, onClose }: { view: Snapshot; onClose: () => void }) {
  useLocale();
  const [focus, setFocus] = useState(view.market[0]?.key ?? 'wheat');
  const row = view.market.find((m) => m.key === focus) ?? view.market[0];
  const store = (key: string) => Math.floor(view.resources.find((r) => r.key === key)?.amount ?? 0);
  // Where the prices come from. The panel has always been called the world
  // market; now it is one, and it should say so rather than leaving a player to
  // guess whether the number is theirs or everybody's.
  const world = worldMarketState();

  return (
    <Shell
      title={t('World Market')}
      subtitle={world.live
        ? t('One market across every settlement. Prices are the same everywhere; what your town buys and sells is its own.')
        : t('Households buy food, producers consume inputs, and the market moves to close the gaps.')}
      onClose={onClose}
      wide
    >
      <p className={`market-source ${world.live ? 'live' : ''}`}>
        {world.live ? (
          <>
            <b>{world.traders === 1 ? t('Trading with one settlement.') : t('Trading with {n} settlements.', { n: world.traders })}</b>{' '}
            {t('Every price below is what the same good costs in every other world right now. Your stores decide whether you are buying or selling at it.')}
          </>
        ) : (
          <>
            <b>{t('Pricing your own stores.')}</b> {t('The world market is out of reach, so this settlement is quoting what it can see — the way it did before there were others to trade with.')}
          </>
        )}
      </p>
      {row && (
        <div className="market-focus">
          <div>
            <span className="eyebrow">{t('FOCUS')}</span>
            <h3>{tn(row.label)}</h3>
            <strong>{row.quote.price.toFixed(2)} <small>{t('GOLD / UNIT')}</small></strong>
          </div>
          {/* A chart of one point is an empty box the height of a chart, which
              is what a brand-new world shows on its first day. Say so instead
              until there is a second day to draw a line between. */}
          <div className="market-chart">
            {row.quote.history.length > 1 ? (
              <>
                <span className="eyebrow">
                  {t('LAST {n} DAYS', { n: row.quote.history.length })}
                </span>
                <Sparkline values={row.quote.history} width={260} height={54} />
              </>
            ) : (
              <>
                <span className="eyebrow">{t('PRICE HISTORY')}</span>
                <p className="muted small no-history">{t('Nothing to plot yet — come back tomorrow.')}</p>
              </>
            )}
          </div>
          <div className="market-figures">
            <div><span>{t('IN STORE')}</span><b>{store(row.key)}</b></div>
            <div><span>{t('MADE / DAY')}</span><b>{Math.round(view.production[row.key] ?? 0)}</b></div>
            <div><span>{t('USED / DAY')}</span><b>{Math.round(view.consumption[row.key] ?? 0)}</b></div>
            <div>
              <span>{t('TREND')}</span>
              <b className={row.quote.trend >= 0 ? 'up' : 'down'}>
                {row.quote.trend >= 0 ? '+' : ''}{row.quote.trend.toFixed(3)}
              </b>
            </div>
          </div>
        </div>
      )}

      <div className="market-rows">
        <div className="market-row head">
          <span>{t('RESOURCE')}</span><span>{t('PRICE')}</span><span>{t('30 DAYS')}</span><span>{t('PRESSURE')}</span><span>{t('IN STORE')}</span><span>{t('FLOW')}</span>
        </div>
        {view.market.map((m) => {
          const pressure = m.quote.demand - m.quote.supply;
          const flow = Math.round((view.production[m.key] ?? 0) - (view.consumption[m.key] ?? 0));
          return (
            // Six columns do not fit a phone, so each cell carries its own
            // label and the row reflows into two lines rather than being
            // squeezed into six unreadable slivers.
            <button key={m.key} className={`market-row ${focus === m.key ? 'focused' : ''}`} onClick={() => setFocus(m.key)}>
              <span className="cell name">{tn(m.label)}</span>
              <b className="cell price"><i>{t('price')}</i>{m.quote.price.toFixed(2)}</b>
              <span className="cell spark"><Sparkline values={m.quote.history} width={78} height={18} subtle /></span>
              <span className={`cell ${pressure > 0 ? 'buy' : 'sell'}`}>
                <i>{t('pressure')}</i>{pressure > 0 ? t('WANTED') : t('SURPLUS')} {Math.abs(Math.round(pressure))}
              </span>
              <span className="cell store"><i>{t('in store')}</i>{store(m.key)}</span>
              <span className={`cell ${flow >= 0 ? 'buy' : 'sell'}`}><i>{t('flow')}</i>{flow >= 0 ? '+' : ''}{flow}{t('/day')}</span>
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
  const locale = useLocale();
  if (locale === 'zh') return <GuideZh view={view} onClose={onClose} />;
  return (
    <Shell
      title="Game Guide"
      subtitle="What everything here does, and how to earn from it."
      onClose={onClose}
      wide
    >
      <div className="guide">
        {/* The long-form version of all of this, for reading rather than for
            glancing at mid-game. Opened in its own tab on purpose: leaving the
            page would tear down a running settlement. */}
        <a className="guide-wiki" href="/wiki" target="_blank" rel="noreferrer">
          <b>The full guide &rarr;</b>
          <span>
            Every price, the yield worked through, how the world market is priced, and what is
            settled on chain. Opens in a new tab.
          </span>
        </a>
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
            <li>Connect a wallet first. Your plots, your balance and your name belong to an address, not to this browser.</li>
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
            A day passes in a few minutes; the speed control at the top runs it at 1× or 2×. But
            half a <em>year</em> passes in each of those days, which is the part that catches
            people out: children born while you are reading this will be old enough to work by
            tomorrow evening, and the farmer you grew attached to on Monday is a line in the feed
            by Friday.
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
            Twelve trades turn the land into goods: farmers, woodcutters, miners, fishers,
            hunters and foragers take raw material, millers and bakers and carpenters and smiths
            and tailors turn it into something better. Each trade needs its building, and a
            building supports two workers (three down a mine). People change trade on their own
            when they are unhappy or their trade is overfull — and immediately when you raise a
            building nobody is working in.
          </p>
          <p>
            Three of them work out of doors, where you can watch. Fishers stand on the bank with
            a rod: bait costs the treasury a little Gold every day, and a rod that snaps costs
            timber from the yard. Hunters go into the wild ground after the animals that live
            there — deer and boar under the trees, goats on the shelf, gazelle on the dunes — and
            carry the kill home; arrows cost timber, and a herd hunted faster than it recovers
            leaves them coming back empty-handed. Foragers pick berries and herbs. Fish, game and
            berries are eaten like bread; hides and herbs sell dear at the market.
          </p>
          <p>
            The market buys what the settlement cannot make and sells what it has too much of, at
            prices that move with real scarcity. The Market panel shows every price, its trend, and
            what actually moved yesterday.
          </p>
        </section>

        <section>
          <h4>Wages</h4>
          <p>
            The Bank sets what the settlement pays, from half the going rate to
            {' '}{Math.round(WAGE_MAX * 100)}% of it. It is a dial with a cost at both ends.
            <b> Underpaying is not thrift.</b> People do less, lose heart, and the town produces
            and sells less — over a long run it ends up with fewer people <em>and</em> less Gold
            than paying properly would have. <b>Overpaying does not pay for itself either</b>: the
            wage bill rises far faster than the work does. What it buys is a contented, growing
            settlement, and it is paid for out of the treasury.
          </p>
        </section>

        <section>
          <h4>The plot helper</h4>
          <p>
            The side panel&rsquo;s <b>Plot Helper</b> reads the settlement every few seconds and
            says what to build next, and why: who is sleeping rough, what is piling up in store with
            no trade to turn it into something, which need is lowest in town, what the busiest
            workshop would give if it were improved. It is the same list the Build panel opens
            with. Follow it and the place fills up — a well-run plot with a spare roof draws
            settlers on the road, and a cafe, a school, a clinic and improved houses draw more.
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
            <b>Clearing the wood.</b> The Build panel also carries a tool: tap the ground with it and
            every tree within reach comes down, for {CLEAR_TREE_GOLD} Gold a tree, with {CLEAR_TREE_WOOD} timber
            each going to the yard. The wood grows back over the following days, so clear where you mean
            to build.
          </p>
          <p>
            <b>The settlement builds for itself too.</b> With the treasury holding a comfortable
            surplus — twice a building&rsquo;s price, and a fortnight of wages and upkeep besides —
            it raises what it needs without being asked: a roof for the homeless first, then a
            farm or a woodcutter when the stores are thin, then whatever the plot helper would
            have told you next. The feed says what it built and why.
          </p>
          <p>
            Beyond the trades there are the places a town is built around. A <b>Cafe</b> gets
            people out among each other; a <b>School</b> and a <b>Library</b> make everyone
            better at their trade sooner; a <b>Studio</b> gives them somewhere to make things and
            a reason to; a <b>Lab</b> lifts every trade&rsquo;s output and sees trouble coming; a{' '}
            <b>Clinic</b> is the difference between a hard winter and a funeral. None of them
            employs anybody, and all of them cost upkeep.
          </p>
          <p>
            A building&rsquo;s card also offers <b>Move</b> and <b>Improve</b>. Moving arms the
            placing cursor and puts it down wherever you tap, for a third of what it cost to raise.
            Improving takes it up a level — three at most — for Gold and materials, and each level
            gets about a fifth more work out of it for half again in daily upkeep. It does not hold
            more people; an improved building nobody works in is only a bigger bill.
          </p>
          <p>
            Anything can be <b>pulled down</b> from its card except the market, the bank and the town
            hall — those hold the settlement together — and any house somebody still lives in,
            which has to be emptied first. You get half the timber and stone back. The Gold does
            not: it went on wages and haulage, and those were spent.
          </p>
        </section>

        <section>
          <h4>Gatherings</h4>
          <p>
            Every evening at seven the settlement holds one gathering, and each does something real:
          </p>
          <ul>
            <li><b>Town meetup</b> — the town resolves on what it most needs, and that resolution outranks what the settlement would otherwise build for three days.</li>
            <li><b>Art showcase</b> — somebody makes a piece, named and titled, kept in the settlement&rsquo;s body of work.</li>
            <li><b>Market day</b> — over the middle of the day, every fifth day: stock moves nearly twice as fast and the stalls take real Gold.</li>
            <li><b>Harvest feast</b> — when the larder can carry one. It eats real food and everybody goes home fed and warm.</li>
          </ul>
        </section>

        <section>
          <h4>Danger</h4>
          <p>
            Seven things can go wrong, each out of the world&rsquo;s own state, and each with a defence
            you can build. One at a time, never in the first five days.
          </p>
          <ul>
            <li><b>Fire</b> — dry heat and hearths. Answered by wells and by having enough people about.</li>
            <li><b>Blight</b> — a growing season and fields. Answered by a granary and food put by.</li>
            <li><b>Wolves</b> — a cold night near woodland. Answered by fires burning and by numbers.</li>
            <li><b>Flood</b> — a storm on a river. The water rises for days and takes the buildings on the bank. Answered by building back from it.</li>
            <li><b>Earthquake</b> — hard ground, a shelf or a plateau. The ground shakes for hours, walls crack, some come down, and aftershocks follow. Answered by stone in the yard and a lab.</li>
            <li><b>Tornado</b> — a storm over open country. A funnel crosses the map and wrecks what it passes over. Answered by a storehouse, sturdy improved buildings and a lab.</li>
            <li><b>Plague</b> — a big settlement in a cold season. It passes between people standing together, and it kills. Answered by a clinic and herbs in store.</li>
          </ul>
          <p>
            While a disaster runs, a red bar sits under the clock with the one thing you can do:
            <b> spend Gold against it</b>, once — bucket chains, sandbags, storm crews, a
            quarantine. It does exactly what it says. Buildings the disaster wrecks are <b>ruins</b>
            until you rebuild them from the building card, for Gold and about half the materials.
            The carpenters patch lesser damage on their own.
          </p>
          <p>
            <b>People turn, too.</b> Somebody miserable, purposeless or nursing a grudge can turn on
            the settlement and set about wrecking it, torch in hand. You cannot lift them away or
            step in: the others go after them, there is a scuffle, and they are thrown in the jail
            — or killed, if they have already brought two buildings down. A Jail halves how often
            it happens and gives the settlement somewhere to hold them.
          </p>
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
              <b>Stewardship yield.</b> The only new {TOKEN.ticker}. Up to {steward.cap.toLocaleString()} per
              <em>real</em> day — not per settlement day — multiplied by two things.
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
              <b>Your attention</b> — full if you have done something in the last hour, sliding to
              eight per cent over a day and a half of nothing. Building, pulling down, moving
              somebody, funding the treasury and renaming all count.
            </li>
          </ul>
          <p>
            <b>The speed control does not pay.</b> Yield is paced by the wall clock rather than by the
            settlement&rsquo;s calendar, so 2× shows you more of your world in the same hour and pays
            exactly the same for it. There was a 6× once, and it is gone: what you are paid for is
            attending to the place, and a button that skips a year of it skips the game.
          </p>
          <p>
            So: a world you have not touched for two days earns about 1,700 {TOKEN.ticker} a day. One
            you are actually running earns around 21,000. Collect it in the Bank panel whenever you
            like.
          </p>
          <p>
            <b>Four plots pay.</b> You may own as many as you can afford, but only the four you
            claimed first earn {TOKEN.ticker} — so the most anyone can make is four well-run
            settlements, {DAILY_EARN_CEILING.toLocaleString()} a real day, and no more. The rest are
            yours to build in for the pleasure of it. Give one of the four up and the next in line
            starts earning.
          </p>
          <p>
            <b>You are being paid for judgement, not for uptime.</b> Nobody gets rich here by opening
            a tab and going to lunch.
          </p>
        </section>

        <section className="earn">
          <h4>Nothing is taken — everything is burned</h4>
          <p>
            The game takes no cut of anything. There is no fee address, no treasury the developers
            draw from, and no tax on what you earn. Every {TOKEN.ticker} the game charges you — a
            claim, a survey, a rename, a pull on the prospectors — is destroyed. It leaves your
            balance and it leaves the supply, permanently.
          </p>
          <p>
            The only money the project makes is the trading fee on the coin itself, which has
            nothing to do with anything you do in here. That means every action you take in the game
            shrinks the supply rather than feeding somebody, and the burn counter in the Bank is a
            real running total of what has gone.
          </p>
        </section>

        <section>
          <h4>Sending out a party</h4>
          <p>
            Under <b>Prospect</b> you can hire a party for a day for
            {' '}{DIG_COST_EMERGE.toLocaleString()} {TOKEN.ticker} — burned, like everything else. They
            always come back with something: Gold for the treasury, timber, stone, ore or wheat for
            the yard, naming rights, or, rarely, people looking for work.
          </p>
          <p>
            The odds are printed on the panel as real percentages, computed from the same table the
            draw rolls against, so what you are shown cannot drift away from what actually happens.
            There is no blank on the table — the worst result still pays. It is a way to convert
            tokens into a settlement, not a slot machine, and people are the one thing on it you
            cannot buy any other way.
          </p>
        </section>

        <section>
          <h4>Your world is saved</h4>
          <p>
            Everything the settlement is — the people, what they have built, who they are friends
            with, the treasury, the date — is written down as you play and restored when you come
            back. Close the tab mid-winter and you return to that winter.
          </p>
          <p>
            The settlement itself is kept in this browser, so clearing your site data loses it and
            it does not follow you to another device. What <em>does</em> travel is your holdings —
            which plots are yours, and your balance — because those belong to your wallet address
            and are held in the registry. The snapshot other players visit is a copy sent out while
            you play; it is not a backup, and it is not read back into your own game. Giving a plot
            up erases its settlement for good.
          </p>
        </section>

        <section>
          <h4>Land</h4>
          <p>
            The world map is a chart of islands, and there are twelve charts to sail between —
            room for about two hundred plots in all, and the map says how many are claimed and how
            many are left. Each chart holds seventeen plots and no more: when a chart is fully
            surveyed, prospecting there is refused and you have to go elsewhere. Surveying costs
            {' '}{PROSPECT_COST_EMERGE.toLocaleString()} {TOKEN.ticker} and turns up a brand-new seed, so no
            two prospected plots are the same land.
          </p>
          <p>
            <b>Land you find belongs on everybody&rsquo;s map.</b> A plot you survey appears for every
            other player as well — the registry hands out the berths, so two people prospecting the
            same chart can never be given the same one. You paid to find it; anyone may claim it,
            and the first to do so gets it.
          </p>
          <p>
            A claim is a purchase and it is yours. The price is charged in {TOKEN.ticker} and burned;
            nobody receives it.{onChainClaimsLive() ? ' What you get back is a token in your wallet whose id is the plot\u2019s seed, so the land is yours on chain and readable by anybody.' : ''}
            {' '}Leaving a world does not release it — your plots are marked on the chart and you can
            walk back into any of them. Giving one up is a separate, deliberate action
            {onChainClaimsLive() ? ' that burns the token and puts the seed back on the market.' : '.'}
          </p>
          <p>
            <b>Selling is between players.</b> Put a plot up for sale from the On-Chain panel and it
            shows on everybody&rsquo;s map with its price. A buyer pays <em>your wallet</em> directly
            in {TOKEN.ticker} — a transfer, not a burn — and the registry moves the plot to them
            once the chain has settled it. The settlement goes with the land: they walk into your
            town as you left it. Anybody can also <b>make an offer</b> on a plot, listed or not;
            the owner accepts or declines it from the On-Chain panel, and an accepted offer holds
            the plot for that bidder at that price for two days. Nothing is escrowed: the bidder
            pays when they take it.
          </p>
        </section>

        <section>
          <h4>Other people&rsquo;s worlds</h4>
          <p>
            The world map shows every plot anybody has claimed, not only yours. Land somebody else
            has settled is marked as theirs, and you cannot claim it — the registry keeps one owner
            per plot and refuses the second person to ask, so nothing you pay for can be taken out
            from under you.
          </p>
          <p>
            You can go and look. Tap a settled marker and <b>visit</b>, or tap somebody&rsquo;s name
            in chat to travel straight to the world they built. What you see is their settlement as
            they last left it — their people, their buildings, their weather — restored from a
            snapshot they publish while they play, not a fresh world grown from the same seed. The
            bar at the top says whose it is and how recent it is.
          </p>
          <p>
            A visit is a visit. You can watch, follow anybody around and read the feed; you cannot
            build, pull anything down, pick anyone up or earn a single {TOKEN.ticker} there. You
            cannot see their treasury either — how much Gold a settlement is holding is its
            owner&rsquo;s business. When somebody is looking at <em>your</em> world an eye appears by
            your purse with a count of them; you are never in your own count.
          </p>
          <p>
            <b>You can give.</b> The one thing a visitor may do is put Gold into the settlement
            they are standing in, at the same {EMERGE_PER_GOLD.toLocaleString()} {TOKEN.ticker} a
            Gold your own deposits cost. The tokens are burned like every other cost in the game
            and the Gold is waiting in their treasury when they next open the world. You cannot
            gift to yourself — that is what the Bank is for, and it is priced the same.
          </p>
          <p>
            You will also hear about it when somebody says something and you are not looking at
            chat, when anybody anywhere claims a plot, and when a gift lands in your treasury.
            They arrive as a small card in the corner that goes away on its own. The chat ones can
            be switched off from the Chat panel if a busy channel gets in the way; claims and gifts
            are rare enough to stay.
          </p>
        </section>

        <section>
          <h4>Talking to other players</h4>
          <p>
            <b>Chat</b> has two channels: the world you are standing in, so a conversation about
            Fernrest is read by the people looking at Fernrest, and a global one that follows you
            everywhere. Connect a wallet and you post under your address; otherwise you post under
            your name.
          </p>
          <p>
            You arrive with a name picked for you and <b>your first change is free</b> — nobody
            should be charged to correct a name they did not choose. Changing it again costs
            {' '}{RENAME_PLAYER_EMERGE.toLocaleString()} {TOKEN.ticker}, burned like the rest.
          </p>
          <p>
            Whoever owns the world a channel belongs to has their name marked in gold with a star,
            so you can tell a suggestion from the person who built the place from a suggestion from
            somebody passing through. Any name with an arrow beside it is a door: tap it and you
            travel to the world they built.
          </p>
        </section>

        <section>
          <h4>The chain</h4>
          <p>
            <b>A wallet is not optional.</b> Your plots, your balance, your name and everything you
            earn belong to an address rather than to this browser, so the map does not open until
            one is connected. Connect the same wallet on another device and your holdings are
            there.
          </p>
          <p>
            Emerge is hybrid by design. The living world runs off-chain so it is always responsive;
            {' '}{ACTIVE_CHAIN.label} carries ownership and value.
          </p>
          {onChainClaimsLive() ? (
            <>
              <p>
                <b>A plot is a token in your wallet.</b> Not a row in our database — an ERC-721
                whose id is the plot&rsquo;s own seed, the same number that grows the land. Anyone
                can read who owns what straight off the chain without asking this game anything,
                and nobody, us included, can move a plot out of the wallet holding it.
              </p>
              <p>
                Claiming asks for two signatures: one approving exactly what the plot costs — never
                an open-ended allowance — and one to claim it. The contract takes the payment,
                burns it, and mints the title in the same transaction, so there is no moment where
                you have paid and do not own the land. The price you see is read from the contract
                and passed back into it as a ceiling, so it cannot change between the two.
              </p>
              <p>
                <b>Money in, money out.</b> Everything the game charges goes to the burn address and
                is gone. A deposit is the exception: that is your own money, held in the vault so
                the withdrawal door has something to give back — and it goes back automatically.
                Press withdraw and the vault signs a transfer to your wallet there and then; the
                Bank hands you the transaction so you can check it on an explorer. Nobody approves
                it and nobody can decide not to.
              </p>
              <p>
                What you can take back out is what the chain says you put in. Deposits are read off
                the chain rather than taken on trust, so your principal is the same number on every
                device you connect this wallet to, and no one can withdraw more than they deposited.
                Stewardship is capped instead: up to
                {' '}{DAILY_EARN_CEILING.toLocaleString()} {TOKEN.ticker} a day per wallet, paid only
                to wallets that hold land. The {Math.round(WITHDRAW_BURN_RATE * 100)}% taken off
                either kind stays in the vault to be burned.
              </p>
            </>
          ) : (
            <p>
              This build reaches the network and your wallet can switch to it. What does not exist
              yet is the {TOKEN.ticker} contract and the land registry — so balances and claims are
              recorded in this browser, every panel says so, and you are never shown a transaction
              that did not happen.
            </p>
          )}
        </section>
      </div>
    </Shell>
  );
}

/**
 * Player chat.
 *
 * A channel that follows the player between worlds and one attached to the
 * world they are in. Messages go to the relay and come back from it every few
 * seconds; what is on screen is whatever the relay has, plus a local cache so
 * a reload does not wipe the conversation.
 */
function ChatPanel({ view, claimed, player, onClose, onPlayer, onVisit, chatNotices, onToggleNotices }: {
  view: Snapshot; claimed: ClaimedWorld; player: PlayerRecord;
  onClose: () => void; onPlayer: (record: PlayerRecord) => void;
  onVisit: (seed: number) => Promise<string | null>;
  /** Whether a message raises a card when the panel is closed. */
  chatNotices: boolean;
  onToggleNotices: () => void;
}) {
  const [state, setState] = useState<ChatState | null>(null);
  const [kind, setKind] = useState<ChannelKind>('world');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [reach, setReach] = useState<{ shared: boolean; offline: boolean }>({ shared: false, offline: false });
  const [travelling, setTravelling] = useState<number | null>(null);
  const { wallet } = useWallet();
  const endRef = useRef<HTMLDivElement | null>(null);
  useLocale();

  /*
   * Which of the people talking own somewhere you can go.
   *
   * Chat carries an address; the registry says what that address holds. Joining
   * the two here is what turns a name in a conversation into a door — you read
   * that somebody's mill finally got staffed, and you can go and look at it.
   */
  const [worldsBy, setWorldsBy] = useState<Map<string, Claim>>(new Map());
  /*
   * What each wallet is called.
   *
   * Chat carries a proven address and nothing else — deliberately, because a
   * name in a message body is a name that can be aimed at somebody. The name
   * is looked up here instead, from the relay's own record of what each
   * address calls itself, so a player who renames themselves is renamed in
   * every conversation at once rather than going on as an address forever.
   */
  const [namesBy, setNamesBy] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const [{ claims }, names] = await Promise.all([fetchClaims(), fetchNames()]);
      if (!live) return;
      setNamesBy(names);
      const byOwner = new Map<string, Claim>();
      for (const claim of claims) {
        const key = claim.owner.toLowerCase();
        // Somebody with several worlds is visited at the one they took first,
        // which is the one they have most likely been playing longest.
        const held = byOwner.get(key);
        if (!held || claim.at < held.at) byOwner.set(key, claim);
        if (claim.ownerName?.trim()) {
          const named = claim.ownerName.trim();
          const heldName = byOwner.get(named);
          if (!heldName || claim.at < heldName.at) byOwner.set(named, claim);
        }
      }
      setWorldsBy(byOwner);
    };
    tick();
    const timer = window.setInterval(tick, 20_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  const worldOf = (author: string) =>
    worldsBy.get(author.toLowerCase()) ?? worldsBy.get(author) ?? null;

  /**
   * What to call an address.
   *
   * The relay's record first, then the name on whatever land they hold, then
   * nothing — and a caller that gets nothing falls back to the address, which
   * is always true even when it is not friendly.
   */
  const nameFor = (address: string) => {
    const key = address.toLowerCase();
    return (namesBy[key] ?? worldsBy.get(key)?.ownerName ?? '').trim();
  };


  /*
   * Whoever holds the world this chat belongs to.
   *
   * Their name is marked, because in a room where anybody can talk about a
   * settlement it matters which one of them actually built it — a suggestion
   * from the owner reads differently from a suggestion from a passer-by.
   */
  const isHost = (author: string) => {
    const held = worldOf(author);
    return !!held && held.seed === claimed.seed;
  };

  const travelTo = async (claim: Claim) => {
    setTravelling(claim.seed);
    const refused = await onVisit(claim.seed);
    setTravelling(null);
    if (refused) setNotice(refused);
  };

  const channel = kind === 'global' ? 'global' : worldChannel(claimed.seed);

  useEffect(() => { setState(loadChat()); }, []);

  // Ask the relay for anything new, now and every few seconds. Re-runs when
  // the player switches channel so the other room fills straight away.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const current = loadChat();
      const result = await poll(current, channel);
      if (!live) return;
      setState(result.state);
      setReach({ shared: result.shared, offline: result.offline });
    };
    tick();
    const timer = window.setInterval(tick, POLL_INTERVAL);
    return () => { live = false; window.clearInterval(timer); };
  }, [channel]);

  // The parent re-renders this panel on every HUD tick, several times a
  // second. Everything below that depends only on the messages is memoised
  // against them, so a tick costs a comparison rather than a rebuild of the
  // whole log.
  const messages = useMemo(() => (state ? channelOf(state, channel) : []), [state, channel]);

  /**
   * Names worn by more than one address in what is on screen.
   *
   * Anybody may call themselves anything, so two people can be "Gatsu" at
   * once — and around a token that is not a curiosity, it is how somebody gets
   * talked into sending money to the wrong wallet. Rather than forbid it,
   * every message under a contested name carries its address as well, so the
   * two are visibly different people.
   */
  const contested = useMemo(() => {
    const byName = new Map<string, Set<string>>();
    for (const m of messages) {
      if (!m.wallet) continue;
      const label = (nameFor(m.author) || shortAddress(m.author)).toLowerCase();
      const holders = byName.get(label) ?? new Set<string>();
      holders.add(m.author.toLowerCase());
      byName.set(label, holders);
    }
    return new Set([...byName].filter(([, holders]) => holders.size > 1).map(([label]) => label));
    // `nameFor` reads both maps, so the set is rebuilt when either changes.
  }, [messages, namesBy, worldsBy]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, kind]);

  /*
   * The rendered log.
   *
   * Formatting a timestamp goes through the locale machinery, and doing it a
   * hundred and twenty times on every tick of the world clock was most of what
   * the chat cost to have open. The rows are built once per change to what is
   * in them, and the time strings are kept per message for good.
   */
  const rows = useMemo(() => messages.map((m) => {
    const theirs = worldOf(m.author);
    const self = m.author === player.name
      || (!!wallet.address && m.author.toLowerCase() === wallet.address.toLowerCase());
    // Your own name is read from your own record, so a rename shows in
    // the conversation the instant you make it rather than after the
    // relay's next round trip.
    const label = m.wallet
      ? (self ? player.name : nameFor(m.author)) || shortAddress(m.author)
      : m.author;
    // The address is the identity; the name is what somebody chose to
    // call themselves. Where two people are wearing the same name, the
    // address goes back on screen for both, because in a room where land
    // changes hands a name on its own is not something to trust.
    const clashes = m.wallet && contested.has(label.toLowerCase());
    const host = isHost(m.author);
    const shown = clashes ? `${label} · ${shortAddress(m.author)}` : label;
    const who = m.wallet ? m.author : label;
    return (
      <div key={m.id} className={`chat-row ${m.wallet ? 'wallet' : ''} ${host ? 'host' : ''} ${m.spectator ? 'spectator' : ''}`}>
        {theirs && !self ? (
          <button
            className={`chat-who ${host ? 'host' : ''}`}
            title={host ? t('{who} owns {world} · {address}', { who: shown, world: view.name, address: who }) : t('Visit {world} · {address}', { world: theirs.worldName, address: who })}
            disabled={travelling !== null}
            onClick={() => travelTo(theirs)}
          >
            {shown}
            <i>{travelling === theirs.seed ? '…' : host ? '★' : '↗'}</i>
          </button>
        ) : (
          <b className={host ? 'host' : ''} title={m.spectator ? t('Watching without a wallet') : who}>
            {shown}{host && <i className="host-star">★</i>}
            {m.spectator && <i className="spectator-tag">{t('spectator')}</i>}
          </b>
        )}
        <span>{m.text}</span>
        <em>{timeOf(m.id, m.at)}</em>
      </div>
    );
    // The helpers read `namesBy` and `worldsBy`; the rows are rebuilt when
    // either changes, or when who is travelling or what you are called does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [messages, namesBy, worldsBy, contested, player.name, wallet.address, travelling, claimed.seed, view.name]);

  if (!state) return null;

  const post = async () => {
    const result = await send(state, channel, draft, wallet.address, player.name);
    setNotice(result.refused);
    if (!result.refused) { setState(result.state); setDraft(''); }
  };

  const rename = (next: string) => {
    const trimmed = next.trim().slice(0, 18);
    if (!trimmed || trimmed === player.name) { setNaming(false); return; }
    // The first change is free. Nobody should be charged to correct the random
    // name they were handed on arrival.
    if (player.nameChanges === 0) {
      onPlayer({ ...player, name: trimmed, nameChanges: 1 });
      setNaming(false);
      return;
    }
    void (async () => {
      const paid = await spend(player.ledger, RENAME_PLAYER_EMERGE, wallet.address);
      if (!paid.ok) {
        setNotice(paid.refused
          ?? t('Changing your name again costs {cost} {ticker}.', { cost: RENAME_PLAYER_EMERGE.toLocaleString(), ticker: TOKEN.ticker }));
        return;
      }
      onPlayer({
        ...player, name: trimmed, nameChanges: player.nameChanges + 1, ledger: paid.ledger,
      });
      setNaming(false);
    })();
  };

  /*
   * Who you are posting as.
   *
   * Your name, not your address. This line said "Posting as 0x1111…1111" for
   * anybody with a wallet connected, which is both unfriendly and — for a
   * player who had just paid to change their name — plainly wrong. The address
   * is still what the badge proves and is still one hover away.
   */
  const who = player.name;

  return (
    <Shell
      title={t('Chat')}
      subtitle={wallet.address
        ? t('Posting as {who}, under {address}.', { who, address: shortAddress(wallet.address) })
        : t('Posting as {who}, as a spectator — connect a wallet to post under your address.', { who })}
      onClose={onClose}
      wide
    >
      <div className="chat-tabs">
        <button className={kind === 'world' ? 'on' : ''} onClick={() => setKind('world')}>
          {view.name}
          <em>{channelOf(state, worldChannel(claimed.seed)).length}</em>
        </button>
        <button className={kind === 'global' ? 'on' : ''} onClick={() => setKind('global')}>
          {t('Global')}
          <em>{channelOf(state, 'global').length}</em>
        </button>
        <button
          className={`ghost bell ${chatNotices ? 'on' : ''}`}
          onClick={onToggleNotices}
          title={chatNotices
            ? t('Messages raise a card when this panel is closed')
            : t('Messages arrive quietly')}
        >
          {chatNotices ? t('🔔 Alerts on') : t('🔕 Alerts off')}
        </button>
        <button className="ghost handle" onClick={() => setNaming((n) => !n)}>
          {player.nameChanges === 0 ? t('Change name · free') : t('Change name')}
        </button>
      </div>

      {naming && (
        <div className="rename-row">
          <input
            defaultValue={player.name}
            maxLength={18}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') rename((e.target as HTMLInputElement).value); }}
          />
          <span className="muted small">
            {player.nameChanges === 0
              ? t('Your first change is free. Press enter.')
              : t('{cost} {ticker}, burned. Press enter.', { cost: RENAME_PLAYER_EMERGE.toLocaleString(), ticker: TOKEN.ticker })}
          </span>
        </div>
      )}

      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted small">
            {kind === 'global'
              ? t('Nothing on the global channel yet. Say hello.')
              : t('Nothing said about {world} yet.', { world: view.name })}
          </p>
        )}
        {rows}
        <div ref={endRef} />
      </div>

      <div className="chat-compose">
        <input
          value={draft}
          maxLength={MESSAGE_LIMIT}
          placeholder={kind === 'global' ? t('Say something to everyone') : t('Say something about {world}', { world: view.name })}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') post(); }}
        />
        <button onClick={post} disabled={!draft.trim()}>{t('Send')}</button>
      </div>
      {notice && <p className="warn">{tx(notice)}</p>}

      {/* What the relay can actually reach, said plainly either way. */}
      {reach.offline ? (
        <p className="muted small">
          {t('The relay is not answering. Your messages are being kept here and nobody else can see them until it comes back.')}
        </p>
      ) : !reach.shared ? (
        <p className="muted small">
          {t('This build has no shared relay behind it yet, so what you say reaches players on the same server and no further. Said plainly rather than left for you to discover.')}
        </p>
      ) : null}
    </Shell>
  );
}

/**
 * The dig.
 *
 * $EMERGE in, burned; a prospecting party out; something the settlement can
 * use back. The odds are computed from the same table the draw uses, so the
 * percentages on screen cannot drift away from the ones being rolled.
 */
function GachaPanel({ player, onClose, onDig }: {
  player: PlayerRecord; onClose: () => void;
  onDig: () => Promise<{ prize: Prize; story: string } | string>;
}) {
  const [last, setLast] = useState<{ prize: Prize; story: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useLocale();
  const table = odds();
  const affordable = player.ledger.balance >= DIG_COST_EMERGE;

  const [digging, setDigging] = useState(false);
  const pull = async () => {
    // With a token deployed this asks the player to sign, so the button has to
    // say something while the wallet is open rather than looking dead.
    setDigging(true);
    const result = await onDig();
    setDigging(false);
    if (typeof result === 'string') { setNotice(result); return; }
    setNotice(null);
    setLast(result);
  };

  return (
    <Shell
      title={t('Send out a party')}
      subtitle={t('Hire prospectors for a day. They always come back with something.')}
      onClose={onClose}
      wide
    >
      <div className="dig">
        <button className="dig-button" onClick={pull} disabled={digging || !affordable}>
          <span>{digging ? t('SENDING…') : affordable ? t('SEND THEM OUT') : t('NOT ENOUGH {ticker}', { ticker: TOKEN.ticker })}</span>
          <b>{DIG_COST_EMERGE.toLocaleString()} {TOKEN.ticker}</b>
          <i>{t('burned, not collected')}</i>
        </button>

        {last && (
          <div className={`dig-result ${last.prize.kind}`}>
            <span className="eyebrow">{t('THEY CAME BACK WITH')}</span>
            <b>{tx(last.prize.label)}</b>
            <p>{tx(last.story)}</p>
          </div>
        )}
        {!last && (
          <div className="dig-result waiting">
            <span className="eyebrow">{t('NOTHING SENT YET')}</span>
            <p>
              {t('Every party comes back with something — the worst outcome on the table is still worth more than a wasted afternoon.')}
            </p>
          </div>
        )}
      </div>

      {notice && <p className="warn">{tx(notice)}</p>}

      <h4>{t('What they might find')}</h4>
      <div className="odds">
        {table.map((prize) => (
          <div key={prize.id} className={`odds-row ${prize.kind}`}>
            <span>{tx(prize.label)}</span>
            <div className="odds-bar"><i style={{ width: `${Math.max(3, prize.percent * 3)}%` }} /></div>
            <b>{prize.percent.toFixed(1)}%</b>
          </div>
        ))}
      </div>
      <p className="muted small">
        {t('These are the real weights: the panel computes them from the same table the draw rolls against, so they cannot drift apart. Naming rights let you rename one citizen without paying the usual fee, and you hold {n} of them.', { n: player.nameTokens })}
      </p>
    </Shell>
  );
}

/**
 * Sending Gold to somebody else's settlement.
 *
 * A visitor cannot build here, cannot pull anything down and cannot take a
 * penny out — but they can put something in. The $EMERGE is burned out of the
 * sender's balance exactly like every other cost in the game, and Gold appears
 * in the owner's treasury when their world next opens. It is the one way one
 * player's tokens turn into another player's settlement.
 */
function GiftPanel({ player, visit, onClose, onGift }: {
  player: PlayerRecord;
  visit: { worldName: string; ownerName: string; owner: string };
  onClose: () => void;
  onGift: (gold: number) => Promise<string | null>;
}) {
  const [amount, setAmount] = useState('100');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  const gold = Math.floor(Number(amount) || 0);
  const cost = gold * EMERGE_PER_GOLD;
  const affordable = player.ledger.balance >= cost;
  const who = visit.ownerName?.trim() ? visit.ownerName : shortAddress(visit.owner);
  useLocale();

  const send = async () => {
    if (!(gold > 0)) { setNotice(t('Enter an amount to send.')); return; }
    if (gold > MAX_GIFT_GOLD) {
      setNotice(t('A single gift carries at most {max} Gold.', { max: MAX_GIFT_GOLD.toLocaleString() }));
      return;
    }
    if (!affordable) {
      setNotice(t('That is {cost} {ticker}, and you hold {held}.', { cost: cost.toLocaleString(), ticker: TOKEN.ticker, held: Math.floor(player.ledger.balance).toLocaleString() }));
      return;
    }
    setSending(true);
    const refused = await onGift(gold);
    setSending(false);
    if (refused) { setNotice(refused); return; }
    setNotice(null);
    setSent(gold);
  };

  return (
    <Shell
      title={t('Send Gold to {world}', { world: visit.worldName })}
      subtitle={t('{who} built this place. You cannot change it — but you can help pay for it.', { who })}
      onClose={onClose}
    >
      <div className="vault-card">
        <span className="eyebrow">{t('HOW MUCH')}</span>
        <div className="vault-row">
          <input
            value={amount}
            inputMode="numeric"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
          />
          <span className="muted">{t('Gold')}</span>
        </div>
        <p className="muted small">
          {gold > 0
            ? t('{cost} {ticker}, burned out of your balance. {who} finds {gold} Gold in their treasury when they next open {world}.', { cost: cost.toLocaleString(), ticker: TOKEN.ticker, who, gold: gold.toLocaleString(), world: visit.worldName })
            : t('{rate} {ticker} per Gold, the same rate as your own deposits.', { rate: EMERGE_PER_GOLD.toLocaleString(), ticker: TOKEN.ticker })}
        </p>
        <button className="claim-button" onClick={send} disabled={sending || !affordable || !(gold > 0)}>
          {sending
            ? t('Sending…')
            : !(gold > 0)
              ? t('Enter an amount')
              : !affordable
                ? t('Not enough {ticker}', { ticker: TOKEN.ticker })
                : t('Send {gold} Gold', { gold: gold.toLocaleString() })}
        </button>
        {sent !== null && (
          <p className="muted small">
            {t('Sent. {gold} Gold is waiting for {who}, and {burned} {ticker} has left the supply for good.', { gold: sent.toLocaleString(), who, burned: (sent * EMERGE_PER_GOLD).toLocaleString(), ticker: TOKEN.ticker })}
          </p>
        )}
        {notice && <p className="warn">{tx(notice)}</p>}
      </div>

      <p className="muted small">
        {t('At most {max} Gold at a time. Gifts cannot be sent to a world you own — putting your own tokens into your own treasury is what the Bank is for, and it is priced the same either way.', { max: MAX_GIFT_GOLD.toLocaleString() })}
      </p>
    </Shell>
  );
}

/**
 * What the settlement pays its people.
 *
 * A slider rather than a number box, because the interesting thing about this
 * decision is that it is a dial with a cost at both ends, and a slider says
 * that where a field does not. Every figure under it is the real consequence
 * worked out from the same functions the simulation runs, so a player can see
 * what they are buying before they buy it.
 */
function WageControl({ view, onWages }: { view: Snapshot; onWages: (rate: number) => void }) {
  const rate = view.wageRate;
  const effort = wageEffort(rate);
  const bill = Math.round(view.payroll);
  const pct = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <div className="wages">
      <div className="wage-head">
        <b>{pct(rate)}</b>
        <span className="muted small">{t('of the going rate · {bill} Gold a day', { bill: bill.toLocaleString() })}</span>
      </div>
      <input
        className="wage-slider"
        type="range"
        min={WAGE_MIN * 100}
        max={WAGE_MAX * 100}
        step={5}
        value={Math.round(rate * 100)}
        onChange={(e) => onWages(Number(e.target.value) / 100)}
        aria-label={t('Wages, as a share of the going rate')}
      />
      <div className="wage-scale">
        <span>{pct(WAGE_MIN)}</span>
        <span>{pct(WAGE_STANDARD)}</span>
        <span>{pct(WAGE_MAX)}</span>
      </div>
      <div className="wage-effect">
        <div>
          <span>{t('WORK DONE')}</span>
          <b className={effort >= 1 ? 'up' : 'down'}>{pct(effort)}</b>
        </div>
        <div>
          <span>{t('MOOD')}</span>
          <b className={rate >= WAGE_STANDARD ? 'up' : 'down'}>
            {rate === WAGE_STANDARD ? t('steady') : rate > WAGE_STANDARD ? t('lifting') : t('sinking')}
          </b>
        </div>
      </div>
      <p className="muted small">
        {rate < WAGE_STANDARD
          ? t('Paying under the rate does not even leave you richer. People do less and lose heart, the settlement produces and sells less, and a hundred and fifty days of it ends with a smaller town and an emptier treasury than paying properly would have.')
          : rate > WAGE_STANDARD
            ? t('Paying over the rate does not pay for itself: a wage bill rises far faster than the work does. What it buys is a contented, growing settlement, and it is paid for in Gold that does not all come home.')
            : t('The going rate. People work as expected and their sense of purpose holds steady.')}
      </p>
    </div>
  );
}

function BankPanel({ view, claimed, player, earning, onClose, onVault, onWages }: {
  view: Snapshot; claimed: ClaimedWorld; player: PlayerRecord; earning: boolean;
  onClose: () => void;
  onVault: (ledger: VaultLedger, goldDelta: number, note: string) => void;
  onWages: (rate: number) => void;
}) {
  const [depositAmount, setDepositAmount] = useState('100000');
  const [withdrawAmount, setWithdrawAmount] = useState('50');
  const [claimAmount, setClaimAmount] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<'deposit' | 'withdraw' | 'collect' | null>(null);
  const [history, setHistory] = useState<PayoutHistory | null>(null);
  const { wallet } = useWallet();
  const ledger = player.ledger;
  const steward = view.stewardship;
  useLocale();

  /** Who is asking, so a queued payout can be attributed and paid. */
  const who = {
    address: wallet.address,
    name: player.name,
    seed: claimed.seed,
    worldName: claimed.name,
  };

  /*
   * What the server says, which for money is the only thing that counts.
   *
   * The principal figure here is the one withdrawals are actually checked
   * against — it is built from deposits the server verified on chain, so it can
   * differ from this browser's own record (a deposit made on another device, or
   * one whose credit is still catching up). Showing the server's number means
   * the Withdraw button and the ledger agree about what is possible.
   */
  const refreshHistory = useCallback(async () => {
    if (!liveToken() || !wallet.address) { setHistory(null); return; }
    setHistory(await fetchPayouts(wallet.address));
  }, [wallet.address]);

  useEffect(() => {
    if (!liveToken() || !wallet.address) { setHistory(null); return; }
    let live = true;
    // Finish crediting anything a previous session could not, then read back.
    creditPendingDeposits(wallet.address)
      .then(() => fetchPayouts(wallet.address!))
      .then((rows) => { if (live) setHistory(rows); });
    return () => { live = false; };
  }, [wallet.address]);

  /** Principal the vault will actually honour, in Gold. */
  const standingGold = history
    ? Math.floor(history.principal / EMERGE_PER_GOLD)
    : Math.floor(ledger.principalGold);

  const depositGold = Math.floor((Number(depositAmount) || 0) / EMERGE_PER_GOLD * 100) / 100;
  const quote = quoteWithdraw(Math.floor(Number(withdrawAmount) || 0));

  const doDeposit = async () => {
    setBusy('deposit');
    const result = await deposit(ledger, Number(depositAmount) || 0, who);
    setBusy(null);
    setMessage(result.message);
    if (!result.ok) return;
    onVault(result.ledger, depositGold, t('{gold} Gold arrived from the {ticker} vault.', { gold: depositGold, ticker: TOKEN.ticker }));
    void refreshHistory();
  };

  const netYesterday = view.earnedYesterday - view.spentYesterday;

  const doWithdraw = async () => {
    setBusy('withdraw');
    const result = await withdraw(ledger, Math.floor(Number(withdrawAmount) || 0), view.treasury, who);
    setBusy(null);
    setMessage(result.message);
    if (!result.ok) return;
    onVault(result.ledger, -quote.gold, t('{gold} Gold of principal was withdrawn to {ticker}.', { gold: quote.gold, ticker: TOKEN.ticker }));
    void refreshHistory();
  };

  const doClaim = async () => {
    const amount = Math.floor(Number(claimAmount) || 0) || Math.floor(ledger.earnedEmerge);
    setBusy('collect');
    const result = await claimEarnings(ledger, amount, who);
    setBusy(null);
    setMessage(result.message);
    if (!result.ok) return;
    // Collecting earnings does not touch the treasury: the settlement's Gold is
    // the settlement's, and what the player earned is for their work.
    onVault(result.ledger, 0, t('{amount} {ticker} of earnings was collected.', { amount: amount.toLocaleString(), ticker: TOKEN.ticker }));
    void refreshHistory();
  };

  return (
    <Shell title={t('Bank')} subtitle={t('Gold circulates between the treasury, workers, households and the market.')} onClose={onClose} wide>
      <div className="bank-balance">{Math.floor(view.treasury).toLocaleString()} <small>{t('GOLD')}</small></div>
      <div className="bank-grid">
        <div><span>{t('HOUSEHOLD WEALTH')}</span><b>{Math.floor(view.householdWealth).toLocaleString()}</b></div>
        <div><span>{t('WAGES PER DAY')}</span><b>{Math.floor(view.dailyWages).toLocaleString()}</b></div>
        <div><span>{t('FAMILIES')}</span><b>{view.familyCount}</b></div>
        <div><span>{t('BUILDINGS ON UPKEEP')}</span><b>{view.upkeep}</b></div>
      </div>

      <h4>{t('Wages')}</h4>
      <WageControl view={view} onWages={onWages} />

      <h4>{t('The day’s books')}</h4>
      <p className="muted small">
        {t('Every Gold in or out of the treasury is booked under a heading, and the headings add up to the change in the balance above.')}{' '}
        {netYesterday >= 0
          ? t('Yesterday closed up {gold} Gold.', { gold: Math.abs(Math.round(netYesterday)).toLocaleString() })
          : t('Yesterday closed down {gold} Gold.', { gold: Math.abs(Math.round(netYesterday)).toLocaleString() })}
      </p>
      <div className="books">
        <div className="books-col earning">
          <div className="books-head">
            <span>{t('EARNED YESTERDAY')}</span>
            <b>+{Math.round(view.earnedYesterday).toLocaleString()}</b>
          </div>
          {view.incomeLines.length ? view.incomeLines.map((line) => (
            <div key={line.key} className="books-line">
              <span>{tn(line.label)}</span><b>{Math.round(line.amount).toLocaleString()}</b>
            </div>
          )) : <div className="books-line empty"><span>{t('Nothing came in')}</span></div>}
          <div className="books-line today"><span>{t('So far today')}</span><b>+{Math.round(view.earnedToday).toLocaleString()}</b></div>
        </div>
        <div className="books-col spending">
          <div className="books-head">
            <span>{t('SPENT YESTERDAY')}</span>
            <b>−{Math.round(view.spentYesterday).toLocaleString()}</b>
          </div>
          {view.outgoingLines.length ? view.outgoingLines.map((line) => (
            <div key={line.key} className="books-line">
              <span>{tn(line.label)}</span><b>{Math.round(line.amount).toLocaleString()}</b>
            </div>
          )) : <div className="books-line empty"><span>{t('Nothing went out')}</span></div>}
          <div className="books-line today"><span>{t('So far today')}</span><b>−{Math.round(view.spentToday).toLocaleString()}</b></div>
        </div>
      </div>

      <h4>{t('What you are earning')}</h4>
      <p className="muted small">
        {t('Gold is the settlement’s money and stays in the settlement. The {ticker} you earn is minted against how well you run the place: a daily ceiling of {cap}, multiplied by how the settlement is doing and by how recently you did anything about it. A world nobody touches earns a fraction of one that is being run.', { ticker: TOKEN.ticker, cap: steward.cap.toLocaleString() })}
      </p>
      <div className="steward-grid">
        <div>
          <span>{t('HOW IT IS RUN')}</span>
          <b>{Math.round(steward.score * 100)}%</b>
          <em>{t('Housed, fed, employed, content and safe')}</em>
        </div>
        <div className={steward.attention < 0.5 ? 'fading' : ''}>
          <span>{t('YOUR ATTENTION')}</span>
          <b>{Math.round(steward.attention * 100)}%</b>
          <em>
            {steward.idleHours < 1
              ? t('Acted on just now')
              : steward.idleHours < 24
                ? t('Nothing done for {n}h', { n: Math.floor(steward.idleHours) })
                : t('Nothing done for {n} days', { n: Math.floor(steward.idleHours / 24) })}
          </em>
        </div>
        <div className={earning ? '' : 'fading'}>
          <span>{t('EARNING PER DAY')}</span>
          <b>{earning ? steward.dailyYield.toLocaleString() : t('nothing')}</b>
          <em>
            {earning
              ? t('{ticker} a real day, of {cap} possible', { ticker: TOKEN.ticker, cap: steward.cap.toLocaleString() })
              : t('beyond your first {n} plots', { n: EARNING_PLOT_LIMIT })}
          </em>
        </div>
        <div>
          <span>{t('EARNED HERE')}</span>
          <b>{Math.floor(ledger.lifetimeEarned).toLocaleString()}</b>
          <em>{t('{n} uncollected', { n: Math.floor(ledger.earnedEmerge).toLocaleString() })}</em>
        </div>
      </div>

      {!earning && (
        <p className="warn">
          {t('This world does not pay. Only the first {n} plots you claimed earn {ticker} — this one is yours to build in, and everything you do here still counts towards the settlement, just not towards your balance. Give up one of the four and the next in line starts earning.', { n: EARNING_PLOT_LIMIT, ticker: TOKEN.ticker })}
        </p>
      )}

      {liveToken() && (
        <p className="muted small vault-note">
          {t('Both directions are real transfers. A deposit is signed by you and lands in the vault at {vault}; a withdrawal is signed by the vault and lands in your wallet, straight away and without anybody approving it. Everything the game charges goes to the burn address instead and is gone. The {pct}% taken off a withdrawal is the one thing that stays put: it remains in the vault to be burned.', { vault: shortAddress(VAULT_ADDRESS), pct: Math.round(WITHDRAW_BURN_RATE * 100) })}
          {history && !history.automatic && (
            <> {t('This build has no vault key configured, so withdrawals are refused rather than paid — nothing here will pretend otherwise.')}</>
          )}
        </p>
      )}

      {liveToken() && history && (history.payouts.length > 0 || ledger.pendingEmerge > 0) && (
        <div className="payout-queue">
          <span className="eyebrow">{t('PAID OUT')}</span>
          {ledger.pendingEmerge > 0 && (
            <div className="vault-line">
              <span>{t('Requested before payouts were automatic')}</span>
              <b>{Math.floor(ledger.pendingEmerge).toLocaleString()} {TOKEN.ticker}</b>
            </div>
          )}
          {history.payouts.slice(0, 6).map((row) => (
            <div key={row.id} className="payout-row paid">
              <span>
                {row.kind === 'principal' ? t('{gold} Gold of principal', { gold: row.gold }) : t('Stewardship earnings')}
                {' · '}{new Date(row.at).toLocaleDateString()}
              </span>
              <b>{row.net.toLocaleString()} {TOKEN.ticker}</b>
              {/* The transaction, so a player can check the claim rather than
                  take our word for it. */}
              {ACTIVE_CHAIN.explorerUrl ? (
                <a
                  href={`${ACTIVE_CHAIN.explorerUrl.replace(/\/$/, '')}/tx/${row.txHash}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >{t('sent')}</a>
              ) : <em>{t('sent')}</em>}
            </div>
          ))}
        </div>
      )}

      <div className="vault-card claim-card">
        <span className="eyebrow">{t('COLLECT EARNINGS')}</span>
        <label className="name-field">
          <span>{t('{ticker} TO COLLECT', { ticker: TOKEN.ticker })}</span>
          <input
            value={claimAmount}
            inputMode="numeric"
            placeholder={String(Math.floor(ledger.earnedEmerge))}
            onChange={(e) => setClaimAmount(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
        <div className="vault-line"><span>{t('Available')}</span><b>{Math.floor(ledger.earnedEmerge).toLocaleString()} {TOKEN.ticker}</b></div>
        <div className="vault-line burn"><span>{t('Burn')}</span><b>{Math.round(WITHDRAW_BURN_RATE * 100)}%</b></div>
        {history?.room && (
          <div className="vault-line">
            <span>{t('Collectable today')}</span>
            <b>{Math.min(history.room.left, history.room.globalLeft).toLocaleString()} {TOKEN.ticker}</b>
          </div>
        )}
        {history?.hand && (
          <p className="muted small">
            {t('Paid as a hired hand: up to {n} {ticker} a day, while you hold at least {min} {ticker}.', { n: HAND_DAILY_CEILING.toLocaleString(), ticker: TOKEN.ticker, min: HAND_MIN_EMERGE.toLocaleString() })}
          </p>
        )}
        {history?.land && history.land !== 'holds' && !history.hand && (
          <p className="warn">
            {history.land === 'no-registry'
              ? t('Stewardship cannot be collected until {ticker} is live here. Your balance keeps accruing and is safe.', { ticker: TOKEN.ticker })
              : history.land === 'unreachable'
                ? t('What land this wallet holds could not be checked just now. Your balance is safe — try again shortly.')
                : t('No plot stands in this wallet’s name. Stewardship is paid to the wallet that holds the land, so if you claimed with a different one, connect that.')}
          </p>
        )}
        <button onClick={doClaim} disabled={busy !== null || ledger.earnedEmerge < 1}>
          {busy === 'collect' ? t('Sending…') : liveToken() ? t('Collect to wallet') : t('Collect')}
        </button>
      </div>

      <h4>{t('{ticker} vault', { ticker: TOKEN.ticker })}</h4>
      <p className="muted small">
        {t('{rate} {ticker} buys 1 Gold, so 1,000,000 {ticker} is 100 Gold. Deposits fund the treasury, and the same Gold can be taken back out — that is your own money and moving it mints nothing, which is why a deposit is the one movement in the game that is vaulted rather than burned. Withdrawals take {pct}%, and that share is burned. The settlement’s own surplus is not withdrawable: it is what the town pays its people with.', { rate: EMERGE_PER_GOLD.toLocaleString(), ticker: TOKEN.ticker, pct: Math.round(WITHDRAW_BURN_RATE * 100) })}
        {liveToken() && ` ${t('What you can take back out is what the chain shows you put in, so it is the same figure on any device you connect this wallet to.')}`}
      </p>

      <div className="vault-grid">
        <div className="vault-card">
          <span className="eyebrow">{t('DEPOSIT')}</span>
          <label className="name-field">
            <span>{t('{ticker} TO DEPOSIT', { ticker: TOKEN.ticker })}</span>
            <input value={depositAmount} inputMode="numeric" onChange={(e) => setDepositAmount(e.target.value.replace(/[^0-9]/g, ''))} />
          </label>
          <div className="vault-line"><span>{t('Buys')}</span><b>{t('{n} Gold', { n: depositGold })}</b></div>
          <div className="vault-line"><span>{t('Balance')}</span><b>{Math.floor(ledger.balance).toLocaleString()} {TOKEN.ticker}</b></div>
          <button
            onClick={doDeposit}
            disabled={busy !== null || depositGold < 0.01 || Number(depositAmount) > ledger.balance}
          >
            {busy === 'deposit' ? t('Signing…') : t('Deposit')}
          </button>
        </div>

        <div className="vault-card">
          <span className="eyebrow">{t('WITHDRAW')}</span>
          <label className="name-field">
            <span>{t('GOLD TO WITHDRAW')}</span>
            <input value={withdrawAmount} inputMode="numeric" onChange={(e) => setWithdrawAmount(e.target.value.replace(/[^0-9]/g, ''))} />
          </label>
          <div className="vault-line"><span>{t('You receive')}</span><b>{quote.received.toLocaleString()} {TOKEN.ticker}</b></div>
          <div className="vault-line burn">
            <span>{liveToken() ? t('Stays in the vault to burn') : t('Burned')}</span>
            <b>{quote.burned.toLocaleString()} {TOKEN.ticker}</b>
          </div>
          <div className="vault-line">
            <span>{t('Principal standing')}</span>
            <b>{t('{n} Gold', { n: standingGold.toLocaleString() })}</b>
          </div>
          <button
            onClick={doWithdraw}
            disabled={busy !== null || quote.gold < 1 || quote.gold > Math.floor(view.treasury) || quote.gold > standingGold}
          >
            {busy === 'withdraw' ? t('Sending…') : liveToken() ? t('Withdraw to wallet') : t('Withdraw')}
          </button>
        </div>
      </div>

      {message && <p className="warn">{tx(message)}</p>}
      <div className="vault-ledger">
        <span>{t('Deposited {n} Gold', { n: ledger.depositedGold.toLocaleString() })}</span>
        <span>{t('Earned {n} {ticker}', { n: Math.floor(ledger.lifetimeEarned).toLocaleString(), ticker: TOKEN.ticker })}</span>
        <span>{t('Withdrawn {n} {ticker}', { n: ledger.withdrawnEmerge.toLocaleString(), ticker: TOKEN.ticker })}</span>
        <span>{t('Burned {n} {ticker}', { n: ledger.burnedEmerge.toLocaleString(), ticker: TOKEN.ticker })}</span>
        {ledger.pendingEmerge > 0 && <span>{t('Queued {n} {ticker}', { n: Math.floor(ledger.pendingEmerge).toLocaleString(), ticker: TOKEN.ticker })}</span>}
        {ledger.vaultBurn > 0 && <span>{t('To burn from the vault {n} {ticker}', { n: Math.floor(ledger.vaultBurn).toLocaleString(), ticker: TOKEN.ticker })}</span>}
      </div>

      <h4>{t('Stores')}</h4>
      <div className="resource-grid">
        {view.resources.map((r) => (
          <div key={r.key} className="resource-cell">
            <span>{tn(r.label)}</span>
            <b>{Math.floor(r.amount)}</b>
          </div>
        ))}
      </div>
    </Shell>
  );
}

/**
 * Everybody and every workplace at a glance, and the lever to change it.
 *
 * Three tabs. People: every adult with their trade, their skill and where
 * they work, the unemployed first, filterable by trade, each with a Retrain
 * control. Trades: every trade with its workers against its posts and a
 * button to fill the open ones with the people who can best be spared.
 * Buildings: every workplace with its crew and its posts, ruins flagged.
 */
function PeoplePanel({ view, onClose, onTrain, onTrainTrade }: {
  view: Snapshot; onClose: () => void; onTrain: (id: string, job: string) => string | null; onTrainTrade: (job: string, count: number) => string | null;
}) {
  useLocale();
  const { roster } = view;
  const [tab, setTab] = useState<'people' | 'trades' | 'buildings'>('people');
  const [filter, setFilter] = useState<string>('all');
  const [retraining, setRetraining] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const trades = roster.trades;
  const shown = roster.people.filter((p) => filter === 'all' ? true : filter === 'unemployed' ? p.job === 'unemployed' : p.job === filter);
  const canPay = (n: number) => view.treasury >= roster.trainCost * n;
  const act = (fn: () => string | null) => { const why = fn(); setNote(why); if (!why) setRetraining(null); };
  return (
    <Shell title={t('PEOPLE')} subtitle={t('{n} adults · {u} without work · {o} open posts', { n: roster.people.length, u: roster.unemployed, o: roster.openPosts })} onClose={onClose} wide>
      <div className="build-shelves">
        <button className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>{t('People')}</button>
        <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>{t('Trades')}</button>
        <button className={tab === 'buildings' ? 'on' : ''} onClick={() => setTab('buildings')}>{t('Buildings')}</button>
      </div>
      <p className="muted small">
        {t('Training costs {n} Gold a head and takes effect at once; a trained person holds their trade for {d} days against the settlement\u2019s own reshuffling, and starts with a head start in skill.', { n: roster.trainCost, d: TRAIN_HOLD_DAYS })}
        {' '}{roster.hasSchool ? t('The School doubles that head start.') : t('A School would double that head start.')}
      </p>
      {note && <p className="people-note">{tx(note)}</p>}

      {tab === 'people' && (
        <>
          <div className="people-filter">
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>{t('Everyone')} · {roster.people.length}</button>
            <button className={filter === 'unemployed' ? 'on' : ''} onClick={() => setFilter('unemployed')}>{t('Without work')} · {roster.unemployed}</button>
            {trades.filter((tr) => tr.workers > 0).map((tr) => (
              <button key={tr.job} className={filter === tr.job ? 'on' : ''} onClick={() => setFilter(tr.job)}>{tn(tr.label)} · {tr.workers}</button>
            ))}
          </div>
          <div className="people-rows">
            {shown.map((p) => (
              <div key={p.id} className={`people-row ${p.job === 'unemployed' ? 'idle' : ''}`}>
                <b>{p.name}</b>
                <span className="muted">{t('{n} yrs', { n: p.age })}</span>
                <span className="people-trade">{tn(p.jobLabel)}{p.trained && <i title={t('Trained')}>✦</i>}</span>
                <span className="muted">{p.skill ? tx(p.skill.title) : t('no trade')}</span>
                <span className="muted">{p.workplace ? (p.at ? t('at the {b}', { b: tn(p.at).toLowerCase() }) : t('works at a {b}', { b: tn(p.workplace).toLowerCase() })) : t('nowhere to work')}</span>
                {retraining === p.id ? (
                  <select autoFocus defaultValue="" onChange={(e) => { if (e.target.value) act(() => onTrain(p.id, e.target.value)); }}>
                    <option value="">{t('Choose a trade')}</option>
                    {trades.filter((tr) => tr.job !== p.job && tr.capacity > 0).map((tr) => (
                      <option key={tr.job} value={tr.job}>{tn(tr.label)} · {tr.open > 0 ? t('{n} open', { n: tr.open }) : t('full')}</option>
                    ))}
                  </select>
                ) : (
                  <button onClick={() => { setNote(null); setRetraining(p.id); }} disabled={!canPay(1)}>{t('Retrain')}</button>
                )}
              </div>
            ))}
            {shown.length === 0 && <p className="muted small">{t('Nobody here.')}</p>}
          </div>
        </>
      )}

      {tab === 'trades' && (
        <div className="people-rows">
          {trades.map((tr) => (
            <div key={tr.job} className={`people-row ${tr.open > 0 ? 'short' : ''}`}>
              <b>{tn(tr.label)}</b>
              <span className="muted">{tn(tr.building)}</span>
              <span className="people-trade">{t('{w} of {c} posts filled', { w: tr.workers, c: tr.capacity })}</span>
              <span className={tr.open > 0 ? 'people-open' : 'muted'}>{tr.open > 0 ? t('{n} open', { n: tr.open }) : tr.workers > tr.capacity ? t('{n} over', { n: tr.workers - tr.capacity }) : t('full')}</span>
              <button disabled={tr.open === 0 || !canPay(1)} onClick={() => act(() => onTrainTrade(tr.job, tr.open))}>
                {tr.open > 0 ? t('Fill {n} for {g} Gold', { n: tr.open, g: tr.open * roster.trainCost }) : t('Full')}
              </button>
            </div>
          ))}
          {trades.length === 0 && <p className="muted small">{t('No workplaces yet. Raise one from the Build panel.')}</p>}
        </div>
      )}

      {tab === 'buildings' && (
        <div className="people-rows">
          {roster.buildings.map((b) => (
            <div key={b.id} className={`people-row ${b.ruined ? 'idle' : b.posts !== null && b.crew < b.posts ? 'short' : ''}`}>
              <b>{tn(b.type)}</b>
              <span className="muted">{t('level {n}', { n: b.level })}</span>
              <span className="people-trade">{b.trade ? tn(b.trade) : t('civic')}</span>
              <span className={b.ruined ? 'people-open' : 'muted'}>{b.ruined ? t('ruin') : b.posts !== null ? t('{c} of {p} at their posts', { c: b.crew, p: b.posts }) : t('{c} inside', { c: b.crew })}</span>
              <span className="muted">{tn(eraName(b.era))}</span>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

function BuildPanel({ view, onClose, onBuild, onClearTrees }: {
  view: Snapshot; onClose: () => void; onBuild: (t: string, c: number) => void; onClearTrees: () => void;
}) {
  const stock = (key: 'wood' | 'stone') => view.resources.find((r) => r.key === key)?.amount ?? 0;
  const wood = stock('wood');
  const stone = stock('stone');
  // Shelves, and what is on each. A shelf with nothing on it in this era is
  // not shown; a building from a later era is shown greyed with the era's
  // name, so the player can see what advancing would open.
  const [shelf, setShelf] = useState<BuildingCategory | 'All'>('All');
  const shelves = BUILDING_CATEGORIES.filter((c) => BUILDABLE.some((o) => BUILDING_CATEGORY[o.type] === c));
  const shown = BUILDABLE.filter((o) => shelf === 'All' || BUILDING_CATEGORY[o.type] === shelf);
  useLocale();
  return (
    <Shell
      title={t('Build')}
      subtitle={t('Gold and materials both. A building takes timber and stone out of the yard, so what the settlement can raise depends on what it has cut and quarried.')}
      onClose={onClose}
      wide
    >
      {view.advice.length > 0 && (
        <div className="build-advice">
          <span>{t('THE HELPER SUGGESTS')}</span>
          {view.advice.map((a, i) => (
            <p key={`${a.kind}-${a.type ?? ''}-${i}`}><b>{tx(a.title)}</b> — {tx(a.why)} <em>{tx(a.gain)}</em></p>
          ))}
        </div>
      )}
      <div className="build-stores">
        <span>{t('IN THE YARD')}</span>
        <b>{t('{n} wood', { n: Math.floor(wood) })}</b>
        <b>{t('{n} stone', { n: Math.floor(stone) })}</b>
      </div>
      {/* Not a building: a tool. Clearing is how the player makes room in a
          wood, and it pays a little timber back for the trouble. */}
      <div className="build-tools">
        <div className="build-card tool">
          <div className="build-icon">🪓</div>
          <h3>{t('Clear trees')}</h3>
          <p>{t('Fell every tree within reach of where you tap. The timber goes to the yard, and the wood grows back over the following days.')}</p>
          <div className="build-cost">
            <b>{t('{n} Gold a tree', { n: CLEAR_TREE_GOLD })}</b>
            <small>{t('+{n} timber each', { n: CLEAR_TREE_WOOD })}</small>
          </div>
          <button disabled={view.treasury < CLEAR_TREE_GOLD} onClick={onClearTrees}>
            {view.treasury < CLEAR_TREE_GOLD ? t('Not enough Gold') : t('Clear')}
          </button>
        </div>
      </div>
      <div className="build-shelves">
        <button className={shelf === 'All' ? 'on' : ''} onClick={() => setShelf('All')}>{t('All')}</button>
        {shelves.map((c) => (
          <button key={c} className={shelf === c ? 'on' : ''} onClick={() => setShelf(c)}>{tn(c)}</button>
        ))}
      </div>
      <div className="build-grid">
        {shown.map((option) => {
          const need = buildMaterials(option.type);
          const paid = view.treasury >= option.cost;
          const stocked = wood >= need.wood && stone >= need.stone;
          const minEra = BUILDING_ERA[option.type] ?? 1;
          const inEra = minEra <= view.era.id;
          const ready = paid && stocked && inEra;
          return (
            <div key={option.type} className={`build-card ${ready ? '' : 'locked'} ${inEra ? '' : 'later-era'}`}>
              <div className="build-icon">{option.icon}</div>
              <h3>{tn(option.type)}{!inEra && <i className="era-lock">{tn(eraName(minEra))}</i>}</h3>
              <p>{t(option.blurb)}</p>
              <div className="build-cost">
                <b>{t('{n} Gold', { n: option.cost })}</b>
                <small>{t('{n}/day upkeep', { n: maintenanceCost(option.type) })}</small>
              </div>
              <div className="build-materials">
                <span className={wood >= need.wood ? '' : 'short'}>{t('{n} wood', { n: need.wood })}</span>
                <span className={stone >= need.stone ? '' : 'short'}>{t('{n} stone', { n: need.stone })}</span>
              </div>
              <button disabled={!ready} onClick={() => onBuild(option.type, option.cost)}>
                {ready ? t('Place') : !inEra ? t('{era} era', { era: tn(eraName(minEra)) }) : !paid ? t('Not enough Gold') : t('Not enough materials')}
              </button>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

/** "3 minutes ago", for a hand's last shift. */
function sinceWhen(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 2) return t('just now');
  if (minutes < 60) return t('{n} minutes ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{n} hours ago', { n: hours });
  return t('{n} days ago', { n: Math.round(hours / 24) });
}

function ConnectPanel({ view, claimed, player, onClose, onRenameWorld, onExpand, onAdvance, onLeave, onRelease, onList }: {
  view: Snapshot; claimed: ClaimedWorld; player: PlayerRecord; onClose: () => void;
  onRenameWorld: (name: string) => void; onExpand: () => Promise<string | null>; onAdvance: () => Promise<string | null>;
  onLeave: () => void; onRelease: () => void;
  onList: (price: number | null) => void;
}) {
  const [releasing, setReleasing] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [advanceNote, setAdvanceNote] = useState<string | null>(null);
  const advance = async () => {
    setAdvancing(true);
    setAdvanceNote(null);
    const refused = await onAdvance();
    setAdvancing(false);
    setAdvanceNote(refused);
  };
  const gate = view.era.gate;
  const [expanding, setExpanding] = useState(false);
  const [expandNote, setExpandNote] = useState<string | null>(null);
  const expand = async () => {
    setExpanding(true);
    setExpandNote(null);
    const refused = await onExpand();
    setExpanding(false);
    setExpandNote(refused);
  };
  const [draftName, setDraftName] = useState(view.name);
  const [askPrice, setAskPrice] = useState(String(Math.round(claimed.price * 1.25)));
  const configured = tokenLive();
  const affordable = player.ledger.balance >= RENAME_COST_EMERGE;
  const changed = draftName.trim().length > 0 && draftName.trim() !== view.name;
  const listing = player.listings.find((l) => l.seed === claimed.seed);
  useLocale();
  const { wallet } = useWallet();

  /*
   * Offers other players have made on this plot, from the registry.
   *
   * Read every quarter minute while the panel is open, so an offer made while
   * the owner is looking turns up without a reload. Accepting one holds the
   * plot for that bidder at that price for two days; nothing else changes
   * until they pay.
   */
  const [offers, setOffers] = useState<Offer[]>([]);
  const [answering, setAnswering] = useState<string | null>(null);
  const [offerNote, setOfferNote] = useState<string | null>(null);
  // The registry's row for this plot, for the hiring card.
  const [row, setRow] = useState<Claim | null>(null);
  const [hiringBusy, setHiringBusy] = useState(false);
  const [hiringNote, setHiringNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const { claims } = await fetchClaims();
      if (!live) return;
      const mine = claims.find((c) => c.seed === claimed.seed) ?? null;
      setRow(mine);
      setOffers(mine?.offers ?? []);
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [claimed.seed]);
  const hire = async (on: boolean) => {
    if (!wallet.address) return;
    setHiringBusy(true);
    const result = await setHiring(claimed.seed, wallet.address, on);
    setHiringBusy(false);
    if (!result.ok || !result.claim) { setHiringNote(result.reason ?? null); return; }
    setRow(result.claim);
    setHiringNote(on ? t('The job is open. It shows on the world map for every player without land.') : t('Closed.'));
  };
  const dismiss = async () => {
    if (!wallet.address) return;
    setHiringBusy(true);
    const result = await quitJob(claimed.seed, wallet.address);
    setHiringBusy(false);
    if (!result.ok || !result.claim) { setHiringNote(result.reason ?? null); return; }
    setRow(result.claim);
    setHiringNote(t('Let go. The job stays open for the next person.'));
  };

  const answer = async (bidder: string, accept: boolean) => {
    if (!wallet.address) return;
    setAnswering(bidder);
    const result = await answerOffer(claimed.seed, wallet.address, bidder, accept);
    setAnswering(null);
    if (!result.ok || !result.claim) { setOfferNote(result.reason ?? null); return; }
    setOffers(result.claim.offers ?? []);
    setOfferNote(accept
      ? t('Accepted. The plot is held for them at that price for two days; the {ticker} lands in your wallet when they pay.', { ticker: TOKEN.ticker })
      : t('Declined.'));
  };

  return (
    <Shell
      title={t('On-Chain')}
      subtitle={t('Emerge is a hybrid world: the settlement runs off-chain, and {ticker} on {chain} carries ownership and value.', { ticker: TOKEN.ticker, chain: ACTIVE_CHAIN.label })}
      onClose={onClose}
      wide
    >
      <div className="connect-grid">
        <div className="connect-card">
          <span className="eyebrow">{t('WALLET')}</span>
          <WalletPicker />
          <div className="vault-line" style={{ marginTop: 12 }}>
            <span>{t('Balance')}</span><b>{Math.floor(player.ledger.balance).toLocaleString()} {TOKEN.ticker}</b>
          </div>
        </div>

        <div className="connect-card">
          <span className="eyebrow">{t('YOUR PLOT')}</span>
          <h3>{claimed.region}</h3>
          <p className="muted">
            {t('Claimed for {price} {ticker} · seed {seed} · day {day}', { price: claimed.price.toLocaleString(), ticker: TOKEN.ticker, seed: view.seed, day: view.day })}
          </p>
          <p className="muted small">
            {claimed.txHash
              ? t('Settled on chain: {tx}', { tx: claimed.txHash })
              : t('Recorded in this browser. Not settled on chain yet.')}
          </p>
          <label className="name-field">
            <span>{t('WORLD NAME')}</span>
            <input value={draftName} maxLength={24} onChange={(e) => setDraftName(e.target.value)} />
          </label>
          <button onClick={() => onRenameWorld(draftName)} disabled={!changed || !affordable}>
            {affordable ? t('Rename for {cost} {ticker}', { cost: RENAME_COST_EMERGE.toLocaleString(), ticker: TOKEN.ticker }) : t('Not enough {ticker}', { ticker: TOKEN.ticker })}
          </button>
        </div>

        <div className="connect-card era-card">
          <span className="eyebrow">{t('ERA')}</span>
          <h3>{tn(view.era.name)}</h3>
          <p className="muted small">{tx(view.era.gate.era.look)} {t('{n} days in this era.', { n: view.era.days })}</p>
          {gate.next ? (
            <>
              <div className="era-next">
                <b>{t('Next: {era}', { era: tn(gate.next.name) })}</b>
                <span className="muted small">{tx(gate.next.arrives)}</span>
              </div>
              <ul className="era-checks">
                <li className={gate.days.have >= gate.days.need ? 'done' : ''}>
                  <i>{gate.days.have >= gate.days.need ? '✓' : '·'}</i>
                  {t('{have} of {need} days in the {era} era', { have: gate.days.have, need: gate.days.need, era: tn(gate.era.name).toLowerCase() })}
                </li>
                {gate.checks.map((c) => (
                  <li key={c.label} className={c.done ? 'done' : ''}><i>{c.done ? '✓' : '·'}</i>{tx(c.label)}</li>
                ))}
              </ul>
              {!gate.open ? (
                <p className="muted small">{t('The {era} era is not built yet. It is coming; the checklist is what it will ask.', { era: tn(gate.next.name) })}</p>
              ) : (
                <button onClick={advance} disabled={advancing || !gate.ready || !wallet.address || player.ledger.balance < ADVANCE_COST_EMERGE}>
                  {advancing
                    ? t('Advancing…')
                    : !gate.ready
                      ? t('Not earned yet')
                      : !wallet.address
                        ? t('Connect a wallet to advance')
                        : player.ledger.balance < ADVANCE_COST_EMERGE
                          ? t('Not enough {ticker}', { ticker: TOKEN.ticker })
                          : t('Advance to {era} · {cost} {ticker}', { era: tn(gate.next.name), cost: ADVANCE_COST_EMERGE.toLocaleString(), ticker: TOKEN.ticker })}
                </button>
              )}
              <p className="muted small">{t('{cost} {ticker}, burned, once per step. The registry judges the checklist on the copy of your world it holds, so the world is published first.', { cost: ADVANCE_COST_EMERGE.toLocaleString(), ticker: TOKEN.ticker })}</p>
            </>
          ) : (
            <p className="muted small">{t('This is as far as the eras go.')}</p>
          )}
          {advanceNote && <p className="muted small">{advanceNote}</p>}
        </div>

        <div className="connect-card">
          <span className="eyebrow">{t('EXPAND THIS PLOT')}</span>
          {view.expanded ? (
            <>
              <h3>{t('Expanded')}</h3>
              <p className="muted small">{t('The land has grown on every side. Pan out to the new ground beyond the old edge; the wood on it is yours to clear and build on.')}</p>
            </>
          ) : (
            <>
              <h3>{t('Grow the land')}</h3>
              <p className="muted small">
                {t('Expanding makes the plot itself bigger: a ring of new ground on every side, about half as much land again, with the river running on into it. {cost} {ticker}, burned. Once per plot.', { cost: EXPAND_COST_EMERGE.toLocaleString(), ticker: TOKEN.ticker })}
              </p>
              <button onClick={expand} disabled={expanding || !wallet.address || player.ledger.balance < EXPAND_COST_EMERGE}>
                {expanding
                  ? t('Expanding…')
                  : !wallet.address
                    ? t('Connect a wallet to expand')
                    : player.ledger.balance < EXPAND_COST_EMERGE
                      ? t('Not enough {ticker}', { ticker: TOKEN.ticker })
                      : t('Expand for {cost} {ticker}', { cost: EXPAND_COST_EMERGE.toLocaleString(), ticker: TOKEN.ticker })}
              </button>
            </>
          )}
          {expandNote && <p className="muted small">{expandNote}</p>}
        </div>

        <div className="connect-card">
          <span className="eyebrow">{t('HIRED HANDS')}</span>
          {row?.hand ? (
            <>
              <h3>{row.hand.name || shortAddress(row.hand.address)}</h3>
              <p className="muted small">
                {Date.now() - row.hand.lastSeen < 15 * 60_000
                  ? t('At work now. While they have this world open it counts as attended, so your rate holds while you are away.')
                  : t('Took the job {date}; last at work {ago}. While they have this world open it counts as attended.', { date: new Date(row.hand.since).toLocaleDateString(), ago: sinceWhen(row.hand.lastSeen) })}
              </p>
              <button className="ghost" onClick={dismiss} disabled={hiringBusy}>{t('Let them go')}</button>
            </>
          ) : (
            <>
              <h3>{row?.hiring ? t('Hiring') : t('Not hiring')}</h3>
              <p className="muted small">
                {t('A hired hand is a player without land who holds at least {min} {ticker}. They attend this plot while you are away — it counts as your attention — and are paid {share} of its stewardship by the vault, never out of yours.', { min: HAND_MIN_EMERGE.toLocaleString(), ticker: TOKEN.ticker, share: `${Math.round(HAND_SHARE * 100)}%` })}
              </p>
              <button onClick={() => hire(!row?.hiring)} disabled={hiringBusy || !wallet.address}>
                {row?.hiring ? t('Stop hiring') : t('Hire a hand')}
              </button>
            </>
          )}
          {hiringNote && <p className="muted small">{hiringNote}</p>}
        </div>

        <div className="connect-card">
          <span className="eyebrow">{t('SELL THIS PLOT')}</span>
          {listing ? (
            <>
              <h3>{t('Listed at {price} {ticker}', { price: listing.price.toLocaleString(), ticker: TOKEN.ticker })}</h3>
              <p className="muted small">
                {t('On the map for every player. A buyer pays your wallet directly in {ticker} — a transfer, not a burn — and the plot and this settlement move to them the moment the chain settles it.', { ticker: TOKEN.ticker })}
              </p>
              <button onClick={() => onList(null)}>{t('Withdraw listing')}</button>
            </>
          ) : (
            <>
              <label className="name-field">
                <span>{t('ASKING PRICE ({ticker})', { ticker: TOKEN.ticker })}</span>
                <input value={askPrice} inputMode="numeric" onChange={(e) => setAskPrice(e.target.value.replace(/[^0-9]/g, ''))} />
              </label>
              <button onClick={() => onList(Number(askPrice) || 0)} disabled={!(Number(askPrice) > 0)}>
                {t('List for sale')}
              </button>
              <p className="muted small">
                {t('A sale is between you and the buyer: they pay your wallet the asking price in {ticker}, nothing is burned, and they walk into this settlement as you left it.', { ticker: TOKEN.ticker })}
              </p>
            </>
          )}
          {offers.length > 0 && (
            <div className="offers">
              <span className="eyebrow">{t('OFFERS ON THIS PLOT')}</span>
              {offers.map((o) => {
                const held = !!o.acceptedUntil && o.acceptedUntil > Date.now();
                return (
                  <div key={o.buyer} className={`offer-line ${held ? 'held' : ''}`}>
                    <span>
                      <b>{o.price.toLocaleString()} {TOKEN.ticker}</b>
                      {' '}<em className="muted">{o.buyerName || shortAddress(o.buyer)}</em>
                      {held && <i>{t('accepted — awaiting their payment')}</i>}
                    </span>
                    {!held && (
                      <span className="offer-actions">
                        <button disabled={answering !== null} onClick={() => answer(o.buyer, true)}>{t('Accept')}</button>
                        <button className="ghost" disabled={answering !== null} onClick={() => answer(o.buyer, false)}>{t('Decline')}</button>
                      </span>
                    )}
                  </div>
                );
              })}
              {offerNote && <p className="muted small">{offerNote}</p>}
            </div>
          )}
          {/* Leaving is not selling. It used to be: stepping out of a world
              deleted the claim, so a player who wanted a look at the map had to
              buy their own land back. */}
          <button className="ghost" onClick={onLeave}>{t('Back to the world map')}</button>
          <button className="danger" onClick={() => {
            if (releasing) onRelease();
            else setReleasing(true);
          }}>
            {releasing ? t('Give it up for good — tap again') : t('Give up this plot')}
          </button>
          {releasing && (
            <p className="muted small">
              {t('{region} goes back on the market and the {price} {ticker} is not refunded. Your world keeps running until you do.', { region: claimed.region, price: claimed.price.toLocaleString(), ticker: TOKEN.ticker })}
            </p>
          )}
        </div>
      </div>

      <h4>{t('{ticker} on {chain}', { ticker: TOKEN.ticker, chain: ACTIVE_CHAIN.label })}</h4>
      {!configured && (
        <p className="muted small">
          {t('This build reaches {chain} at {rpc} (chain {id}), and your wallet can switch to it. What is missing is the {ticker} contract and the land registry: until those are deployed and their addresses set, these are the actions the economy layer is designed around, and balances and listings are local to this browser.', { chain: ACTIVE_CHAIN.label, rpc: ACTIVE_CHAIN.rpcUrl ?? '', id: ACTIVE_CHAIN.chainId ?? '', ticker: TOKEN.ticker })}
        </p>
      )}
      <div className="token-grid">
        {tokenActions().map((action) => (
          <div key={action.id} className={`token-card ${action.ready ? '' : 'pending'}`}>
            <b>{t(action.label)}</b>
            <span>{t(action.detail)}</span>
            <em>{action.ready ? t('Ready') : t('Awaiting chain config')}</em>
          </div>
        ))}
      </div>
    </Shell>
  );
}

export function Panels({ panel, view, claimed, player, onClose, onBuild, onTrain, onTrainTrade, onClearTrees, onRenameWorld, onExpand, onAdvance, onLeave, onRelease, onVault, onWages, onList, onPlayer, onDig, onVisit, spectating, visit, onGift, chatNotices, onToggleNotices }: PanelsProps) {
  if (panel === 'market') return <MarketPanel view={view} onClose={onClose} />;
  if (panel === 'gift' && visit) {
    return <GiftPanel player={player} visit={visit} onClose={onClose} onGift={onGift} />;
  }
  if (panel === 'bank') {
    /*
     * The Bank acts on the settlement in front of you, so on a visit it would
     * have let a stranger deposit into, withdraw from and collect earnings on
     * a treasury that is not theirs. There is a door for putting something in
     * — the gift — and no door at all for taking anything out.
     */
    if (spectating) {
      return visit
        ? <GiftPanel player={player} visit={visit} onClose={onClose} onGift={onGift} />
        : null;
    }
    // Which of the player's worlds pay is decided by claim order, so the panel
    // works it out the same way the credit does rather than being told.
    const earning = [...player.claims]
      .sort((a, b) => a.claimedAt - b.claimedAt)
      .slice(0, EARNING_PLOT_LIMIT)
      .some((c) => c.seed === claimed.seed);
    return (
      <BankPanel
        view={view} claimed={claimed} player={player} earning={earning}
        onClose={onClose} onVault={onVault} onWages={onWages}
      />
    );
  }

  // Everything that changes the settlement is the owner's alone.
  if (spectating && (panel === 'build' || panel === 'people' || panel === 'gacha' || panel === 'connect')) return null;
  if (panel === 'guide') return <GuidePanel view={view} onClose={onClose} />;
  if (panel === 'chat') {
    return (
      <ChatPanel
        view={view} claimed={claimed} player={player}
        onClose={onClose} onPlayer={onPlayer} onVisit={onVisit}
        chatNotices={chatNotices} onToggleNotices={onToggleNotices}
      />
    );
  }
  if (panel === 'gacha') return <GachaPanel player={player} onClose={onClose} onDig={onDig} />;
  if (panel === 'build') return <BuildPanel view={view} onClose={onClose} onBuild={onBuild} onClearTrees={onClearTrees} />;
  if (panel === 'people') return <PeoplePanel view={view} onClose={onClose} onTrain={onTrain} onTrainTrade={onTrainTrade} />;
  if (panel === 'connect') {
    return (
      <ConnectPanel
        view={view} claimed={claimed} player={player} onClose={onClose}
        onRenameWorld={onRenameWorld} onExpand={onExpand} onAdvance={onAdvance} onLeave={onLeave} onRelease={onRelease} onList={onList}
      />
    );
  }
  return null;
}
