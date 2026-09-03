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
  WAGE_MAX, WAGE_MIN, WAGE_STANDARD, buildMaterials, maintenanceCost, wageEffort, worldMarketState,
} from '@/lib/simulation';
import type { Snapshot } from '@/lib/hud';
import {
  ACTIVE_CHAIN, TOKEN, VAULT_ADDRESS, shortAddress, tokenActions, tokenLive,
} from '@/lib/chain/emerge';
import {
  DAILY_EARN_CEILING, EARNING_PLOT_LIMIT, EMERGE_PER_GOLD, PROSPECT_COST_EMERGE, RENAME_CITIZEN_EMERGE,
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
import { fetchClaims, type Claim } from '@/lib/net/registry';
import { fetchPayouts, type PayoutHistory } from '@/lib/net/payouts';
import { onChainClaimsLive } from '@/lib/chain/registry';
import { MAX_GIFT_GOLD } from '@/lib/limits';
import { spend } from '@/lib/chain/spend';
import { WalletPicker, useWallet } from './WalletPicker';

export type PanelKey = 'market' | 'bank' | 'build' | 'guide' | 'chat' | 'gacha' | 'gift' | 'connect' | null;

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
  // Where the prices come from. The panel has always been called the world
  // market; now it is one, and it should say so rather than leaving a player to
  // guess whether the number is theirs or everybody's.
  const world = worldMarketState();

  return (
    <Shell
      title="World Market"
      subtitle={world.live
        ? 'One market across every settlement. Prices are the same everywhere; what your town buys and sells is its own.'
        : 'Households buy food, producers consume inputs, and the market moves to close the gaps.'}
      onClose={onClose}
      wide
    >
      <p className={`market-source ${world.live ? 'live' : ''}`}>
        {world.live ? (
          <>
            <b>Trading with {world.traders === 1 ? 'one settlement' : `${world.traders} settlements`}.</b>{' '}
            Every price below is what the same good costs in every other world right now. Your
            stores decide whether you are buying or selling at it.
          </>
        ) : (
          <>
            <b>Pricing your own stores.</b> The world market is out of reach, so this settlement is
            quoting what it can see — the way it did before there were others to trade with.
          </>
        )}
      </p>
      {row && (
        <div className="market-focus">
          <div>
            <span className="eyebrow">FOCUS</span>
            <h3>{row.label}</h3>
            <strong>{row.quote.price.toFixed(2)} <small>GOLD / UNIT</small></strong>
          </div>
          {/* A chart of one point is an empty box the height of a chart, which
              is what a brand-new world shows on its first day. Say so instead
              until there is a second day to draw a line between. */}
          <div className="market-chart">
            {row.quote.history.length > 1 ? (
              <>
                <span className="eyebrow">
                  LAST {row.quote.history.length} {row.quote.history.length === 1 ? 'DAY' : 'DAYS'}
                </span>
                <Sparkline values={row.quote.history} width={260} height={54} />
              </>
            ) : (
              <>
                <span className="eyebrow">PRICE HISTORY</span>
                <p className="muted small no-history">Nothing to plot yet — come back tomorrow.</p>
              </>
            )}
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
          <h4>Building</h4>
          <p>
            The Build panel places new buildings. Each costs Gold <em>and</em> materials — timber and
            stone out of the yard — so what you can raise depends on what the settlement has cut and
            quarried. Buildings placed off the road network get a lane cut through to them, and one
            placed across water will have a bridge started toward it.
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
            The world map is a chart of islands, and there are six charts to sail between. Each
            holds fifteen to seventeen plots and no more: when a chart is fully surveyed, prospecting
            there is refused and you have to go elsewhere. Surveying costs
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

  const messages = state ? channelOf(state, channel) : [];

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
          ?? `Changing your name again costs ${RENAME_PLAYER_EMERGE.toLocaleString()} ${TOKEN.ticker}.`);
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
      title="Chat"
      subtitle={wallet.address
        ? `Posting as ${who}, under ${shortAddress(wallet.address)}.`
        : `Posting as ${who} — connect a wallet to post under your address.`}
      onClose={onClose}
      wide
    >
      <div className="chat-tabs">
        <button className={kind === 'world' ? 'on' : ''} onClick={() => setKind('world')}>
          {view.name}
          <em>{channelOf(state, worldChannel(claimed.seed)).length}</em>
        </button>
        <button className={kind === 'global' ? 'on' : ''} onClick={() => setKind('global')}>
          Global
          <em>{channelOf(state, 'global').length}</em>
        </button>
        <button
          className={`ghost bell ${chatNotices ? 'on' : ''}`}
          onClick={onToggleNotices}
          title={chatNotices
            ? 'Messages raise a card when this panel is closed'
            : 'Messages arrive quietly'}
        >
          {chatNotices ? '🔔 Alerts on' : '🔕 Alerts off'}
        </button>
        <button className="ghost handle" onClick={() => setNaming((n) => !n)}>
          {player.nameChanges === 0 ? 'Change name · free' : 'Change name'}
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
              ? 'Your first change is free. Press enter.'
              : `${RENAME_PLAYER_EMERGE.toLocaleString()} ${TOKEN.ticker}, burned. Press enter.`}
          </span>
        </div>
      )}

      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted small">
            {kind === 'global'
              ? 'Nothing on the global channel yet. Say hello.'
              : `Nothing said about ${view.name} yet.`}
          </p>
        )}
        {messages.map((m) => {
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
            <div key={m.id} className={`chat-row ${m.wallet ? 'wallet' : ''} ${host ? 'host' : ''}`}>
              {theirs && !self ? (
                <button
                  className={`chat-who ${host ? 'host' : ''}`}
                  title={host ? `${shown} owns ${view.name} · ${who}` : `Visit ${theirs.worldName} · ${who}`}
                  disabled={travelling !== null}
                  onClick={() => travelTo(theirs)}
                >
                  {shown}
                  <i>{travelling === theirs.seed ? '…' : host ? '★' : '↗'}</i>
                </button>
              ) : (
                <b className={host ? 'host' : ''} title={who}>
                  {shown}{host && <i className="host-star">★</i>}
                </b>
              )}
              <span>{m.text}</span>
              <em>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</em>
            </div>
          );
        })}
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

      {/* What the relay can actually reach, said plainly either way. */}
      {reach.offline ? (
        <p className="muted small">
          The relay is not answering. Your messages are being kept here and nobody else can see them
          until it comes back.
        </p>
      ) : !reach.shared ? (
        <p className="muted small">
          This build has no shared relay behind it yet, so what you say reaches players on the same
          server and no further. Said plainly rather than left for you to discover.
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
      title="Send out a party"
      subtitle="Hire prospectors for a day. They always come back with something."
      onClose={onClose}
      wide
    >
      <div className="dig">
        <button className="dig-button" onClick={pull} disabled={digging || !affordable}>
          <span>{digging ? 'SENDING…' : affordable ? 'SEND THEM OUT' : `NOT ENOUGH ${TOKEN.ticker}`}</span>
          <b>{DIG_COST_EMERGE.toLocaleString()} {TOKEN.ticker}</b>
          <i>burned, not collected</i>
        </button>

        {last && (
          <div className={`dig-result ${last.prize.kind}`}>
            <span className="eyebrow">THEY CAME BACK WITH</span>
            <b>{last.prize.label}</b>
            <p>{last.story}</p>
          </div>
        )}
        {!last && (
          <div className="dig-result waiting">
            <span className="eyebrow">NOTHING SENT YET</span>
            <p>
              Every party comes back with something — the worst outcome on the table is still worth
              more than a wasted afternoon.
            </p>
          </div>
        )}
      </div>

      {notice && <p className="warn">{notice}</p>}

      <h4>What they might find</h4>
      <div className="odds">
        {table.map((prize) => (
          <div key={prize.id} className={`odds-row ${prize.kind}`}>
            <span>{prize.label}</span>
            <div className="odds-bar"><i style={{ width: `${Math.max(3, prize.percent * 3)}%` }} /></div>
            <b>{prize.percent.toFixed(1)}%</b>
          </div>
        ))}
      </div>
      <p className="muted small">
        These are the real weights: the panel computes them from the same table the draw rolls
        against, so they cannot drift apart. Naming rights let you rename one citizen without paying
        the usual fee, and you hold {player.nameTokens} of them.
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

  const send = async () => {
    if (!(gold > 0)) { setNotice('Enter an amount to send.'); return; }
    if (gold > MAX_GIFT_GOLD) {
      setNotice(`A single gift carries at most ${MAX_GIFT_GOLD.toLocaleString()} Gold.`);
      return;
    }
    if (!affordable) {
      setNotice(`That is ${cost.toLocaleString()} ${TOKEN.ticker}, and you hold ${Math.floor(player.ledger.balance).toLocaleString()}.`);
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
      title={`Send Gold to ${visit.worldName}`}
      subtitle={`${who} built this place. You cannot change it — but you can help pay for it.`}
      onClose={onClose}
    >
      <div className="vault-card">
        <span className="eyebrow">HOW MUCH</span>
        <div className="vault-row">
          <input
            value={amount}
            inputMode="numeric"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
          />
          <span className="muted">Gold</span>
        </div>
        <p className="muted small">
          {gold > 0
            ? `${cost.toLocaleString()} ${TOKEN.ticker}, burned out of your balance. ${who} finds ${gold.toLocaleString()} Gold in their treasury when they next open ${visit.worldName}.`
            : `${EMERGE_PER_GOLD.toLocaleString()} ${TOKEN.ticker} per Gold, the same rate as your own deposits.`}
        </p>
        <button className="claim-button" onClick={send} disabled={sending || !affordable || !(gold > 0)}>
          {sending
            ? 'Sending…'
            : !(gold > 0)
              ? 'Enter an amount'
              : !affordable
                ? `Not enough ${TOKEN.ticker}`
                : `Send ${gold.toLocaleString()} Gold`}
        </button>
        {sent !== null && (
          <p className="muted small">
            Sent. {sent.toLocaleString()} Gold is waiting for {who}, and{' '}
            {(sent * EMERGE_PER_GOLD).toLocaleString()} {TOKEN.ticker} has left the supply for good.
          </p>
        )}
        {notice && <p className="warn">{notice}</p>}
      </div>

      <p className="muted small">
        At most {MAX_GIFT_GOLD.toLocaleString()} Gold at a time. Gifts cannot be sent to a world you
        own — putting your own tokens into your own treasury is what the Bank is for, and it is
        priced the same either way.
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
        <span className="muted small">of the going rate · {bill.toLocaleString()} Gold a day</span>
      </div>
      <input
        className="wage-slider"
        type="range"
        min={WAGE_MIN * 100}
        max={WAGE_MAX * 100}
        step={5}
        value={Math.round(rate * 100)}
        onChange={(e) => onWages(Number(e.target.value) / 100)}
        aria-label="Wages, as a share of the going rate"
      />
      <div className="wage-scale">
        <span>{pct(WAGE_MIN)}</span>
        <span>{pct(WAGE_STANDARD)}</span>
        <span>{pct(WAGE_MAX)}</span>
      </div>
      <div className="wage-effect">
        <div>
          <span>WORK DONE</span>
          <b className={effort >= 1 ? 'up' : 'down'}>{pct(effort)}</b>
        </div>
        <div>
          <span>MOOD</span>
          <b className={rate >= WAGE_STANDARD ? 'up' : 'down'}>
            {rate === WAGE_STANDARD ? 'steady' : rate > WAGE_STANDARD ? 'lifting' : 'sinking'}
          </b>
        </div>
      </div>
      <p className="muted small">
        {rate < WAGE_STANDARD
          ? 'Paying under the rate does not even leave you richer. People do less and lose heart, the settlement produces and sells less, and a hundred and fifty days of it ends with a smaller town and an emptier treasury than paying properly would have.'
          : rate > WAGE_STANDARD
            ? 'Paying over the rate does not pay for itself: a wage bill rises far faster than the work does. What it buys is a contented, growing settlement, and it is paid for in Gold that does not all come home.'
            : 'The going rate. People work as expected and their sense of purpose holds steady.'}
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
    onVault(result.ledger, depositGold, `${depositGold} Gold arrived from the ${TOKEN.ticker} vault.`);
    void refreshHistory();
  };

  const netYesterday = view.earnedYesterday - view.spentYesterday;

  const doWithdraw = async () => {
    setBusy('withdraw');
    const result = await withdraw(ledger, Math.floor(Number(withdrawAmount) || 0), view.treasury, who);
    setBusy(null);
    setMessage(result.message);
    if (!result.ok) return;
    onVault(result.ledger, -quote.gold, `${quote.gold} Gold of principal was withdrawn to ${TOKEN.ticker}.`);
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
    onVault(result.ledger, 0, `${amount.toLocaleString()} ${TOKEN.ticker} of earnings was collected.`);
    void refreshHistory();
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

      <h4>Wages</h4>
      <WageControl view={view} onWages={onWages} />

      <h4>The day's books</h4>
      <p className="muted small">
        Every Gold in or out of the treasury is booked under a heading, and the headings add up to
        the change in the balance above. Yesterday closed {netYesterday >= 0 ? 'up' : 'down'}
        {' '}{Math.abs(Math.round(netYesterday)).toLocaleString()} Gold.
      </p>
      <div className="books">
        <div className="books-col earning">
          <div className="books-head">
            <span>EARNED YESTERDAY</span>
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
            <span>SPENT YESTERDAY</span>
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
            {steward.idleHours < 1
              ? 'Acted on just now'
              : steward.idleHours < 24
                ? `Nothing done for ${Math.floor(steward.idleHours)}h`
                : `Nothing done for ${Math.floor(steward.idleHours / 24)} ${Math.floor(steward.idleHours / 24) === 1 ? 'day' : 'days'}`}
          </em>
        </div>
        <div className={earning ? '' : 'fading'}>
          <span>EARNING PER DAY</span>
          <b>{earning ? steward.dailyYield.toLocaleString() : 'nothing'}</b>
          <em>
            {earning
              ? `${TOKEN.ticker} a real day, of ${steward.cap.toLocaleString()} possible`
              : `beyond your first ${EARNING_PLOT_LIMIT} plots`}
          </em>
        </div>
        <div>
          <span>EARNED HERE</span>
          <b>{Math.floor(ledger.lifetimeEarned).toLocaleString()}</b>
          <em>{Math.floor(ledger.earnedEmerge).toLocaleString()} uncollected</em>
        </div>
      </div>

      {!earning && (
        <p className="warn">
          This world does not pay. Only the first {EARNING_PLOT_LIMIT} plots you claimed earn
          {' '}{TOKEN.ticker} — this one is yours to build in, and everything you do here still
          counts towards the settlement, just not towards your balance. Give up one of the four and
          the next in line starts earning.
        </p>
      )}

      {liveToken() && (
        <p className="muted small vault-note">
          Both directions are real transfers. A deposit is signed by you and lands in the vault at
          {' '}<b>{shortAddress(VAULT_ADDRESS)}</b>; a withdrawal is signed by the vault and lands in
          your wallet, straight away and without anybody approving it. Everything the game
          <em> charges</em> goes to the burn address instead and is gone. The
          {' '}{Math.round(WITHDRAW_BURN_RATE * 100)}% taken off a withdrawal is the one thing that
          stays put: it remains in the vault to be burned.
          {history && !history.automatic && (
            <> This build has no vault key configured, so withdrawals are refused rather than paid —
            nothing here will pretend otherwise.</>
          )}
        </p>
      )}

      {liveToken() && history && (history.payouts.length > 0 || ledger.pendingEmerge > 0) && (
        <div className="payout-queue">
          <span className="eyebrow">PAID OUT</span>
          {ledger.pendingEmerge > 0 && (
            <div className="vault-line">
              <span>Requested before payouts were automatic</span>
              <b>{Math.floor(ledger.pendingEmerge).toLocaleString()} {TOKEN.ticker}</b>
            </div>
          )}
          {history.payouts.slice(0, 6).map((row) => (
            <div key={row.id} className="payout-row paid">
              <span>
                {row.kind === 'principal' ? `${row.gold} Gold of principal` : 'Stewardship earnings'}
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
                >sent</a>
              ) : <em>sent</em>}
            </div>
          ))}
        </div>
      )}

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
        {history?.room && (
          <div className="vault-line">
            <span>Collectable today</span>
            <b>{Math.min(history.room.left, history.room.globalLeft).toLocaleString()} {TOKEN.ticker}</b>
          </div>
        )}
        <button onClick={doClaim} disabled={busy !== null || ledger.earnedEmerge < 1}>
          {busy === 'collect' ? 'Sending…' : liveToken() ? 'Collect to wallet' : 'Collect'}
        </button>
      </div>

      <h4>{TOKEN.ticker} vault</h4>
      <p className="muted small">
        {EMERGE_PER_GOLD.toLocaleString()} {TOKEN.ticker} buys 1 Gold, so 1,000,000 {TOKEN.ticker} is 100 Gold.
        Deposits fund the treasury, and the same Gold can be taken back out — that is your own money and moving
        it mints nothing, which is why a deposit is the one movement in the game that is vaulted rather than
        burned. Withdrawals take {Math.round(WITHDRAW_BURN_RATE * 100)}%, and that share is burned. The
        settlement&rsquo;s own surplus is not withdrawable: it is what the town pays its people with.
        {liveToken() && ' What you can take back out is what the chain shows you put in, so it is the same figure on any device you connect this wallet to.'}
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
          <button
            onClick={doDeposit}
            disabled={busy !== null || depositGold < 0.01 || Number(depositAmount) > ledger.balance}
          >
            {busy === 'deposit' ? 'Signing…' : 'Deposit'}
          </button>
        </div>

        <div className="vault-card">
          <span className="eyebrow">WITHDRAW</span>
          <label className="name-field">
            <span>GOLD TO WITHDRAW</span>
            <input value={withdrawAmount} inputMode="numeric" onChange={(e) => setWithdrawAmount(e.target.value.replace(/[^0-9]/g, ''))} />
          </label>
          <div className="vault-line"><span>You receive</span><b>{quote.received.toLocaleString()} {TOKEN.ticker}</b></div>
          <div className="vault-line burn">
            <span>{liveToken() ? 'Stays in the vault to burn' : 'Burned'}</span>
            <b>{quote.burned.toLocaleString()} {TOKEN.ticker}</b>
          </div>
          <div className="vault-line">
            <span>Principal standing</span>
            <b>{standingGold.toLocaleString()} Gold</b>
          </div>
          <button
            onClick={doWithdraw}
            disabled={busy !== null || quote.gold < 1 || quote.gold > Math.floor(view.treasury) || quote.gold > standingGold}
          >
            {busy === 'withdraw' ? 'Sending…' : liveToken() ? 'Withdraw to wallet' : 'Withdraw'}
          </button>
        </div>
      </div>

      {message && <p className="warn">{message}</p>}
      <div className="vault-ledger">
        <span>Deposited {ledger.depositedGold.toLocaleString()} Gold</span>
        <span>Earned {Math.floor(ledger.lifetimeEarned).toLocaleString()} {TOKEN.ticker}</span>
        <span>Withdrawn {ledger.withdrawnEmerge.toLocaleString()} {TOKEN.ticker}</span>
        <span>Burned {ledger.burnedEmerge.toLocaleString()} {TOKEN.ticker}</span>
        {ledger.pendingEmerge > 0 && <span>Queued {Math.floor(ledger.pendingEmerge).toLocaleString()} {TOKEN.ticker}</span>}
        {ledger.vaultBurn > 0 && <span>To burn from the vault {Math.floor(ledger.vaultBurn).toLocaleString()} {TOKEN.ticker}</span>}
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
            Claimed for {claimed.price.toLocaleString()} {TOKEN.ticker} · seed {view.seed} · day {view.day}
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
          <button className="ghost" onClick={onLeave}>Back to the world map</button>
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

export function Panels({ panel, view, claimed, player, onClose, onBuild, onRenameWorld, onLeave, onRelease, onVault, onWages, onList, onPlayer, onDig, onVisit, spectating, visit, onGift, chatNotices, onToggleNotices }: PanelsProps) {
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
  if (spectating && (panel === 'build' || panel === 'gacha' || panel === 'connect')) return null;
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
