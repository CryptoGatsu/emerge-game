#!/usr/bin/env node
/*
 * War, headless: the registry's rules without a chain or a browser.
 *
 * The battle is fought on the server, and everything that matters about it
 * is a rule about who may march on whom with what. This drives the registry
 * directly over a stub claim store, so the rules can be checked in a second
 * rather than through a live chain: who can open a base, how fast an army
 * grows, who is a target at all, one occupation to a wallet, what a won and
 * a lost fight do to both sides' armies, and that a stay nobody pays for
 * sends the army home.
 *
 *   node scripts/check-war.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'node:module';

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'emerge-war-'));
let failures = 0;
const say = (label, cond, extra = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

try {
  execFileSync('npx', ['tsc', 'lib/server/war.ts', 'lib/world/war.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2020',
    '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
} catch {
  // Type errors in files this does not run; the emit is what matters.
}

/*
 * The registry and the store, stubbed. The claim rows live in a Map, the
 * lock is a boolean, and the published treasury is whatever the test says.
 */
const rows = new Map();
const published = new Map();
const feed = [];
let locked = false;
mkdirSync(join(out, 'server'), { recursive: true });
writeFileSync(join(out, 'server', 'registry.js'), `
const rows = global.__warRows, published = global.__warPublished;
exports.claimOf = async (seed) => { const r = rows.get(seed); return r ? JSON.parse(JSON.stringify(r)) : null; };
exports.writeClaim = async (claim) => { rows.set(claim.seed, JSON.parse(JSON.stringify(claim))); };
exports.allClaims = async () => [...rows.values()].map((r) => JSON.parse(JSON.stringify(r)));
exports.displayNames = async () => ({});
exports.readWorld = async (seed) => (published.has(seed) ? { snapshot: { world: { treasury: published.get(seed) } } } : null);
`);
writeFileSync(join(out, 'server', 'kv.js'), `
exports.takeLock = async () => (global.__warLocked ? false : (global.__warLocked = true));
exports.releaseLock = async () => { global.__warLocked = false; };
exports.push = async (_k, line) => { global.__warFeed.push(JSON.parse(line)); };
exports.range = async () => global.__warFeed.map((e) => JSON.stringify(e));
`);
writeFileSync(join(out, 'limits.js'), 'exports.serverKey = (k) => k;');
writeFileSync(join(out, 'server-only.js'), 'module.exports = {};');
global.__warRows = rows; global.__warPublished = published; global.__warFeed = feed;
Object.defineProperty(global, '__warLocked', { get: () => locked, set: (v) => { locked = v; } });

const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'server-only') request = join(out, 'server-only.js');
  return original.call(this, request, ...rest);
};
process.env.NODE_PATH = join(root, 'node_modules');
Module._initPaths();
const require = createRequire(import.meta.url);
const W = require(join(out, 'server', 'war.js'));
const U = require(join(out, 'world', 'war.js'));

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const DAY = 86_400_000;
/** A claim old enough to have no shield left. */
const claim = (seed, owner, name, era = 1, extra = {}) =>
  rows.set(seed, { seed, owner, ownerName: name, worldName: name, region: 'Test', at: Date.now() - 5 * DAY, era, ...extra });

try {
  // --- A base, and what it costs to fill.
  claim(1, A, 'Alice'); claim(2, B, 'Bobton'); claim(3, C, 'Cavil');
  published.set(1, 4_000_000); published.set(2, 4_000_000); published.set(3, 4_000_000);

  say('a base cannot be opened on somebody else’s plot', !(await W.buyBase(2, A)).ok);
  const base = await W.buyBase(1, A);
  say('a base opens on your own plot', base.ok && base.claim.army.troops === 0);
  say('opening one twice is not an error, and raises nothing', (await W.buyBase(1, A)).already === true);

  say('troops cannot be trained without a base', !(await W.trainTroops(2, B, 5)).ok);
  const t1 = await W.trainTroops(1, A, 50);
  say('a day trains at most twelve', t1.ok && t1.trained === U.MAX_TRAIN_PER_DAY, `trained ${t1.trained}`);
  say('and the day’s cap holds against a second call', !(await W.trainTroops(1, A, 5)).ok);

  // The published treasury is what the registry spends against, not the browser's word.
  rows.get(1).army.day = '1970-01-01';
  published.set(1, 100);
  say('a treasury the registry has not seen pay for them trains nobody', !(await W.trainTroops(1, A, 5)).ok);
  published.set(1, 4_000_000);
  rows.get(1).army.goldDay = '1970-01-01';
  const t2 = await W.trainTroops(1, A, 50);
  say('a new day trains another twelve', t2.ok && t2.trained === U.MAX_TRAIN_PER_DAY, `trained ${t2.trained}`);
  rows.get(1).army.troops = 40;

  // --- Who is a target.
  const noBase = await W.invade(2, A, 1, 10);
  say('a plot that never opened a base is not a target', !noBase.ok && /no base/i.test(noBase.reason), noBase.reason);
  await W.buyBase(2, B);
  rows.get(2).army.troops = 6;

  const fresh = 4;
  claim(fresh, C, 'Newton');
  rows.get(fresh).at = Date.now();
  await W.buyBase(fresh, C);
  const shielded = await W.invade(fresh, A, 1, 10);
  say('a plot claimed today is shielded', !shielded.ok && /shield/i.test(shielded.reason), shielded.reason);

  say('an attack under the minimum is refused', !(await W.invade(2, A, 1, U.MIN_ATTACK - 1)).ok);
  say('you cannot march on your own plot', !(await W.invade(1, A, 1, 10)).ok);
  say('you cannot march from a plot that is not yours', !(await W.invade(2, A, 2, 10)).ok);
  say('you cannot send more than the base holds', !(await W.invade(2, A, 1, 999)).ok);

  // --- The fight itself.
  const before = rows.get(1).army.troops;
  const fight = await W.invade(2, A, 1, 30);
  say('an invasion of a plot with a base is fought', fight.ok && fight.battle.rounds.length > 0, `${fight.battle?.rounds?.length} rounds`);
  const won = fight.battle.winner === 'attacker';
  say('  the roll is committed to before it is revealed',
    require('node:crypto').createHash('sha256').update(fight.battle.reveal).digest('hex') === fight.battle.commit);
  say('  the army that marched has left home', rows.get(1).army.troops <= before - (won ? 30 : 0), `home ${rows.get(1).army.troops} of ${before}`);
  if (won) {
    say('  a win puts the attacker’s survivors on the plot', !!rows.get(2).occupation && rows.get(2).occupation.by === A.toLowerCase());
    say('  and the plot it marched from is marked as holding one', rows.get(1).occupying === 2);
    say('  the stay is paid a day ahead to start with', rows.get(2).occupation.paidUntil > Date.now());

    // One occupation to a wallet, whatever else it owns.
    claim(5, A, 'Alice II');
    await W.buyBase(5, A);
    published.set(5, 4_000_000);
    rows.get(5).army = { troops: 20, since: Date.now() };
    const twice = await W.invade(3, A, 5, 10);
    say('one occupation to a wallet, not one to a plot', !twice.ok && /already holding/i.test(twice.reason), twice.reason);

    // Paying for the stay comes out of the home plot's published treasury.
    const paid = await W.payOccupation(2, A);
    say('another day of the stay is paid', paid.ok && paid.gold === U.occupyUpkeepGold(rows.get(2).occupation.era), `${paid.reason ?? paid.gold}`);
    published.set(1, 10);
    say('a stay the home treasury cannot cover is refused', !(await W.payOccupation(2, A)).ok);
    published.set(1, 4_000_000);
    say('a stranger cannot pay for, or end, somebody else’s occupation', !(await W.payOccupation(2, C)).ok && !(await W.withdraw(2, C)).ok);

    // An unpaid stay sends the army home on its own.
    const garrison = rows.get(2).occupation.troops;
    const homeBefore = rows.get(1).army.troops;
    rows.get(2).occupation.paidUntil = Date.now() - 1000;
    const settled = await W.warRow(2);
    say('a stay nobody pays for ends on its own', !settled.occupation);
    say('  and the army walks home', rows.get(1).army.troops === homeBefore + garrison, `${homeBefore} + ${garrison} = ${rows.get(1).army.troops}`);
    say('  and the plot it came from is free to march again', rows.get(1).occupying === undefined);
  } else {
    say('  a loss leaves the plot unoccupied', !rows.get(2).occupation);
    say('  and the survivors come home', rows.get(1).army.troops > before - 30, `home ${rows.get(1).army.troops}`);
  }

  // --- Retaking, and the shield it earns.
  claim(6, A, 'Alice III');
  await W.buyBase(6, A);
  published.set(6, 4_000_000);
  rows.get(6).army = { troops: 30, since: Date.now() };
  rows.get(6).occupation = { by: C.toLowerCase(), byName: 'Cavil', fromSeed: 3, fromName: 'Cavil', since: Date.now(), troops: 2, era: 1, paidUntil: Date.now() + DAY };
  rows.get(3).occupying = 6;
  say('a stranger cannot retake somebody else’s plot', !(await W.retake(6, B, 5)).ok);
  const back = await W.retake(6, A, 30);
  say('the owner can march on the garrison holding their plot', back.ok, back.reason ?? '');
  if (back.ok && back.battle.winner === 'attacker') {
    say('  a retaken plot is free', !rows.get(6).occupation);
    say('  and shielded for a day', W.shieldedUntil(rows.get(6)) > Date.now() + U.SHIELD_MS - 60_000);
    say('  and the garrison that lost walks home', (rows.get(3).army?.troops ?? 0) >= 0 && rows.get(3).occupying === undefined);
  }

  // --- A plot that changes hands while its army is away.
  claim(7, A, 'Alice IV'); await W.buyBase(7, A); published.set(7, 4_000_000);
  rows.get(7).army = { troops: 20, since: Date.now() };
  claim(8, B, 'Bobton II'); await W.buyBase(8, B); rows.get(8).army = { troops: 2, since: Date.now() };
  const took = await W.invade(8, A, 7, 20);
  if (took.ok && took.battle.winner === 'attacker') {
    // The token moves: the row keeps the base, the buyer is somebody new.
    rows.get(7).owner = C; rows.get(7).ownerName = 'Cavil';
    say('a sold plot still says its old owner’s army is away (the state under test)', rows.get(7).occupying === 8);
    rows.get(8).occupation.paidUntil = Date.now() - 1000;
    await W.warRow(8);
    say('when that expedition lapses, the sold plot stops saying its army is away', rows.get(7).occupying === undefined);
    say('  and the troops do not go to the buyer, who never sent them', rows.get(7).army.troops === 0, `troops ${rows.get(7).army.troops}`);
    say('  so the buyer can march from it', (await W.invade(3, C, 7, 3)).reason !== 'Your army is already holding a plot. Withdraw it first.');
  } else {
    say('(the sale-mid-occupation check needs an attacking win; skipped this roll)', true);
  }

  // --- The arithmetic everybody reads.
  say('an age fights better than the one before it',
    U.unitOf(5).attack > U.unitOf(1).attack && U.unitOf(2).defence > U.unitOf(1).defence);
  say('holding your own ground is worth something',
    U.defenceStrength(10, 1, true, 1) > U.defenceStrength(10, 1, false, 1));
  say('a bigger army is likelier to win',
    U.attackOdds({ troops: 40, era: 1 }, { troops: 5, era: 1, home: true }) > U.attackOdds({ troops: 5, era: 1 }, { troops: 40, era: 1, home: true }));
  say('but nothing is certain', U.attackOdds({ troops: 40, era: 1 }, { troops: 5, era: 1, home: true }) < 1);
  say('a base holds more in a later age', U.armyCap(5) > U.armyCap(1), `${U.armyCap(1)} -> ${U.armyCap(5)}`);
} finally {
  Module._resolveFilename = original;
  rmSync(out, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
