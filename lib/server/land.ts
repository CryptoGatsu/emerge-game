import 'server-only';

/**
 * Does this wallet hold any land?
 *
 * Asked before paying stewardship out, and it is the one real defence against
 * a wallet farm. Earnings are the half of the ledger the server cannot verify —
 * the simulation runs in the player's browser — so the question becomes how
 * expensive it is to *be* a player at all. A plot costs two hundred thousand
 * $EMERGE or more and burns it, so an identity has to spend before it can earn.
 *
 * Where a registry is deployed the chain is asked and nothing else: `balanceOf`
 * on the land registry cannot be talked into a wrong answer.
 *
 * **Where there is no registry, a claim row counts — but only while the token
 * is live.** The relay's claims are the server's own word about who owns what,
 * and on their own they would be worthless here: an attacker who can write a
 * claim could unlock earnings. What makes them worth something in this one
 * configuration is `/api/plots`, which in exactly this case refuses to write a
 * row until it has read a burn off the chain: a real transaction, from this
 * wallet, settled, worth at least the plot price, and single-use. So the row is
 * evidence that this identity spent, which is the whole property the registry
 * was here to provide. The question is only ever *how* it was proved.
 *
 * With no registry **and** no token, claiming costs nothing at all, so a claim
 * row proves nothing and this answers false. That is the case the earlier
 * blanket refusal was really written for — a live token with a free claim would
 * have been a faucet, not a game. Deposits and principal withdrawals never
 * depended on any of this.
 */

import { createPublicClient, defineChain, http, type Hex } from 'viem';
import { ACTIVE_CHAIN, tokenLive } from '../chain/emerge';
import { allClaims } from './registry';

const chain = () => defineChain({
  id: ACTIVE_CHAIN.chainId ?? 4663,
  name: ACTIVE_CHAIN.label,
  nativeCurrency: { name: 'Robinhood', symbol: 'RH', decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } },
});

const ERC721 = [
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'ownerOf', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }],
  },
] as const;

export type LandCheck = 'holds' | 'none' | 'no-registry' | 'unreachable';

/** Whether the relay shows any plot standing in this wallet's name. */
async function claimsHeldBy(address: string): Promise<boolean> {
  const wanted = address.toLowerCase();
  const claims = await allClaims();
  return claims.some((c) => c.owner.toLowerCase() === wanted);
}

/**
 * The same question, answered in a way the caller can explain to a player.
 *
 * All three refusals used to be one `false`, and the player was told the same
 * thing every time: that they hold no land. Somebody standing in a settlement
 * they own reads that as the game lying to them — and where the registry is
 * unreachable or not deployed, it was. Failing closed is right; saying the
 * wrong reason is not.
 */
export async function landCheck(address: string): Promise<LandCheck> {
  const registry = ACTIVE_CHAIN.registryAddress;
  if (!registry) {
    // No registry and no token: claiming is free, so a claim row is not
    // evidence of anything and stewardship stays shut.
    if (!tokenLive()) return 'no-registry';
    try {
      const held = await claimsHeldBy(address);
      return held ? 'holds' : 'none';
    } catch {
      // The relay is the only record there is here, so not being able to read
      // it is the same kind of "we could not find out" as an unreachable node.
      return 'unreachable';
    }
  }
  try {
    const client = createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
    const held = await client.readContract({
      address: registry as Hex, abi: ERC721, functionName: 'balanceOf', args: [address as Hex],
    });
    return held > 0n ? 'holds' : 'none';
  } catch {
    /*
     * A chain we cannot reach must not become a way to be paid.
     *
     * Failing closed here costs an honest player a retry; failing open would
     * mean an RPC outage is an open door.
     */
    return 'unreachable';
  }
}

export async function holdsLand(address: string): Promise<boolean> {
  return (await landCheck(address)) === 'holds';
}

/**
 * Who the chain says holds one plot, or null if nobody does.
 *
 * Used to stop the relay being squatted. The relay's claim rows are what the
 * world map draws, and writing one costs nothing — so without this a single
 * script could POST a claim for every seed on every chart and make the whole
 * map read as taken, blocking real players who would have paid. Once a registry
 * exists the relay may only record what the chain already agrees with.
 *
 * Throws rather than returning null on an unreachable chain, so the caller can
 * tell "nobody owns it" from "we could not find out" — treating the second as
 * the first is how an RPC outage becomes an open door.
 */
export async function ownerOnChain(seed: number): Promise<string | null> {
  const registry = ACTIVE_CHAIN.registryAddress;
  if (!registry) return null;
  const client = createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
  try {
    const owner = await client.readContract({
      address: registry as Hex, abi: ERC721, functionName: 'ownerOf', args: [BigInt(seed)],
    });
    return /^0x0+$/.test(owner) ? null : owner.toLowerCase();
  } catch (error) {
    // `ownerOf` reverts for a plot nobody has claimed. That is an answer, not a
    // failure — but a network error is a failure, and must not read as one.
    const message = error instanceof Error ? error.message : '';
    if (/revert|nonexistent|not a token|execution/i.test(message)) return null;
    throw error;
  }
}

/** True when this deployment has a land contract to check against. */
export const registryConfigured = () => !!ACTIVE_CHAIN.registryAddress;
