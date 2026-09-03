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

/* ------------------------------------------------------------------ *
 * The token itself
 * ------------------------------------------------------------------ */

/**
 * Where burned tokens go.
 *
 * The zero address, as specified for this project. Every charge the game makes
 * is a transfer to it, visible on any explorer, needing no contract of ours.
 *
 * One caveat worth knowing before launch, because it is silent until it is not:
 * many ERC-20 implementations — OpenZeppelin's among them — **revert** on a
 * transfer to the zero address. If the deployed $EMERGE is one of those, every
 * charge will fail with a rejected transaction rather than a wrong balance.
 * `NEXT_PUBLIC_BURN_ADDRESS` overrides this without a code change;
 * `0x…dEaD` is the usual alternative and is read as burnt by every explorer
 * and supply tracker.
 */
export const BURN_ADDRESS =
  process.env.NEXT_PUBLIC_BURN_ADDRESS ?? '0x0000000000000000000000000000000000000000';

/**
 * The vault.
 *
 * Deposits — $EMERGE converted into a settlement's Gold — are transferred here
 * rather than destroyed, because that Gold is the player's own money and the
 * withdrawal door has to be able to give it back. The burn a withdrawal takes
 * stays behind in this wallet rather than going to the burn address, so it can
 * be burned from here deliberately.
 *
 * A wallet, not a contract: it cannot pay out on its own, which is why the
 * withdrawal path books a settlement rather than pretending to send tokens.
 * `docs/CONTRACTS.md` sets out what a vault contract would change.
 */
export const VAULT_ADDRESS =
  process.env.NEXT_PUBLIC_EMERGE_VAULT ?? '0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062';

/** True once there is somewhere for deposited tokens to actually go. */
export const vaultLive = (config: ChainConfig = ACTIVE_CHAIN) =>
  tokenLive(config) && /^0x[0-9a-fA-F]{40}$/.test(VAULT_ADDRESS);

/**
 * True when the token can destroy its own supply.
 *
 * Set `NEXT_PUBLIC_TOKEN_BURNABLE=true` for any token carrying OpenZeppelin's
 * `ERC20Burnable` — which every Pons v2 launch does. Charges then call
 * `burn(uint256)` and `totalSupply()` actually falls, rather than piling up in
 * a dead address.
 *
 * Off by default, because calling `burn` on a token that does not have it is a
 * transaction that reverts, and a charge that always fails is worse than one
 * that burns imperfectly.
 */
export const tokenBurnable = () => truthy(process.env.NEXT_PUBLIC_TOKEN_BURNABLE);

/**
 * An environment flag, read the way somebody setting it would expect.
 *
 * Deliberately forgiving. A strict `=== 'true'` turned `TRUE`, `True` and `1`
 * into silent falses, and a silent false here is not a cosmetic difference —
 * it sends every charge to the burn address instead of calling `burn`, which on
 * an OpenZeppelin token with the zero address configured reverts every
 * transaction in the game. A variable that has to be typed in exactly one
 * casing to avoid that is a trap, not a setting.
 */
const truthy = (value: string | undefined) =>
  ['true', '1', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

/**
 * True when this build's burn target cannot possibly work.
 *
 * The zero address is not a valid recipient for most ERC-20s — OpenZeppelin's
 * `_transfer` reverts on it outright, and every Pons launch is an OpenZeppelin
 * token. So "not burnable, burning to `0x0`" is a combination that fails every
 * charge, and it fails in the worst way: a wallet error with no explanation,
 * after the player has already agreed to pay.
 *
 * Caught here so it can be said out loud instead.
 */
export const burnTargetBroken = (config: ChainConfig = ACTIVE_CHAIN) =>
  tokenLive(config) && !tokenBurnable() && /^0x0+$/.test(BURN_ADDRESS);

/**
 * One JSON-RPC call against the configured node.
 *
 * Reads only — anything that changes state is signed by the player's wallet,
 * never by us, because there is no key in this application to sign with.
 */
export async function rpc<T>(
  method: string,
  params: unknown[],
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<T | null> {
  if (!config.rpcUrl) return null;
  try {
    const response = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await response.json()) as { result?: T; error?: { message?: string } };
    if (json.error || json.result === undefined || json.result === null) return null;
    return json.result;
  } catch {
    return null;
  }
}

/** One `eth_call` against the configured RPC, returning the raw hex word. */
export async function ethCall(
  to: string,
  data: string,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<string | null> {
  const result = await rpc<string>('eth_call', [{ to, data }, 'latest'], config);
  return typeof result === 'string' ? result : null;
}

/** An ABI word: 32 bytes, right-aligned, no `0x`. */
export const hexWord = (value: string) => value.replace(/^0x/, '').padStart(64, '0');

/** A uint256 argument. */
export const numWord = (value: bigint | number) =>
  (typeof value === 'bigint' ? value : BigInt(Math.round(value))).toString(16).padStart(64, '0');

/**
 * How many decimals the token uses.
 *
 * Read rather than assumed. Eighteen is the usual answer and the fallback, but
 * a token with six would make every balance on screen wrong by a factor of a
 * million, and that is not a thing to guess at.
 */
export async function tokenDecimals(config: ChainConfig = ACTIVE_CHAIN): Promise<number> {
  if (!tokenLive(config)) return 18;
  // decimals()
  const result = await ethCall(config.tokenAddress!, '0x313ce567', config);
  const parsed = result ? Number.parseInt(result, 16) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 36 ? parsed : 18;
}

/**
 * What a wallet actually holds, in whole tokens.
 *
 * Returns null when there is no token deployed to ask, which is what tells the
 * rest of the game to fall back to the development allocation and say so.
 */
export async function tokenBalance(
  address: string,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<number | null> {
  if (!tokenLive(config) || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  // balanceOf(address)
  const data = '0x70a08231' + hexWord(address.toLowerCase());
  const result = await ethCall(config.tokenAddress!, data, config);
  if (!result) return null;
  try {
    const raw = BigInt(result);
    const scale = 10n ** BigInt(await tokenDecimals(config));
    // Whole tokens plus four places, which is finer than anything the game
    // charges and avoids losing a fractional balance to integer division.
    const scaled = Number((raw * 10_000n) / scale) / 10_000;
    return Number.isFinite(scaled) ? scaled : null;
  } catch {
    return null;
  }
}

export interface BurnResult {
  ok: boolean;
  txHash: string | null;
  message: string;
}

/**
 * Move tokens from the player to an address they choose to send them to.
 *
 * The one primitive behind both burning and depositing: the only difference
 * between destroying tokens and vaulting them is where they land, and keeping
 * that a parameter means the two paths cannot drift apart.
 */
export async function transferTokens(
  from: string,
  to: string,
  whole: number,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<BurnResult> {
  if (!tokenLive(config)) {
    return { ok: false, txHash: null, message: `The ${TOKEN.ticker} contract is not deployed yet.` };
  }
  if (!walletAvailable()) {
    return { ok: false, txHash: null, message: 'No wallet to sign with.' };
  }
  try {
    const decimals = await tokenDecimals(config);
    // Through a string, not a float: 120,000 tokens at eighteen decimals is far
    // past what a double can hold exactly, and a rounding error here is real
    // money.
    const units = BigInt(Math.round(whole)) * 10n ** BigInt(decimals);
    // transfer(address,uint256)
    const data = '0xa9059cbb' + hexWord(to) + units.toString(16).padStart(64, '0');
    const txHash = (await window.ethereum!.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: config.tokenAddress, data }],
    })) as string;
    return { ok: true, txHash, message: `Sent ${whole.toLocaleString()} ${TOKEN.ticker}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The transaction was rejected.';
    return { ok: false, txHash: null, message };
  }
}

/**
 * Actually destroy tokens, by transferring them to the burn address.
 *
 * The player signs it, because it is their money: there is no custody here and
 * no approval to grant. A rejected signature is not an error, it is a player
 * changing their mind, and the caller must not charge them for it.
 */
export async function burnTokens(
  from: string,
  whole: number,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<BurnResult> {
  /*
   * A real burn where the token has one.
   *
   * `burn(uint256)` destroys the tokens: `totalSupply()` goes down, and anybody
   * checking how much $EMERGE exists sees the difference. Sending to a dead
   * address only moves them somewhere nobody holds the key to, which is
   * unrecoverable but is not the same claim — the supply figure is unchanged
   * and the tokens still sit in a balance.
   *
   * The fallback is for a token without `ERC20Burnable`, where a transfer to
   * an address nobody controls is the only burn available.
   */
  if (tokenBurnable()) {
    const gone = await burnViaToken(from, whole, config);
    if (gone.ok) return { ...gone, message: `Burned ${whole.toLocaleString()} ${TOKEN.ticker}.` };
    return gone;
  }
  /*
   * Refuse rather than send a transaction that cannot succeed.
   *
   * Asking somebody to sign a transfer to the zero address on a token that
   * rejects them costs them gas and tells them nothing. This is a
   * misconfiguration of ours and should read as one.
   */
  if (burnTargetBroken(config)) {
    return {
      ok: false,
      txHash: null,
      message: `This build cannot burn ${TOKEN.ticker}: it is set to send to the zero address, which the token refuses. Nothing was charged — this is ours to fix.`,
    };
  }
  const sent = await transferTokens(from, BURN_ADDRESS, whole, config);
  return sent.ok
    ? { ...sent, message: `Burned ${whole.toLocaleString()} ${TOKEN.ticker}.` }
    : sent;
}

/** `burn(uint256)`, as `ERC20Burnable` defines it. */
async function burnViaToken(
  from: string,
  whole: number,
  config: ChainConfig,
): Promise<BurnResult> {
  if (!config.tokenAddress) {
    return { ok: false, txHash: null, message: `No ${TOKEN.ticker} contract is configured.` };
  }
  if (!walletAvailable()) {
    return { ok: false, txHash: null, message: 'No wallet to sign with.' };
  }
  const units = BigInt(Math.round(whole)) * 10n ** BigInt(await tokenDecimals(config));
  try {
    const txHash = (await window.ethereum!.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: config.tokenAddress, data: `0x42966c68${numWord(units)}` }],
    })) as string;
    return { ok: true, txHash, message: 'Sent.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The transaction was rejected.';
    return { ok: false, txHash: null, message };
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
