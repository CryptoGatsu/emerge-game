/*
 * Deploy the four contracts to the rehearsal node from the vault key — an
 * ERC-20 standing in for $EMERGE, then EmergeRoyalties, EmergeLand and
 * EmergeMarket in the order the docs give — and hand the two players some
 * tokens. Writes deployed.json, which chain.js and the tests read, and
 * prints the environment the app has to be built with.
 *
 * Compile first: `cd ../test && for f in ../EmergeLand.sol ../EmergeRoyalties.sol ../EmergeMarket.sol MockToken.sol; do node compile.js $f; done`.
 */
const fs = require('fs');
const path = require('path');
const { encodeAbiParameters } = require('viem');
const C = require('./chain.js');
const SITE = process.env.SITE ?? 'http://localhost:3471';
const load = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', `${n}.json`), 'utf8'));
async function deploy(name, args, types) {
  const art = load(name);
  const data = art.bytecode + (types.length ? encodeAbiParameters(types, args).slice(2) : '');
  const { client } = C.wallet('vault');
  const hash = await client.sendTransaction({ data, gas: 6_000_000n });
  const r = await C.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${name} failed (${r.status})`);
  console.log(`${name}: ${r.contractAddress}`);
  return { address: r.contractAddress, abi: art.abi };
}
(async () => {
  const vault = C.addr('vault');
  const token = process.env.TOKEN_ADDRESS ? { address: process.env.TOKEN_ADDRESS } : await deploy('MockToken', [], []);
  const royalties = await deploy('EmergeRoyalties', [vault], [{ type: 'address' }]);
  const land = await deploy('EmergeLand', [`${SITE}/api/nft/`, `${SITE}/api/nft/collection`, royalties.address, 500n], [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint96' }]);
  const market = await deploy('EmergeMarket', [land.address, token.address], [{ type: 'address' }, { type: 'address' }]);
  const players = [C.addr('a'), C.addr('b')];
  if (!process.env.TOKEN_ADDRESS) {
    const { client } = C.wallet('vault');
    for (const p of players) { const h = await client.writeContract({ address: token.address, abi: token.abi, functionName: 'mint', args: [p, C.E(5_000_000)] }); await C.pub.waitForTransactionReceipt({ hash: h }); }
  }
  const out = { token: token.address, royalties: royalties.address, land: land.address, market: market.address, vault, players };
  fs.writeFileSync(path.join(__dirname, 'deployed.json'), JSON.stringify(out, null, 2));
  console.log(`\nBuild the app with:\nNEXT_PUBLIC_ROBINHOOD_RPC_URL=${C.RPC} NEXT_PUBLIC_ROBINHOOD_CHAIN_ID=${C.CHAIN_ID} NEXT_PUBLIC_EMERGE_TOKEN=${out.token} NEXT_PUBLIC_EMERGE_REGISTRY=${out.land} NEXT_PUBLIC_EMERGE_MARKET=${out.market} NEXT_PUBLIC_EMERGE_ROYALTIES=${out.royalties} NEXT_PUBLIC_EMERGE_VAULT=${vault} NEXT_PUBLIC_OPENSEA_CHAIN=robinhood NEXT_PUBLIC_SITE_URL=${SITE}`);
})().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
