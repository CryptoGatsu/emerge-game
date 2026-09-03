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
import { VERSION } from '@/lib/version';
import TokenStats from './TokenStats';
import { WalletPicker, useWallet } from './WalletPicker';
import { LanguageSwitch } from './LanguageSwitch';
import { t, useLocale } from '@/lib/i18n';

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
    title: t('Nobody is waiting for orders'),
    body: t('Every being on your plot has their own hunger, trade, friends and grudges. You cannot tell anyone what to do — you build them a workshop and watch somebody decide it is theirs.'),
  },
  onChainLand
    ? {
        title: t('The land is yours, on chain'),
        body: t('A plot is a token in your wallet, not a row in our database. Its price, its owner and its name are all read from the contract, and no one — this game included — can move it.'),
      }
    : {
        title: t('The land is yours, and paid for'),
        body: t('Claiming burns {ticker} from your own wallet, and the registry will not record a plot until it has read that burn off the chain. One owner per plot, held against your address rather than your browser, so it follows you to any device. The land contract is not deployed yet, so this is our registry rather than an on-chain title — said plainly here because it is the difference that matters.', { ticker: TOKEN.ticker }),
      },
  onChainLand
    ? {
        title: t('You are paid for judgement'),
        body: t('Running a settlement well earns {ticker}; neglecting it earns almost nothing. Only your first {limit} plots pay, so no wallet is large enough to buy past the ceiling.', { ticker: TOKEN.ticker, limit: EARNING_PLOT_LIMIT }),
      }
    : {
        title: t('Every charge is burned'),
        body: t('Claiming land, surveying it, renaming a world: each one destroys the {ticker} it costs, and the supply falls with it. Nothing the game charges is collected by anybody. Deposits are the one exception, because the withdrawal door has to be able to give them back.', { ticker: TOKEN.ticker }),
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
      <span className="contract-label">{t('{ticker} CONTRACT', { ticker: TOKEN.ticker })}</span>
      <button className="contract-address" onClick={copy} title={t('Copy the contract address')}>
        <code>{address}</code>
        <em>{copied ? t('copied') : t('copy')}</em>
      </button>
      <p className="muted small">
        {t('On {chain}{id}. Check it before you buy, and trust nothing that does not match.', { chain: ACTIVE_CHAIN.label, id: ACTIVE_CHAIN.chainId ? ` · chain ${ACTIVE_CHAIN.chainId}` : '' })}
        {ACTIVE_CHAIN.explorerUrl && (
          <>
            {' '}
            <a
              href={`${ACTIVE_CHAIN.explorerUrl.replace(/\/$/, '')}/token/${address}`}
              target="_blank"
              rel="noreferrer noopener"
            >{t('View it on the explorer')}</a>.
          </>
        )}
      </p>
    </section>
  );
}

/**
 * The front door, with a side door.
 *
 * Nothing past this point *costs* anything without a wallet, but until now
 * nothing past it could be *seen* without one either, and a game that will
 * not show itself to somebody who has not signed anything yet is asking for
 * trust it has not earned. So there is a second way in: just watch. A
 * spectator can walk the world map, visit any settlement and talk in chat,
 * badged as a spectator so nobody mistakes them for a landholder. Claiming,
 * building and earning still need an address, and the map says so.
 */
export default function Landing({ onEnter, onSpectate }: { onEnter: () => void; onSpectate: () => void }) {
  const { wallet } = useWallet();
  const connected = wallet.status === 'connected' && !!wallet.address;
  useLocale();

  return (
    <main className="landing">
      <div className="landing-inner">
        <LanguageSwitch className="landing-lang" />
        <section className="hero">
          {/*
            The mark, at the size it was drawn to be seen at. Rendered with
            pixelated smoothing because it is pixel art: the browser's default
            bilinear scaling turns every hard edge in it to mush.
          */}
          <Image
            className="hero-mark"
            src="/emerge-logo.png"
            alt={t('Emerge — the AI world')}
            width={320}
            height={320}
            priority
          />
          <h1>{t('A world that gets on with its life.')}</h1>
          <p className="hero-lede">
            {t('Claim a plot of land, name the world that grows on it, and the beings who live there will call it that. They think, they work, they fall out with each other and they bury their dead whether or not you are watching. You do not control them. You shape the place they live in.')}
          </p>

          <div className="gate">
            {connected ? (
              <>
                <button className="enter-button" onClick={onEnter}>{t('Open the world map')}</button>
                <div className="gate-wallet"><WalletPicker compact /></div>
                <p className="muted small">
                  {t('Everything you claim, earn and are called belongs to this address.')}
                </p>
              </>
            ) : (
              <>
                <div className="gate-wallet"><WalletPicker /></div>
                <p className="muted small">
                  {t('A plot belongs to an address, and so does your balance and your name. Connect a wallet and the map opens — nothing before that point costs you anything.')}
                </p>
                <button className="ghost spectate-button" onClick={onSpectate}>{t('Just watch for now')}</button>
                <p className="muted small">
                  {t('Look around without connecting anything: visit any settlement and talk in chat as a spectator. Connect a wallet whenever you want land of your own.')}
                </p>
              </>
            )}
            <a className="gate-guide" href="/wiki">
              {t('Read the guide first')} &rarr;
            </a>
          </div>
        </section>

        <ContractAddress />
        <TokenStats />

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
            <a href="/wiki">{t('Guide')}</a>
            <span aria-hidden>·</span>
            <span className="foot-version">v{VERSION}</span>
            <span aria-hidden>·</span>
            <a href={X_URL} target="_blank" rel="noreferrer noopener">@emergerh</a>
            <span aria-hidden>·</span>
            <span>{SITE_DOMAIN}</span>
            <span aria-hidden>·</span>
            <span>{ACTIVE_CHAIN.label}{ACTIVE_CHAIN.chainId ? ` · chain ${ACTIVE_CHAIN.chainId}` : ''}</span>
          </div>
          <p className="muted small">
            {onChainClaimsLive()
              ? t('Land is an ERC-721 token whose id is the plot’s own seed, so ownership is readable on any explorer without asking us. Every {ticker} the game charges is burned; deposits are held in the vault so they can be given back.', { ticker: TOKEN.ticker })
              : tokenLive()
                ? t('Balances are read from the {ticker} contract and every charge is burned on chain. The land registry contract is not deployed yet, so ownership is held in the shared registry — enforced for every player, but not yet an on-chain title.', { ticker: TOKEN.ticker })
                : t('The {ticker} contract is not deployed yet, so balances are a local development allocation and nothing on this page moves a real token. Every panel says so where it matters.', { ticker: TOKEN.ticker })}
          </p>
        </footer>
      </div>
    </main>
  );
}
