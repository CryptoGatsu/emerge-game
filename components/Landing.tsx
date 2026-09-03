'use client';

/**
 * The front door.
 *
 * One screen. The mark, one sentence about what this is, and the one thing
 * there is to do — connect a wallet and open the map. Everything that used to
 * be argued in four cards up here is now three short lines under the fold, for
 * somebody who wants them, and the game itself is where the rest is learned.
 *
 * Nothing past this point works without a wallet — a plot is a token in an
 * address, and so is the balance, the name and everything earned on it — so the
 * page asks for one rather than letting somebody get as far as choosing land
 * and then telling them. It is still not a wall: every word here is readable
 * without connecting anything.
 */

import Image from 'next/image';
import { useState } from 'react';
import { ACTIVE_CHAIN, TOKEN, tokenLive } from '@/lib/chain/emerge';
import { onChainClaimsLive } from '@/lib/chain/registry';
import { EARNING_PLOT_LIMIT } from '@/lib/chain/vault';
import { WalletPicker, useWallet } from './WalletPicker';

/** Where to find the project outside the game. */
export const X_URL = 'https://x.com/emergerh';
export const SITE_DOMAIN = 'emergerh.world';

/**
 * The three notes under the fold.
 *
 * The middle one and the last one both depend on what is actually deployed, and
 * they are written out per case rather than hedged. A front page that says land
 * is a token in your wallet while the land contract does not exist is a lie,
 * and on a token project's front page that is the kind of lie people are right
 * to leave over.
 */
const notesFor = (onChainLand: boolean) => [
  {
    title: 'Nobody is waiting for orders',
    body: `Every being on your plot has their own hunger, trade, friends and grudges. You cannot
      tell anyone what to do — you build them a workshop and watch somebody decide it is theirs.`,
  },
  onChainLand
    ? {
        title: 'The land is yours, on chain',
        body: `A plot is a token in your wallet, not a row in our database. Its price, its owner
          and its name are all read from the contract, and no one — this game included — can
          move it.`,
      }
    : {
        title: 'The land is yours, and paid for',
        body: `Claiming burns ${TOKEN.ticker} from your own wallet, and the registry will not
          record a plot until it has read that burn off the chain. One owner per plot, held
          against your address rather than your browser, so it follows you to any device. The
          land contract is not deployed yet, so this is our registry rather than an on-chain
          title — said plainly here because it is the difference that matters.`,
      },
  onChainLand
    ? {
        title: 'You are paid for judgement',
        body: `Running a settlement well earns ${TOKEN.ticker}; neglecting it earns almost
          nothing. Only your first ${EARNING_PLOT_LIMIT} plots pay, so no wallet is large enough
          to buy past the ceiling.`,
      }
    : {
        title: 'Every charge is burned',
        body: `Claiming land, surveying it, renaming a world: each one destroys the
          ${TOKEN.ticker} it costs, and the supply falls with it. Nothing the game charges is
          collected by anybody. Deposits are the one exception, because the withdrawal door has
          to be able to give them back.`,
      },
];

/**
 * The token's address, offered to be copied.
 *
 * Read from the chain config rather than written out here, so the address on
 * the front page is the one the game actually transacts against and the two
 * cannot drift. Shown in full: an abbreviated contract address is no use to
 * somebody who wants to paste it into a wallet, and around a launch a
 * half-shown address is exactly what an impersonator relies on.
 */
function ContractAddress() {
  const [copied, setCopied] = useState(false);
  const address = ACTIVE_CHAIN.tokenAddress;
  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard refused; the address is on screen to be selected by hand.
    }
  };

  return (
    <section className="contract">
      <span className="contract-label">{TOKEN.ticker} CONTRACT</span>
      <button className="contract-address" onClick={copy} title="Copy the contract address">
        <code>{address}</code>
        <em>{copied ? 'copied' : 'copy'}</em>
      </button>
      <p className="muted small">
        On {ACTIVE_CHAIN.label}{ACTIVE_CHAIN.chainId ? ` · chain ${ACTIVE_CHAIN.chainId}` : ''}. Check
        it before you buy, and trust nothing that does not match.
        {ACTIVE_CHAIN.explorerUrl && (
          <>
            {' '}
            <a
              href={`${ACTIVE_CHAIN.explorerUrl.replace(/\/$/, '')}/token/${address}`}
              target="_blank"
              rel="noreferrer noopener"
            >View it on the explorer</a>.
          </>
        )}
      </p>
    </section>
  );
}

export default function Landing({ onEnter }: { onEnter: () => void }) {
  const { wallet } = useWallet();
  const connected = wallet.status === 'connected' && !!wallet.address;

  return (
    <main className="landing">
      <div className="landing-inner">
        <section className="hero">
          {/*
            The mark, at the size it was drawn to be seen at. Rendered with
            pixelated smoothing because it is pixel art: the browser's default
            bilinear scaling turns every hard edge in it to mush.
          */}
          <Image
            className="hero-mark"
            src="/emerge-logo.png"
            alt="Emerge — the AI world"
            width={320}
            height={320}
            priority
          />
          <h1>A world that gets on with its life.</h1>
          <p className="hero-lede">
            Claim a plot of land, name the world that grows on it, and the beings who live there
            will call it that. They think, they work, they fall out with each other and they bury
            their dead whether or not you are watching. You do not control them. You shape the
            place they live in.
          </p>

          <div className="gate">
            {connected ? (
              <>
                <button className="enter-button" onClick={onEnter}>Open the world map</button>
                <div className="gate-wallet"><WalletPicker compact /></div>
                <p className="muted small">
                  Everything you claim, earn and are called belongs to this address.
                </p>
              </>
            ) : (
              <>
                <div className="gate-wallet"><WalletPicker /></div>
                <p className="muted small">
                  A plot belongs to an address, and so does your balance and your name. Connect a
                  wallet and the map opens — nothing before that point costs you anything.
                </p>
              </>
            )}
          </div>
        </section>

        <ContractAddress />

        <section className="notes">
          {notesFor(onChainClaimsLive()).map((note) => (
            <article key={note.title}>
              <h2>{note.title}</h2>
              <p>{note.body}</p>
            </article>
          ))}
        </section>

        <footer className="landing-foot">
          <div className="foot-links">
            <a href={X_URL} target="_blank" rel="noreferrer noopener">@emergerh</a>
            <span aria-hidden>·</span>
            <span>{SITE_DOMAIN}</span>
            <span aria-hidden>·</span>
            <span>{ACTIVE_CHAIN.label}{ACTIVE_CHAIN.chainId ? ` · chain ${ACTIVE_CHAIN.chainId}` : ''}</span>
          </div>
          <p className="muted small">
            {onChainClaimsLive()
              ? `Land is an ERC-721 token whose id is the plot's own seed, so ownership is readable on any explorer without asking us. Every ${TOKEN.ticker} the game charges is burned; deposits are held in the vault so they can be given back.`
              : tokenLive()
                ? `Balances are read from the ${TOKEN.ticker} contract and every charge is burned on chain. The land registry contract is not deployed yet, so ownership is held in the shared registry — enforced for every player, but not yet an on-chain title.`
                : `The ${TOKEN.ticker} contract is not deployed yet, so balances are a local development allocation and nothing on this page moves a real token. Every panel says so where it matters.`}
          </p>
        </footer>
      </div>
    </main>
  );
}
