#!/usr/bin/env node
/*
 * What a browser keeps of its own record when the server's copy comes back.
 *
 * Which of a player's worlds pay is decided by claim order, so a plot given
 * up long ago that stays on the record pushes the real ones past the limit
 * that pays, and a player holding one plot is told it earns nothing. The
 * server drops such plots when it reads the record back against the
 * registry; this checks the browser does not put them straight back.
 *
 *   node scripts/check-record.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-record-'));
try {
  execFileSync('npx', ['tsc', 'lib/world/plots.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop', '--jsx', 'react'], { stdio: 'pipe' });
} catch {
  // Type errors in files this does not run; the emit is what matters.
}
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/lib/')) request = join(out, request.slice('@/lib/'.length));
  else if (request.startsWith('@/components/')) request = join(out, 'stub.js');
  return original.call(this, request, ...rest);
};
writeFileSync(join(out, 'stub.js'), 'module.exports = new Proxy({}, { get: () => () => null });');
process.env.NODE_PATH = join(root, 'node_modules');
Module._initPaths();
const require = createRequire(import.meta.url);
const P = require(join(out, 'world', 'plots.js'));

let failures = 0;
const say = (label, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

const now = Date.now();
const claim = (seed, claimedAt) => ({ seed, name: `World ${seed}`, region: 'Test', price: 1, claimedAt, owner: '0xme', txHash: null });
const record = (claims, savedAt) => ({ ledger: { balance: 0 }, name: 'Me', nameChanges: 0, nameTokens: 0, claims, prospected: [], listings: [], savedAt });

// The browser remembers four plots given up months ago, then the one it really holds.
const gone = [11, 12, 13, 14].map((seed) => claim(seed, now - 90 * 86_400_000));
const held = claim(99, now - 30 * 86_400_000);
const local = record([...gone, held], now - 60_000);
// The server's copy, reconciled against the registry: only what the wallet holds.
const remote = record([held], now);

const merged = P.mergeRecords(local, remote);
const seeds = merged.claims.map((c) => c.seed);
say('land the server no longer lists is not put back by the browser', !seeds.some((s) => s <= 14), seeds.join(','));
say('the plot the wallet holds is kept', seeds.includes(99));
// The first five claimed pay: EARNING_PLOT_LIMIT in lib/chain/vault.
const paying = [...merged.claims].sort((a, b) => a.claimedAt - b.claimedAt).slice(0, 5).some((c) => c.seed === 99);
say('and it is inside the earning limit', paying);

// A claim made in this browser a moment ago, not yet on the server's copy, survives the merge.
const fresh = claim(200, now - 30_000);
const withFresh = P.mergeRecords(record([...gone, held, fresh], now), remote);
say('a claim made here moments ago is kept', withFresh.claims.some((c) => c.seed === 200) && !withFresh.claims.some((c) => c.seed === 11));

// The other way round: the server's copy is the newer one and carries a plot this browser has never seen.
const bought = claim(300, now - 5 * 86_400_000);
const fromServer = P.mergeRecords(record([held], now - 3_600_000), record([held, bought], now));
say('a plot that arrived on another device is taken up', fromServer.claims.some((c) => c.seed === 300));

// When the browser's copy is the newer, the rule is the same.
const newerLocal = P.mergeRecords(record([...gone, held, fresh], now + 1), record([held], now - 1_000));
say('a newer browser copy still does not revive what the server dropped', !newerLocal.claims.some((c) => c.seed === 11) && newerLocal.claims.some((c) => c.seed === 200));

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
