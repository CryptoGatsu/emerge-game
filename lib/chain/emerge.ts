/**
 * Robinhood Chain / $EMERGE integration boundary.
 *
 * Emerge is a hybrid: the living world — movement, needs, production ticks,
 * every routine AI decision — stays off-chain so the settlement is always
 * responsive. The chain is reserved for ownership, the token economy and player
 * actions that want verifiable settlement.
 *
 * Nothing in this module is called from the simulation tick. It is deliberately
 * a thin, dependency-free EIP-1193 layer so a wallet or contract call can never
 * stall a frame; the world keeps running whether or not a wallet is connected.
 */

export const TOKEN = {
  name: 'Emerge',
  symbol: 'EMERGE',
  ticker: '$EMERGE',
  decimals: 18,
} as const;

/**
 * Network descriptors.
 *
 * The two Robinhood Chain networks are built in: their RPC endpoints and chain
 * ids are public facts about the network, not deployment secrets, so a build
 * with no environment set still knows how to reach the chain and can ask a
 * wallet to switch to it. The environment still wins where it is set, so a fork
 * or a local node is a matter of one variable.
 *
 * What is *not* built in is the $EMERGE token address and the land registry —
 * those are this game's own deployments, and until they exist the interface
 * says so rather than pretending a claim settled.
 */
export interface ChainConfig {
  key: 'robinhood' | 'robinhood-testnet';
  label: string;
  chainId: number | null;
  rpcUrl: string | null;
  explorerUrl: string | null;
  tokenAddress: string | null;
  /** The land registry, once one is deployed. Ownership is read from here. */
  registryAddress: string | null;
}

const envNumber = (value: string | undefined, fallback: number | null = null) => {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Robinhood Chain mainnet. */
export const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const MAINNET_CHAIN_ID = 4663;
/** Robinhood Chain testnet. Note the `/rpc` path — the host alone is not an endpoint. */
export const TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com/rpc';
export const TESTNET_CHAIN_ID = 46630;

export const CHAINS: Record<ChainConfig['key'], ChainConfig> = {
  robinhood: {
    key: 'robinhood',
    label: 'Robinhood Chain',
    chainId: envNumber(process.env.NEXT_PUBLIC_ROBINHOOD_CHAIN_ID, MAINNET_CHAIN_ID),
    rpcUrl: process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? MAINNET_RPC,
    explorerUrl: process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER ?? null,
    tokenAddress: process.env.NEXT_PUBLIC_EMERGE_TOKEN ?? null,
    registryAddress: process.env.NEXT_PUBLIC_EMERGE_REGISTRY ?? null,
  },
  'robinhood-testnet': {
    key: 'robinhood-testnet',
    label: 'Robinhood Chain (test)',
    chainId: envNumber(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_CHAIN_ID, TESTNET_CHAIN_ID),
    rpcUrl: process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL ?? TESTNET_RPC,
    explorerUrl: process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_EXPLORER ?? null,
    tokenAddress: process.env.NEXT_PUBLIC_EMERGE_TOKEN_TESTNET ?? null,
    registryAddress: process.env.NEXT_PUBLIC_EMERGE_REGISTRY_TESTNET ?? null,
  },
};

/**
 * Which network this build targets.
 *
 * Mainnet, because that is where the token will live. Set
 * `NEXT_PUBLIC_CHAIN_TARGET=testnet` to point a build at the test network
 * instead — useful for trying a contract before it is deployed for real.
 *
 * Targeting a chain is not the same as having anything deployed on it: what
 * makes a claim or a balance real is the token and registry addresses, and
 * every panel says plainly which of those exist yet.
 */
export const ACTIVE_CHAIN: ChainConfig =
  process.env.NEXT_PUBLIC_CHAIN_TARGET === 'testnet' ? CHAINS['robinhood-testnet'] : CHAINS.robinhood;

/** True once the build knows how to reach the network. Built in, so: always. */
export const chainConfigured = (config: ChainConfig = ACTIVE_CHAIN) =>
  config.chainId !== null && !!config.rpcUrl;

/**
 * True once the $EMERGE contract itself is deployed and known to this build.
 *
 * This is the honest test, and the one the interface should ask. Knowing the
 * network's RPC does not mean there is a token to move: until an address is
 * set, a balance on screen is a local development allocation and every claim is
 * a row in this browser's storage.
 */
export const tokenLive = (config: ChainConfig = ACTIVE_CHAIN) =>
  chainConfigured(config) && !!config.tokenAddress;

/* ------------------------------------------------------------------ *
 * Wallet
 * ------------------------------------------------------------------ */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

interface Eip6963ProviderInfo { uuid: string; name: string; icon: string; rdns: string }
interface Eip6963AnnounceEvent extends Event { detail: { info: Eip6963ProviderInfo; provider: Eip1193Provider } }

declare global {
  interface Window { ethereum?: Eip1193Provider & { providers?: Eip1193Provider[]; isMetaMask?: boolean; isTrust?: boolean; isTrustWallet?: boolean } }
}

export interface DiscoveredWallet {
  id: string;
  name: string;
  icon: string | null;
  rdns: string | null;
  provider: Eip1193Provider;
}

/** Wallets we name explicitly, because they are the ones Robinhood Chain users have. */
export const PREFERRED_WALLETS = ['MetaMask', 'Trust Wallet'] as const;

const nameFromLegacy = (provider: Window['ethereum']) => {
  if (!provider) return 'Browser wallet';
  if (provider.isMetaMask) return 'MetaMask';
  if (provider.isTrust || provider.isTrustWallet) return 'Trust Wallet';
  return 'Browser wallet';
};

/**
 * Find the wallets installed in this browser.
 *
 * Uses EIP-6963 announcements, which is how MetaMask and Trust Wallet both
 * advertise themselves when more than one extension is present — reading
 * `window.ethereum` alone silently picks whichever one won the injection race.
 * The legacy object is still used as a fallback for older wallets.
 *
 * Returns an unsubscribe function; call it on unmount.
 */
export function discoverWallets(onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const found = new Map<string, DiscoveredWallet>();

  const publish = () => onChange([...found.values()]);

  const onAnnounce = (event: Event) => {
    const { info, provider } = (event as Eip6963AnnounceEvent).detail;
    if (!info || !provider) return;
    found.set(info.rdns || info.uuid, {
      id: info.rdns || info.uuid,
      name: info.name,
      icon: info.icon ?? null,
      rdns: info.rdns ?? null,
      provider,
    });
    publish();
  };

  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Fall back to the injected object for wallets that do not announce.
  const legacy = window.ethereum;
  if (legacy) {
    const list = legacy.providers?.length ? legacy.providers : [legacy];
    list.forEach((provider, i) => {
      const named = nameFromLegacy(provider as Window['ethereum']);
      const id = `legacy:${named}:${i}`;
      if (![...found.values()].some((w) => w.name === named)) {
        found.set(id, { id, name: named, icon: null, rdns: null, provider });
      }
    });
    publish();
  }

  return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
}

export interface WalletState {
  status: 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'error';
  address: string | null;
  chainId: number | null;
  /** Which wallet is connected, for the interface to show. */
  wallet: string | null;
  error: string | null;
}

export const INITIAL_WALLET: WalletState = { status: 'disconnected', address: null, chainId: null, wallet: null, error: null };

export function walletAvailable() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

export function shortAddress(address: string | null) {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Request accounts from a wallet. Any failure resolves to an error state rather
 * than throwing, so a rejected prompt is never a crash mid-game.
 */
export async function connectWallet(wallet?: DiscoveredWallet): Promise<WalletState> {
  const provider = wallet?.provider ?? (typeof window !== 'undefined' ? window.ethereum : undefined);
  const label = wallet?.name ?? nameFromLegacy(typeof window !== 'undefined' ? window.ethereum : undefined);
  if (!provider) {
    return { status: 'unsupported', address: null, chainId: null, wallet: null, error: 'No browser wallet detected.' };
  }
  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    const rawChain = (await provider.request({ method: 'eth_chainId' })) as string;
    return {
      status: accounts?.length ? 'connected' : 'disconnected',
      address: accounts?.[0] ?? null,
      chainId: Number.parseInt(rawChain, 16) || null,
      wallet: label,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wallet connection was rejected.';
    return { status: 'error', address: null, chainId: null, wallet: label, error: message };
  }
}

/**
 * Reconnect a wallet the player has already authorised, without a prompt.
 *
 * `eth_accounts` reports what the wallet has already granted this site and
 * never opens a dialogue, so it is safe to call on every load. Without it a
 * connection lasted exactly as long as the tab: reloading, or coming back to
 * the game later, left the player looking at "connect a wallet" while the
 * wallet itself considered them connected — and everything they own is keyed
 * by that address.
 */
export async function resumeWallet(preferred?: DiscoveredWallet): Promise<WalletState | null> {
  const provider = preferred?.provider ?? (typeof window !== 'undefined' ? window.ethereum : undefined);
  if (!provider) return null;
  const label = preferred?.name ?? nameFromLegacy(typeof window !== 'undefined' ? window.ethereum : undefined);
  try {
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
    if (!accounts?.length) return null;
    const rawChain = (await provider.request({ method: 'eth_chainId' })) as string;
    return {
      status: 'connected',
      address: accounts[0],
      chainId: Number.parseInt(rawChain, 16) || null,
      wallet: label,
      error: null,
    };
  } catch {
    // A wallet that will not answer a silent query is simply not connected.
    return null;
  }
}

/** Ask the wallet to switch to the configured Emerge network. */
export async function switchToEmergeChain(config: ChainConfig = ACTIVE_CHAIN): Promise<string | null> {
  if (!walletAvailable()) return 'No browser wallet detected.';
  if (!chainConfigured(config)) return `${config.label} is not configured in this deployment yet.`;
  const hexId = `0x${config.chainId!.toString(16)}`;
  try {
    await window.ethereum!.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    return null;
  } catch {
    // 4902-style "unknown chain": offer to add it from the configured details.
    try {
      await window.ethereum!.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexId,
          chainName: config.label,
          nativeCurrency: { name: TOKEN.name, symbol: TOKEN.symbol, decimals: TOKEN.decimals },
          rpcUrls: [config.rpcUrl],
          blockExplorerUrls: config.explorerUrl ? [config.explorerUrl] : undefined,
        }],
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not switch network.';
    }
  }
}

/**
 * The economy bridge.
 *
 * V1 keeps every Gold transaction inside the simulation. These are the points
 * where token-backed value will attach later — ownership of a world, funding a
 * treasury, settling a build — expressed as data so the UI can already show
 * them and the wiring is a matter of filling in the calls.
 */
export interface TokenAction {
  id: string;
  label: string;
  detail: string;
  /** Whether the action can settle on chain in this build. */
  ready: boolean;
}

export interface ClaimRequest {
  seed: number;
  region: string;
  worldName: string;
  price: number;
  address: string | null;
}

export interface ClaimResult {
  /** True only when the claim was actually written to the chain. */
  settled: boolean;
  txHash: string | null;
  /** Why it did not settle, in words a player can act on. */
  reason: string | null;
}

/**
 * Claim a plot.
 *
 * Settlement needs a deployed registry contract on Robinhood Chain. Until that
 * exists this returns `settled: false` with the reason, and the caller records
 * the claim locally so the world is still playable. It deliberately does not
 * fake a transaction: a player should never be shown a hash that buys nothing.
 */
export async function claimPlot(request: ClaimRequest, config: ChainConfig = ACTIVE_CHAIN): Promise<ClaimResult> {
  if (!chainConfigured(config)) {
    return { settled: false, txHash: null, reason: `${config.label} is not configured in this build, so the claim is local to this browser.` };
  }
  if (!config.tokenAddress) {
    return { settled: false, txHash: null, reason: `The ${TOKEN.ticker} contract address is not set, so the claim is local to this browser.` };
  }
  if (!request.address) {
    return { settled: false, txHash: null, reason: 'No wallet is connected, so the claim is local to this browser.' };
  }
  // The land registry contract is not deployed yet. When it is, the transfer of
  // `price` $EMERGE and the plot registration go here.
  return {
    settled: false,
    txHash: null,
    reason: 'The land registry contract is not deployed yet. Your world is saved locally and can be re-claimed on chain later.',
  };
}

/** True once a land registry exists to read ownership from. */
export const registryLive = (config: ChainConfig = ACTIVE_CHAIN) =>
  chainConfigured(config) && !!config.registryAddress;

export interface PlotOwnership {
  /** The owning wallet, when the registry knows one. */
  owner: string | null;
  /** True when this came from the chain rather than from local storage. */
  onChain: boolean;
  /** Why it is not on chain, in words a player can act on. */
  reason: string | null;
}

/**
 * Who owns a plot.
 *
 * This is the call that makes one player's claims visible to another, and it
 * cannot work without a deployed registry: two browsers share no storage, so a
 * claim recorded locally is invisible to everybody else by construction. The
 * shape is here, the read goes through the configured RPC, and until the
 * contract exists this returns `onChain: false` with the reason rather than
 * implying a registry that is not there.
 */
export async function plotOwner(seed: number, config: ChainConfig = ACTIVE_CHAIN): Promise<PlotOwnership> {
  if (!registryLive(config)) {
    return {
      owner: null,
      onChain: false,
      reason: `The land registry is not deployed on ${config.label} yet, so claims are only visible in the browser that made them.`,
    };
  }
  try {
    // `ownerOf(uint256)` — the seed is the token id, so a plot's identity on
    // chain is the same number that generates its terrain.
    const selector = '0x6352211e';
    const data = selector + seed.toString(16).padStart(64, '0');
    const response = await fetch(config.rpcUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: config.registryAddress, data }, 'latest'],
      }),
    });
    const json = (await response.json()) as { result?: string; error?: { message?: string } };
    if (json.error) return { owner: null, onChain: false, reason: json.error.message ?? 'The registry call failed.' };
    const word = json.result?.replace(/^0x/, '') ?? '';
    if (word.length < 64) return { owner: null, onChain: true, reason: null };
    const address = `0x${word.slice(-40)}`;
    const empty = /^0x0+$/.test(address);
    return { owner: empty ? null : address, onChain: true, reason: null };
  } catch (error) {
    return {
      owner: null,
      onChain: false,
      reason: error instanceof Error ? error.message : 'Could not reach the registry.',
    };
  }
}

export function tokenActions(config: ChainConfig = ACTIVE_CHAIN): TokenAction[] {
  const ready = tokenLive(config);
  return [
    { id: 'own', label: 'Claim world ownership', detail: `Register this world's seed to your wallet on ${config.label}.`, ready },
    { id: 'fund', label: `Fund treasury with ${TOKEN.ticker}`, detail: 'Convert tokens into world Gold that citizens can earn and spend.', ready },
    { id: 'land', label: 'Buy build rights', detail: 'Hold verifiable rights to a parcel before constructing on it.', ready },
    { id: 'rewards', label: 'Claim world rewards', detail: 'Settle earnings from a thriving settlement back to your wallet.', ready },
  ];
}
