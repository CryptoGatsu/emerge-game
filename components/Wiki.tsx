'use client';

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
  RENAME_CITIZEN_EMERGE, RENAME_COST_EMERGE, RENAME_PLAYER_EMERGE, WITHDRAW_BURN_RATE,
} from '@/lib/chain/vault';
import { DIG_COST_EMERGE } from '@/lib/chain/gacha';
import {
  JOBS, LEDGER_LABELS, STEWARDSHIP_DAILY_CAP, WAGE_MAX, WAGE_MIN, WAGE_STANDARD,
  maintenanceCost, wageEffort,
} from '@/lib/simulation';
import { MAX_GIFT_GOLD } from '@/lib/limits';
import { BASE_PRICE, BIOME_KINDS_BY_INDEX, BIOME_PREMIUM, PRICE_SCALE } from '@/lib/world/price';
import { BrandLine } from './Brand';

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
];

/** What each trade is paid a day, straight from the recipes the game runs. */
const WAGES = (Object.entries(JOBS) as [keyof typeof JOBS, { wage: number }][])
  .map(([job, recipe]) => ({ job, wage: recipe.wage }))
  .sort((a, b) => a.wage - b.wage);

const SECTIONS = [
  ['start', 'Getting started'],
  ['land', 'Land and ownership'],
  ['costs', 'What things cost'],
  ['earning', 'Earning $EMERGE'],
  ['economy', 'The settlement\u2019s own money'],
  ['vault', 'Deposits and withdrawals'],
  ['world', 'The world itself'],
  ['together', 'Other players'],
  ['honest', 'What is settled, and what is not'],
] as const;

export default function Wiki() {
  const landOnChain = onChainClaimsLive();
  const live = tokenLive();

  return (
    <main className="wiki">
      <div className="wiki-inner">
        <header className="wiki-head">
          <Link href="/" className="wiki-home"><BrandLine size={40} /></Link>
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
        <section id="together">
          <h2>Other players</h2>
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
                <td className={landOnChain ? 'yes' : 'no'}>
                  {landOnChain ? 'On chain' : 'Not yet'}
                </td>
                <td className="muted">
                  {landOnChain ? 'paid from the vault' : 'waiting on the land contract'}
                </td>
              </tr>
              <tr>
                <td>The simulation</td>
                <td className="partial">Off chain</td>
                <td className="muted">it runs in your browser, as it must to be responsive</td>
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
