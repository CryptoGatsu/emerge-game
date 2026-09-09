#!/usr/bin/env node
/**
 * Pre-flight for the land contracts on Robinhood Chain.
 *
 * Reads, never writes: no key is needed and nothing is sent. Run it from the
 * repo with the same environment the deployment carries and it says whether
 * the chain, the token, the land, the market, the royalty receiver and the
 * vault agree with each other and with the site — every fact the game relies
 * on when it mints, lists, sells and sweeps.
 *
 *   NEXT_PUBLIC_EMERGE_TOKEN=0x… NEXT_PUBLIC_EMERGE_REGISTRY=0x… \
 *   NEXT_PUBLIC_EMERGE_MARKET=0x… NEXT_PUBLIC_EMERGE_ROYALTIES=0x… \
 *   NEXT_PUBLIC_SITE_URL=https://www.emergerh.world node scripts/check-nft-chain.mjs
 *
 * Add NEXT_PUBLIC_CHAIN_TARGET=testnet (and the …_TESTNET addresses) to
 * check a testnet deployment. NEXT_PUBLIC_ROBINHOOD_RPC_URL overrides the RPC.
 * Exit code 0 when everything agrees, 1 when something does not.
 */
import { createPublicClient, http, defineChain, formatEther, parseAbi } from 'viem';

const env = process.env;
const testnet = env.NEXT_PUBLIC_CHAIN_TARGET === 'testnet';
const pick = (name) => (testnet ? env[`${name}_TESTNET`] : env[name]) ?? null;
const rpcUrl = (testnet ? env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL : env.NEXT_PUBLIC_ROBINHOOD_RPC_URL) ?? (testnet ? 'https://rpc.testnet.chain.robinhood.com/rpc' : 'https://rpc.mainnet.chain.robinhood.com');
const wantChainId = Number((testnet ? env.NEXT_PUBLIC_ROBINHOOD_TESTNET_CHAIN_ID : env.NEXT_PUBLIC_ROBINHOOD_CHAIN_ID) ?? (testnet ? 46630 : 4663));
const token = pick('NEXT_PUBLIC_EMERGE_TOKEN');
const land = pick('NEXT_PUBLIC_EMERGE_REGISTRY');
const market = pick('NEXT_PUBLIC_EMERGE_MARKET');
const royalties = pick('NEXT_PUBLIC_EMERGE_ROYALTIES');
const vault = env.NEXT_PUBLIC_EMERGE_VAULT ?? '0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062';
const site = (env.NEXT_PUBLIC_SITE_URL ?? 'https://www.emergerh.world').replace(/\/$/, '');

const chain = defineChain({ id: wantChainId, name: testnet ? 'Robinhood Chain (test)' : 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl) });

const ERC20 = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)']);
const LAND = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function owner() view returns (address)', 'function minter() view returns (address)',
  'function royaltyReceiver() view returns (address)', 'function royaltyBps() view returns (uint96)', 'function baseURI() view returns (string)', 'function contractURI() view returns (string)',
  'function mintedCount() view returns (uint256)', 'function supportsInterface(bytes4) view returns (bool)', 'function royaltyInfo(uint256,uint256) view returns (address,uint256)',
]);
const MARKET = parseAbi(['function land() view returns (address)', 'function token() view returns (address)', 'function paused() view returns (bool)', 'function listedCount() view returns (uint256)', 'function owner() view returns (address)']);
const ROYALTIES = parseAbi(['function vault() view returns (address)', 'function owner() view returns (address)']);

let failed = 0;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const say = (good, label, detail = '') => { console.log(`${good ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`); if (!good) failed++; };
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

try {
  const id = await client.getChainId();
  say(id === wantChainId, `RPC ${rpcUrl} answers for chain ${wantChainId}`, `chain id ${id}`);
  const block = await client.getBlockNumber();
  say(block > 0n, 'the chain is producing blocks', `block ${block}`);

  const gas = await client.getBalance({ address: vault });
  say(gas > 0n, `the vault ${vault} holds ETH for gas`, `${formatEther(gas)} ETH`);

  if (!token) say(false, 'NEXT_PUBLIC_EMERGE_TOKEN is set');
  else {
    const [dec, sym] = await Promise.all([read(token, ERC20, 'decimals'), read(token, ERC20, 'symbol').catch(() => '?')]);
    say(dec === 18, `$EMERGE at ${token} has 18 decimals`, `${sym}, ${dec} decimals`);
    const held = await read(token, ERC20, 'balanceOf', [vault]);
    say(true, 'the vault holds $EMERGE', `${formatEther(held)}`);
  }

  if (!land) say(false, 'NEXT_PUBLIC_EMERGE_REGISTRY (the land contract) is set: plots are not tokens without it');
  else {
    const [name, sym, owner, minter, receiver, bps, base, curi, minted] = await Promise.all([
      read(land, LAND, 'name'), read(land, LAND, 'symbol'), read(land, LAND, 'owner'), read(land, LAND, 'minter'), read(land, LAND, 'royaltyReceiver'),
      read(land, LAND, 'royaltyBps'), read(land, LAND, 'baseURI'), read(land, LAND, 'contractURI'), read(land, LAND, 'mintedCount'),
    ]);
    say(name === 'Emerge Land' && sym === 'EMLAND', `the land contract at ${land} is Emerge Land`, `${name} (${sym}), ${minted} minted, owner ${owner}`);
    say(same(minter, vault), 'the vault is the minter (setMinter was called)', `minter ${minter}`);
    say(base === `${site}/api/nft/`, 'baseURI points at this site with a trailing slash', base);
    say(curi === `${site}/api/nft/collection`, 'contractURI points at the collection route', curi);
    say(bps > 0n && bps <= 1000n, 'royalty is set', `${Number(bps) / 100}%`);
    say(!royalties || same(receiver, royalties), 'the royalty receiver is the EmergeRoyalties contract', `receiver ${receiver}`);
    const [i721, i2981, i4906] = await Promise.all(['0x80ac58cd', '0x2a55205a', '0x49064906'].map((i) => read(land, LAND, 'supportsInterface', [i])));
    say(i721 && i2981 && i4906, 'ERC-721, ERC-2981 and ERC-4906 are declared (what OpenSea reads)');
    const [rcv, amt] = await read(land, LAND, 'royaltyInfo', [1n, 10n ** 20n]);
    say(same(rcv, receiver) && amt === (10n ** 20n * bps) / 10000n, 'royaltyInfo pays the receiver the set share');
  }

  if (!market) say(true, 'no market set: the land market sells on OpenSea only (NEXT_PUBLIC_EMERGE_MARKET unset)');
  else {
    const [mLand, mToken, paused, listed] = await Promise.all([read(market, MARKET, 'land'), read(market, MARKET, 'token'), read(market, MARKET, 'paused'), read(market, MARKET, 'listedCount')]);
    say(same(mLand, land), `the market at ${market} sells this land contract`, `land ${mLand}`);
    say(same(mToken, token), 'the market is priced in this $EMERGE', `token ${mToken}`);
    say(!paused, 'the market is not paused', `${listed} listed`);
  }

  if (!royalties) say(true, 'no royalty receiver set: royalties are not swept (NEXT_PUBLIC_EMERGE_ROYALTIES unset)');
  else {
    const rVault = await read(royalties, ROYALTIES, 'vault');
    say(same(rVault, vault), `the royalty receiver at ${royalties} sweeps to the vault`, `vault ${rVault}`);
    const waiting = await client.getBalance({ address: royalties });
    if (token) { const t = await read(token, ERC20, 'balanceOf', [royalties]); say(true, 'royalties waiting to be swept', `${formatEther(t)} $EMERGE, ${formatEther(waiting)} ETH`); }
  }

  // The site, if reachable from here: its status has to agree with the chain.
  try {
    const status = await fetch(`${site}/api/nft`).then((r) => r.json());
    say(status.live === true, `${site}/api/nft says plots are tokens`, JSON.stringify({ land: status.land, market: status.market, royalties: status.royalties, minter: status.minter, canSign: status.canSign, minted: status.mintedCount, rows: status.rows, unminted: status.unminted, queue: status.queue }));
    say(same(status.land, land) && (!market || same(status.market, market)) && (!royalties || same(status.royalties, royalties)), 'the site was built with these addresses');
    say(status.canSign === true && same(status.minter, vault), 'the site can sign as the vault (EMERGE_VAULT_PRIVATE_KEY is set and matches)');
    say(!status.chainProblem, 'the site can read the chain', status.chainProblem ?? '');
  } catch (error) {
    say(true, `${site} not checked from here`, error instanceof Error ? error.message : String(error));
  }
} catch (error) {
  say(false, 'could not finish', error instanceof Error ? (error.shortMessage ?? error.message) : String(error));
}
console.log(failed ? `\n${failed} problem${failed === 1 ? '' : 's'}.` : '\nEverything agrees.');
process.exit(failed ? 1 : 0);
