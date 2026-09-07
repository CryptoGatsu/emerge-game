import 'server-only';

/**
 * War, as the registry keeps it.
 *
 * A base is bought on a plot in burned $EMERGE and written on its claim row.
 * Troops are trained there in the settlement's own Gold — the settlement
 * spends it, the registry counts them, capped by the plot's age and by the
 * day. An army marches from its plot onto another; the registry fights the
 * battle here, on numbers everybody can see and a secret it commits to
 * first, and writes the result on the row for both settlements to play
 * back. A won invasion is an occupation: the invader's troops hold the plot,
 * a share of its yield goes to them, and they pay Gold a day to stay. The
 * owner retakes it with their own army, anybody else can ambush it, and an
 * occupation nobody pays for goes home on its own.
 *
 * Every change to a row happens under one lock, because a battle touches
 * two rows at once and two fights over the same plot at the same moment
 * must not both win.
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import { allClaims, claimOf, displayNames, readWorld, writeClaim, type Claim } from './registry';
import { push, range, releaseLock, takeLock } from './kv';
import { serverKey } from '../limits';
import {
  MAX_TRAIN_PER_DAY, MIN_ATTACK, OCCUPY_PAID_DAYS_MAX, SHIELD_MS, UNITS, armyCap, occupyUpkeepGold, resolveBattle,
  type Battle, type BattleKind, type BattleSide, type Occupation, type WarEvent, type WarEventKind,
} from '../world/war';

const LOCK = serverKey('war:lock');
const FEED = serverKey('war:feed');
const FEED_KEEP = 120;
const DAY_MS = 86_400_000;

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type WarResult<T = { claim: Claim }> = ({ ok: true } & T) | { ok: false; reason: string; status?: number };

/** Until when a plot cannot be invaded: a day after it was claimed, or whatever a retake set. */
export function shieldedUntil(claim: Claim): number {
  return Math.max(claim.at + SHIELD_MS, claim.shieldUntil ?? 0);
}

/** Whether the plot's occupation has run out of pay. */
const lapsed = (claim: Claim, now: number) => !!claim.occupation && claim.occupation.paidUntil < now;

async function withLock<T>(work: () => Promise<T>): Promise<T | { ok: false; reason: string; status?: number }> {
  if (!(await takeLock(LOCK, 15))) return { ok: false, reason: 'The registry is settling another fight. Try again in a moment.', status: 409 };
  try { return await work(); } finally { await releaseLock(LOCK); }
}

/**
 * The Gold the registry believes a settlement has: the figure in the copy its
 * owner last published.
 *
 * War used to be counted here and paid for in the browser, which meant it was
 * not paid for at all by anyone willing to call the API themselves: troops
 * were free and an occupation could be held for ever for nothing, while it
 * took three fifths of somebody's yield. The published copy is what the server
 * already judges a plot's level and stewardship from, so war Gold is judged
 * there too. It lags the browser by a publish, so a day's spending is tallied
 * against it rather than each charge separately.
 */
async function publishedGold(seed: number): Promise<number | null> {
  try {
    const published = await readWorld(seed);
    const saved = published?.snapshot as { world?: { treasury?: number } } | undefined;
    const gold = saved?.world?.treasury;
    return typeof gold === 'number' && Number.isFinite(gold) ? gold : null;
  } catch {
    return null;
  }
}

const NOT_PUBLISHED = 'The registry has not seen this settlement yet. Open it once so its treasury is published, then try again.';

/** What a wallet is called: the name it chose in the game, else the name on its claim, else nothing. */
async function nameOf(address: string, fallback: string): Promise<string> {
  try {
    const names = await displayNames();
    return names[address.toLowerCase()] ?? names[address] ?? fallback;
  } catch {
    return fallback;
  }
}

async function note(kind: WarEventKind, seed: number, claim: Claim, actor: { address: string; name: string }, other: { address: string; name: string }, troops?: number): Promise<void> {
  const event: WarEvent = {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, kind, at: Date.now(), seed,
    region: claim.region, worldName: claim.worldName,
    actor: actor.address.toLowerCase(), actorName: await nameOf(actor.address, actor.name), other: other.address.toLowerCase(), otherName: await nameOf(other.address, other.name), troops,
  };
  await push(FEED, JSON.stringify(event), FEED_KEEP);
}

/** The war feed, newest first, since a moment. */
export async function warFeed(since = 0, limit = 30): Promise<WarEvent[]> {
  const lines = await range(FEED);
  return lines.map((raw) => { try { return JSON.parse(raw) as WarEvent; } catch { return null; } })
    .filter((e): e is WarEvent => !!e && e.at > since)
    .sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * Send a lapsed occupation home. The occupier's row gets its troops back;
 * the plot is free. Called on every read of a row that could be occupied,
 * under the lock when a write follows.
 */
async function settleLapsed(claim: Claim, now: number): Promise<Claim> {
  if (!lapsed(claim, now)) return claim;
  const occ = claim.occupation!;
  const home = await claimOf(occ.fromSeed);
  if (home && same(home.owner, occ.by)) {
    home.army = { ...(home.army ?? { troops: 0, since: now }), troops: (home.army?.troops ?? 0) + occ.troops };
    delete home.occupying;
    await writeClaim(home);
  }
  delete claim.occupation;
  await writeClaim(claim);
  await note('lapsed', claim.seed, claim, { address: occ.by, name: occ.byName }, { address: claim.owner, name: claim.ownerName }, occ.troops);
  return claim;
}

/** A plot's row with any run-out occupation sent home. */
export async function warRow(seed: number): Promise<Claim | null> {
  const claim = await claimOf(seed);
  if (!claim) return null;
  if (!lapsed(claim, Date.now())) return claim;
  const settled = await withLock(async () => ({ ok: true as const, claim: await settleLapsed((await claimOf(seed)) ?? claim, Date.now()) }));
  return settled.ok ? settled.claim : claim;
}

/** Every plot under occupation right now, for the map. */
export async function sieges(): Promise<Claim[]> {
  const now = Date.now();
  const rows = (await allClaims()).filter((c) => c.occupation);
  const out: Claim[] = [];
  for (const row of rows) {
    if (lapsed(row, now)) { const settled = await warRow(row.seed); if (settled?.occupation) out.push(settled); }
    else out.push(row);
  }
  return out;
}

/** Open a base on a plot the wallet owns. The charge is the caller's business. */
export async function buyBase(seed: number, owner: string): Promise<WarResult<{ claim: Claim; already: boolean }>> {
  return withLock(async () => {
    const claim = await claimOf(seed);
    if (!claim || !same(claim.owner, owner)) return { ok: false, reason: 'That plot is not yours.', status: 409 };
    if (claim.army) return { ok: true, claim, already: true };
    claim.army = { troops: 0, since: Date.now() };
    await writeClaim(claim);
    await note('base', seed, claim, { address: owner, name: claim.ownerName }, { address: owner, name: claim.ownerName });
    return { ok: true, claim, already: false };
  });
}

/**
 * Train troops at a plot's base. The settlement has already paid the Gold
 * and the steel; the registry counts, and caps by the plot's age and by
 * the day so an army cannot be conjured in an afternoon.
 */
export async function trainTroops(seed: number, owner: string, count: number): Promise<WarResult<{ claim: Claim; trained: number }>> {
  const n = Math.floor(count);
  if (!(n > 0)) return { ok: false, reason: 'Train at least one.', status: 400 };
  return withLock(async () => {
    const claim = await claimOf(seed);
    if (!claim || !same(claim.owner, owner)) return { ok: false, reason: 'That plot is not yours.', status: 409 };
    if (!claim.army) return { ok: false, reason: 'The plot has no base. Open one first.', status: 409 };
    const day = utcDay();
    const today = claim.army.day === day ? (claim.army.today ?? 0) : 0;
    const cap = armyCap(claim.era ?? 1);
    const away = claim.occupying ? ((await claimOf(claim.occupying))?.occupation?.troops ?? 0) : 0;
    const room = Math.max(0, Math.min(MAX_TRAIN_PER_DAY - today, cap - claim.army.troops - away));
    if (room <= 0) {
      return { ok: false, reason: today >= MAX_TRAIN_PER_DAY ? `The base has trained its ${MAX_TRAIN_PER_DAY} for today.` : `The base holds ${cap} in this age, and it is full.`, status: 409 };
    }
    const each = UNITS[Math.min(5, Math.max(1, claim.era ?? 1)) as 1 | 2 | 3 | 4 | 5].gold;
    const gold = await publishedGold(seed);
    if (gold === null) return { ok: false, reason: NOT_PUBLISHED, status: 409 };
    // The published copy lags the browser by a publish, so what the registry
    // has already authorised against this same copy is counted against it too.
    // Once a smaller treasury is published the spending has been booked there
    // and the tally starts again.
    const booked = typeof claim.army.goldSeen === 'number' && gold < claim.army.goldSeen;
    const spentToday = claim.army.goldDay === day && !booked ? (claim.army.goldToday ?? 0) : 0;
    const affordable = Math.floor(Math.max(0, gold - spentToday) / each);
    if (affordable <= 0) {
      return { ok: false, reason: `The treasury the registry last saw holds ${Math.floor(Math.max(0, gold - spentToday)).toLocaleString()} Gold, and one costs ${each.toLocaleString()}.`, status: 409 };
    }
    const trained = Math.min(n, room, affordable);
    claim.army = { ...claim.army, troops: claim.army.troops + trained, day, today: today + trained, goldDay: day, goldToday: spentToday + trained * each, goldSeen: gold };
    await writeClaim(claim);
    return { ok: true, claim, trained };
  });
}

function fightWith(kind: BattleKind, seed: number, attacker: BattleSide, defender: BattleSide, homeDefence: boolean, plotEra: number, attackerHome = false): Battle {
  const reveal = randomBytes(16).toString('hex');
  const commit = createHash('sha256').update(reveal).digest('hex');
  const rolls = createHmac('sha256', reveal).update(`${attacker.address}|${defender.address}|${seed}`).digest();
  let cursor = 0;
  const roll = () => { const byte = rolls[cursor % rolls.length]; cursor += 1; return (byte + (cursor % 7) * 0.01) / 255.1; };
  const result = resolveBattle(roll, { troops: attacker.troops, era: attacker.era, home: attackerHome }, { troops: defender.troops, era: defender.era, home: homeDefence, plotEra });
  return {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, kind, at: Date.now(), seed,
    attacker, defender, homeDefence, winner: result.winner, rounds: result.rounds, survivors: result.survivors, commit, reveal,
  };
}

/**
 * March on a plot. The attacker's army comes from `fromSeed`, a plot they
 * own with a base; the target is somebody else's plot, unshielded. A plot
 * already under occupation is defended by the occupier's garrison — an
 * ambush — and the winner holds it. One occupation per wallet at a time.
 */
export async function invade(targetSeed: number, attacker: string, fromSeed: number, troops: number): Promise<WarResult<{ claim: Claim; battle: Battle; home: Claim }>> {
  const sent = Math.floor(troops);
  if (!(sent >= MIN_ATTACK)) return { ok: false, reason: `Send at least ${MIN_ATTACK}.`, status: 400 };
  return withLock(async () => {
    const now = Date.now();
    const home = await claimOf(fromSeed);
    if (!home || !same(home.owner, attacker)) return { ok: false, reason: 'That plot is not yours.', status: 409 };
    if (!home.army) return { ok: false, reason: 'The plot has no base. Open one first.', status: 409 };
    if (home.occupying) return { ok: false, reason: 'Your army is already holding a plot. Withdraw it first.', status: 409 };
    // One occupation to a wallet, not one to a plot. The flag above is only on
    // the plot the army marched from, so a player with three plots and three
    // bases held three plots at once, against the rule everybody was told.
    const elsewhere = (await allClaims()).find((c) => c.occupation && same(c.occupation.by, attacker) && !lapsed(c, now));
    if (elsewhere) return { ok: false, reason: `Your army is already holding ${elsewhere.worldName || 'another plot'}. Withdraw it first.`, status: 409 };
    if (home.army.troops < sent) return { ok: false, reason: `The base holds ${home.army.troops}, not ${sent}.`, status: 409 };
    let target = await claimOf(targetSeed);
    if (!target) return { ok: false, reason: 'Nobody holds that plot.', status: 404 };
    if (same(target.owner, attacker)) return { ok: false, reason: 'That plot is yours.', status: 409 };
    target = await settleLapsed(target, now);
    const shield = shieldedUntil(target);
    if (shield > now) return { ok: false, reason: `That plot is shielded for another ${Math.ceil((shield - now) / 3_600_000)} hours.`, status: 409 };
    if (target.occupation && same(target.occupation.by, attacker)) return { ok: false, reason: 'Your army already holds it.', status: 409 };
    const attackerName = await nameOf(attacker, home.ownerName);
    const attackerSide: BattleSide = { address: attacker.toLowerCase(), name: attackerName, seed: fromSeed, worldName: home.worldName, era: home.era ?? 1, troops: sent };
    const occ = target.occupation;
    const defenderSide: BattleSide = occ
      ? { address: occ.by, name: occ.byName, seed: occ.fromSeed, worldName: occ.fromName, era: occ.era, troops: occ.troops }
      : { address: target.owner.toLowerCase(), name: await nameOf(target.owner, target.ownerName), seed: targetSeed, worldName: target.worldName, era: target.era ?? 1, troops: target.army?.troops ?? 0 };
    const battle = fightWith(occ ? 'ambush' : 'invasion', targetSeed, attackerSide, defenderSide, !occ, target.era ?? 1);
    // The attacker's army leaves home either way; what comes back is what survived.
    home.army = { ...home.army, troops: home.army.troops - sent };
    if (battle.winner === 'attacker') {
      if (occ) {
        // The old garrison's survivors walk home.
        const theirs = await claimOf(occ.fromSeed);
        if (theirs && same(theirs.owner, occ.by)) {
          theirs.army = { ...(theirs.army ?? { troops: 0, since: now }), troops: (theirs.army?.troops ?? 0) + battle.survivors.defender };
          delete theirs.occupying;
          await writeClaim(theirs);
        }
      } else if (target.army) {
        target.army = { ...target.army, troops: battle.survivors.defender };
      }
      target.occupation = {
        by: attacker.toLowerCase(), byName: attackerName, fromSeed, fromName: home.worldName, since: now,
        troops: battle.survivors.attacker, era: home.era ?? 1, paidUntil: now + DAY_MS,
      } satisfies Occupation;
      home.occupying = targetSeed;
    } else {
      home.army.troops += battle.survivors.attacker;
      if (occ) target.occupation = { ...occ, troops: battle.survivors.defender };
      else if (target.army) target.army = { ...target.army, troops: battle.survivors.defender };
    }
    target.battle = battle;
    await writeClaim(home);
    await writeClaim(target);
    await note(battle.winner === 'attacker' ? (occ ? 'ambushed' : 'invaded') : 'held', targetSeed, target,
      { address: attacker, name: attackerName }, { address: defenderSide.address, name: defenderSide.name }, sent);
    return { ok: true, claim: target, battle, home };
  });
}

/** The owner throws the occupier out with their own army. A win shields the plot for a day. */
export async function retake(seed: number, owner: string, troops: number): Promise<WarResult<{ claim: Claim; battle: Battle }>> {
  const sent = Math.floor(troops);
  if (!(sent >= 1)) return { ok: false, reason: 'Send at least one.', status: 400 };
  return withLock(async () => {
    const now = Date.now();
    let claim = await claimOf(seed);
    if (!claim || !same(claim.owner, owner)) return { ok: false, reason: 'That plot is not yours.', status: 409 };
    claim = await settleLapsed(claim, now);
    const occ = claim.occupation;
    if (!occ) return { ok: false, reason: 'Nobody is holding the plot.', status: 409 };
    if (!claim.army) return { ok: false, reason: 'The plot has no base. Open one first.', status: 409 };
    if (claim.army.troops < sent) return { ok: false, reason: `The base holds ${claim.army.troops}, not ${sent}.`, status: 409 };
    const ownerName = await nameOf(owner, claim.ownerName);
    const attackerSide: BattleSide = { address: owner.toLowerCase(), name: ownerName, seed, worldName: claim.worldName, era: claim.era ?? 1, troops: sent };
    const defenderSide: BattleSide = { address: occ.by, name: occ.byName, seed: occ.fromSeed, worldName: occ.fromName, era: occ.era, troops: occ.troops };
    // The owner fights on their own ground even on the attack: the home bonus is theirs, not the garrison's.
    const battle = fightWith('retake', seed, attackerSide, defenderSide, false, claim.era ?? 1, true);
    claim.army = { ...claim.army, troops: claim.army.troops - sent };
    if (battle.winner === 'attacker') {
      claim.army.troops += battle.survivors.attacker;
      const theirs = await claimOf(occ.fromSeed);
      if (theirs && same(theirs.owner, occ.by)) {
        theirs.army = { ...(theirs.army ?? { troops: 0, since: now }), troops: (theirs.army?.troops ?? 0) + battle.survivors.defender };
        delete theirs.occupying;
        await writeClaim(theirs);
      }
      delete claim.occupation;
      claim.shieldUntil = now + SHIELD_MS;
    } else {
      claim.army.troops += battle.survivors.attacker;
      claim.occupation = { ...occ, troops: battle.survivors.defender };
    }
    claim.battle = battle;
    await writeClaim(claim);
    await note(battle.winner === 'attacker' ? 'retaken' : 'held', seed, claim, { address: owner, name: ownerName }, { address: occ.by, name: occ.byName }, sent);
    return { ok: true, claim, battle };
  });
}

/** The occupier goes home of their own accord, troops and all. */
export async function withdraw(seed: number, occupier: string): Promise<WarResult> {
  return withLock(async () => {
    const claim = await claimOf(seed);
    if (!claim) return { ok: false, reason: 'Nobody holds that plot.', status: 404 };
    const occ = claim.occupation;
    if (!occ || !same(occ.by, occupier)) return { ok: false, reason: 'Your army is not holding that plot.', status: 409 };
    const home = await claimOf(occ.fromSeed);
    if (home && same(home.owner, occupier)) {
      home.army = { ...(home.army ?? { troops: 0, since: Date.now() }), troops: (home.army?.troops ?? 0) + occ.troops };
      delete home.occupying;
      await writeClaim(home);
    }
    delete claim.occupation;
    await writeClaim(claim);
    await note('withdrew', seed, claim, { address: occupier, name: occ.byName }, { address: claim.owner, name: claim.ownerName }, occ.troops);
    return { ok: true, claim };
  });
}

/** Pay for another day of holding the plot. The Gold was the occupier's settlement's; the registry extends the stay. */
export async function payOccupation(seed: number, occupier: string): Promise<WarResult<{ claim: Claim; gold: number }>> {
  return withLock(async () => {
    const now = Date.now();
    const claim = await claimOf(seed);
    if (!claim) return { ok: false, reason: 'Nobody holds that plot.', status: 404 };
    const occ = claim.occupation;
    if (!occ || !same(occ.by, occupier)) return { ok: false, reason: 'Your army is not holding that plot.', status: 409 };
    if (occ.paidUntil < now) return { ok: false, reason: 'The occupation has already run out.', status: 409 };
    if (occ.paidUntil - now > (OCCUPY_PAID_DAYS_MAX - 1) * DAY_MS) return { ok: false, reason: `It is paid ${OCCUPY_PAID_DAYS_MAX} days ahead already.`, status: 409 };
    // The army is fed from home, so home's treasury is what has to cover it.
    const due = occupyUpkeepGold(occ.era);
    const gold = await publishedGold(occ.fromSeed);
    if (gold === null) return { ok: false, reason: NOT_PUBLISHED, status: 409 };
    if (gold < due) return { ok: false, reason: `Holding it costs ${due.toLocaleString()} Gold a day, and the treasury the registry last saw at ${occ.fromName || 'your plot'} holds ${Math.floor(gold).toLocaleString()}.`, status: 409 };
    claim.occupation = { ...occ, paidUntil: occ.paidUntil + DAY_MS };
    await writeClaim(claim);
    return { ok: true, claim, gold: due };
  });
}

/** A test hook: move a claim's time of claiming back by `hours`, so a shield can be tested without waiting a day. */
export async function ageClaim(seed: number, hours: number): Promise<WarResult> {
  return withLock(async () => {
    const claim = await claimOf(seed);
    if (!claim) return { ok: false, reason: 'Nobody holds that plot.', status: 404 };
    claim.at -= Math.max(0, hours) * 3_600_000;
    if (claim.shieldUntil) claim.shieldUntil -= Math.max(0, hours) * 3_600_000;
    await writeClaim(claim);
    return { ok: true, claim };
  });
}
