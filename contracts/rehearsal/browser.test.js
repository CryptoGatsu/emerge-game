/* The real interface against a live EVM (chain id 4663) with a wallet that really signs: list from the On-Chain panel, buy from the world map, give the plot up. */
const { chromium } = (() => { try { return require('playwright'); } catch { return require('/opt/node22/lib/node_modules/playwright'); } })();
const walletLive = require('./wallet.js');
const { ok, cookieFor, api, BASE, OP } = require('./site.js');
const C = require('./chain.js');
const A = C.addr('a').toLowerCase(), B = C.addr('b').toLowerCase();
const S1 = 1120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(1000); } return false; };
const text = async (p) => (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
(async () => {
  // A owns Fernrest on chain, paid for on chain.
  const held = await api('/api/plots', { owner: A, reserve: true, seed: S1 }, A);
  const pay = await C.write('a', 'token', 'transfer', [C.deployed.vault, C.E(held.json.price)]);
  const claimed = await api('/api/plots', { owner: A, seed: S1, region: 'Test', worldName: 'Fernrest', ownerName: 'Alice', burnTx: pay.hash }, A);
  ok('A claims Fernrest with a real payment', claimed.status === 200, `${claimed.status}`);
  ok('…and it is minted to A', await until(async () => (await C.ownerOf(S1)) === A, 30));

  const b = await chromium.launch(); const errors = [];
  const open = async (who) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addInitScript(walletLive(who === 'a' ? C.addr('a') : C.addr('b'), C.CHAIN_ID, C.RPC)); await ctx.addCookies([cookieFor(who === 'a' ? A : B)]);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.waitForTimeout(900);
    await p.getByRole('button', { name: /Open the world map/i }).click(); await p.waitForTimeout(2500);
    return { ctx, p };
  };

  // 1. A, in the world: the On-Chain panel lists the plot at 1000 through the market contract.
  const a = await open('a');
  await a.p.locator('.region-pin.owned').first().click(); await a.p.waitForTimeout(600);
  const mapCard = await text(a.p);
  ok('A’s plot card says it is a token, with OpenSea and explorer links', /OpenSea/.test(mapCard) && await a.p.locator('a', { hasText: /View on OpenSea/ }).count() === 1, mapCard.match(/.{0,80}OpenSea.{0,80}/)?.[0] ?? mapCard.slice(0, 120));
  const osHref = await a.p.locator('a', { hasText: /View on OpenSea/ }).getAttribute('href');
  ok('the OpenSea link names the land contract and the seed', osHref === `https://opensea.io/assets/robinhood/${C.deployed.land}/${S1}`, osHref);
  await a.p.locator('.land-claim .claim-button').first().click();
  await a.p.waitForSelector('.action', { timeout: 60000 }); await a.p.waitForTimeout(2000);
  await a.p.locator('button.action.connect').first().click(); await a.p.waitForTimeout(1200);
  const sell = a.p.locator('.connect-card', { hasText: 'SELL THIS PLOT' });
  await sell.locator('input').fill('1000');
  await sell.locator('button', { hasText: /List for sale/ }).click();
  ok('the approval, then the listing, were signed by A', await until(async () => a.p.evaluate(() => window.__sent.length) .then((n) => n >= 2), 40), String(await a.p.evaluate(() => window.__sent.length)));
  const sentA = await a.p.evaluate(() => window.__sent);
  ok('first to the land contract (setApprovalForAll), then to the market (list)', sentA[0]?.to?.toLowerCase() === C.deployed.land.toLowerCase() && sentA[0].data.startsWith('0xa22cb465') && sentA[1]?.to?.toLowerCase() === C.deployed.market.toLowerCase() && sentA[1].data.startsWith('0x'), JSON.stringify(sentA.map((s) => [s.to, s.data.slice(0, 10)])));
  ok('the chain has the listing at 1000 by A', await until(async () => { const l = await C.read('market', 'listings', [BigInt(S1)]); return l[0].toLowerCase() === A && l[1] === C.E(1000); }, 30));
  ok('the row mirrors it', await until(async () => (await api('/api/land?fresh=1', undefined, null, OP)).json.rows?.some((r) => r.seed === S1 && r.price === 1000), 20));
  ok('the sell card switches to Listed at 1,000', await until(async () => /Listed at 1,000 \$EMERGE/.test(await text(a.p)), 30), (await text(a.p)).match(/.{0,60}Listed.{0,80}/)?.[0]);
  const afterList = await text(a.p);
  ok('the sell card explains the token sale and the holders’ share', /stays in your wallet until it sells/.test(afterList) && /5% of it goes to the holders’ dividend pool/.test(afterList), afterList.match(/.{0,40}dividend pool.{0,40}/)?.[0]);
  await a.p.screenshot({ path: 'listed.png' });

  // 2. B, on the map: the land market shows it; Buy settles on the market contract and B walks in.
  const bb = await open('b');
  await bb.p.locator('button', { hasText: /^Land for sale$/ }).first().click(); await bb.p.waitForTimeout(1500);
  const row = bb.p.locator('.land-row', { hasText: 'Fernrest' }).first();
  ok('B sees Fernrest for sale at 1,000', await row.count() === 1 && /1,000 \$EMERGE/.test(await row.innerText()), (await row.innerText().catch(() => '')).slice(0, 120));
  await row.locator('button', { hasText: /Show on the map/ }).click(); await bb.p.waitForTimeout(1000);
  const buyBtn = bb.p.locator('button', { hasText: /^Buy Test · 1,000 \$EMERGE/ });
  ok('the buy button names the chain price', await buyBtn.count() === 1, String(await buyBtn.count()));
  await buyBtn.click();
  ok('B holds the plot on chain', await until(async () => (await C.ownerOf(S1)) === B, 60), await C.ownerOf(S1));
  const sentB = await bb.p.evaluate(() => window.__sent);
  ok('B signed the $EMERGE approval and the buy', sentB.length === 2 && sentB[0].to.toLowerCase() === C.deployed.token.toLowerCase() && sentB[1].to.toLowerCase() === C.deployed.market.toLowerCase(), JSON.stringify(sentB.map((s) => [s.to, s.data.slice(0, 10)])));
  ok('the row followed the chain to B', await until(async () => { const r = await api('/api/plots', { owner: B, seed: S1, follow: true }, B); return r.json.claim?.owner?.toLowerCase() === B && r.json.claim.forSale === undefined; }, 20));
  ok('B walked into Fernrest', await until(async () => (await bb.p.locator('.action').count()) > 0, 60));
  await bb.p.waitForTimeout(1500);
  ok('the royalty receiver holds 50 $EMERGE', (await C.read('token', 'balanceOf', [C.deployed.royalties])) === C.E(50));
  await bb.p.screenshot({ path: 'bought.png' });

  // 3. A's view: the plot is no longer hers.
  const sync = await api('/api/nft', { sync: true }, null, OP);
  ok('nothing left for the sync to move', sync.json.moved?.length === 0, JSON.stringify(sync.json));

  // 4. B gives the plot up: the token is burnt by B's wallet, then the row goes.
  await bb.p.locator('button.action.connect').first().click(); await bb.p.waitForTimeout(1200);
  const giveUp = bb.p.locator('button', { hasText: /Give up this plot/ });
  ok('the release warns that the token will be burnt', /burn|Burn/.test(await text(bb.p)), (await text(bb.p)).match(/.{0,80}[Bb]urn.{0,80}/)?.[0]);
  await giveUp.click(); await bb.p.waitForTimeout(400);
  await bb.p.locator('button', { hasText: /Give it up for good/ }).click();
  ok('the token is burnt', await until(async () => (await C.ownerOf(S1)) === null, 40));
  ok('the row is released', await until(async () => (await api(`/api/nft/${S1}`)).status === 404, 30));
  ok('the burn was B’s own signature to the land contract', (await bb.p.evaluate(() => window.__sent)).some((s) => s.to.toLowerCase() === C.deployed.land.toLowerCase() && s.data.startsWith('0x42966c68')));
  await bb.p.waitForTimeout(1500);
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
})().catch((e) => { console.log('FAIL  crashed', e); process.exit(1); });
