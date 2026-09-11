/*
 * War against a live EVM: base → train → shield → invade → occupy → pay →
 * retake → withdraw, and the rules each of those is supposed to keep.
 *
 * Two wallets, two plots. Everything goes through the HTTP routes as a
 * browser would, so the session gate, the burn and the registry's own locks
 * are all in the path.
 */
const { ok, api, OP } = require('./site.js');
const C = require('./chain.js');
const A = C.addr('a').toLowerCase(), B = C.addr('b').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SA = 1120, SB = 1365;
const BASE_COST = 250_000;

/** A world small enough to publish, with the treasury the registry should read. */
const worldOf = (seed, treasury, day = 5) => ({
  seed, at: Date.now(),
  world: {
    seed, day, hour: 9, treasury, population: 12, name: 'Probe',
    citizens: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `P${i}`, x: 50, y: 50, age: 30 })),
    buildings: Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, type: 'House', x: 40 + i, y: 40, level: 1 })),
    resources: { wood: 50, stone: 50, wheat: 50, steel: 40 },
  },
});

const claim = async (seed, who, name) => {
  if ((await C.ownerOf(seed).catch(() => null)) === who) return;
  const held = await api('/api/plots', { owner: who, reserve: true, seed }, who);
  const pay = await C.write(who === A ? 'a' : 'b', 'token', 'transfer', [C.deployed.vault, C.E(held.json.price)]);
  await api('/api/plots', { seed, region: 'Test', worldName: name, owner: who, ownerName: name, burnTx: pay.hash }, who);
};
const publish = (seed, who, name, treasury, day) =>
  api('/api/worlds', { seed, owner: who, ownerName: name, worldName: name, day, hour: 9, population: 12, snapshot: worldOf(seed, treasury, day) }, who);
const war = (body, who) => api('/api/war', body, who);
const rowOf = async (seed) => (await api(`/api/war?seed=${seed}`)).json.war;
/** The test hook that ages a claim past its shield; refused where the token is live. */
const age = (seed, hours) => api('/api/war', { action: 'age', address: A, seed, hours }, A, OP);

(async () => {
  await claim(SA, A, 'Alice');
  await claim(SB, B, 'Bobton');
  let day = 5;
  await publish(SA, A, 'Alice', 4_000_000, day);
  await publish(SB, B, 'Bobton', 4_000_000, day);

  // 1. The door.
  ok('war needs a session', (await api('/api/war', { action: 'base', address: A, seed: SA })).status === 401);
  const trespass = await war({ action: 'base', address: A, seed: SB }, A);
  ok('a base on somebody else\'s plot is refused before any payment is taken',
    trespass.status === 409 && /not yours/i.test(trespass.json?.error ?? ''), `${trespass.status} ${trespass.json?.error ?? ''}`);

  // 2. A base costs $EMERGE, burned.
  const cheap = await C.write('a', 'token', 'transfer', [C.deployed.vault, C.E(BASE_COST - 1)]);
  const short = await war({ action: 'base', address: A, seed: SA, burnTx: cheap.hash }, A);
  ok('a base payment short of the price is refused', short.status === 402 || short.status === 202, `${short.status} ${short.json?.error ?? ''}`);
  const paid = await C.write('a', 'token', 'transfer', [C.deployed.vault, C.E(BASE_COST)]);
  const opened = await war({ action: 'base', address: A, seed: SA, burnTx: paid.hash }, A);
  ok('a base opens on a real payment', opened.status === 200 && opened.json.war?.army?.troops === 0, `${opened.status} ${JSON.stringify(opened.json).slice(0, 140)}`);
  const twice = await war({ action: 'base', address: A, seed: SA, burnTx: paid.hash }, A);
  ok('the same payment cannot buy a second base', twice.status !== 200 || twice.json.already === true, `${twice.status}`);

  // 3. Training: capped by the day, and by the Gold the registry has seen.
  const t1 = await war({ action: 'train', address: A, seed: SA, count: 40 }, A);
  ok('training is capped at twelve a day', t1.status === 200 && t1.json.trained === 12, `trained ${t1.json?.trained} ${t1.json?.error ?? ''}`);
  const t2 = await war({ action: 'train', address: A, seed: SA, count: 5 }, A);
  ok('and the day\'s cap holds on a second try', t2.status !== 200, `${t2.status} ${t2.json?.error ?? ''}`);
  await publish(SA, A, 'Alice', 500, ++day);
  const broke = await war({ action: 'train', address: A, seed: SA, count: 1 }, A);
  ok('a treasury that cannot pay trains nobody', broke.status !== 200, `${broke.status} ${broke.json?.error ?? ''}`);
  await publish(SA, A, 'Alice', 4_000_000, ++day);

  // 4. The shield.
  const early = await war({ action: 'invade', address: A, seed: SB, from: SA, troops: 5 }, A);
  ok('a plot claimed within the day cannot be invaded', early.status !== 200 && /shield/i.test(early.json?.error ?? ''), `${early.status} ${early.json?.error ?? ''}`);
  const aged = await age(SB, 48);
  ok('the test hook ages a claim past its shield', aged.status === 200, `${aged.status} ${aged.json?.error ?? ''}`);

  // 5. A plot that never opened a base is not in the war at all.
  const defender = await rowOf(SB);
  ok('the target has no base', !defender.army, JSON.stringify(defender.army));
  const undefended = await war({ action: 'invade', address: A, seed: SB, from: SA, troops: 5 }, A);
  ok('a plot with no base cannot be marched on', undefended.status === 409 && /no base/i.test(undefended.json?.error ?? ''),
    `${undefended.status} ${undefended.json?.error ?? ''}`);

  // 5b. Once it opens one, it is a target — and it fights back.
  const bPaid = await C.write('b', 'token', 'transfer', [C.deployed.vault, C.E(BASE_COST)]);
  const bBase = await war({ action: 'base', address: B, seed: SB, burnTx: bPaid.hash }, B);
  ok('the defender opens a base of its own', bBase.status === 200, `${bBase.status} ${bBase.json?.error ?? ''}`);
  await war({ action: 'train', address: B, seed: SB, count: 4 }, B);
  const strike = await war({ action: 'invade', address: A, seed: SB, from: SA, troops: 8 }, A);
  ok('a plot with a base can be invaded', strike.status === 200, `${strike.status} ${strike.json?.error ?? ''}`);
  const won = strike.json?.battle?.winner === 'attacker';
  ok('  the fight is fought round by round', (strike.json?.battle?.rounds?.length ?? 0) > 0,
    `${strike.json?.battle?.rounds?.length} rounds, ${strike.json?.battle?.winner} won`);
  ok('  the result is committed to before it is revealed',
    !!strike.json?.battle?.commit && !!strike.json?.battle?.reveal
    && require('crypto').createHash('sha256').update(strike.json.battle.reveal).digest('hex') === strike.json.battle.commit);
  if (won) ok('  a win is an occupation', !!strike.json.war?.occupation, JSON.stringify(strike.json.war?.occupation ?? null).slice(0, 110));
  else ok('  a loss leaves the plot free', !strike.json.war?.occupation);

  if (!won) { console.log('   (the attacker lost this roll; the occupation checks need a win)'); return; }

  // 6. One occupation to a wallet, however many plots and bases it has.
  const second = await war({ action: 'invade', address: A, seed: SB, from: SA, troops: 3 }, A);
  ok('a wallet cannot hold two plots at once', second.status !== 200, `${second.status} ${second.json?.error ?? ''}`);

  // 7. Paying for the stay, retaking, and going home.
  const payday = await war({ action: 'pay', address: A, seed: SB }, A);
  ok('another day of the stay is paid from the home treasury', payday.status === 200, `${payday.status} ${payday.json?.error ?? ''}`);
  await publish(SA, A, 'Alice', 10, ++day);
  const skint = await war({ action: 'pay', address: A, seed: SB }, A);
  ok('a stay the home treasury cannot cover is refused', skint.status !== 200, `${skint.status} ${skint.json?.error ?? ''}`);
  await publish(SA, A, 'Alice', 4_000_000, ++day);
  const stranger = await war({ action: 'withdraw', address: B, seed: SB }, B);
  ok('only the occupier can march their own army home', stranger.status !== 200, `${stranger.status} ${stranger.json?.error ?? ''}`);
  const gone = await war({ action: 'withdraw', address: A, seed: SB }, A);
  ok('the occupier can go home', gone.status === 200 && !gone.json.war?.occupation, `${gone.status} ${gone.json?.error ?? ''}`);
  const home = await rowOf(SA);
  ok('and the army comes back to its own base', (home.army?.troops ?? 0) >= 4, `troops ${home.army?.troops}`);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
