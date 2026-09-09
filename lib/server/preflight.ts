import 'server-only';

/**
 * The launch pre-flight, from inside the app.
 *
 * The same checks as `scripts/check-nft-chain.mjs`, run by the deployment
 * itself against the addresses it was built with, so the operator can ask
 * `GET /api/nft?check=1` (with the cron secret) from a browser or curl and
 * needs no checkout and no Node. Reads only; sends nothing.
 */

import { createPublicClient, defineChain, formatEther, http, parseAbi, type Hex } from 'viem';
import { ACTIVE_CHAIN, VAULT_ADDRESS } from '../chain/emerge';
import { LAND_ADDRESS, MARKET_ADDRESS, ROYALTIES_ADDRESS } from '../chain/plots';
import { vaultAddress, vaultCanSign } from './signer';

export interface CheckLine { ok: boolean; what: string; detail?: string }

const ERC20 = parseAbi(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const LAND = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function minter() view returns (address)',
  'function royaltyReceiver() view returns (address)', 'function royaltyBps() view returns (uint96)', 'function baseURI() view returns (string)', 'function contractURI() view returns (string)',
  'function mintedCount() view returns (uint256)', 'function supportsInterface(bytes4) view returns (bool)',
]);
const MARKET = parseAbi(['function land() view returns (address)', 'function token() view returns (address)', 'function paused() view returns (bool)', 'function listedCount() view returns (uint256)']);
const ROYALTIES = parseAbi(['function vault() view returns (address)']);

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export async function preflight(siteBase: string): Promise<{ ok: boolean; lines: CheckLine[] }> {
  const lines: CheckLine[] = [];
  const say = (ok: boolean, what: string, detail?: string) => lines.push({ ok, what, detail });
  const site = siteBase.replace(/\/$/, '');
  const chain = defineChain({ id: ACTIVE_CHAIN.chainId ?? 4663, name: ACTIVE_CHAIN.label, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ACTIVE_CHAIN.rpcUrl ?? ''] } } });
  const client = createPublicClient({ chain, transport: http(ACTIVE_CHAIN.rpcUrl ?? undefined) });
  const read = <T,>(address: string, abi: typeof ERC20 | typeof LAND | typeof MARKET | typeof ROYALTIES, functionName: string, args: unknown[] = []) =>
    client.readContract({ address: address as Hex, abi, functionName, args } as never) as Promise<T>;
  try {
    const id = await client.getChainId();
    say(id === ACTIVE_CHAIN.chainId, `RPC answers for chain ${ACTIVE_CHAIN.chainId}`, `${ACTIVE_CHAIN.rpcUrl} says ${id}`);
    const gas = await client.getBalance({ address: VAULT_ADDRESS as Hex });
    say(gas > 0n, `the vault ${VAULT_ADDRESS} holds ETH for gas`, `${formatEther(gas)} ETH`);
    say(vaultCanSign() && same(vaultAddress(), VAULT_ADDRESS), 'the site can sign as the vault', vaultCanSign() ? `key for ${vaultAddress()}` : 'EMERGE_VAULT_PRIVATE_KEY is not set');

    const token = ACTIVE_CHAIN.tokenAddress;
    if (!token) say(false, 'NEXT_PUBLIC_EMERGE_TOKEN is set');
    else {
      const dec = await read<number>(token, ERC20, 'decimals');
      say(dec === 18, `$EMERGE at ${token} has 18 decimals`, `${dec} decimals`);
    }

    const land = LAND_ADDRESS;
    if (!land) say(false, 'NEXT_PUBLIC_EMERGE_REGISTRY (the land contract) is set: plots are not tokens without it');
    else {
      const [name, sym, minter, receiver, bps, base, curi, minted] = await Promise.all([
        read<string>(land, LAND, 'name'), read<string>(land, LAND, 'symbol'), read<string>(land, LAND, 'minter'), read<string>(land, LAND, 'royaltyReceiver'),
        read<bigint>(land, LAND, 'royaltyBps'), read<string>(land, LAND, 'baseURI'), read<string>(land, LAND, 'contractURI'), read<bigint>(land, LAND, 'mintedCount'),
      ]);
      say(name === 'Emerge Land' && sym === 'EMLAND', `the land contract at ${land} is Emerge Land`, `${name} (${sym}), ${minted} minted`);
      say(same(minter, VAULT_ADDRESS), 'the vault is the minter (setMinter was called)', `minter ${minter}`);
      say(base === `${site}/api/nft/`, 'baseURI points at this site with a trailing slash', base);
      say(curi === `${site}/api/nft/collection`, 'contractURI points at the collection route', curi);
      say(bps > 0n && bps <= 1000n, 'royalty is set', `${Number(bps) / 100}%`);
      say(!ROYALTIES_ADDRESS || same(receiver, ROYALTIES_ADDRESS), 'the royalty receiver is the EmergeRoyalties contract', `receiver ${receiver}`);
      const faces = await Promise.all(['0x80ac58cd', '0x2a55205a', '0x49064906'].map((i) => read<boolean>(land, LAND, 'supportsInterface', [i])));
      say(faces.every(Boolean), 'ERC-721, ERC-2981 and ERC-4906 are declared (what OpenSea reads)');
    }

    if (!MARKET_ADDRESS) say(true, 'no market set: plots sell on OpenSea only (NEXT_PUBLIC_EMERGE_MARKET unset)');
    else {
      const [mLand, mToken, paused, listed] = await Promise.all([read<string>(MARKET_ADDRESS, MARKET, 'land'), read<string>(MARKET_ADDRESS, MARKET, 'token'), read<boolean>(MARKET_ADDRESS, MARKET, 'paused'), read<bigint>(MARKET_ADDRESS, MARKET, 'listedCount')]);
      say(same(mLand, land ?? ''), `the market at ${MARKET_ADDRESS} sells this land contract`, `land ${mLand}`);
      say(same(mToken, token ?? ''), 'the market is priced in this $EMERGE', `token ${mToken}`);
      say(!paused, 'the market is not paused', `${listed} listed`);
    }

    if (!ROYALTIES_ADDRESS) say(true, 'no royalty receiver set: royalties are not swept (NEXT_PUBLIC_EMERGE_ROYALTIES unset)');
    else {
      const rVault = await read<string>(ROYALTIES_ADDRESS, ROYALTIES, 'vault');
      say(same(rVault, VAULT_ADDRESS), `the royalty receiver at ${ROYALTIES_ADDRESS} sweeps to the vault`, `vault ${rVault}`);
      if (token) {
        const [t, e] = await Promise.all([read<bigint>(token, ERC20, 'balanceOf', [ROYALTIES_ADDRESS]), client.getBalance({ address: ROYALTIES_ADDRESS as Hex })]);
        say(true, 'royalties waiting to be swept', `${formatEther(t)} $EMERGE, ${formatEther(e)} ETH`);
      }
    }
  } catch (error) {
    say(false, 'could not finish', error instanceof Error ? error.message.slice(0, 200) : String(error));
  }
  return { ok: lines.every((l) => l.ok), lines };
}
