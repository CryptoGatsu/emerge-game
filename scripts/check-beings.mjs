/**
 * The beings have inner lives, and this checks they still do.
 *
 * Four things a settlement has to keep doing for it to read as people rather
 * than a diorama: adults want things and get them; news travels from mouth
 * to mouth until somebody knows a thing they never saw; people remark on
 * what the owner just did, each in their own voice; and a turn in a
 * conversation is drawn as speech while a musing is drawn as a thought.
 *
 * Runs headless against the compiled simulation. Run it after touching
 * lib/simulation.ts, lib/dialogue.ts or lib/speech.ts:
 *
 *   node scripts/check-beings.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-beings-'));
try {
  execFileSync('npx', ['tsc', 'lib/simulation.ts', 'lib/speech.ts', 'lib/dialogue.ts', 'lib/world/plots.ts',
    '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--moduleResolution', 'node',
    '--skipLibCheck', '--esModuleInterop', '--jsx', 'react'], { stdio: 'pipe' });
} catch {
  // Type errors in files this does not run; the emit is what matters.
}

// The compiled code keeps the app's "@/lib" aliases and wants the app's
// node_modules; both are pointed at from here.
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
const D = require(join(out, 'dialogue.js'));

let failures = 0;
const say = (label, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

let w = S.createWorld(1120, 'Probe');
const hour = () => { w = S.advance(w, 1); };
const day = () => { w.gold = Math.max(w.gold, 200_000); for (let h = 0; h < 24; h++) hour(); };
for (let d = 0; d < 25; d++) day();

// Wants.
const adults = w.citizens.filter((c) => c.age >= 16);
const wanting = adults.filter((c) => c.want);
say('adults want things', adults.length > 0 && wanting.length > 0, `${wanting.length} of ${adults.length}`);
say('a want is said as a thing', wanting.every((c) => /^(a |to |somebody |work )/.test(D.wantWord(c.want))), wanting[0] ? D.wantWord(wanting[0].want) : '');
const held = wanting.map((c) => ({ id: c.id, kind: c.want.kind, since: c.want.since }));
let feedSaid = null;
for (let d = 0; d < 20; d++) {
  w.gold = Math.max(w.gold, 200_000);
  for (let h = 0; h < 24; h++) { hour(); feedSaid ??= (w.feed.find((f) => / has .* at last\.$/.test(f.text)) ?? null); }
}
const met = w.citizens.flatMap((c) => (c.recent ?? []).filter((e) => e.kind === 'wantMet'));
say('some wants are met and remembered', met.length > 0, `${met.length} met: ${JSON.stringify(met.slice(0, 3).map((e) => e.about))}`);
say('a want that stands is kept, not re-rolled', w.citizens.some((c) => c.want && held.some((h) => h.id === c.id && h.kind === c.want.kind && h.since === c.want.since)) || wanting.length <= met.length);
say('the feed says so, in the third person', !!feedSaid && !/ my own/.test(feedSaid.text), feedSaid ? feedSaid.text : '(none)');

// Word of mouth.
const secondHand = w.citizens.filter((c) => (c.heard ?? []).some((h) => {
  const subject = w.citizens.find((o) => o.name === h.about);
  return subject && subject.id !== c.id && !(c.lastTalk ?? {})[subject.id];
}));
say('news travels by conversation', w.citizens.some((c) => (c.heard ?? []).length > 0));
say('and reaches people who never met the subject', secondHand.length > 0, `${secondHand.length} know something second-hand`);

// Noticing the owner.
w.treasury = Math.max(w.treasury, 50_000);
S.clearTrees(w, 50, 50, 4);
S.holdFestival(w);
S.setWageRate(w, (w.wageRate ?? 1) * 1.2);
say('the world keeps what the owner just did', (w.noticed ?? []).length >= 3, JSON.stringify((w.noticed ?? []).map((n) => n.kind)));
const remarks = new Set();
for (let beat = 0; beat < 40; beat++) for (const c of w.citizens) {
  const u = SP.utteranceFor(w, c, beat);
  if (u && /wood is gone|cleared the wood|cut the trees|festival|wage has gone up|cut the wage/i.test(u.text)) remarks.add(u.text);
}
say('people remark on it, in more than one voice', remarks.size >= 2, JSON.stringify([...remarks].slice(0, 3)));

// Thought against speech.
let thought = 0, saidInTalk = 0, talks = 0;
for (let i = 0; i < 24 * 4 * 2; i++) {
  w = S.advance(w, 0.25);
  talks += w.conversations.length;
  const talking = new Set(); for (const t of w.conversations) { talking.add(t.a); talking.add(t.b); }
  for (const c of w.citizens) {
    const u = SP.utteranceFor(w, c, i);
    if (!u) continue;
    if (u.said) { if (talking.has(c.id)) saidInTalk++; } else thought++;
  }
}
say('conversations happen', talks > 0, `${talks} conversation-quarters over two days`);
say('a turn in a conversation is speech', saidInTalk > 0, `${saidInTalk} spoken turns`);
say('musings are thoughts', thought > 0, `${thought} thoughts`);

rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed.` : '\nAll good.');
process.exit(failures ? 1 : 0);
