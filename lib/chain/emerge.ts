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
 * Network descriptors. RPC and chain id are read from the environment so the
 * same build can target a development network or mainnet; the placeholders keep
 * the UI honest about which one is configured.
 */
export interface ChainConfig {
  key: 'robinhood' | 'robinhood-testnet';
  label: string;
  chainId: number | null;
  rpcUrl: string | null;
  explorerUrl: string | null;
  tokenAddress: string | null;
}

const envNumber = (value: string | undefined) => {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const CHAINS: Record<ChainConfig['key'], ChainConfig> = {
  robinhood: {
    key: 'robinhood',
    label: 'Robinhood Chain',
    chainId: envNumber(process.env.NEXT_PUBLIC_ROBINHOOD_CHAIN_ID),
    rpcUrl: process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? null,
    explorerUrl: process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER ?? null,
    tokenAddress: process.env.NEXT_PUBLIC_EMERGE_TOKEN ?? null,
  },
  'robinhood-testnet': {
    key: 'robinhood-testnet',
    label: 'Robinhood Chain (test)',
    chainId: envNumber(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_CHAIN_ID),
    rpcUrl: process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL ?? null,
    explorerUrl: process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_EXPLORER ?? null,
    tokenAddress: process.env.NEXT_PUBLIC_EMERGE_TOKEN_TESTNET ?? null,
  },
};

/** Which network this build targets. Development defaults to the test network. */
export const ACTIVE_CHAIN: ChainConfig =
  process.env.NEXT_PUBLIC_CHAIN_TARGET === 'mainnet' ? CHAINS.robinhood : CHAINS['robinhood-testnet'];

/** True once the deployment has real chain details wired in. */
export const chainConfigured = (config: ChainConfig = ACTIVE_CHAIN) =>
  config.chainId !== null && !!config.rpcUrl;

/* ------------------------------------------------------------------ *
 * Wallet
 * ------------------------------------------------------------------ */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window { ethereum?: Eip1193Provider }
}

export interface WalletState {
  status: 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'error';
  address: string | null;
  chainId: number | null;
  error: string | null;
}

export const INITIAL_WALLET: WalletState = { status: 'disconnected', address: null, chainId: null, error: null };

export function walletAvailable() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

export function shortAddress(address: string | null) {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Request accounts from an injected wallet. Any failure resolves to an error
 * state rather than throwing, so a rejected prompt is never a crash mid-game.
 */
export async function connectWallet(): Promise<WalletState> {
  if (!walletAvailable()) {
    return { status: 'unsupported', address: null, chainId: null, error: 'No browser wallet detected.' };
  }
  const provider = window.ethereum!;
  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    const rawChain = (await provider.request({ method: 'eth_chainId' })) as string;
    return {
      status: accounts?.length ? 'connected' : 'disconnected',
      address: accounts?.[0] ?? null,
      chainId: Number.parseInt(rawChain, 16) || null,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wallet connection was rejected.';
    return { status: 'error', address: null, chainId: null, error: message };
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

export function tokenActions(config: ChainConfig = ACTIVE_CHAIN): TokenAction[] {
  const ready = chainConfigured(config) && !!config.tokenAddress;
  return [
    { id: 'own', label: 'Claim world ownership', detail: `Register this world's seed to your wallet on ${config.label}.`, ready },
    { id: 'fund', label: `Fund treasury with ${TOKEN.ticker}`, detail: 'Convert tokens into world Gold that citizens can earn and spend.', ready },
    { id: 'land', label: 'Buy build rights', detail: 'Hold verifiable rights to a parcel before constructing on it.', ready },
    { id: 'rewards', label: 'Claim world rewards', detail: 'Settle earnings from a thriving settlement back to your wallet.', ready },
  ];
}
