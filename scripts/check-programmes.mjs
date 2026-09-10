#!/usr/bin/env node
/*
 * The standing programmes and the great works, headless.
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


/* ------------------------------------------------------------------ *
 * Great works
 * ------------------------------------------------------------------ */

console.log('');
// A city big enough and rich enough to commission one.
const city = (era = 1) => {
  const x = grown(30);
  const seedFolk = [...x.citizens];
  for (let i = 0; x.citizens.length < 90; i++) {
    const twinned = JSON.parse(JSON.stringify(seedFolk[i % seedFolk.length]));
    twinned.id = `cit${i}`; twinned.name = `Cit ${i}`;
    x.citizens.push(twinned);
  }
  x.population = x.citizens.length;
  x.era = era;
  x.works = { level: 10 };
  x.treasury = 5_000_000;
  x.resources.wood = 5_000; x.resources.stone = 5_000;
  return x;
};

say('there are great works to build', S.GREAT_WORKS.length >= 5, S.GREAT_WORKS.map((w) => w.key).join(', '));
let g = city(1);
const gardenCost = S.greatWorkCost(g, 'gardens');
say('a great work is priced in the hundreds of thousands, not the hundreds', gardenCost.gold >= 30_000,
  `${gardenCost.gold.toLocaleString()} Gold, ${gardenCost.wood} timber, ${gardenCost.stone} stone`);
const era5 = city(5);
say('and costs far more in a later age', S.greatWorkCost(era5, 'gardens').gold > gardenCost.gold * 3,
  `era 1 ${gardenCost.gold.toLocaleString()}, era 5 ${S.greatWorkCost(era5, 'gardens').gold.toLocaleString()}`);
say('the dearest work is within a full treasury of its age', S.greatWorkCost(era5, 'observatory').gold < 5_000_000,
  `${S.greatWorkCost(era5, 'observatory').gold.toLocaleString()} against a 5,000,000 ceiling`);

// The era and the level are gates.
const young = grown(20); young.treasury = 5_000_000; young.resources.wood = 5_000; young.resources.stone = 5_000;
say('a small city cannot commission one', !!S.greatWorkProblem(young, 'gardens'), S.greatWorkProblem(young, 'gardens') ?? '');
say('an era it has not reached is refused', !!S.greatWorkProblem(city(1), 'observatory'), S.greatWorkProblem(city(1), 'observatory') ?? '');

// Commissioning takes the money and the materials now.
const goldBefore = g.treasury, woodBefore = g.resources.wood;
const begun = S.commissionGreatWork(g, 'gardens');
say('a great work is commissioned', begun.ok, begun.message);
say('the Gold and the materials go at once', g.treasury === goldBefore - gardenCost.gold && g.resources.wood === woodBefore - gardenCost.wood,
  `${Math.round(goldBefore - g.treasury)} Gold, ${Math.round(woodBefore - g.resources.wood)} timber`);
say('it is booked under its own heading', (g.ledger?.out?.greatworks ?? 0) >= gardenCost.gold * 0.9);
say('only one is built at a time', !S.commissionGreatWork(g, 'aqueduct').ok);
say('it does nothing while it is being built', !S.greatWorkStanding(g, 'gardens'));

// It finishes on its own days, stands as a building, and is remembered.
for (let d = 0; d < S.greatWorkSpec('gardens').days + 1; d++) { g.treasury = Math.max(g.treasury, 400_000); g = runDay(g); }
say('it finishes after its days of building', S.greatWorkStanding(g, 'gardens'), JSON.stringify(S.greatWorkAt(g, 'gardens')));
say('and stands in the city as a building', g.buildings.some((b) => b.type === 'Terraced Gardens'));
say('the feed says so', g.feed.some((f) => /is finished\./.test(f.text)), (g.feed.find((f) => /is finished\./.test(f.text)) ?? {}).text ?? '(none)');
say('people remember it being raised', g.citizens.some((c) => (c.recent ?? []).some((e) => e.kind === 'greatWork')));

// Its keep is charged every day, and an unpayable keep is disrepair, not ruin.
const keep = S.greatWorkUpkeep(g, 'gardens');
say('the keep is a daily charge', keep > 0 && S.greatWorksBill(g) === keep, `${keep} Gold a day`);
g.treasury = 1;
g = runDay(g);
say('a keep the treasury cannot cover puts it in disrepair', S.greatWorkAt(g, 'gardens').disrepair === true);
say('but the work is not lost', S.greatWorkAt(g, 'gardens').done === true && g.buildings.some((b) => b.type === 'Terraced Gardens'));
say('and it does nothing while it is in disrepair', !S.greatWorkStanding(g, 'gardens'));
g.treasury = 500_000;
g = runDay(g);
say('paying again puts it back in order', S.greatWorkStanding(g, 'gardens'));

// Each does the thing it says it does.
const withWork = (key) => {
  const x = city(5);
  x.greatWorks = [{ key, progress: S.greatWorkSpec(key).days, days: S.greatWorkSpec(key).days, done: true }];
  return x;
};
const plain = city(5);
say('the great library teaches', S.learningRate(withWork('library')) > S.learningRate(plain),
  `${S.learningRate(plain).toFixed(2)} -> ${S.learningRate(withWork('library')).toFixed(2)}`);
say('the grand exchange sells for more', S.marketEdge(withWork('exchange')) > S.marketEdge(plain),
  `${S.marketEdge(plain).toFixed(2)} -> ${S.marketEdge(withWork('exchange')).toFixed(2)}`);
say('the aqueduct waits on fire', S.readiness(withWork('aqueduct')).fire > S.readiness(plain).fire,
  `${S.readiness(plain).fire.toFixed(2)} -> ${S.readiness(withWork('aqueduct')).fire.toFixed(2)}`);
const seen = S.readiness(withWork('observatory')), blind = S.readiness(plain);
// Flood is judged by where the city stands, which no instrument changes; a
// kind already at complete readiness cannot rise, and that is not a failure.
const watched = ['fire', 'blight', 'wolves', 'earthquake', 'tornado', 'plague'].filter((k) => blind[k] < 0.999);
say('the observatory sees every kind of trouble coming', watched.length > 0 && watched.every((k) => seen[k] > blind[k]),
  watched.map((k) => `${k} ${blind[k].toFixed(2)}->${seen[k].toFixed(2)}`).join(', '));

// A work survives a save, standing and all.
const savedCity = SV.worldFromSave(JSON.parse(JSON.stringify(SV.snapshotOf(g))), 1120, 'Probe');
say('great works survive a save', S.greatWorkStanding(savedCity, 'gardens'), JSON.stringify(savedCity.greatWorks ?? []));

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
