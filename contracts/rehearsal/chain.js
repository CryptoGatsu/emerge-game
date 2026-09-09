/*
 * The chain, from the players' side: real signed transactions against the
 * node the rehearsal runs on. Defaults are the well-known `ganache -d`
 * development keys, which are public and hold nothing anywhere real. Point
 * RPC_URL and the three keys at a testnet to rehearse there instead.
 */
const { createWalletClient, createPublicClient, http, defineChain, parseUnits, encodeFunctionData } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const fs = require('fs');
const path = require('path');
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 4663);
const deployedPath = process.env.DEPLOYED ?? path.join(__dirname, 'deployed.json');
const deployed = fs.existsSync(deployedPath) ? JSON.parse(fs.readFileSync(deployedPath, 'utf8')) : {};
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', `${n}.json`), 'utf8')).abi;
const ABI = { token: art('MockToken'), land: art('EmergeLand'), market: art('EmergeMarket'), royalties: art('EmergeRoyalties') };
const chain = defineChain({ id: CHAIN_ID, name: 'rehearsal', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const KEYS = {
  vault: process.env.VAULT_KEY ?? '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
  a: process.env.PLAYER_A_KEY ?? '0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1',
  b: process.env.PLAYER_B_KEY ?? '0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c',
};
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (who) => { const account = privateKeyToAccount(KEYS[who]); return { account, client: createWalletClient({ account, chain, transport: http(RPC) }) }; };
const addr = (who) => privateKeyToAccount(KEYS[who]).address;
const E = (n) => parseUnits(String(n), 18);
async function write(who, which, functionName, args, value) {
  const { client } = wallet(who);
  const hash = await client.writeContract({ address: deployed[which], abi: ABI[which], functionName, args, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { hash, status: r.status };
}
const read = (which, functionName, args = []) => pub.readContract({ address: deployed[which], abi: ABI[which], functionName, args });
async function sendEth(who, to, wei) { const { client } = wallet(who); const hash = await client.sendTransaction({ to, value: wei }); await pub.waitForTransactionReceipt({ hash }); return hash; }
const ownerOf = async (seed) => { try { return (await read('land', 'ownerOf', [BigInt(seed)])).toLowerCase(); } catch { return null; } };
module.exports = { RPC, CHAIN_ID, deployed, ABI, pub, wallet, addr, E, write, read, sendEth, ownerOf, encodeFunctionData };
