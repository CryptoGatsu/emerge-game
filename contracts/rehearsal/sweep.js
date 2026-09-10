/*
 * The interface, every door and every size, looking for what is wrong.
 *
 * Walks into a settlement on the live test chain and, at four viewports,
 * opens every panel on the strip plus the bank, the guide and a being's
 * card, and after each one records: page errors, console errors and
 * warnings, whether the page scrolls sideways, any interface box off the
 * screen, any two floating boxes that overlap, buttons with no label, and
 * images that failed. Then the standalone pages. Prints one line per
 * finding, and a screenshot of every state into OUT.
 */
const { chromium } = (() => { try { return require('playwright'); } catch { return require('/opt/node22/lib/node_modules/playwright'); } })();
const fs = require('fs');
const walletLive = require('./wallet.js');
const { cookieFor, api, BASE } = require('./site.js');
const C = require('./chain.js');
const A = C.addr('a').toLowerCase();
const OUT = process.env.OUT ?? './shots/sweep';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(1000); } return false; };
const findings = [];
/** A click that cannot land is exactly the kind of thing this is looking for. */
const tap = async (loc, where, what) => {
  const before = await loc.page().locator('.overlay-panel').count();
  try { await loc.click({ timeout: 9000 }); return true; }
  catch (e) {
    // The click landed and the page was merely slow to say so: on the software
    // renderer these trials run on, a frame can take longer than the wait.
    if (/Timeout/.test(String(e.message)) && (await loc.page().locator('.overlay-panel').count()) > before) return true;
    const m = String(e.message).match(/<([a-z0-9]+)([^>]*)>[^<]*<\/[a-z0-9]+>? from <[^>]+> subtree intercepts|<([a-z0-9]+)([^>]*)>[^<]* intercepts pointer events|(not stable)|(outside of the viewport)/i);
    note(where, `${what} cannot be tapped`, m ? m[0].slice(0, 140) : String(e.message).split('\n')[0].slice(0, 100));
    return false;
  }
};
const closeAll = async (p) => {
  for (let i = 0; i < 3 && await p.locator('.overlay-panel').count(); i++) {
    await p.keyboard.press('Escape'); await sleep(350);
    if (await p.locator('.overlay-panel').count()) await p.locator('.overlay-panel .panel-close').first().click({ force: true, timeout: 2000 }).catch(() => {});
    await sleep(250);
  }
  return (await p.locator('.overlay-panel').count()) === 0;
};
const note = (where, what, detail = '') => { findings.push({ where, what, detail }); console.log(`FINDING  [${where}]  ${what}${detail ? '  — ' + detail : ''}`); };

// What the DOM says about itself in one state.
const inspect = async (p, where) => {
  const r = await p.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const out = { scrollX: document.documentElement.scrollWidth > vw + 1, off: [], overlaps: [], unlabeled: [], brokenImg: [], tiny: [] };
    const boxes = [];
    const sel = '.hud > *, .overlay-panel, .notices .notice, .phone-sheet, .action-row, .right-rail > .panel, .bottom-left > *, .top-centre > *, .world-chip, .hud-corner';
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || cs.pointerEvents === 'none' && el.className.includes('hud')) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      const name = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase();
      // A box inside a column that scrolls is meant to run past the edge.
      const scroller = el.parentElement && el.parentElement.closest('.right-rail, .bottom-left, .phone-sheet');
      if (!(scroller && /auto|scroll/.test(getComputedStyle(scroller).overflowY)) && (b.right > vw + 1 || b.bottom > vh + 1 || b.left < -1 || b.top < -1)) out.off.push(`${name} ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`);
      boxes.push({ name, b, z: parseInt(cs.zIndex) || 0, el });
    }
    // Overlaps between siblings that are both floating over the world.
    const floating = boxes.filter((x) => ['.top-centre', '.right-rail', '.bottom-left', '.bottom-right', '.action-bar', '.world-chip', '.hud-corner', '.notices', '.visiting-bar', '.placement-bar', '.touch-zoom', '.rail-toggle'].some((k) => x.name.startsWith(k)));
    for (let i = 0; i < floating.length; i++) for (let j = i + 1; j < floating.length; j++) {
      const a = floating[i].b, b = floating[j].b;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 8 && h > 8 && !floating[i].el.contains(floating[j].el) && !floating[j].el.contains(floating[i].el)) out.overlaps.push(`${floating[i].name} × ${floating[j].name} (${Math.round(w)}x${Math.round(h)}) at ${Math.round(a.left)},${Math.round(a.top)} ${Math.round(a.width)}x${Math.round(a.height)} / ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    for (const btn of document.querySelectorAll('button')) {
      const cs = getComputedStyle(btn); if (cs.display === 'none') continue;
      const b = btn.getBoundingClientRect(); if (b.width < 2) continue;
      const label = (btn.textContent || btn.getAttribute('aria-label') || btn.title || '').trim();
      if (!label) out.unlabeled.push(btn.className || btn.outerHTML.slice(0, 60));
      if (b.width < 24 || b.height < 24) out.tiny.push(`${btn.className || 'button'} ${Math.round(b.width)}x${Math.round(b.height)} "${label.slice(0, 20)}"`);
    }
    for (const img of document.querySelectorAll('img')) if (img.complete && img.naturalWidth === 0 && img.src) out.brokenImg.push(img.src.slice(-60));
    return out;
  });
  if (r.scrollX) note(where, 'page scrolls sideways');
  for (const x of r.off) note(where, 'box off screen', x);
  for (const x of r.overlaps) note(where, 'floating boxes overlap', x);
  for (const x of r.unlabeled.slice(0, 5)) note(where, 'button with no label', x);
  for (const x of r.tiny.slice(0, 5)) note(where, 'tap target under 24px', x);
  for (const x of r.brokenImg) note(where, 'broken image', x);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // The API trials may have sold the usual plot on: take it, or the first one nobody holds.
  let S1 = 1120;
  // The home chart's own seeds, so the plot taken is one the map opens on.
  for (const seed of [1120, 1050, 1000, 1020, 1220, 1060, 1030, 1080, 1040]) {
    const holder = await C.ownerOf(seed).catch(() => null);
    if (!holder || holder.toLowerCase() === A) { S1 = seed; break; }
  }
  if ((await C.ownerOf(S1).catch(() => null)) !== A) {
    const held = await api('/api/plots', { owner: A, reserve: true, seed: S1 }, A);
    if (held.json?.price) {
      const pay = await C.write('a', 'token', 'transfer', [C.deployed.vault, C.E(held.json.price)]);
      await api('/api/plots', { owner: A, seed: S1, region: 'Test', worldName: 'Fernrest', ownerName: 'Alice', burnTx: pay.hash }, A);
      await until(async () => (await C.ownerOf(S1)) === A, 30);
    }
  }
  const b = await chromium.launch();
  const sizes = [['desktop', 1440, 900], ['laptop', 1024, 700], ['phone', 400, 800], ['landscape', 812, 375]];
  for (const [name, width, height] of sizes) {
    const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    await ctx.addInitScript(walletLive(C.addr('a'), C.CHAIN_ID, C.RPC));
    await ctx.addCookies([cookieFor(A)]);
    const p = await ctx.newPage();
    const logs = [];
    p.on('pageerror', (e) => logs.push(['pageerror', e.message.slice(0, 160)]));
    p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push([m.type(), m.text().slice(0, 160)]); });
    const flush = (where) => { for (const [k, t] of logs.splice(0)) if (!/favicon|Download the React DevTools|net::ERR_|hydrat/i.test(t)) note(where, k, t); };
    const shot = (state) => p.screenshot({ path: `${OUT}/${name}-${state}.png` });

    await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(900);
    flush(`${name}/landing`); await inspect(p, `${name}/landing`); await shot('landing');
    await p.getByRole('button', { name: /Open the world map/i }).click(); await sleep(2500);
    flush(`${name}/map`); await inspect(p, `${name}/map`); await shot('map');
    await p.locator('.region-pin.owned').first().click(); await sleep(600);
    await p.locator('.land-claim .claim-button').first().click();
    await p.waitForSelector('.action', { timeout: 60000 }); await sleep(8500);
    flush(`${name}/world`); await inspect(p, `${name}/world`); await shot('world');

    // A being's card, through the first-day card's own button.
    const show = p.locator('button', { hasText: /^Show me$/ });
    if (await show.count() && await tap(show.first(), `${name}/being`, 'Show me')) { await sleep(900); flush(`${name}/being`); await inspect(p, `${name}/being`); await shot('being'); await p.locator('.being-card .panel-close').first().click({ timeout: 2000 }).catch(() => {}); await sleep(300); }

    // Every door on the strip.
    for (const key of ['build', 'people', 'market', 'land', 'exchange', 'chat', 'arena', 'casino', 'gacha', 'connect']) {
      const door = p.locator(`button.action.${key}`);
      if (!(await door.count())) { note(`${name}/${key}`, 'door missing from the strip'); continue; }
      await closeAll(p);
      if (!(await tap(door, `${name}/${key}`, 'the door'))) { await shot(`${key}-blocked`); continue; }
      await sleep(900);
      const open = await p.locator('.overlay-panel').count();
      if (!open) note(`${name}/${key}`, 'door opened nothing');
      flush(`${name}/${key}`); await inspect(p, `${name}/${key}`); await shot(key);
      if (!(await closeAll(p))) { note(`${name}/${key}`, 'panel did not close'); await shot(`${key}-stuck`); }
    }
    // The bank, through the purse; the guide, through the corner.
    if (await p.locator('.purse').count() && await tap(p.locator('.purse'), `${name}/bank`, 'the purse')) { await sleep(900); flush(`${name}/bank`); await inspect(p, `${name}/bank`); await shot('bank'); await closeAll(p); }
    if (await p.locator('.hud-guide').count() && await tap(p.locator('.hud-guide'), `${name}/guide`, 'the guide button')) { await sleep(900); if (!(await p.locator('.overlay-panel').count())) note(`${name}/guide`, 'guide button opened nothing'); flush(`${name}/guide`); await inspect(p, `${name}/guide`); await shot('guide'); await closeAll(p); }
    // The phone sheet.
    if (await p.locator('.rail-toggle').count() && await tap(p.locator('.rail-toggle'), `${name}/sheet`, 'the WORLD toggle')) { await sleep(700); flush(`${name}/sheet`); await inspect(p, `${name}/sheet`); await shot('sheet'); await p.locator('.rail-toggle').click(); await sleep(300); }
    await ctx.close();
  }
  // Standalone pages, no wallet.
  for (const path of ['/land', '/markets', '/wiki']) {
    for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 400, 800]]) {
      const p = await b.newPage({ viewport: { width, height } });
      const logs = [];
      p.on('pageerror', (e) => logs.push(['pageerror', e.message.slice(0, 160)]));
      p.on('console', (m) => { if (m.type() === 'error') logs.push(['error', m.text().slice(0, 160)]); });
      await p.goto(BASE + path, { waitUntil: 'networkidle' }); await sleep(1200);
      for (const [k, t] of logs) if (!/favicon|net::ERR_/i.test(t)) note(`${name}${path}`, k, t);
      const sx = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (sx) note(`${name}${path}`, 'page scrolls sideways');
      await p.screenshot({ path: `${OUT}/${name}${path.replace('/', '-')}.png` });
      await p.close();
    }
  }
  await b.close();
  fs.writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
  console.log(`\n${findings.length} findings; screenshots in ${OUT}`);
})();
