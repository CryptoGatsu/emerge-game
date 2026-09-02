'use client';

/**
 * The front door.
 *
 * What Emerge is, in the order somebody deciding whether to play needs it, and
 * one thing to do at the end of it. Nothing past this point works without a
 * wallet — a plot belongs to an address, and so does the balance, the name and
 * every token earned on it — so the page asks for one rather than letting
 * somebody get as far as choosing land and then telling them.
 *
 * It is deliberately not a wall. Everything here is readable without
 * connecting, because a person who has never heard of this should be able to
 * find out what it is before being asked for anything.
 */

import { ACTIVE_CHAIN, TOKEN, tokenLive } from '@/lib/chain/emerge';
import { EARNING_PLOT_LIMIT, DAILY_EARN_CEILING } from '@/lib/chain/vault';
import { WalletPicker, useWallet } from './WalletPicker';

const PILLARS = [
  {
    icon: '✦',
    title: 'They are not waiting for orders',
    body: `Every being on your plot has their own hunger, trade, friends and grudges. They wake,
      work, argue, fall in love, raise children and bury their dead whether or not you are
      watching. You cannot tell anyone what to do — you can build them a workshop and watch
      somebody decide it is theirs.`,
  },
  {
    icon: '⌂',
    title: 'You shape the place',
    body: `Fund the treasury, raise houses and workshops, pull down what is not working, cut roads
      and bridges to land nobody can reach. A camp of eight becomes a town of thirty because of
      decisions you made, or it does not.`,
  },
  {
    icon: '◈',
    title: 'You are paid for judgement',
    body: `Running a settlement well mints ${TOKEN.ticker} — housed, fed, employed, content and
      ready for what the season brings. Neglect it and the yield falls to almost nothing. Up to
      ${EARNING_PLOT_LIMIT} plots pay, so the ceiling is ${DAILY_EARN_CEILING.toLocaleString()} a
      real day and no wallet is large enough to buy past it.`,
  },
  {
    icon: '◉',
    title: 'Other people are in here',
    body: `Every plot anybody has claimed is on one shared map, and no two players can own the
      same land. Visit the settlements other people built, talk to them in a global channel or
      one for the world you are standing in, and send Gold to a town you like the look of.`,
  },
];

export default function Landing({ onEnter }: { onEnter: () => void }) {
  const { wallet } = useWallet();
  const connected = wallet.status === 'connected' && !!wallet.address;

  return (
    <main className="landing">
      <div className="landing-inner">
        <header className="landing-head">
          <div className="brand-line">
            <div className="brand-mark">✦</div>
            <div>
              <div className="wordmark">EMERGE</div>
              <div className="tagline">THE AI WORLD</div>
            </div>
          </div>
          <h1>A new world. A life of its own.</h1>
          <p className="landing-lede">
            Emerge is a living world of autonomous beings. Claim a plot, name the world that grows
            there, and the people who live in it will call it that. They think, they work, they
            fall out with each other and they get on with their lives. You do not control them.
            You discover them, and you shape the world they live in.
          </p>
        </header>

        <div className="pillars">
          {PILLARS.map((pillar) => (
            <section key={pillar.title} className="pillar">
              <div className="pillar-icon" aria-hidden>{pillar.icon}</div>
              <h2>{pillar.title}</h2>
              <p>{pillar.body}</p>
            </section>
          ))}
        </div>

        <section className="landing-gate">
          {connected ? (
            <>
              <span className="eyebrow">READY</span>
              <h2>The map is open.</h2>
              <p className="muted">
                Everything you claim, earn and are called belongs to this address.
              </p>
              <div className="claim-wallet"><WalletPicker compact /></div>
              <button className="claim-button" onClick={onEnter}>Open the world map</button>
            </>
          ) : (
            <>
              <span className="eyebrow">CONNECT TO PLAY</span>
              <h2>A plot belongs to an address.</h2>
              <p className="muted">
                So does your balance, your name and everything you earn. Connect a wallet and the
                map opens; nothing before that point costs you anything.
              </p>
              <div className="claim-wallet"><WalletPicker /></div>
            </>
          )}
        </section>

        <footer className="landing-foot">
          <p className="muted small">
            Built on {ACTIVE_CHAIN.label}
            {ACTIVE_CHAIN.chainId ? ` · chain ${ACTIVE_CHAIN.chainId}` : ''}.
            {' '}
            {tokenLive()
              ? `Balances are read from the ${TOKEN.ticker} contract and every charge is burned on chain.`
              : `The ${TOKEN.ticker} contract is not deployed yet, so balances are a local development allocation and nothing on this page moves a real token. Every panel says so where it matters.`}
          </p>
        </footer>
      </div>
    </main>
  );
}
