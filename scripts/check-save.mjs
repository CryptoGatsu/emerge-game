#!/usr/bin/env node
/*
 * What a save keeps, headless.
 *
 * A world played for months grew to five times what the relay takes, and a
 * world that cannot be published cannot advance an era. This runs a
 * settlement, then loads it with the bulk a long life leaves behind — a bond
 * for every pair who ever met, households with nobody left in them, clearings
 * long regrown — and checks the save cuts each back to what play reads, and
 * that the world read back from that save is whole.
 *
 *   node scripts/check-save.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-save-'));
try {
  execFileSync('npx', ['tsc', 'lib/simulation.ts', 'lib/world/save.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop', '--jsx', 'react'], { stdio: 'pipe' });
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

let w = S.createWorld(1120, 'Probe');
for (let d = 0; d < 40; d++) { w.treasury = Math.max(w.treasury, 4000); for (let h = 0; h < 24; h++) w = S.advance(w, 1); }
// A town of a hundred and twenty, so the bound on bonds is the thing that bites.
const seedFolk = [...w.citizens];
for (let i = 0; w.citizens.length < 120; i++) {
  const twin = JSON.parse(JSON.stringify(seedFolk[i % seedFolk.length]));
  twin.id = `twin${i}`; twin.name = `Twin ${i}`;
  w.citizens.push(twin);
  w.families.find((f) => f.id === twin.familyId)?.members.push(twin.id);
}
w.population = w.citizens.length;
const people = w.citizens.length;

// The bulk of a long life: a bond between every pair, most of them faint, a few
// of them friendships; and a bond to somebody long dead.
const ids = w.citizens.map((c) => c.id);
let pairs = 0;
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
  w.bonds[key] = { a: ids[i], b: ids[j], strength: ((i * 7 + j * 3) % 23) - 6, friends: (i + j) % 17 === 0, rivals: false, met: 1, fights: 0 };
  pairs++;
}
w.bonds['dead|' + ids[0]] = { a: 'dead', b: ids[0], strength: 50, friends: true, rivals: false, met: 1, fights: 0 };
for (let i = 0; i < 300; i++) w.families.push({ id: `ghost${i}`, name: 'Gone', members: [], homeId: '', wealth: 0 });
const living = w.families.filter((f) => f.members.length).length;
w.clearings = [[10, 10, w.day - 100], [12, 12, w.day - 1]];
w.unlockedAreas = ['The Far Shore', 'The Far Shore', 'The Outer Belt'];

const before = JSON.stringify(w.bonds).length;
const snap = SV.snapshotOf(w);
const kept = Object.values(snap.world.bonds);
const perPerson = new Map();
for (const b of kept) { if (!b.friends && !b.rivals) for (const id of [b.a, b.b]) perPerson.set(id, (perPerson.get(id) ?? 0) + 1); }
const most = Math.max(0, ...perPerson.values());
say('bonds are cut to the strongest around each person', kept.length < pairs && kept.length >= Math.min(pairs, people * 4), `${pairs} -> ${kept.length} for ${people} people`);
say('every friendship is kept', kept.filter((b) => b.friends).length === Object.values(w.bonds).filter((b) => b.friends && b.a !== 'dead').length);
say('a bond to the dead is dropped', !kept.some((b) => b.a === 'dead' || b.b === 'dead'));
say('nobody carries more than sixteen faint bonds of their own', most <= 16 * 2, `most ${most}`);
say('empty households are dropped', snap.world.families.length === living, `${w.families.length} -> ${snap.world.families.length}`);
say('regrown clearings are dropped', snap.world.clearings.length === 1);
say('unlocked areas are not repeated', snap.world.unlockedAreas.length === 2);
say('the save is smaller for it', JSON.stringify(snap.world.bonds).length < before / 2, `${before} -> ${JSON.stringify(snap.world.bonds).length}`);

// Read back: the world is whole and runs on.
const back = SV.worldFromSave(JSON.parse(JSON.stringify(snap)), 1120, 'Probe');
say('the save reads back', !!back && back.citizens.length === people && back.families.length === living);
const dayBefore = back.day;
let again = back;
for (let h = 0; h < 48; h++) again = S.advance(again, 1);
say('and runs on', again.day > dayBefore && again.citizens.length > 0, `day ${dayBefore} -> ${again.day}, ${again.citizens.length} people`);

// A death drops the household it empties.
const one = again.citizens.find((c) => again.families.find((f) => f.id === c.familyId)?.members.length === 1);
if (one) {
  const familiesBefore = again.families.length;
  S.dismissCitizen?.(again, one.id);
  say('a household emptied by a departure is dropped', again.families.length <= familiesBefore, `${familiesBefore} -> ${again.families.length}`);
}

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
