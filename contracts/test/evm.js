/* A tiny EVM harness over @ethereumjs/vm: deploy, call, read logs, expect reverts. */
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const { Address, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { encodeFunctionData, decodeFunctionResult, decodeEventLog, parseAbi } = require('viem');
const fs = require('fs');
const load = (name) => JSON.parse(fs.readFileSync(`${name}.json`, 'utf8'));
async function make() {
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });
  const fund = async (addr) => { const a = await vm.stateManager.getAccount(addr) ?? (await import('@ethereumjs/util')).Account.fromAccountData({}); a.balance = 10n ** 24n; await vm.stateManager.putAccount(addr, a); };
  const who = (n) => new Address(hexToBytes('0x' + n.toString(16).padStart(40, '0')));
  const deploy = async (name, from, args = [], abiArgs = []) => {
    const art = load(name);
    let data = art.bytecode;
    if (args.length) { const { encodeAbiParameters } = require('viem'); data += encodeAbiParameters(abiArgs, args).slice(2); }
    const r = await vm.evm.runCall({ caller: from, data: hexToBytes(data), gasLimit: 10_000_000n });
    if (r.execResult.exceptionError) throw new Error(`deploy ${name} failed: ${r.execResult.exceptionError.error}`);
    return { address: r.createdAddress, abi: art.abi };
  };
  const call = async (c, from, fn, args = [], value = 0n) => {
    const data = encodeFunctionData({ abi: c.abi, functionName: fn, args });
    const r = await vm.evm.runCall({ caller: from, to: c.address, data: hexToBytes(data), value, gasLimit: 5_000_000n });
    const logs = (r.execResult.logs || []).map(([addr, topics, d]) => { try { return decodeEventLog({ abi: c.abi, topics: topics.map(bytesToHex), data: bytesToHex(d) }); } catch { return null; } }).filter(Boolean);
    if (r.execResult.exceptionError) {
      let reason = r.execResult.exceptionError.error;
      const ret = bytesToHex(r.execResult.returnValue);
      if (ret.startsWith('0x08c379a0')) { const { decodeAbiParameters } = require('viem'); reason = decodeAbiParameters([{ type: 'string' }], '0x' + ret.slice(10))[0]; }
      return { ok: false, reason, logs };
    }
    let result; try { result = decodeFunctionResult({ abi: c.abi, functionName: fn, data: bytesToHex(r.execResult.returnValue) }); } catch { result = undefined; }
    return { ok: true, result, logs, gas: r.execResult.executionGasUsed };
  };
  const sendValue = async (from, to, value) => { const r = await vm.evm.runCall({ caller: from, to, value, gasLimit: 100_000n, data: new Uint8Array() }); return !r.execResult.exceptionError; };
  const balance = async (addr) => (await vm.stateManager.getAccount(addr))?.balance ?? 0n;
  return { vm, who, fund, deploy, call, sendValue, balance, hex: (a) => a.toString() };
}
module.exports = { make, parseAbi };
