#!/usr/bin/env node
/*
 * The standing programmes, headless.
 *
 * A town that has built everything it can afford has nowhere for its Gold to
 * go, and a full treasury turns income away. Programmes are the other shape
 * of spending: a bill every day, and a change in how the place runs. This
 * checks that each is charged, that the bill scales with the town and its
 * age, that a treasury which cannot cover one drops it rather than running
 * on credit, and that each actually moves the thing it says it moves.
 *
 *   node scripts/check-programmes.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-programmes-'));
try {
  execFileSync('npx', ['tsc', 'lib/simulation.ts', 'lib/world/save.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2020',
    '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop', '--jsx', 'react'], { stdio: 'pipe' });
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
const S = require(join(out, 'simulation.js'));
const SV = require(join(out, 'world', 'save.js'));

let failures = 0;
const say = (label, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

const grown = (days = 30) => {
  let w = S.createWorld(1120, 'Probe');
  for (let d = 0; d < days; d++) { w.treasury = Math.max(w.treasury, 20_000); for (let h = 0; h < 24; h++) w = S.advance(w, 1); }
  return w;
};
const runDay = (w) => { for (let h = 0; h < 24; h++) w = S.advance(w, 1); return w; };

let w = grown();
say('there are programmes to run', S.PROGRAMMES.length >= 5, S.PROGRAMMES.map((p) => p.key).join(', '));
say('none runs until it is begun', S.programmesBill(w) === 0 && !S.programmeOn(w, 'watch'));

// Every programme costs something a town of this size can be quoted.
for (const spec of S.PROGRAMMES) {
  const cost = S.programmeCost(w, spec.key);
  say(`${spec.name} is priced`, Number.isFinite(cost) && cost >= 0, `${cost} Gold a day`);
}

// Begun, charged, and the ledger says so under its own heading.
w.treasury = 40_000;
const started = S.setProgramme(w, 'watch', true);
say('a programme begins', started.ok && S.programmeOn(w, 'watch'), started.message);
const bill = S.programmeCost(w, 'watch');
w = runDay(w);
const booked = w.ledgerYesterday?.out?.programmes ?? w.ledger?.out?.programmes ?? 0;
say('the day charges for it, under its own heading', booked >= bill * 0.9, `${Math.round(booked)} booked against ${bill} a day`);

// The same day, run twice from the same morning: the one paying for a
// programme ends with less. Comparing against the day before would not do
// it — a town takes Gold in as well as paying it out.
const twin = () => { const x = grown(20); x.treasury = 40_000; return x; };
const idle = runDay(twin());
const paying = (() => { const x = twin(); S.setProgramme(x, 'watch', true); return runDay(x); })();
say('and the treasury is lower for it', paying.treasury < idle.treasury,
  `${Math.round(idle.treasury)} idle, ${Math.round(paying.treasury)} paying`);

// A bill nobody can pay lapses the programme rather than running on credit.
w.treasury = 1;
w = runDay(w);
say('a programme the treasury cannot cover lapses', !S.programmeOn(w, 'watch'), `treasury ${Math.round(w.treasury)}`);
say('and never leaves the treasury below nought', w.treasury >= 0, String(w.treasury));
say('the feed says which lapsed', w.feed.some((f) => /lapsed: the treasury could not cover/.test(f.text)), (w.feed.find((f) => /lapsed/.test(f.text)) ?? {}).text ?? '(none)');
const broke = twin(); broke.treasury = 1;
say('one that cannot be paid for cannot be begun', !S.setProgramme(broke, 'physicians', true).ok,
  S.setProgramme(broke, 'physicians', true).message);

// The bill grows with the town and with the age it is in.
const small = grown(20);
// A town of two hundred, so the bill is the per-head term rather than the floor.
const big = grown(20);
const seedFolk = [...big.citizens];
for (let i = 0; big.citizens.length < 200; i++) {
  const twinned = JSON.parse(JSON.stringify(seedFolk[i % seedFolk.length]));
  twinned.id = `extra${i}`; twinned.name = `Extra ${i}`;
  big.citizens.push(twinned);
}
say('a bigger town pays a bigger bill', S.programmeCost(big, 'watch') > S.programmeCost(small, 'watch'),
  `${S.programmeCost(small, 'watch')} for ${small.citizens.length} people, ${S.programmeCost(big, 'watch')} for ${big.citizens.length}`);
const older = JSON.parse(JSON.stringify(big)); older.era = 3;
say('a later age pays a bigger bill', S.programmeCost(older, 'watch') > S.programmeCost(big, 'watch'),
  `era 1 ${S.programmeCost(big, 'watch')}, era 3 ${S.programmeCost(older, 'watch')}`);

// Each does the thing it says it does.
const fresh = () => { const x = grown(20); x.treasury = 200_000; return x; };
let a = fresh();
const paceBefore = S.transportBoost(a);
S.setProgramme(a, 'roadworks', true);
say('roadworks make everybody quicker', S.transportBoost(a) > paceBefore, `${paceBefore.toFixed(2)} -> ${S.transportBoost(a).toFixed(2)}`);

a = fresh();
const learnBefore = S.learningRate(a);
S.setProgramme(a, 'apprentices', true);
say('apprenticeships make a day teach more', S.learningRate(a) > learnBefore, `${learnBefore.toFixed(2)} -> ${S.learningRate(a).toFixed(2)}`);

a = fresh();
const careBefore = S.careOf(a), readyBefore = S.readiness(a).plague;
S.setProgramme(a, 'physicians', true);
say('physicians attend the sick', S.careOf(a) > careBefore && S.hasCare(a), `care ${careBefore.toFixed(2)} -> ${S.careOf(a).toFixed(2)}`);
say('and the town is readier for a plague', S.readiness(a).plague > readyBefore, `${readyBefore.toFixed(2)} -> ${S.readiness(a).plague.toFixed(2)}`);

// Relief costs nothing where nobody is poor, and reaches the poorest where they are.
a = fresh();
S.setProgramme(a, 'relief', true);
const poorBefore = a.citizens.filter((c) => c.wealth === 'poor');
const pursesBefore = poorBefore.reduce((s, c) => s + c.wallet, 0);
a = runDay(a);
const reliefCost = a.ledgerYesterday?.out?.programmes ?? 0;
if (poorBefore.length) {
  const pursesAfter = a.citizens.filter((c) => poorBefore.some((p) => p.id === c.id)).reduce((s, c) => s + c.wallet, 0);
  say('relief reaches the poorest purses', pursesAfter > pursesBefore || reliefCost > 0, `${Math.round(pursesBefore)} -> ${Math.round(pursesAfter)}, ${Math.round(reliefCost)} paid`);
} else {
  say('relief costs nothing where nobody is poor', S.programmeCost(a, 'relief') === 0);
}

// The night watch holds trouble down: the chance the day rolls against.
a = fresh();
const rogueBefore = S.rogueChance(a);
S.setProgramme(a, 'watch', true);
const rogueAfter = S.rogueChance(a);
say('the night watch makes turning on the town rarer', rogueAfter < rogueBefore,
  `${(rogueBefore * 100).toFixed(1)}% a day -> ${(rogueAfter * 100).toFixed(1)}%`);
say('and it holds alongside a jail rather than instead of one', (() => {
  const x = fresh();
  const jail = x.buildings.find((b) => b.type === 'Jail');
  if (!jail) x.buildings.push({ id: 'jail-probe', type: 'Jail', x: 50, y: 50, workers: [], active: true });
  const withJail = S.rogueChance(x);
  S.setProgramme(x, 'watch', true);
  return S.rogueChance(x) < withJail;
})());

// A programme survives a save, or a town would wake with its bills cancelled.
a = fresh();
S.setProgramme(a, 'watch', true);
S.setProgramme(a, 'physicians', true);
const back = SV.worldFromSave(JSON.parse(JSON.stringify(SV.snapshotOf(a))), 1120, 'Probe');
say('programmes survive a save', S.programmeOn(back, 'watch') && S.programmeOn(back, 'physicians'), (back.programmes ?? []).join(', '));

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
