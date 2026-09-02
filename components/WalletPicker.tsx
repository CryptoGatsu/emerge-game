'use client';

/**
 * Wallet connection.
 *
 * Lists the wallets actually installed in this browser, discovered through
 * EIP-6963, so a player with both MetaMask and Trust Wallet gets to choose
 * rather than having whichever one won the injection race picked for them.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ACTIVE_CHAIN, INITIAL_WALLET, PREFERRED_WALLETS, connectWallet, discoverWallets,
  shortAddress, switchToEmergeChain,
  type DiscoveredWallet, type WalletState,
} from '@/lib/chain/emerge';

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

  const connect = useCallback(async (choice?: DiscoveredWallet) => {
    publish({ ...current, status: 'connecting' });
    publish(await connectWallet(choice));
  }, []);

  return { wallet, available, connect, setWallet: publish };
}

export function WalletPicker({ compact = false }: { compact?: boolean }) {
  const { wallet, available, connect } = useWallet();
  const [notice, setNotice] = useState<string | null>(null);

  if (wallet.status === 'connected') {
    const wrongChain = ACTIVE_CHAIN.chainId !== null && wallet.chainId !== ACTIVE_CHAIN.chainId;
    return (
      <div className="wallet-box">
        <span className="wallet-ok">◈ {shortAddress(wallet.address)}</span>
        <small className="muted">{wallet.wallet} · chain {wallet.chainId ?? '—'}</small>
        {wrongChain && (
          <button className="ghost" onClick={async () => setNotice(await switchToEmergeChain())}>
            Switch to {ACTIVE_CHAIN.label}
          </button>
        )}
        {notice && <p className="warn">{notice}</p>}
      </div>
    );
  }

  if (!available.length) {
    return (
      <div className="wallet-box">
        <small className="muted">
          No wallet detected. {PREFERRED_WALLETS.join(' or ')} works with {ACTIVE_CHAIN.label}
          {compact ? ' — you can still claim and play.' : '.'}
        </small>
      </div>
    );
  }

  return (
    <div className="wallet-box">
      {!compact && <small className="muted">{PREFERRED_WALLETS.join(' and ')} both work with {ACTIVE_CHAIN.label}.</small>}
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
