#!/usr/bin/env node
/*
 * The day's payout budget, headless.
 *
 * The vault pays out a share of what it kept from charges over a trailing
 * window, a day at a time, and never more than a small share of what it
 * holds free and clear, under a hard cap. This drives the accounting with
 * the store in memory and the chain stubbed, and checks each rule binds
 * when it should, that a charge that has just landed shows at once, that
 * the window forgets a fortnight-old charge, and that a reservation is
 * refused past the budget.
 *
 *   node scripts/check-emission.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-emission-'));
let failures = 0;
const say = (label, cond, extra = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

try {
  execFileSync('npx', ['tsc', 'lib/server/accounts.ts', 'lib/server/treasury.ts', 'lib/server/kv.ts', 'lib/chain/vault.ts', 'lib/limits.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2020',
    '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
} catch {
  // Type errors in files this does not run; the emit is what matters.
}
mkdirSync(join(out, 'server'), { recursive: true });
// The chain, stubbed: the vault holds whatever the test says.
writeFileSync(join(out, 'server', 'signer.js'), `
exports.vaultHealth = async () => ({ ok: true, tokens: global.__vaultTokens, gas: 1n, problem: null });
exports.vaultCanSign = () => false;
exports.burnFromVault = async () => ({ ok: false, reason: 'stub' });
`);
writeFileSync(join(out, 'server-only.js'), 'module.exports = {};');
writeFileSync(join(out, 'stub.js'), 'module.exports = new Proxy({}, { get: () => () => null });');
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'server-only') return join(out, 'server-only.js');
  // The client-side network helpers the vault module reaches for are not this guard's business.
  if (/(^|\/)net\//.test(request)) return join(out, 'stub.js');
  if (request.startsWith('@/lib/')) request = join(out, request.slice('@/lib/'.length));
  return original.call(this, request, ...rest);
};
process.env.NODE_PATH = join(root, 'node_modules');
Module._initPaths();
const require = createRequire(import.meta.url);
const A = require(join(out, 'server', 'accounts.js'));
const T = require(join(out, 'server', 'treasury.js'));
const V = require(join(out, 'chain', 'vault.js'));

global.__vaultTokens = 100_000_000;
const now = Date.now();

// 1. Nothing charged: nothing to pay, and the intake rule is the one that says so.
let b = await A.emissionBudget(now);
say('with nothing charged the budget is nought', b.budget === 0 && b.bound === 'intake', JSON.stringify(b));
say('and a reservation against it is refused', (await A.reserveEmission('0xabc', 1_000, 1_000_000, null, b.budget)) === false);

// 2. A charge lands: the budget is a share of what the vault kept, per day of the window, at once.
await T.noteCharge(720_000);
const kept = V.chargeSplit(720_000).kept;
b = await A.emissionBudget(now);
say('a charge that has just landed shows in the budget at once', b.kept === kept, `kept ${b.kept}`);
say('the budget is half the kept intake, a day of the window at a time', b.budget === Math.floor((kept * V.EMISSION_INTAKE_SHARE) / V.EMISSION_WINDOW_DAYS) && b.bound === 'intake', `${b.budget} of ${kept}`);
say('a reservation inside it is taken', (await A.reserveEmission('0xabc', b.budget, 1_000_000, null, b.budget)) === true);
say('and one past it is refused', (await A.reserveEmission('0xdef', 1, 1_000_000, null, b.budget)) === false);
const room = await A.emissionRoom('0xdef', 1_000_000, null, null, b);
say('the room says the day is spent and why', room.globalLeft === 0 && room.bound === 'intake' && room.kept === kept, JSON.stringify(room));

// 3. A fortnight of charges, then a vault that holds little: the balance rule binds.
for (let i = 0; i < 13; i++) await T.noteCharge(4_000_000);
b = await A.emissionBudget(now + 1);
say('more charges raise the budget', b.budget > 100_000 && b.bound === 'intake', `${b.budget}`);
global.__vaultTokens = 1_000_000;
await T.noteCharge(100); // clears the cached budget
b = await A.emissionBudget(now + 2);
say('a vault holding little is bound by what it holds', b.bound === 'balance' && b.budget === Math.floor(b.free * V.EMISSION_BALANCE_SHARE), `${b.budget} of ${b.free} free`);
say('what it holds free is net of the burn it owes and the dividend pool', b.free < 1_000_000, `${b.free}`);

// 4. The hard cap still stands above everything.
global.__vaultTokens = 100_000_000_000;
for (let i = 0; i < 40; i++) await T.noteCharge(50_000_000);
b = await A.emissionBudget(now + 3);
say('the hard cap binds when intake and balance would pay more', b.bound === 'cap' && b.budget === A.emissionCap(), `${b.budget}`);

// 5. The window forgets: the same store read a fortnight on has no intake.
say('a fortnight on, the charges have fallen out of the window', (await T.keptOver(V.EMISSION_WINDOW_DAYS, now + 16 * 86_400_000)) === 0);
const later = await A.emissionBudget(now + 16 * 86_400_000);
say('and the budget is nought again', later.budget === 0 && later.bound === 'intake', `${later.budget}`);

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
