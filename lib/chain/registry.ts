/**
 * The land registry, on chain.
 *
 * `contracts/EmergeLand.sol` is an ERC-721 in which **the token id is the plot
 * seed** — the same number that generates the terrain. So a plot is not a row
 * in our database that happens to mention a wallet: it is a token in that
 * wallet, transferable, visible in any explorer, and readable by anybody
 * without asking this game anything.
 *
 * What that buys, concretely:
 *
 *   - Ownership is the chain's answer, not the server's. Clear your site data,
 *     change browser, come back in a year: the plots are still yours.
 *   - The price is read from the contract, so the number on the button is the
 *     number the transaction enforces. `claim` takes a `maxPrice` and reverts
 *     above it, so a price change between reading and signing cannot overcharge.
 *   - The claim fee goes to the burn address from inside the contract. Nothing
 *     we run can intercept it.
 *
 * Every function here answers rather than throwing, and every one degrades to
 * "no registry deployed" rather than pretending. Until
 * `NEXT_PUBLIC_EMERGE_REGISTRY` is set the shared relay in `lib/server` is
 * still what keeps two players off the same land, and the interface says so.
 */

import {
  ACTIVE_CHAIN, TOKEN, activeProvider, ethCall, hexWord, numWord, registryLive, rpc, tokenLive,
  walletAvailable, type ChainConfig,
} from './emerge';

/* ------------------------------------------------------------------ *
 * Selectors
 *
 * Written out rather than derived, because deriving them needs a keccak
 * implementation in the browser bundle to compute constants that never change.
 * Each is the first four bytes of the hash of the signature beside it.
 * ------------------------------------------------------------------ */

const SEL = {
  ownerOf: '0x6352211e',          // ownerOf(uint256)
  priceOf: '0xb9186d7d',          // priceOf(uint256)
  claimedCount: '0xc08fa1a4',     // claimedCount()
  registry: '0x6f111692',         // registry(uint256,uint256)
  claim: '0xabae21de',            // claim(uint256,string,uint256)
  release: '0x37bdc99b',          // release(uint256)
  rename: '0x3ec2d836',           // rename(uint256,string)
  allowance: '0xdd62ed3e',        // allowance(address,address)
  approve: '0x095ea7b3',          // approve(address,uint256)
} as const;

/**
 * True once a claim can settle end to end.
 *
 * The registry alone is not enough: claiming pays in $EMERGE, so the token has
 * to exist for the contract to take payment from. One without the other is a
 * half-deployed build, and the interface should say that rather than offering
 * a button that always reverts.
 */
export const onChainClaimsLive = (config: ChainConfig = ACTIVE_CHAIN) =>
  registryLive(config) && tokenLive(config);

/* ------------------------------------------------------------------ *
 * ABI, by hand
 * ------------------------------------------------------------------ */

const strip = (hex: string) => hex.replace(/^0x/, '');

/** Split return data into 32-byte words. */
const words = (hex: string) => strip(hex).match(/.{1,64}/g) ?? [];

/** A word at a byte offset. */
const wordAt = (hex: string, byteOffset: number) => strip(hex).slice(byteOffset * 2, byteOffset * 2 + 64);

const asNumber = (word: string) => Number(BigInt(`0x${word || '0'}`));

const asAddress = (word: string) => `0x${word.slice(-40)}`;

/** UTF-8 into ABI's length-prefixed, 32-byte-padded bytes. */
function encodeString(value: string): { head: string; tail: string } {
  const bytes = new TextEncoder().encode(value);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return { head: numWord(bytes.length), tail: padded };
}

/** ABI bytes back into a string. */
function decodeString(hex: string, byteOffset: number): string {
  const length = asNumber(wordAt(hex, byteOffset));
  if (!Number.isFinite(length) || length <= 0 || length > 4096) return '';
  const data = strip(hex).slice((byteOffset + 32) * 2, (byteOffset + 32) * 2 + length * 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = Number.parseInt(data.slice(i * 2, i * 2 + 2), 16) || 0;
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * What the contract will charge for a plot, in whole $EMERGE.
 *
 * The price shown to a player must come from here and not from the game's own
 * generator, or the two will disagree the first time the contract's owner
 * adjusts `basePrice` — and the disagreement would show up as a transaction
 * that reverts for no visible reason.
 *
 * Null means there is no registry to ask, which is the caller's signal to fall
 * back to the local price and say the claim is not on chain.
 */
export async function registryPrice(
  seed: number,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<number | null> {
  if (!registryLive(config)) return null;
  const result = await ethCall(config.registryAddress!, SEL.priceOf + numWord(seed), config);
  if (!result) return null;
  try {
    // The contract prices in token units; the game talks in whole tokens.
    const units = BigInt(result);
    return Number(units / 10n ** BigInt(TOKEN.decimals));
  } catch {
    return null;
  }
}

export interface RegistryPlot {
  seed: number;
  owner: string;
  worldName: string;
}

/** How many plots have ever been claimed on chain. */
export async function claimedCount(config: ChainConfig = ACTIVE_CHAIN): Promise<number | null> {
  if (!registryLive(config)) return null;
  const result = await ethCall(config.registryAddress!, SEL.claimedCount, config);
  if (!result) return null;
  const n = asNumber(words(result)[0] ?? '');
  return Number.isFinite(n) ? n : null;
}

/** How many plots one page of the registry asks for. */
const PAGE = 100;

/**
 * Every plot the chain says is held, with its owner and its name.
 *
 * Paged, because a single call returning ten thousand names is a call that
 * times out. A plot that has been released reads as owner zero and is dropped
 * here rather than shown as owned by nobody.
 */
export async function allOnChainPlots(config: ChainConfig = ACTIVE_CHAIN): Promise<RegistryPlot[] | null> {
  const total = await claimedCount(config);
  if (total === null) return null;

  const out: RegistryPlot[] = [];
  for (let start = 0; start < total; start += PAGE) {
    const data = SEL.registry + numWord(start) + numWord(Math.min(PAGE, total - start));
    const result = await ethCall(config.registryAddress!, data, config);
    if (!result) return out.length ? out : null;
    out.push(...decodeRegistryPage(result));
  }
  return out;
}

/**
 * Decode `(uint256[] seeds, address[] owners, string[] names)`.
 *
 * Three dynamic arrays, so the return data opens with three offsets and every
 * name is itself behind another offset. Written out longhand because pulling
 * in an ABI library to read one view is a lot of bundle for one function.
 */
function decodeRegistryPage(hex: string): RegistryPlot[] {
  const seedsAt = asNumber(wordAt(hex, 0));
  const ownersAt = asNumber(wordAt(hex, 32));
  const namesAt = asNumber(wordAt(hex, 64));
  if (![seedsAt, ownersAt, namesAt].every(Number.isFinite)) return [];

  const count = asNumber(wordAt(hex, seedsAt));
  if (!Number.isFinite(count) || count <= 0 || count > 10_000) return [];

  const out: RegistryPlot[] = [];
  for (let i = 0; i < count; i++) {
    const seed = asNumber(wordAt(hex, seedsAt + 32 + i * 32));
    const owner = asAddress(wordAt(hex, ownersAt + 32 + i * 32));
    // Each name sits at an offset measured from the start of the array's body.
    const nameAt = namesAt + 32 + asNumber(wordAt(hex, namesAt + 32 + i * 32));
    const worldName = decodeString(hex, nameAt);
    if (/^0x0+$/.test(owner)) continue; // released
    out.push({ seed, owner, worldName });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export interface ChainTx {
  ok: boolean;
  txHash: string | null;
  message: string;
}

/** Send a transaction from the player's wallet. They sign; we never do. */
async function send(from: string, to: string, data: string): Promise<ChainTx> {
  if (!walletAvailable()) return { ok: false, txHash: null, message: 'No wallet to sign with.' };
  try {
    const txHash = (await activeProvider()!.request({
      method: 'eth_sendTransaction',
      params: [{ from, to, data }],
    })) as string;
    return { ok: true, txHash, message: 'Sent.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The transaction was rejected.';
    return { ok: false, txHash: null, message };
  }
}

/** How long to wait for a transaction before giving up on watching it. */
const RECEIPT_TIMEOUT_MS = 90_000;
const RECEIPT_POLL_MS = 2_000;

/**
 * Wait for a transaction to be mined.
 *
 * Needed because an approval and the claim that spends it are two
 * transactions: sending the second before the first is mined makes it revert
 * on an allowance that is not there yet. Returns false on a revert and null on
 * a timeout, which are different things — the second may still succeed, so the
 * caller says "still pending" rather than "failed".
 */
async function waitForReceipt(txHash: string, config: ChainConfig): Promise<boolean | null> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await rpc<{ status?: string }>('eth_getTransactionReceipt', [txHash], config);
    if (receipt) return receipt.status === '0x1';
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
  return null;
}

/** What the registry is currently allowed to take from a wallet, in units. */
async function allowanceUnits(owner: string, config: ChainConfig): Promise<bigint> {
  const data = SEL.allowance + hexWord(owner.toLowerCase()) + hexWord(config.registryAddress!.toLowerCase());
  const result = await ethCall(config.tokenAddress!, data, config);
  try {
    return result ? BigInt(result) : 0n;
  } catch {
    return 0n;
  }
}

export interface OnChainClaim extends ChainTx {
  /** What the contract actually charged, in whole tokens. */
  price: number | null;
  /** True when the claim transaction was mined successfully. */
  settled: boolean;
}

/**
 * Claim a plot on chain: approve, then claim.
 *
 * Two signatures, and the player is told that before the first one. The
 * approval is for exactly this claim's price rather than an unlimited
 * allowance, because an unlimited allowance on a contract is a standing
 * permission to drain a wallet and there is no reason to ask for one here.
 *
 * `maxPrice` is what the player agreed to. If the contract's price moved
 * between the quote and the signature the transaction reverts rather than
 * quietly charging more.
 */
export async function claimOnChain(
  from: string,
  seed: number,
  worldName: string,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<OnChainClaim> {
  const refuse = (message: string): OnChainClaim =>
    ({ ok: false, txHash: null, message, price: null, settled: false });

  if (!onChainClaimsLive(config)) {
    return refuse('The land registry is not deployed yet.');
  }

  const price = await registryPrice(seed, config);
  if (price === null) return refuse('Could not read the price from the registry.');

  const units = BigInt(price) * 10n ** BigInt(TOKEN.decimals);

  // Approve only what this claim costs, and only when the standing allowance
  // will not already cover it.
  if ((await allowanceUnits(from, config)) < units) {
    const approval = await send(
      from,
      config.tokenAddress!,
      SEL.approve + hexWord(config.registryAddress!.toLowerCase()) + numWord(units),
    );
    if (!approval.ok) return { ...approval, price, settled: false };
    const mined = await waitForReceipt(approval.txHash!, config);
    if (mined === false) return { ...refuse('The approval failed on chain.'), price };
    if (mined === null) {
      return {
        ok: false, txHash: approval.txHash, price, settled: false,
        message: 'The approval is still pending. Wait for it to confirm and claim again — you will not be asked to approve twice.',
      };
    }
  }

  const name = encodeString(worldName);
  const data = SEL.claim
    + numWord(seed)
    // Three arguments, so the string's body starts after three words.
    + numWord(96)
    + numWord(units)
    + name.head
    + name.tail;

  const claim = await send(from, config.registryAddress!, data);
  if (!claim.ok) return { ...claim, price, settled: false };

  const mined = await waitForReceipt(claim.txHash!, config);
  if (mined === false) {
    return {
      ok: false, txHash: claim.txHash, price, settled: false,
      message: 'The claim was rejected on chain. Somebody may have taken this plot first.',
    };
  }
  if (mined === null) {
    return {
      ok: true, txHash: claim.txHash, price, settled: false,
      message: 'Your claim was sent and is still confirming.',
    };
  }
  return {
    ok: true, txHash: claim.txHash, price, settled: true,
    message: `Claimed on chain for ${price.toLocaleString()} ${TOKEN.ticker}, burned by the contract.`,
  };
}

/** Give a plot up. The token is burned and the seed is claimable again. */
export async function releaseOnChain(
  from: string,
  seed: number,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<ChainTx> {
  if (!registryLive(config)) return { ok: false, txHash: null, message: 'No registry deployed.' };
  return send(from, config.registryAddress!, SEL.release + numWord(seed));
}

/** Rename a world on chain, so the name travels with the token. */
export async function renameOnChain(
  from: string,
  seed: number,
  worldName: string,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<ChainTx> {
  if (!registryLive(config)) return { ok: false, txHash: null, message: 'No registry deployed.' };
  const name = encodeString(worldName);
  return send(
    from,
    config.registryAddress!,
    SEL.rename + numWord(seed) + numWord(64) + name.head + name.tail,
  );
}

/** Where to look a plot up, when the chain has an explorer. */
export function plotExplorerUrl(seed: number, config: ChainConfig = ACTIVE_CHAIN): string | null {
  if (!config.explorerUrl || !config.registryAddress) return null;
  return `${config.explorerUrl.replace(/\/$/, '')}/token/${config.registryAddress}?a=${seed}`;
}
