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
 * The chain is asked, not the relay. The relay's claims are the server's own
 * word about who owns what, and using them here would mean an attacker who can
 * write a claim can also unlock earnings; `balanceOf` on the land registry
 * cannot be talked into a wrong answer.
 *
 * **Where there is no registry deployed** this answers true. That is
 * deliberate rather than an oversight: before the land contract exists there is
 * no on-chain fact to check, and refusing everybody would mean the game could
 * not pay anybody. The other caps still apply, and `docs/CONTRACTS.md` says so.
 */

import { createPublicClient, defineChain, http, type Hex } from 'viem';
import { ACTIVE_CHAIN } from '../chain/emerge';

const chain = () => defineChain({
  id: ACTIVE_CHAIN.chainId ?? 4663,
  name: ACTIVE_CHAIN.label,
  nativeCurrency: { name: 'Robinhood', symbol: 'RH', decimals: 18 },
  rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } },
});

const ERC721 = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }],
}] as const;

export async function holdsLand(address: string): Promise<boolean> {
  const registry = ACTIVE_CHAIN.registryAddress;
  if (!registry) return true;
  try {
    const client = createPublicClient({ chain: chain(), transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
    const held = await client.readContract({
      address: registry as Hex, abi: ERC721, functionName: 'balanceOf', args: [address as Hex],
    });
    return held > 0n;
  } catch {
    /*
     * A chain we cannot reach must not become a way to be paid.
     *
     * Failing closed here costs an honest player a retry; failing open would
     * mean an RPC outage is an open door.
     */
    return false;
  }
}
