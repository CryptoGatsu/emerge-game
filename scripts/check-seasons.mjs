#!/usr/bin/env node
/*
 * The weather on the ground and the year's holidays, headless.
 *
 * Runs a settlement through a winter with the snow forced, and through the
 * holidays, and checks that: snow settles and holds; people go out and play
 * in it and leave snowmen and angels behind; doorsteps get cleared; the
 * hearths burn wood in the cold, the stacks take stone in a storm and the
 * rain spoils wheat with no granary; each holiday is held and leaves its
 * mark; and the day gets talked about. Same harness as the other guards:
 * the simulation is compiled to a temp dir and driven directly.
 *
 *   node scripts/check-seasons.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-seasons-'));
try {
  execFileSync('npx', ['tsc', 'lib/simulation.ts', 'lib/speech.ts', 'lib/dialogue.ts', 'lib/world/plots.ts',
    '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--moduleResolution', 'node',
    '--skipLibCheck', '--esModuleInterop', '--jsx', 'react'], { stdio: 'pipe' });
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
const SP = require(join(out, 'speech.js'));

let failures = 0;
const say = (label, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
const feedSince = (w, day, re) => said.filter((f) => f.day >= day && re.test(f.text));

let w = S.createWorld(1120, 'Probe');
// The feed keeps forty lines; everything it ever said is kept here.
const said = [];
const seen = new Set();
const remember = () => { for (const f of w.feed) { const k = `${f.day}:${f.text}`; if (!seen.has(k)) { seen.add(k); said.push({ day: f.day, text: f.text }); } } };
const hour = (weather) => { w = S.advance(w, 1); if (weather) w.weather = weather; remember(); };
const runDay = (weather) => { w.gold = Math.max(w.gold ?? 0, 200_000); w.treasury = Math.max(w.treasury, 4000); for (let h = 0; h < 24; h++) hour(weather); };

// Into the winter: day 19 is the first winter day of the first year.
while (w.day < 18) runDay();
w.resources.wood = Math.max(w.resources.wood, 80);
const woodBefore = w.resources.wood;
runDay('Snow');
const firstSnowDay = w.day;
say('the calendar knows the season', w.season === 'Winter', `day ${w.day} ${w.season}`);
say('snow lies after a day of it', (w.ground?.snow ?? 0) > 0.85, `snow ${w.ground?.snow?.toFixed(2)} wet ${w.ground?.wet?.toFixed(2)}`);
say('a snowy day burns more firewood in the hearths', feedSince(w, firstSnowDay - 1, /Snow on the ground\. \d+ loads of firewood/).length > 0 && w.resources.wood < woodBefore, feedSince(w, firstSnowDay - 1, /hearths/).map((f) => f.text).join(' | '));

// Two clear, cold days on the lying snow: the play happens off the clock.
let plays = new Set(), snowballs = 0, shovels = 0, angels = 0, snowmen = 0;
for (let d = 0; d < 3; d++) {
  for (let h = 0; h < 24; h++) {
    hour('Clear');
    for (const c of w.citizens) if (c.play) { plays.add(`${c.id}:${c.play.kind}`); if (c.play.kind === 'snowball') snowballs++; if (c.play.kind === 'shovel') shovels++; if (c.play.kind === 'angel') angels++; if (c.play.kind === 'snowman') snowmen++; }
  }
}
say('snow holds in the cold', (w.ground?.snow ?? 0) > 0.6, `snow ${w.ground?.snow?.toFixed(2)} temp ${w.temperature.toFixed(1)}`);
say('people play in the snow', plays.size > 0, `${plays.size} plays: ${snowballs} snowball, ${snowmen} snowman, ${angels} angel, ${shovels} shovel hours`);
say('snowmen are left standing', (w.snowmen ?? []).length > 0, `${(w.snowmen ?? []).length} snowmen by ${(w.snowmen ?? []).map((m) => m.by).join(', ')}`);
say('angels are left in the snow', (w.angels ?? []).length > 0, `${(w.angels ?? []).length}`);
// Clearing a doorstep needs a grown adult standing free at their own house
// in lying snow, and whether three days of business leave one there is
// chance rather than mechanism. So give it a longer winter to happen in,
// with the snow held down, rather than calling the mechanism broken because
// one seed's week was busy.
for (let d = 0; d < 8 && !w.buildings.some((b) => b.snowCleared !== undefined); d++) {
  for (let h = 0; h < 24; h++) {
    w.ground.snow = 1;
    hour('Clear');
    for (const c of w.citizens) if (c.play?.kind === 'shovel') shovels++;
  }
}
say('doorsteps get cleared', w.buildings.some((b) => b.snowCleared !== undefined), w.buildings.filter((b) => b.snowCleared !== undefined).map((b) => `${b.type}@${b.snowCleared}`).join(', '));
say('the feed tells of it', feedSince(w, firstSnowDay, /snowball fight|built a snowman|clearing the snow/).length > 0, feedSince(w, firstSnowDay, /snowball fight|built a snowman|clearing the snow/).slice(0, 3).map((f) => f.text).join(' | '));
say('a play never leaves somebody stuck in it', w.citizens.every((c) => !c.play || (c.play.day === w.day && c.play.until > w.hour - 1)));
// Somebody says something about the snow.
//
// Said at a time and in a state where the snow is the thing to remark on:
// the middle of a lying-snow day, with everybody about. Left to whatever
// hour the run happened to end on, this asked a sleeping town what it
// thought of the weather and read the silence as a failure.
//
// And asked exactly, not by sampling. A line about the day is only reached
// on six of a hundred roll residues, and the roll is (hash * 31 + beat * 17)
// mod 100, so a hundred consecutive beats put every citizen on every
// residue exactly once; anybody mid-conversation says nothing at all, so
// the conversations are cleared first. And not on a holiday: the day line
// gives a holiday first and the snow nothing, and how many days the
// doorstep loop above took decides whether this lands on one. What is
// left is the mechanism.
while (S.holidayFor(w.day)) w.day += 1;
w.hour = 12;
w.ground = { snow: 1, wet: 0 };
w.conversations = [];
for (const c of w.citizens) { c.inside = false; c.activity = 'wandering'; c.seeking = undefined; }
let snowLines = 0;
for (const c of w.citizens) for (let beat = 0; beat < 100; beat++) { const t = SP.speechFor(w, c, beat); if (t && /snow|ice|boots|log on the fire|children have been out/i.test(t)) snowLines++; }
say('the snow is talked about', snowLines > 0, `${snowLines} lines`);

// The thaw: warm days, rain, and the snowmen go with it.
for (let d = 0; d < 3; d++) { for (let h = 0; h < 24; h++) hour('Rain'); }
say('rain and warmth take the snow', (w.ground?.snow ?? 0) < 0.2, `snow ${w.ground?.snow?.toFixed(2)}`);
say('and the snowmen with it', (w.snowmen ?? []).length === 0 && feedSince(w, w.day - 3, /melted away/).length > 0);
say('wet ground after rain', (w.ground?.wet ?? 0) > 0.6, `wet ${w.ground?.wet?.toFixed(2)}`);
say('rain spoils wheat with no granary', feedSince(w, w.day - 3, /Rain got into the wheat/).length > 0 || w.buildings.some((b) => b.type === 'Granary'));
const stoneBefore = w.resources.stone = Math.max(w.resources.stone, 30);
runDay('Storm');
say('a storm has stone laid on the stacks', feedSince(w, w.day - 1, /hold them down/).length > 0 && w.resources.stone < stoneBefore, feedSince(w, w.day - 1, /hold them down/).map((f) => f.text).join(' | '));

// The holidays, one year on: each is scheduled, held, and leaves its line.
const wanted = ['Blossom Day', 'Midsummer Fair', 'Halloween', 'Thanksgiving', 'Christmas', 'New Year’s Eve'];
const scheduled = new Set();
for (let d = 0; d < 26; d++) {
  runDay();
  for (const g of w.gatherings) if (g.kind === 'holiday') scheduled.add(g.name);
}
for (const name of wanted) {
  const line = said.find((f) => f.text.startsWith(name + ':'));
  say(`${name} is held`, scheduled.has(name) && !!line, line ? line.text : scheduled.has(name) ? 'scheduled, never concluded' : 'never scheduled');
}
say('the town is dressed for the holiday the day before', S.decorFor(24 + 17) === 'halloween' && S.decorFor(24 + 16) === 'halloween' && S.decorFor(24 + 22) === 'christmas' && S.decorFor(24 + 24) === 'newyear' && S.decorFor(24 + 12) === null);
// A holiday greeting on the day.
w.day = 24 + 21 + 1; w.hour = 12;
let greetings = 0;
for (const c of w.citizens) for (let beat = 0; beat < 40; beat++) { const t = SP.speechFor(w, c, beat); if (t && /Christmas|tree in the square|gift/i.test(t)) greetings++; }
say('the holiday is talked about on the day', greetings > 0, `${greetings} lines`);

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
