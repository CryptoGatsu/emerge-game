/*
 * Pictures of the interface, inside a settlement, on the live test chain.
 *
 * Claims Fernrest for wallet A the way the API rehearsal does, opens the game
 * with that wallet signing, walks in, and photographs the world screen at a
 * desktop and a phone size, then with the Build and Bank panels open. The
 * files land wherever OUT says (default ./shots), named by the tag given as
 * the first argument, so before and after runs can sit side by side.
 *
 *   node capture.js after
 */
const { chromium } = (() => { try { return require('playwright'); } catch { return require('/opt/node22/lib/node_modules/playwright'); } })();
const fs = require('fs');
const walletLive = require('./wallet.js');
const { cookieFor, api, BASE } = require('./site.js');
const C = require('./chain.js');
const A = C.addr('a').toLowerCase();
const S1 = 1120;
const OUT = process.env.OUT ?? './shots';
const tag = process.argv[2] ?? 'after';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(1000); } return false; };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // A owns Fernrest, paid for on chain — unless a previous run already did this.
  if ((await C.ownerOf(S1).catch(() => null)) !== A) {
    const held = await api('/api/plots', { owner: A, reserve: true, seed: S1 }, A);
    if (held.json?.price) {
      const pay = await C.write('a', 'token', 'transfer', [C.deployed.vault, C.E(held.json.price)]);
      await api('/api/plots', { owner: A, seed: S1, region: 'Test', worldName: 'Fernrest', ownerName: 'Alice', burnTx: pay.hash }, A);
      await until(async () => (await C.ownerOf(S1)) === A, 30);
    }
  }
  const b = await chromium.launch();
  const shoot = async (name, width, height, then) => {
    const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    await ctx.addInitScript(walletLive(C.addr('a'), C.CHAIN_ID, C.RPC));
    await ctx.addCookies([cookieFor(A)]);
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(900);
    await p.getByRole('button', { name: /Open the world map/i }).click(); await sleep(2500);
    await p.locator('.region-pin.owned').first().click(); await sleep(600);
    await p.locator('.land-claim .claim-button').first().click();
    await p.waitForSelector('.action', { timeout: 60000 });
    // Past the opening titles, and long enough for a few people to speak.
    await sleep(9000);
    if (then) await then(p);
    await p.screenshot({ path: `${OUT}/${tag}-${name}.png` });
    console.log(`${tag}-${name}  ${width}x${height}  errors=${errors.length}${errors.length ? '  ' + errors[0] : ''}`);
    await ctx.close();
  };
  await shoot('world', 1440, 900);
  await shoot('phone', 400, 800);
  await shoot('build', 1440, 900, async (p) => { await p.locator('button.action.build').click(); await sleep(800); });
  await shoot('bank', 1440, 900, async (p) => { await p.locator('.purse').click(); await sleep(800); });
  await b.close();
})();
