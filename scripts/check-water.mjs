#!/usr/bin/env node
/*
 * Filling water in, headless.
 *
 * The plot's own pond and river can be filled a circle at a time, a dug
 * pond goes in one tap, the ground that results is ground people and
 * buildings can use, the save keeps it, and a dig on filled ground brings
 * the water back.
 *
 *   node scripts/check-water.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-water-'));
try {
  execFileSync('npx', ['tsc', 'lib/simulation.ts', 'lib/world/save.ts', 'lib/world/terrain.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop', '--jsx', 'react'], { stdio: 'pipe' });
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
const T = require(join(out, 'world', 'terrain.js'));

let failures = 0;
const say = (label, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

let w = S.createWorld(1120, 'Probe');
for (let h = 0; h < 24; h++) w = S.advance(w, 1);
w.treasury = 50_000;
const water = () => S.waterOf(w);

// Somewhere in the plot's own water, well away from any bridge.
let spot = null;
for (let y = 10; y < 90 && !spot; y += 1) for (let x = 10; x < 90 && !spot; x += 1) {
  if (water().isWater(x, y) && S.fillProblem(w, x, y) === null && water().distanceToWater(x, y) === 0) {
    // Deep in: every neighbour wet too, so one circle does not clear it by accident.
    if ([[2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => water().isWater(x + dx, y + dy))) spot = [x, y];
  }
}
say('the plot has water of its own to fill', !!spot, spot ? `at ${spot}` : 'none');
if (!spot) { rmSync(out, { recursive: true, force: true }); process.exit(1); }
const [fx, fy] = spot;
const wetBefore = water().coverage;
say('dry ground cannot be filled', S.fillWater(w, 2, 2).ok === false);
const before = w.treasury;
const filled = S.fillWater(w, fx, fy);
say('the plot\'s own water can be filled', filled.ok, filled.message);
say('and it costs Gold', w.treasury === before - S.FILL_GOLD, `${before} -> ${w.treasury}`);
say('the spot is dry now', !water().isWater(fx, fy));
say('and the water is smaller for it', water().coverage < wetBefore, `${wetBefore} -> ${water().coverage}`);
say('the fill is remembered on the world', (w.dug ?? []).some((d) => d.fill), JSON.stringify(w.dug));
say('nobody stands in water afterwards', w.citizens.every((c) => c.afloat || !water().blocks(c.x, c.y)));
say('the terrain draws it as ground, not a bank or water', (() => {
  const map = T.generateWorldMap(w, { props: false });
  const t = map.tileAt(fx, fy);
  return t !== T.Tile.Water && t !== T.Tile.WaterShore && t !== T.Tile.Sand && t !== T.Tile.Marsh;
})());

// A dig on the filled ground brings the water back; a fill of that dug pond takes it out whole.
const dug = S.digWater(w, fx, fy);
say('digging on filled ground brings water back', dug.ok && water().isWater(fx, fy), dug.message);
const refilled = S.fillWater(w, fx, fy);
say('a pond you dug is filled in one tap', refilled.ok && !water().isWater(fx, fy) && !(w.dug ?? []).some((d) => !d.fill), refilled.message);

// A second circle beside the first widens the ground.
const wetNow = water().coverage;
const more = S.fillWater(w, fx + 3, fy);
say('a second tap fills more of it', !more.ok || water().coverage <= wetNow, `${wetNow} -> ${water().coverage}`);

// The save keeps it, and the world read back is dry there too.
const snap = SV.snapshotOf(w);
const back = SV.worldFromSave(JSON.parse(JSON.stringify(snap)), 1120, 'Probe');
say('the save keeps the filled ground', !!back && (back.dug ?? []).some((d) => d.fill) && !S.waterOf(back).isWater(fx, fy));
let on = back;
for (let h = 0; h < 24; h++) on = S.advance(on, 1);
say('and the world runs on', on.citizens.length > 0);

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
