'use client';

import { UPDATES } from '@/lib/updates';

/**
 * The guide.
 *
 * Everything a player might want to know before spending anything, on one
 * page, with every number imported from the code that enforces it rather than
 * typed out here. A wiki that drifts from the game is worse than no wiki: it
 * is a promise the software does not keep.
 *
 * The tone is the same one the panels use. Say what is true, including the
 * parts that are inconvenient — which right now means being direct about
 * stewardship not paying out until the land contract exists, rather than
 * describing an income nobody can collect.
 */

import Link from 'next/link';
import { ACTIVE_CHAIN, TOKEN, tokenLive } from '@/lib/chain/emerge';
import { onChainClaimsLive } from '@/lib/chain/registry';
import {
  DAILY_EARN_CEILING, EARNING_PLOT_LIMIT, EMERGE_PER_GOLD, PROSPECT_COST_EMERGE,
  RENAME_CITIZEN_EMERGE, RENAME_COST_EMERGE, RENAME_PLAYER_EMERGE, WITHDRAW_BURN_RATE, HAND_DAILY_CEILING, HAND_MIN_EMERGE, HAND_SHARE, EXPAND_COST_EMERGE, ADVANCE_COST_EMERGE
} from '@/lib/chain/vault';
import { DIG_COST_EMERGE } from '@/lib/chain/gacha';
import {
  ARROW_WOOD, BAIT_GOLD, BUILD_COSTS, BUILD_MATERIALS, CLEAR_TREE_GOLD, CLEAR_TREE_WOOD, ROD_WOOD, HAZARD_DEFENCE, HAZARD_LABELS, JOBS, LEDGER_LABELS, MAX_BUILDING_LEVEL,
  MOVE_SHARE, OUTPUT_PER_LEVEL, RESOURCE_LABELS, STEWARDSHIP_DAILY_CAP, UPGRADE_STEPS,
  UPKEEP_PER_LEVEL, WAGE_MAX, WAGE_MIN, WAGE_STANDARD, maintenanceCost, wageEffort,
  type HazardKind, type Resource,
} from '@/lib/simulation';
import { MAX_GIFT_GOLD } from '@/lib/limits';
import { BASE_PRICE, BIOME_KINDS_BY_INDEX, BIOME_PREMIUM, PRICE_SCALE } from '@/lib/world/price';
import { BrandLine } from './Brand';
import { LanguageSwitch } from './LanguageSwitch';
import { useLocale } from '@/lib/i18n';
import { WikiZh } from './WikiZh';

const n = (value: number) => value.toLocaleString();
const pct = (value: number) => `${Math.round(value * 100)}%`;

/** Land prices, straight from the same function the game charges with. */
const PLOT_PRICES = [...BIOME_KINDS_BY_INDEX]
  .map((kind) => ({ kind, price: (BASE_PRICE + BIOME_PREMIUM[kind]) * PRICE_SCALE }))
  .sort((a, b) => a.price - b.price);

const CHARGES = [
  { what: 'Claim a plot', cost: `${n(PLOT_PRICES[0].price)} – ${n(PLOT_PRICES[PLOT_PRICES.length - 1].price)}`, note: 'by biome' },
  { what: 'Survey new land', cost: n(PROSPECT_COST_EMERGE), note: 'finds a seed nobody has had' },
  { what: 'Rename your world', cost: n(RENAME_COST_EMERGE), note: '' },
  { what: 'Rename a being', cost: n(RENAME_CITIZEN_EMERGE), note: 'free with a naming right from a dig' },
  { what: 'Rename yourself', cost: n(RENAME_PLAYER_EMERGE), note: 'the first change is free' },
  { what: 'Send a digging party', cost: n(DIG_COST_EMERGE), note: '' },
  { what: 'Expand a plot', cost: n(EXPAND_COST_EMERGE), note: 'once per plot; about half as much land again' },
  { what: 'Advance an era', cost: n(ADVANCE_COST_EMERGE), note: 'once per step, after the plot has earned it' },
];

/**
 * What a plot actually pays, worked through.
 *
 * `dailyYield = STEWARDSHIP_DAILY_CAP × score × attention`, which is the exact
 * line the simulation runs, so these rows are the real function rather than an
 * illustration of it.
 */
const yieldFor = (score: number, attention: number) =>
  Math.round(STEWARDSHIP_DAILY_CAP * score * attention);

const EXAMPLES = [
  { how: 'Run well, looked after daily', score: 0.95, attention: 0.9 },
  { how: 'Run decently, checked most days', score: 0.8, attention: 0.7 },
  { how: 'Left alone for two days', score: 0.8, attention: 0.08 },
  { how: 'Struggling and neglected', score: 0.4, attention: 0.08 },
];

/**
 * The settlement's books, taken from the ledger the simulation actually keeps.
 *
 * Split into what comes in and what goes out, in the order a player meets
 * them, with the headings read from `LEDGER_LABELS` so a line renamed in the
 * game is renamed here.
 */
const INCOME: [keyof typeof LEDGER_LABELS, string][] = [
  ['exports', 'Selling what the town has too much of, at the world market\u2019s price, plus the takings from market day.'],
  ['households', 'Wages coming back. People buy clothing, furniture and tools from the stalls with money they were paid.'],
  ['food', 'Meals. Everybody eats, and everybody pays for it out of their own purse.'],
  ['vault', 'What you put in yourself, and Gold other players gift your settlement.'],
  ['arena', 'Bets that came in at the colosseum.'],
];

/*
 * Only the lines the ledger actually books on this side. "Food sales" reads
 * like a cost and is not one: the town's food money moves from a citizen's
 * purse into the treasury, and what the settlement pays to bring food in is
 * booked under imports like everything else it buys.
 */
const SPENDING: [keyof typeof LEDGER_LABELS, string][] = [
  ['wages', 'Everyone who works is paid, every day. It is the largest line in most settlements.'],
  ['imports', 'Buying what the town cannot make for itself, at the world market\u2019s price.'],
  ['upkeep', `Every building costs something to keep standing, from ${maintenanceCost('House')} Gold a day for a house to ${maintenanceCost('Market')} for the market.`],
  ['building', 'What you raise, in Gold and in materials out of the yard.'],
  ['works', 'Bridges to land nobody can walk to, and the roads that follow.'],
  ['vault', 'The other half of the vault door: Gold leaving the treasury when you take a deposit back out.'],
  ['arena', 'Bets that went out at the colosseum. Over time this is the larger of the two arena lines, by design.'],
];

/** What each trade is paid a day, straight from the recipes the game runs. */
const WAGES = (Object.entries(JOBS) as [keyof typeof JOBS, { wage: number }][])
  .map(([job, recipe]) => ({ job, wage: recipe.wage }))
  .sort((a, b) => a.wage - b.wage);

/**
 * Every building, what it is for, and what it costs to raise and to keep.
 *
 * The trades come from the job recipes — so a building's output is literally
 * what its workers make — and the rest are the ones that do something for the
 * settlement without anybody being employed in them.
 */
const TRADE_BUILDINGS = (Object.entries(JOBS) as [keyof typeof JOBS, {
  wage: number; building: string;
  output: Partial<Record<Resource, number>>; input?: Partial<Record<Resource, number>>;
}][]).map(([job, recipe]) => ({
  job,
  type: recipe.building,
  wage: recipe.wage,
  makes: Object.entries(recipe.output).map(([r, n]) => `${n} ${RESOURCE_LABELS[r as Resource].toLowerCase()}`).join(', '),
  needs: Object.entries(recipe.input ?? {}).map(([r, n]) => `${n} ${RESOURCE_LABELS[r as Resource].toLowerCase()}`).join(', '),
}));

const CIVIC_BUILDINGS = [
  ['House', 'Somewhere to live. A settlement with more people than beds has rough sleepers, who lose warmth faster and are unhappier for it.'],
  ['Storage', 'Room for a surplus, and part of how ready the place is for a bad harvest.'],
  ['Market', 'Where trade happens and where people go to eat. The settlement opens with one and it cannot be pulled down.'],
  ['Tavern', 'Where the settlement gathers. Meetups and feasts happen here, and they are what turns neighbours into friends.'],
  ['Bank', 'A counting house. Costs nothing to keep.'],
  ['Town Hall', 'Where the settlement holds a meeting and resolves on something.'],
  ['Cafe', 'Tables on the terrace. Everybody\u2019s company improves a little every day, and gatherings can be held here where there is no tavern.'],
  ['School', 'Everyone learns their trade about a third faster. The single best thing you can do for a young settlement\u2019s output.'],
  ['Library', 'A little learning and a little purpose for everybody, every day.'],
  ['Studio', 'Somewhere to make things. Purpose grows here, which is what keeps people at their trades.'],
  ['Lab', 'Better methods: every trade gets a tenth more out of the same day. It also sees fire, blight and wolves coming, which is worth a well or two.'],
  ['Clinic', 'People survive what would have killed them. Deaths from age and hardship fall by nearly half.'],
] as const;

/** What a plot's status figures mean, and what actually moves them. */
const STATUS = [
  ['Population', 'Everyone alive here, children included. It grows when people are fed, housed and content enough to start families, and when word gets round: a well-run plot with a spare roof draws settlers on the road, and a cafe, a school, a clinic and improved houses draw more — up to three a day. It falls in a hard winter or a bad hazard.',
    'Build houses before you build anything else, and improve them: an improved house sleeps more. Nobody moves to a town with no spare roof, however good it is.'],
  ['Happiness', 'The average of six things each person carries: how fed, how rested, how sociable, how well clothed, how purposeful and how warm they are.',
    'The quickest lever is wages. After that: a tavern and benches for company, clothing in the stores, and firewood through the winter.'],
  ['Energy', 'How rested people are. It drains all day and comes back in a bed — faster in a real house than for somebody sleeping rough.',
    'Houses. Somebody with a bed recovers more than twice as fast as somebody without one.'],
  ['Temperature', 'The actual air temperature, which follows the season, the weather and the biome. Below about twelve degrees people start to lose warmth unless they are sheltered.',
    'Keep wood in the store — a fire is what makes a house warm rather than merely indoors — and keep people in clothing.'],
  ['Woodland', 'Trees standing, and how many are growing back. Woodcutters fell real trees and the forest really thins.',
    'Nothing, if you can help it. A forest regrows on its own; the number to watch is whether it is falling faster than that.'],
  ['Working / outdoors', 'How many people are at their trade right now, and how many are outside. Both move through the day: nobody works at night.',
    'If the working figure is low in daylight, a trade is missing a building or the treasury cannot pay.'],
] as const;

/**
 * What brings each kind of trouble.
 *
 * The answers come from `HAZARD_DEFENCE` in the simulation, so they cannot
 * drift; the causes are written here because the code expresses them as
 * conditions rather than sentences.
 */
const HAZARD_CAUSE: Record<HazardKind, string> = {
  fire: 'Heat and dry air, with buildings close together.',
  blight: 'A growing season, and fields to spoil.',
  wolves: 'A cold night and woodland at the edge of the settlement.',
  flood: 'A storm, and a river to rise.',
  earthquake: 'Hard ground: a shelf or a desert plateau. Rare, and never in the first week.',
  tornado: 'A storm or a heavy sky over open country: steppe, grassland, desert.',
  plague: 'A settlement of nine or more in autumn or winter, with no clinic.',
};

const SECTIONS = [
  ['start', 'Getting started'],
  ['land', 'Land and ownership'],
  ['costs', 'What things cost'],
  ['earning', 'Earning $EMERGE'],
  ['economy', 'The settlement\u2019s own money'],
  ['vault', 'Deposits and withdrawals'],
  ['buildings', 'Buildings'],
  ['eras', 'Eras'],
  ['status', 'Reading your settlement'],
  ['danger', 'What can go wrong'],
  ['world', 'The world itself'],
  ['arena', 'The colosseum'],
  ['together', 'Other players'],
  ['updates', 'Update notes'],
  ['honest', 'What is settled, and what is not'],
] as const;

export default function Wiki() {
  const landOnChain = onChainClaimsLive();
  const live = tokenLive();
  const locale = useLocale();
  if (locale === 'zh') return <WikiZh />;

  return (
    <main className="wiki">
      <div className="wiki-inner">
        <header className="wiki-head">
          <Link href="/" className="wiki-home"><BrandLine size={40} /></Link>
          <LanguageSwitch className="wiki-lang" />
          <h1>How Emerge works</h1>
          <p className="wiki-lede">
            A living world of autonomous beings that you own land in and shape, but do not command.
            This is the whole of it: what you can do, what everything costs, how the money moves,
            and — the part most pages like this leave out — which of it settles on chain today and
            which does not.
          </p>
          <nav className="wiki-nav">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`}>{label}</a>
            ))}
          </nav>
        </header>

        {/* ---------------------------------------------------------- */}
        <section id="start">
          <h2>Getting started</h2>
          <figure className="wiki-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wiki/settlement.jpg" alt="A settlement on day forty-one: the plaza, the trades round it, and people going about the day. The rail on the right reads the place and says what to build next." loading="lazy" />
            <figcaption>A settlement on day forty-one: the plaza, the trades round it, and people going about the day. The rail on the right reads the place and says what to build next.</figcaption>
          </figure>
          <ol className="wiki-steps">
            <li>
              <b>Connect a wallet.</b> MetaMask or Trust Wallet, on {ACTIVE_CHAIN.label}
              {ACTIVE_CHAIN.chainId ? ` (chain ${ACTIVE_CHAIN.chainId})` : ''}. If you have more
              than one wallet installed, pick the one you mean — the game will ask rather than
              guess.
            </li>
            <li>
              <b>Sign in.</b> One free signature on a plain sentence, good for a day. It is not a
              transaction and moves nothing; it proves the wallet is yours so nobody else can spend,
              claim or speak as you.
            </li>
            <li>
              <b>Claim a plot.</b> Pick land on the world map. You pay in {TOKEN.ticker}, it is
              burned, and the plot is yours.
            </li>
            <li>
              <b>Then just watch for a while.</b> Nothing needs doing immediately. The settlement
              runs whether or not you are there.
            </li>
          </ol>
          <p className="wiki-note">
            Everything you own is keyed to your wallet address, not to your browser. Connect the
            same wallet on a different device and your worlds are there.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="land">
          <h2>Land and ownership</h2>
          <figure className="wiki-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wiki/world-map.jpg" alt="The world map: every chart, every island, who holds what. Tap a marker to inspect the land, visit it, make an offer, or claim it." loading="lazy" />
            <figcaption>The world map: every chart, every island, who holds what. Tap a marker to inspect the land, visit it, make an offer, or claim it.</figcaption>
          </figure>
          <p>
            A plot is a seed. The same number that generates its rivers, hills and woodland is the
            number that identifies it, so no two plots are the same land and the ground you see
            before you buy is the ground you get.
          </p>
          <p>
            <b>One owner per plot, always.</b> A claim is written once and cannot be overwritten;
            if two people go for the same land in the same instant, exactly one gets it and the
            other is refused before paying. Your land is held against your wallet address, so it
            survives clearing your browser, changing device, or coming back months later.
          </p>
          <p>
            <b>Nothing is recorded until it is paid for.</b> The registry reads your burn off the
            chain before it writes a title — right wallet, right amount, settled, not already spent
            on something else. There is no way to get land without paying for it, and no way to pay
            without getting it.
          </p>
          <p>
            <b>Resale is player to player.</b> A plot you put up for sale shows on everybody&rsquo;s
            map with its price. The buyer pays your wallet directly in {TOKEN.ticker} — a plain
            transfer, nothing burned, nothing taken by the game — and the registry moves the plot to
            them once it has read that transfer off the chain, from their wallet, to yours, for at
            least what you asked. The settlement goes with the land. The world holds room for about
            two hundred plots across twelve charts, and the map says how many are claimed and how
            many are left.
          </p>
          <p>
            <b>Offers.</b> Any plot can be offered for, listed or not: name a price on its card and
            the owner sees it in their On-Chain panel and gets a card saying so. Accepting holds the
            plot for that bidder at that price for two days; they pay your wallet to take it,
            exactly as for a listed sale. Nothing is escrowed — an offer is a price, not a deposit —
            so a bidder who walks away costs nobody anything, and the hold simply lapses.
          </p>
          {!landOnChain && (
            <div className="wiki-callout">
              <b>Land is held in our registry, not as a token in your wallet — yet.</b>
              <p>
                The land contract is not deployed. Ownership is enforced for every player and tied
                to your address, but it is a record we keep rather than an on-chain title you hold
                independently of us. When the contract goes live, a plot becomes an ERC-721 token
                whose id is its seed, and claims move across. Said plainly here because the
                difference is real and you should know which one you have.
              </p>
            </div>
          )}
          <h3>What a plot costs</h3>
          <p>Priced by what the land supports, from the seed alone:</p>
          <table className="wiki-table">
            <thead><tr><th>Biome</th><th>Price</th></tr></thead>
            <tbody>
              {PLOT_PRICES.map(({ kind, price }) => (
                <tr key={kind}>
                  <td style={{ textTransform: 'capitalize' }}>{kind}</td>
                  <td className="num">{n(price)} {TOKEN.ticker}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">
            You may hold as many plots as you like. Only the first {EARNING_PLOT_LIMIT} you claimed
            earn — see below.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="costs">
          <h2>What things cost</h2>
          <p>
            <b>Every charge is burned.</b> Not sent to us, not collected by anybody, not held in a
            treasury — destroyed, so the supply falls each time. There is no address the project
            takes a cut into, because there is no cut.
          </p>
          <table className="wiki-table">
            <thead><tr><th>Action</th><th>Cost</th><th /></tr></thead>
            <tbody>
              {CHARGES.map((row) => (
                <tr key={row.what}>
                  <td>{row.what}</td>
                  <td className="num">{row.cost}</td>
                  <td className="muted">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">
            Building, demolishing, moving people around and everything else inside your settlement
            costs Gold, not {TOKEN.ticker}. Gold is the settlement&rsquo;s own money and never
            leaves it.
          </p>
          <h3>Expanding a plot</h3>
          <p>
            An expansion makes the plot itself bigger. A ring of new ground appears on every side
            of the land you have — about half as much land again — with the river running on into
            it, wildlife on it, and the wood on it yours to clear or build over. Nothing you have
            built moves: the settlement stays exactly where it is and the edge moves out. It costs
            {' '}{n(EXPAND_COST_EMERGE)} {TOKEN.ticker}, burned like every other charge, and can be
            bought <b>once per plot</b>, from the On-Chain panel inside the world. The registry
            records it against the plot, so it follows the land to any device and to a new owner
            if the plot is sold.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="earning">
          <h2>Earning</h2>
          <p>
            You are not paid for holding land. You are paid for running it well, and the rate is
            worked out fresh every day from the state of your settlement. This section is about
            {' '}{TOKEN.ticker} coming to <em>your wallet</em>; the Gold your citizens earn is a
            separate thing and has <a href="#economy">its own section below</a>.
          </p>
          <div className="wiki-formula">
            <code>daily yield = {n(STEWARDSHIP_DAILY_CAP)} × quality × attention</code>
            <span>per plot, per real day</span>
          </div>
          <p>
            <b>Quality</b> is how the place is actually doing — housed (25%), fed (25%), employed
            (20%), content (20%) and safe (10%). <b>Attention</b> is how recently you did anything
            about it: full if you have just acted, sliding down over about a day and a half of
            silence to a floor of {pct(0.08)}. A world nobody touches earns a fraction of one that
            is being run.
          </p>
          <table className="wiki-table">
            <thead>
              <tr><th>How it is going</th><th>One plot</th><th>{EARNING_PLOT_LIMIT} plots</th></tr>
            </thead>
            <tbody>
              {EXAMPLES.map((row) => (
                <tr key={row.how}>
                  <td>{row.how}</td>
                  <td className="num">{n(yieldFor(row.score, row.attention))}</td>
                  <td className="num">{n(yieldFor(row.score, row.attention) * EARNING_PLOT_LIMIT)}</td>
                </tr>
              ))}
              <tr className="wiki-total">
                <td>Absolute ceiling</td>
                <td className="num">{n(STEWARDSHIP_DAILY_CAP)}</td>
                <td className="num">{n(DAILY_EARN_CEILING)}</td>
              </tr>
            </tbody>
          </table>
          <p className="wiki-note">
            All figures are {TOKEN.ticker} per real day. Only your first {EARNING_PLOT_LIMIT} plots
            pay, and {n(DAILY_EARN_CEILING)} a day is a hard ceiling per wallet — so no amount of
            money buys past it. That is deliberate: the cap is what stops the game being a machine
            for turning capital into tokens.
          </p>
          <h3>Earning without land: hired hands</h3>
          <p>
            You do not need a plot to earn, only a job. An owner can open one on their plot; a
            player with no land of their own who holds at least <b>{n(HAND_MIN_EMERGE)} {TOKEN.ticker}</b>
            {' '}takes it from the world map and goes to work. Work is a visit that pays: while you
            have that settlement open and in view, you are paid <b>{Math.round(HAND_SHARE * 100)}%</b> of
            what its stewardship comes to, up to {n(HAND_DAILY_CEILING)} {TOKEN.ticker} a day, by the
            vault — never out of the owner&rsquo;s yield.
          </p>
          <p>
            The owner gets something real for it: while a hand is at work the plot counts as
            attended, so their rate holds while they are away. One hand per plot, one job per
            wallet, and never a landholder — a landholder has their own plot to run. Your shift
            starts at full rate and slides the same way an owner&rsquo;s attention does, so a
            tab left open all week earns about what it would earn an owner: very little.
          </p>

          {!landOnChain && (
            <div className="wiki-callout warn">
              <b>Stewardship does not pay out yet.</b>
              <p>
                Your world accrues yield and the Bank shows it, but collecting it to your wallet is
                switched off until the land contract is deployed. Paying stewardship needs a way to
                prove a wallet genuinely holds land — otherwise anyone could spin up addresses and
                collect the daily ceiling on each, having spent nothing. Until that check exists,
                the door stays shut rather than open and exploitable.
              </p>
              <p>
                <b>Everything else is live.</b> Claiming, burning, deposits and withdrawals of your
                own {TOKEN.ticker} all work today. If you are here for the yield, that is the one
                thing worth waiting for, and we would rather tell you now than after you bought
                land for it.
              </p>
            </div>
          )}
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="economy">
          <h2>The settlement&rsquo;s own money</h2>
          <figure className="wiki-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wiki/market.jpg" alt="One market across every world. Prices are the same everywhere; what your store buys and sells is its own." loading="lazy" />
            <figcaption>One market across every world. Prices are the same everywhere; what your store buys and sells is its own.</figcaption>
          </figure>
          <p>
            There are two moneys in Emerge and they do different jobs.
            {' '}<b>{TOKEN.ticker}</b> is yours: it lives in your wallet, it buys land, and every
            charge burns it. <b>Gold</b> is the town&rsquo;s: it pays the people who live there and
            buys the things they cannot make. Your citizens earn it, spend it and are paid it all
            day, whether or not you are watching.
          </p>

          <h3>How a settlement makes money</h3>
          <p>
            Four ways, and three of them are the townspeople rather than you:
          </p>
          <table className="wiki-table">
            <thead><tr><th>Coming in</th><th /></tr></thead>
            <tbody>
              {INCOME.map(([line, what]) => (
                <tr key={`in-${line}`}>
                  <td className="ledger">{LEDGER_LABELS[line]}</td>
                  <td className="muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <b>It is a circle, not a tap.</b> The treasury pays wages in the morning; the people
            who were paid buy bread, clothes and furniture from the stalls during the day; most of
            that money comes back to the treasury as household spending and food sales. A
            settlement that produces more than it consumes ends the day up. One that does not ends
            it down, and you will see it in the Bank the same evening.
          </p>

          <h3>What it pays out</h3>
          <table className="wiki-table">
            <thead><tr><th>Going out</th><th /></tr></thead>
            <tbody>
              {SPENDING.map(([line, what]) => (
                <tr key={`out-${line}`}>
                  <td className="ledger">{LEDGER_LABELS[line]}</td>
                  <td className="muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Wages are the big one, and they are per person per day:
          </p>
          <table className="wiki-table">
            <thead><tr><th>Trade</th><th>A day&rsquo;s wage</th></tr></thead>
            <tbody>
              {WAGES.map(({ job, wage }) => (
                <tr key={job}>
                  <td style={{ textTransform: 'capitalize' }}>{job}</td>
                  <td className="num">{wage} Gold</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">
            If the treasury cannot cover the payroll, everybody is paid a share of what there is
            and the feed says so. Nobody is sacked for it, but people get poorer, and poorer people
            buy less, which is how a settlement talks itself into a slump.
          </p>

          <h3>What you pay them</h3>
          <p>
            You set the wage, from {pct(WAGE_MIN)} of the going rate to {pct(WAGE_MAX)}, in the
            Bank. It is a dial with a cost at both ends and no free setting.
          </p>
          <table className="wiki-table">
            <thead><tr><th>You pay</th><th>Work done</th><th>What happens</th></tr></thead>
            <tbody>
              {[WAGE_MIN, 0.75, WAGE_STANDARD, 1.3, WAGE_MAX].map((rate) => (
                <tr key={rate}>
                  <td className="num">{pct(rate)}</td>
                  <td className="num">{pct(wageEffort(rate))}</td>
                  <td className="muted">
                    {rate < WAGE_STANDARD
                      ? 'People do less and lose heart. Over a long run the town ends up smaller and poorer than if you had paid properly.'
                      : rate > WAGE_STANDARD
                        ? 'A happier, growing settlement, paid for out of the treasury. It does not pay for itself in goods.'
                        : 'People work as expected and their purpose holds steady.'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wiki-note">
            Those numbers are not a guess — the curve was set by running eight settlements for a
            hundred and fifty days at each setting. An earlier version gave generous pay a large
            production bonus, and the extra goods sold more than repaid the extra wages, which made
            generosity free. It is not free now.
          </p>

          <h3>Why the world market matters to your books</h3>
          <p>
            Exports and imports are both priced by the shared market, so what your land is
            <em> good at</em> is now worth real money. A settlement sitting on a surplus of
            something scarce across every world sells it dearly; one that has to buy in what
            everybody else is also short of pays dearly for it. Nine biomes support different
            trades, which is what makes a plot&rsquo;s biome an economic decision rather than a
            colour.
          </p>
          <p>
            Your citizens read this too. When the world pays well for metal, more of them take up
            mining and smithing — unless the town is hungry, in which case they farm, because
            feeding themselves comes first.
          </p>

          <div className="wiki-callout">
            <b>Gold is not a second withdrawal door.</b>
            <p>
              This is the honest part, and it is the reason the game has an economy at all. Gold
              your settlement earns stays in the settlement. It is not convertible to
              {' '}{TOKEN.ticker}: what the vault will send you is capped by what the chain shows
              you deposited, so a rich treasury does not become tokens, however well the town is
              run.
            </p>
            <p>
              Letting Gold out was tried and it broke everything — a world became a machine for
              printing tokens and nothing else about it mattered. The reward for running a place
              well is stewardship yield, which is capped, and the place itself getting bigger.
            </p>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="vault">
          <h2>Deposits and withdrawals</h2>
          <figure className="wiki-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wiki/bank.jpg" alt="The Bank: the treasury, wages and the day’s books. The doors in and out of the vault are further down the same panel." loading="lazy" />
            <figcaption>The Bank: the treasury, what stewardship has earned, and the doors in and out of the vault.</figcaption>
          </figure>
          <p>
            Gold funds your settlement; {TOKEN.ticker} is the token behind it. You can move your own
            money both ways.
          </p>
          <table className="wiki-table">
            <tbody>
              <tr><td>Rate</td><td className="num">{n(EMERGE_PER_GOLD)} {TOKEN.ticker} = 1 Gold</td></tr>
              <tr><td>Deposit fee</td><td className="num">none</td></tr>
              <tr><td>Withdrawal</td><td className="num">{pct(WITHDRAW_BURN_RATE)} held back and burned</td></tr>
              <tr><td>Gift to another world</td><td className="num">up to {n(MAX_GIFT_GOLD)} Gold at a time</td></tr>
            </tbody>
          </table>
          <p>
            <b>Deposits are the one thing not burned</b>, and for an obvious reason: it is your own
            money and the withdrawal door has to be able to give it back. Deposits go to the vault
            and are credited only after the chain confirms they arrived — from your wallet,
            specifically, so nobody can claim credit for a deposit you made.
          </p>
          <p>
            <b>Withdrawals are automatic.</b> Press withdraw and the vault signs a transfer to your
            wallet there and then; the Bank hands you the transaction so you can check it yourself.
            Nobody approves it and nobody can decide not to. What you can take out is what the chain
            says you put in — so it is the same figure on every device, and no one can withdraw more
            than they deposited.
          </p>
          <p className="wiki-note">
            Gold your settlement earns on its own is not withdrawable — see
            {' '}<a href="#economy">the settlement&rsquo;s own money</a> for what it is and what it
            does. What comes out of the vault is what you put in, plus stewardship yield when that
            opens.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="buildings">
          <h2>Buildings</h2>
          <figure className="wiki-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wiki/build.jpg" alt="The Build panel: what each building costs in Gold, timber and stone, and what the yard holds." loading="lazy" />
            <figcaption>The Build panel: what each building costs in Gold, timber and stone, and what the yard holds.</figcaption>
          </figure>
          <p>
            You cannot tell anybody what to do, so a building is how you say what the settlement
            needs. Raise one and somebody will decide it is theirs — immediately, if it is standing
            empty. Each holds <b>two workers</b>, except a mine, which holds three.
          </p>
          <p>
            Everything costs Gold <em>and</em> materials out of the yard, so what you can raise
            depends on what your woodcutters have felled and your quarry has cut. Every building
            also costs Gold every day to keep standing, for as long as it stands.
          </p>
          <p>
            <b>The settlement builds for itself.</b> When the treasury holds twice a building&rsquo;s
            price and a fortnight of wages and upkeep besides, and the yard has the timber and
            stone, it raises what it is short of without being asked: a roof for anybody sleeping
            rough first, then a farm or a woodcutter when the stores are thin, then whatever the
            plot helper would tell you next — a store, a cafe, a school, a clinic, a lab, a trade
            the land supports. One building a day at most, and the feed says what it built and why.
          </p>

          <h3>The trades</h3>
          <p>Nine of them turn land into goods, and each is a link in a chain:</p>
          <table className="wiki-table">
            <thead>
              <tr>
                <th>Building</th><th>To raise</th><th>Upkeep</th><th>Makes a day</th><th>Out of</th><th>Wage</th>
              </tr>
            </thead>
            <tbody>
              {TRADE_BUILDINGS.map((b) => {
                const need = BUILD_MATERIALS[b.type] ?? { wood: 10, stone: 4 };
                return (
                  <tr key={b.type}>
                    <td>{b.type}</td>
                    <td className="num">
                      {(BUILD_COSTS[b.type] ?? 250).toLocaleString()}g
                      <em className="matter"> · {need.wood}w {need.stone}s</em>
                    </td>
                    <td className="num">{maintenanceCost(b.type)}g</td>
                    <td>{b.makes}</td>
                    <td className="muted">{b.needs || '—'}</td>
                    <td className="num">{b.wage}g</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="wiki-note">
            Per worker, per day, before the land, the season, the weather and what you pay have had
            their say. A farm on fertile ground grows more than the same farm on sand; a farm in
            winter grows less than the same farm in summer; and everything is multiplied by the
            wage you set. &ldquo;Out of&rdquo; is what the trade consumes — a baker with no flour
            bakes nothing, however many bakers you have.
          </p>

          <h3>Fishing, hunting and foraging</h3>
          <p>
            Three trades work out of doors, and the settlement is a better thing to watch for it.
            A <b>Fishery</b> puts fishers on the bank nearest the hut, rod out over the water.
            Every fisher goes through <b>{BAIT_GOLD} Gold</b> of bait a day, booked under
            &ldquo;Bait and arrows&rdquo; in the Bank, and about one day in seven a rod snaps and
            <b>{ROD_WOOD} timber</b> goes to a new one. No Gold for bait or no timber for a rod
            halves the catch until there is. Winter and storms slow it; a coast or a river
            speeds it.
          </p>
          <p>
            A <b>Lodge</b> sends hunters after the animals that actually live on the plot. Every
            land has its own &mdash; deer, boar and fox under trees; goats and elk on the
            shelf; antelope on the steppe; gazelle on the dunes; ducks on the fen; boar and a
            gator in the swamp &mdash; and they graze, wander and bolt from anybody who walks
            too close. A hunter picks one, closes on it, brings it down and carries it back to
            the store: the kill is credited the moment it happens, game and hides both, scaled
            by skill. Each hunter uses <b>{ARROW_WOOD} timber</b> of arrows a day, and a short
            quiver means lighter kills. The herd comes back a head or two a day up to what the
            land carries, so a lodge that hunts faster than that empties its own wood. Hunters
            also count toward readiness for wolves.
          </p>
          <p>
            A <b>Forager</b> camp sends people onto the open ground for berries and herbs, heavy
            in autumn and thin under snow. Fish, game and berries are eaten alongside bread;
            hides and herbs are sold, and herbs are the dearest thing a small settlement makes.
          </p>

          <h3>Everything else</h3>
          <table className="wiki-table">
            <thead><tr><th>Building</th><th>To raise</th><th>Upkeep</th><th>What it is for</th></tr></thead>
            <tbody>
              {CIVIC_BUILDINGS.map(([type, what]) => (
                <tr key={type}>
                  <td>{type}</td>
                  <td className="num">
                    {(BUILD_COSTS[type] ?? 250).toLocaleString()}g
                    <em className="matter"> · {(BUILD_MATERIALS[type] ?? { wood: 10 }).wood}w {(BUILD_MATERIALS[type] ?? { stone: 4 }).stone}s</em>
                  </td>
                  <td className="num">{maintenanceCost(type)}g</td>
                  <td className="muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Clearing trees</h3>
          <p>
            The Build panel carries a tool for the wood: tap the ground with it and every standing
            tree within reach is felled, for <b>{CLEAR_TREE_GOLD} Gold a tree</b>, with{' '}
            <b>{CLEAR_TREE_WOOD} timber each</b> going to the yard. Cleared ground stays cleared
            through a reload and grows back over the following days, the same way a woodcutter&rsquo;s
            work does, so clear where you mean to build rather than for the view.
          </p>
          <h3>Moving and improving</h3>
          <p>
            A building&rsquo;s card has two buttons besides the trade it does. <b>Move</b> picks it
            up and arms the placing cursor: tap the ground and it goes there, for{' '}
            <b>{Math.round(MOVE_SHARE * 100)}% of what it cost to raise</b>. Roads are cut to the
            new spot and anybody who was walking to the old one is given somewhere else to be.
            Nothing is lost by moving except the Gold. One rule for placing anything, moved or new:
            it must leave <b>room to walk between it and its neighbours</b>. Two buildings that
            touch make a seam nobody can pass, and the cursor will refuse the spot and say so.
          </p>
          <p>
            <b>Improve</b> spends Gold and materials to take a building up a level, to a maximum of{' '}
            <b>{MAX_BUILDING_LEVEL}</b>. The first step costs {Math.round(UPGRADE_STEPS[0] * 100)}%
            of the original price, the second {Math.round(UPGRADE_STEPS[1] * 100)}%, in Gold and in
            timber and stone both — so the top level is a decision, not a formality. Each level adds
            about <b>{Math.round(OUTPUT_PER_LEVEL * 100)}% to what the building produces</b> and{' '}
            <b>{Math.round(UPKEEP_PER_LEVEL * 100)}% to its upkeep</b>. It does not hold more workers — and
            it shows: lanterns and a banner at the second level, a glass annex, a taller frame and
            gold along the eaves at the third. An improved workshop
            earns its keep if it is staffed and supplied; an improved one standing idle is simply a
            larger bill every day.
          </p>
          <p className="wiki-note">
            Anything can be pulled down from its card except the market, the bank and the town hall
            — those hold the settlement together — and any house somebody still lives in. Pulling
            something down salvages <b>half the timber and stone</b> back into the yard. The Gold is
            gone; what you get is the upkeep stopped, and that is usually the point of doing it.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="eras">
          <h2>Eras</h2>
          <p>
            Every plot begins in the <b>Settlement</b> era: timber and thatch, hand tools, dirt
            lanes, everybody on foot. When it has earned it, the owner can advance it one era at a
            time. Five are named; the second is built and the rest are gated and coming.
          </p>
          <table className="wiki-table">
            <thead><tr><th>Era</th><th>Days</th><th>What it asks</th><th>What arrives</th></tr></thead>
            <tbody>
              <tr><td>Settlement</td><td className="num">&mdash;</td><td>&mdash;</td><td>Where every plot starts.</td></tr>
              <tr><td>Township</td><td className="num">60</td><td>40 people, 30 buildings, a Town Hall, a Bank, a School and a Jail, 20,000 Gold in the treasury, no ruins standing</td><td>Stone and tile, cobbled streets, carts, the ferry; Chapel, Guildhall, Brewery, Printer, Stables, Harbour</td></tr>
              <tr><td>Industrial</td><td className="num">90</td><td>70 people, 50 buildings, a Lab and a Library, 300 iron ore, the plot expanded</td><td className="muted">Not built yet</td></tr>
              <tr><td>Modern</td><td className="num">120</td><td>110 people, 75 buildings, a Hospital and a Stadium, the plot expanded</td><td className="muted">Not built yet</td></tr>
              <tr><td>AI</td><td className="num">150</td><td>160 people, 100 buildings, a Research Campus and a Power Plant, the plot expanded, stewardship above 0.7</td><td className="muted">Not built yet</td></tr>
            </tbody>
          </table>
          <p>
            The days are counted in the era the plot is in, and the checklist is drawn from things
            the settlement already measures. Both are shown on the <b>ERA</b> card in the On-Chain
            panel, line by line, with a tick against each one met. When every line is met the
            button offers the step for {n(ADVANCE_COST_EMERGE)} {TOKEN.ticker}, burned like every
            other charge. The world is published first and the registry judges the checklist on the
            copy it holds, so nothing on your own device can be edited into an era. The era is
            recorded against the plot and follows it to any device and to a buyer.
          </p>
          <h3>What a township changes</h3>
          <ul>
            <li><b>The look.</b> Buildings raised or improved after the step are stone with tiled roofs; the ones you already had keep their timber until you improve them, so an old stone chapel in the middle of a modern town is the right picture. Dirt lanes become cobbles. People wear wool coats and hats.</li>
            <li><b>Carts.</b> A Stables puts every working adult on a cart while they are on the move, four tenths faster than walking. The cart is drawn under them.</li>
            <li><b>The ferry.</b> A Harbour puts a boat on every channel. People cross open water on it where there is no bridge, and every island counts as reachable, so a settlement hemmed in by water can spread to all of its land. Bridges stay, and the roads still run over them. If the Harbour is ruined, anyone out on the water swims for the bank.</li>
            <li><b>Six buildings.</b> Chapel (company and purpose), Guildhall (learning), Brewery (company), Printer (purpose and learning), Stables, Harbour. They cost Gold, timber and stone like everything else and appear on their shelves in the Build panel once the plot is a township.</li>
          </ul>
          <h3>Shelves</h3>
          <p>
            The Build panel sorts every building onto a shelf: Homes, Food, Materials, Civic, Care
            and learning, Leisure, Transport and Utilities. A building from a later era is shown
            greyed with the name of the era it belongs to, so you can see what is coming. The
            settlement&rsquo;s own builder raises only what the plot&rsquo;s era allows.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="status">
          <h2>Reading your settlement</h2>
          <p>
            The panel in the corner is the settlement&rsquo;s vital signs. None of these is a score
            you are given — each is measured from the people who live there, and each has something
            you can actually do about it.
          </p>
          <table className="wiki-table">
            <thead><tr><th>Figure</th><th>What it is</th><th>How to move it</th></tr></thead>
            <tbody>
              {STATUS.map(([label, what, how]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="muted">{what}</td>
                  <td>{how}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <b>Happiness is the one that pays.</b> It is one fifth of the stewardship score, and it
            is the fifth you have the most direct hold on — the other four are housing, food, work
            and safety, which are all buildings and preparation.
          </p>
          <p className="wiki-note">
            Everybody carries all six needs separately, and you can read any one person&rsquo;s by
            tapping them. A settlement whose average happiness is fine can still contain somebody
            cold, friendless and about to change trade.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="danger">
          <h2>What can go wrong</h2>
          <figure className="wiki-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wiki/danger.jpg" alt="A tornado over the west side, and two buildings already in ruins. The banner says what it is doing and what the storm crews would cost." loading="lazy" />
            <figcaption>A tornado over the west side. The banner says what it is doing and what the storm crews would cost; the card in the corner says the settlement is in danger.</figcaption>
          </figure>
          <p>
            Seven things, and none of them is random punishment: each wants particular conditions,
            and each has something that answers it. A hazard that arrives at a settlement which is
            ready for it costs close to nothing. One that arrives at a settlement which is not can
            take a building, a harvest, or somebody&rsquo;s life.
          </p>
          <p>
            Three of them are disasters that run by the hour and can be watched. An <b>earthquake</b>
            shakes the whole plot for hours, cracks walls, brings some down and rattles the rest
            with aftershocks. A <b>tornado</b> comes down at the edge of the map and crosses it,
            wrecking whatever it passes over, until it lifts. A <b>flood</b> climbs the bank over
            days and takes the buildings standing in the water. A <b>plague</b> passes between
            people standing together, slows the sick, and kills some of them; herbs in store are
            the physic, one a day per patient.
          </p>
          <p>
            <b>You can spend Gold against any of them, once.</b> The red bar under the clock, and
            the What could go wrong panel, offer the one thing that answers each: bucket chains,
            burning the blighted rows, a night watch, sandbags along the bank, shoring up the
            walls, storm crews, a quarantine. The price scales with how bad it is and how much
            town there is to save, and each does exactly what the panel says. Buildings a disaster
            wrecks are <b>ruins</b> &mdash; out of use, smoking, a heap of stone &mdash; until you
            rebuild them from the building card for about six tenths of the Gold and materials
            they cost new. Damage short of a ruin the carpenters patch on their own, two timber a
            day.
          </p>
          <table className="wiki-table">
            <thead><tr><th>Trouble</th><th>What brings it</th><th>What answers it</th></tr></thead>
            <tbody>
              {(Object.keys(HAZARD_LABELS) as HazardKind[]).map((kind) => (
                <tr key={kind}>
                  <td>{HAZARD_LABELS[kind]}</td>
                  <td className="muted">{HAZARD_CAUSE[kind]}</td>
                  <td>{HAZARD_DEFENCE[kind]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            The <b>What could go wrong</b> panel shows how ready you are for each, as a percentage,
            <em> before</em> anything happens. That is the whole point of it: readiness is something
            to build in a quiet week, not something to read afterwards.
          </p>
          <h3>People who turn</h3>
          <p>
            Once in a while somebody turns on the settlement: the miserable, the purposeless, or
            somebody with a real enemy in the town. They take up a torch and set about the nearest
            building, and it comes down in a few hours. <b>You have no hand in it.</b> You cannot
            lift them away, and you cannot lift away the people who go after them. The three
            nearest adults awake drop what they are doing and give chase; when one gets within
            arm&rsquo;s reach there is a scuffle, and it ends with the rogue thrown in the jail, or
            &mdash; twice at most &mdash; broken free and off after the next building. Somebody
            who has already brought two buildings down is not taken alive. A <b>Jail</b> halves
            how often anybody turns, and holds them; without one, the market cellar does.
          </p>
          <p className="wiki-note">
            Readiness is not a purchase. It is counted from what is actually there — wells within
            reach and enough people awake nearby, food put by and somewhere to keep it, fires
            burning through a cold night, buildings set back from the water. Safety is a tenth of
            the stewardship score, so a settlement that is never ready is quietly paid less for it.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="world">
          <h2>The world itself</h2>
          <p>
            Every being on your plot has their own hunger, energy, trade, friendships and grudges.
            They wake, work, argue, fall in love, raise children and bury their dead whether or not
            you are watching. <b>You cannot tell anyone what to do.</b> You can build them a
            workshop and watch somebody decide it is theirs.
          </p>
          <p>
            What you actually control is the place: fund the treasury, raise houses and workshops,
            pull down what is not working, cut roads and bridges to land nobody can reach. A camp of
            eight becomes a town of thirty because of decisions you made, or it does not.
          </p>
          <p>
            Seasons turn, weather lands, food runs short in a bad winter, and a settlement with no
            farm in a desert will struggle exactly as much as you would expect. Nine biomes, each
            supporting different trades — which is why they are priced differently.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="arena">
          <h2>The colosseum</h2>
          <p>
            An island nobody owns and anybody can walk into, whether or not they hold land. Players
            enter a citizen; the arena pairs two of them and runs a bout every three minutes, and
            everybody watching sees the same fight at the same moment.
          </p>
          <h3>Sending somebody</h3>
          <p>
            The Arena panel lists the five people in your settlement most fit to fight. Fitness is
            not a hidden combat stat — it is rest, food, warmth and clothing, so the way to a good
            fighter is to run a good settlement. Skill is the trade they have spent their life at.
            Strength decides only <em>how often somebody lands a blow</em>, never how hard, which is
            why even a lopsided pairing is worth watching.
          </p>
          <p>
            <b>An entry is good for one bout.</b> Whoever is drawn comes off the roster the moment
            the pairing is made and goes home when the bell goes. Sending them back out is a
            decision you make again each time, not something that keeps happening to them.
          </p>
          <h3>Betting</h3>
          <p>
            Two minutes of each bout are open for betting; the last minute is the fight. Stakes come
            out of the settlement&rsquo;s treasury and wins go back into it, booked in the Bank&rsquo;s
            daily accounts so you can see exactly what the arena has cost you. Bets settle against
            the house at the odds shown, which are measured from the fight itself — several thousand
            simulated bouts of that exact pairing — so the price you are offered cannot drift from
            what actually happens. The house keeps a margin, and over time the arena takes more than
            it pays.
          </p>
          <p className="wiki-note">
            <b>The result cannot be known early and cannot be rigged.</b> The arena draws a secret
            when it makes a bout and publishes only its hash. Betting runs against that hash; the
            secret is released the moment betting closes, and the fight is computed from it. Nobody,
            the house included, can know the winner while money is going on — and afterwards anybody
            can check that the secret matches the hash published beforehand. The Arena panel does
            that check itself, in your browser, and says either way.
          </p>
          <p className="wiki-note">
            Arena Gold is Gold, not {TOKEN.ticker}. Winning at the colosseum makes your settlement
            richer; it does not mint anything and cannot be withdrawn as a token.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="together">
          <h2>Other players</h2>
          <figure className="wiki-figure">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wiki/chat.jpg" alt="Chat, with a channel for the world you are standing in and a global one. A badge means a wallet signed the message; a spectator tag means nobody did." loading="lazy" />
            <figcaption>Chat, with a channel for the world you are standing in and a global one. A badge means a wallet signed the message; a spectator tag means nobody did.</figcaption>
          </figure>
          <p>
            Every plot anybody has claimed sits on one shared map. You can visit the settlements
            other people have built — tap a marker, or tap somebody&rsquo;s name in chat — and see
            their world as they last left it.
          </p>
          <p>
            A visit is a visit: you can watch and follow people around, but you cannot build, pull
            anything down, or earn there. You cannot see their treasury either. The one thing a
            visitor may do is <b>put Gold into a settlement they like the look of</b>, up to
            {' '}{n(MAX_GIFT_GOLD)} Gold at a time, paid for in {TOKEN.ticker} at the usual rate.
          </p>
          <p>
            Chat has a global channel and one for the world you are standing in. A message posted
            under a wallet is signed by that wallet — so a name with a badge beside it really is
            that address, and cannot be worn by somebody else.
          </p>
          <p>
            <b>You can look before you connect anything.</b> The front door has a <em>just watch</em>
            {' '}button: a spectator walks the world map, visits any settlement and talks in chat,
            marked as a spectator on every message so nobody mistakes them for a landholder.
            Claiming, building and earning still need a wallet.
          </p>
          <p>
            <b>Your settlement follows you.</b> It is saved in your browser every fifteen seconds
            and published to the server; whichever copy is further along is the one that continues
            when you open the world anywhere, and the server refuses a copy that would put the
            world backwards — so a tab left open on an old device cannot undo a week of building
            on a new one.
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="updates">
          <h2>Update notes</h2>
          {UPDATES.map((u) => (
            <div key={u.version} className="wiki-update">
              <h3>v{u.version} — {u.title} <em>{u.date}</em></h3>
              <ul>
                {u.notes.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          ))}
        </section>

        {/* ---------------------------------------------------------- */}
        <section id="honest">
          <h2>What is settled, and what is not</h2>
          <p>
            The useful question about any game like this is which parts the chain enforces and which
            parts are a company&rsquo;s word. Here is the whole answer.
          </p>
          <table className="wiki-table status">
            <tbody>
              <tr>
                <td>{TOKEN.ticker} balances</td>
                <td className={live ? 'yes' : 'no'}>{live ? 'On chain' : 'Local development build'}</td>
                <td className="muted">read from your wallet</td>
              </tr>
              <tr>
                <td>Charges and burns</td>
                <td className={live ? 'yes' : 'no'}>{live ? 'On chain' : 'Local'}</td>
                <td className="muted">signed by you, supply falls</td>
              </tr>
              <tr>
                <td>Deposits</td>
                <td className={live ? 'yes' : 'no'}>{live ? 'On chain' : 'Local'}</td>
                <td className="muted">verified before crediting</td>
              </tr>
              <tr>
                <td>Withdrawals</td>
                <td className={live ? 'yes' : 'no'}>{live ? 'On chain, automatic' : 'Local'}</td>
                <td className="muted">the vault signs, you get the hash</td>
              </tr>
              <tr>
                <td>Land ownership</td>
                <td className={landOnChain ? 'yes' : 'partial'}>
                  {landOnChain ? 'On chain (ERC-721)' : 'Our registry'}
                </td>
                <td className="muted">
                  {landOnChain ? 'a token in your wallet' : 'enforced, tied to your address, not yet a token'}
                </td>
              </tr>
              <tr>
                <td>Stewardship payouts</td>
                <td className={landOnChain ? 'yes' : live ? 'partial' : 'no'}>
                  {landOnChain ? 'On chain' : live ? 'Paid' : 'Not yet'}
                </td>
                <td className="muted">
                  {landOnChain
                    ? 'paid from the vault'
                    : live
                      ? 'from the vault, to wallets on our land record'
                      : 'waiting on the token'}
                </td>
              </tr>
              <tr>
                <td>The simulation</td>
                <td className="partial">Off chain</td>
                <td className="muted">it runs in your browser, as it must to be responsive</td>
              </tr>
              <tr>
                <td>Your settlement</td>
                <td className="partial">Saved</td>
                <td className="muted">
                  in this browser and on our server; open it on another device and the copy that is
                  further along continues
                </td>
              </tr>
            </tbody>
          </table>
          <p className="wiki-note">
            Two things worth knowing plainly. Gold and everything inside a settlement is game state,
            not money — the only door out of the game is withdrawing what you deposited. And the
            land record lives in a database we run: no other player can take your plot, but it is
            our word rather than the chain&rsquo;s until the contract ships.
          </p>
        </section>

        <footer className="wiki-foot">
          <Link href="/" className="wiki-back">Back to the game</Link>
          <p className="muted small">
            Every figure on this page is read from the code that enforces it, so it cannot drift
            from what the game actually does.
          </p>
        </footer>
      </div>
    </main>
  );
}
