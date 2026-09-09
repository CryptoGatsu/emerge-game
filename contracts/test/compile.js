const solc = require('solc');
const fs = require('fs');
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const input = { language: 'Solidity', sources: { [file]: { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: process.env.EVM ?? 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.log(e.severity + ': ' + e.formattedMessage.split('\n')[0]);
if (errors.length) process.exit(1);
for (const [name, c] of Object.entries(out.contracts[file])) { console.log(`${name}: ${c.evm.bytecode.object.length / 2} bytes`); fs.writeFileSync(`${name}.json`, JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object })); }
