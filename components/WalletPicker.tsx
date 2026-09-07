'use client';

/**
 * Wallet connection.
 *
 * Lists the wallets actually installed in this browser, discovered through
 * EIP-6963, so a player with both MetaMask and Trust Wallet gets to choose
 * rather than having whichever one won the injection race picked for them.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ACTIVE_CHAIN, INITIAL_WALLET, PREFERRED_WALLETS, connectWallet, discoverWallets,
  resumeWallet, shortAddress, switchToEmergeChain, walletDeepLinks, walletSighting,
  type DiscoveredWallet, type WalletState,
} from '@/lib/chain/emerge';
import { t, useLocale } from '@/lib/i18n';

/**
 * One wallet, shared by everything that asks for it.
 *
 * This used to be ordinary component state, which meant every caller of
 * `useWallet` had its own copy: connecting on the world map left the chat
 * panel and the On-Chain panel still reading "no wallet", and the player record
 * — which is keyed by address — could not agree with itself about whose it was.
 * A module-level value with subscribers is the smallest thing that fixes it,
 * and a wallet connection genuinely is one per page rather than one per panel.
 */
let current: WalletState = INITIAL_WALLET;
const listeners = new Set<(state: WalletState) => void>();

function publish(next: WalletState) {
  current = next;
  for (const listener of listeners) listener(next);
}

/** What is connected right now, for code that is not a component. */
export const currentWallet = () => current;

/**
 * Which wallet the player last used, remembered across reloads.
 *
 * Only the name: the address comes back from the wallet itself, which is the
 * only party entitled to say who is connected.
 */
const LAST_WALLET = 'emerge.wallet.v1';

const rememberWallet = (name: string | null) => {
  try {
    if (name) window.localStorage.setItem(LAST_WALLET, name);
    else window.localStorage.removeItem(LAST_WALLET);
  } catch { /* private browsing; the session still works, it just will not resume */ }
};

const lastWallet = () => {
  try {
    return window.localStorage.getItem(LAST_WALLET);
  } catch {
    return null;
  }
};

/**
 * Pick the connection back up on load.
 *
 * Runs once for the page, not once per component, and never prompts: a silent
 * `eth_accounts` either reports an authorisation the player already gave or
 * reports nothing.
 */
let resuming: Promise<void> | null = null;

function resumeOnce(available: DiscoveredWallet[]) {
  if (resuming || current.status === 'connected') return;

  /*
   * Only resume a wallet we can identify.
   *
   * This used to fall back to `available[0]` — whichever extension happened to
   * be first in the list — and then ask it for accounts. A second wallet
   * installed alongside the intended one answers that question perfectly well
   * about *its own* account, so the game would silently come up connected to
   * the wrong wallet, showing an address the player does not recognise on a
   * chain they are not on, and every signature after that would be refused by
   * a wallet that had never heard of the account being asked about.
   *
   * So: the wallet they last chose, or the only one there. With several
   * installed and no memory of a choice, resuming is a guess — and the right
   * answer to a guess about somebody's money is to ask.
   */
  const remembered = lastWallet();
  const preferred = remembered
    ? available.find((w) => w.name === remembered)
    : available.length === 1
      ? available[0]
      : undefined;
  if (!preferred) return;

  resuming = resumeWallet(preferred).then((state) => {
    if (state && current.status !== 'connected') publish(state);
  }).catch(() => { /* nothing to resume */ });
}

/** "MetaMask, Trust Wallet and Binance Wallet": a list said the way a person says one. */
const listOf = (words: readonly string[], conj: string) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')}${conj}${words[words.length - 1]}`;

export function useWallet() {
  const [wallet, setLocal] = useState<WalletState>(current);
  const [available, setAvailable] = useState<DiscoveredWallet[]>([]);

  useEffect(() => {
    listeners.add(setLocal);
    // Another component may have connected between this one's first render and
    // its subscription; take whatever is current rather than the render-time copy.
    setLocal(current);
    return () => { listeners.delete(setLocal); };
  }, []);

  useEffect(() => discoverWallets(setAvailable), []);

  // Wallets announce themselves asynchronously, so the resume waits for the
  // list rather than firing at mount and finding nothing.
  useEffect(() => { resumeOnce(available); }, [available]);

  const connect = useCallback(async (choice?: DiscoveredWallet) => {
    publish({ ...current, status: 'connecting' });
    const state = await connectWallet(choice);
    if (state.status === 'connected') rememberWallet(state.wallet);
    publish(state);
  }, []);

  return { wallet, available, connect, disconnect: disconnectWallet, setWallet: publish };
}

/**
 * Let go of the wallet.
 *
 * Forgets which wallet was remembered as well, or the silent resume on the
 * next load would connect it straight back. Nothing the player owns is
 * touched: the record is keyed by address and is still there when they
 * connect again.
 */
export function disconnectWallet() {
  rememberWallet(null);
  publish(INITIAL_WALLET);
}

export function WalletPicker({ compact = false }: { compact?: boolean }) {
  const { wallet, available, connect } = useWallet();
  const [notice, setNotice] = useState<string | null>(null);
  useLocale();

  if (wallet.status === 'connected') {
    const wrongChain = ACTIVE_CHAIN.chainId !== null && wallet.chainId !== ACTIVE_CHAIN.chainId;
    return (
      <div className="wallet-box">
        <span className="wallet-ok">◈ {shortAddress(wallet.address)}</span>
        <small className="muted">{wallet.wallet} · {t('chain')} {wallet.chainId ?? '—'}</small>
        {wrongChain && (
          <button className="ghost" onClick={async () => setNotice(await switchToEmergeChain())}>
            {t('Switch to {chain}', { chain: ACTIVE_CHAIN.label })}
          </button>
        )}
        {notice && <p className="warn">{notice}</p>}
      </div>
    );
  }

  if (!available.length) {
    const sighting = walletSighting();
    return (
      <div className="wallet-box">
        <small className="muted">
          {t('No wallet detected. {wallets} works with {chain}', { wallets: listOf(PREFERRED_WALLETS, t(' or ')), chain: ACTIVE_CHAIN.label })}
          {compact ? t(' — you can still claim and play.') : '.'}
        </small>
        {sighting.mobile && !sighting.inApp && (
          <small className="muted wallet-open">
            {t('A phone browser has no wallet in it. Open this page inside your wallet’s own browser:')}
            {' '}
            {walletDeepLinks().map((l) => <a key={l.name} href={l.href}>{l.name}</a>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ' · ', el] : [el]), [])}
            {' · '}
            {t('Binance: in the Binance app, open Wallet → Web3 and enter emergerh.world on its Discover page.')}
          </small>
        )}
        {!compact && (
          <details className="wallet-why">
            <summary>{t('Why can’t the game see my wallet?')}</summary>
            <small className="muted">
              {t('The game listens for wallets that announce themselves and looks for the ones that only inject, for eight seconds after the page opens. What it can see right now:')}
              {' '}<code>{sighting.line}</code>{' '}
              {t('If your wallet is installed and this says none, send this line to support.')}
            </small>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-box">
      {!compact && <small className="muted">{t('{wallets} all work with {chain}.', { wallets: listOf(PREFERRED_WALLETS, t(' and ')), chain: ACTIVE_CHAIN.label })}</small>}
      <div className="wallet-options">
        {available.map((option) => (
          <button key={option.id} className="wallet-option" onClick={() => connect(option)} disabled={wallet.status === 'connecting'}>
            {option.icon
              // Wallet-supplied icons are data URIs from the extension itself.
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={option.icon} alt="" width={18} height={18} />
              : <span className="wallet-dot">◈</span>}
            {option.name}
          </button>
        ))}
      </div>
      {wallet.error && <p className="warn">{wallet.error}</p>}
    </div>
  );
}
