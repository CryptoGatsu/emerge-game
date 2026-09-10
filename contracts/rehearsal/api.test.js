/* The API against a live EVM with chain id 4663: claim → mint → metadata → list → buy → sync → royalties → burn → release. */
const { ok, api, BASE, OP } = require('./site.js');
const C = require('./chain.js');
const A = C.addr('a').toLowerCase(), B = C.addr('b').toLowerCase(), VAULT = C.addr('vault').toLowerCase();

const op = (body) => api('/api/nft', body, null, OP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S1 = 1120, S2 = 1365;
(async () => {
  // 0. Status before anything.
  let st = (await api('/api/nft')).json;
  ok('status: plots are tokens', st.live === true, JSON.stringify(st).slice(0, 200));
  ok('status: contracts match the deployment', st.land?.toLowerCase() === C.deployed.land.toLowerCase() && st.market?.toLowerCase() === C.deployed.market.toLowerCase() && st.royalties?.toLowerCase() === C.deployed.royalties.toLowerCase());
  ok('status: the vault is the minter and can sign', st.minter?.toLowerCase() === VAULT && st.canSign === true && (await C.read('land', 'minter')).toLowerCase() === VAULT);
  ok('status: nothing minted yet', st.mintedCount === 0 && st.rows === 0, `minted ${st.mintedCount} rows ${st.rows}`);
  ok('operator door refuses without the secret', (await api('/api/nft', { sync: true })).status === 401);

  // 1. A claims S1: reserve, pay the vault in $EMERGE on chain, claim with the hash.
  const held = await api('/api/plots', { owner: A, reserve: true, seed: S1 }, A);
  ok('reserve answers the price', held.status === 200 && held.json.price > 0, JSON.stringify(held.json));
  const price = held.json.price;
  const short = await C.write('a', 'token', 'transfer', [C.deployed.vault, C.E(price - 1)]);
  const under = await api('/api/plots', { seed: S1, region: 'Test', worldName: 'Fernrest', owner: A, ownerName: 'Alice', burnTx: short.hash }, A);
  ok('a payment short of the price is refused', under.status !== 200 && /costs/.test(under.json?.error ?? ''), `${under.status} ${under.json?.error}`);
  const pay = await C.write('a', 'token', 'transfer', [C.deployed.vault, C.E(price)]);
  const claimed = await api('/api/plots', { seed: S1, region: 'Test', worldName: 'Fernrest', owner: A, ownerName: 'Alice', burnTx: pay.hash }, A);
  ok('claim with a real on-chain payment', claimed.status === 200 && claimed.json.claim?.owner?.toLowerCase() === A, `${claimed.status} ${JSON.stringify(claimed.json).slice(0, 160)}`);
  const again = await api('/api/plots', { seed: S1, region: 'Test', worldName: 'Fernrest', owner: A, ownerName: 'Alice', burnTx: pay.hash }, A);
  ok('the same payment cannot buy twice', again.status !== 200, `${again.status}`);
  // The mint is fired after the claim answers; give it a moment, then make sure.
  for (let i = 0; i < 20 && (await C.ownerOf(S1)) !== A; i++) await sleep(500);
  let holder = await C.ownerOf(S1);
  if (holder !== A) { const m = await op({ mint: true }); console.log('   flush:', JSON.stringify(m.json)); holder = await C.ownerOf(S1); }
  ok('the plot was minted on chain to the claimant', holder === A, `ownerOf=${holder}`);
  const flushAgain = await op({ mint: true });
  ok('a second flush mints nothing', flushAgain.json.minted === 0 && flushAgain.json.waiting === 0, JSON.stringify(flushAgain.json));
  st = (await api('/api/nft')).json;
  ok('status counts one token, no queue', st.mintedCount === 1 && st.queue === 0 && st.unminted === 0 && st.inFlight === null, JSON.stringify({ m: st.mintedCount, q: st.queue, u: st.unminted, f: st.inFlight }));

  // 2. Metadata as OpenSea would read it.
  const uri = await C.read('land', 'tokenURI', [BigInt(S1)]);
  ok('tokenURI points at the game', uri === `${BASE}/api/nft/${S1}`, uri);
  const meta = await api(`/api/nft/${S1}`);
  ok('metadata route answers', meta.status === 200 && /Fernrest/.test(meta.json?.name ?? '') && meta.json.image === `${BASE}/api/nft/${S1}/image` && Array.isArray(meta.json.attributes), JSON.stringify(meta.json).slice(0, 200));
  const img = await fetch(`${BASE}/api/nft/${S1}/image`); const svg = await img.text();
  ok('image route serves the plot picture', img.status === 200 && /image\/svg/.test(img.headers.get('content-type') ?? '') && svg.includes('Fernrest') && svg.length > 5000, `${img.status} ${img.headers.get('content-type')} ${svg.length}b`);
  const curi = await C.read('land', 'contractURI');
  const coll = await api('/api/nft/collection');
  ok('contractURI and the collection route agree on the royalty receiver', curi === `${BASE}/api/nft/collection` && coll.json?.fee_recipient?.toLowerCase() === C.deployed.royalties.toLowerCase() && coll.json.seller_fee_basis_points === 500, JSON.stringify(coll.json).slice(0, 160));
  const [rcv, amt] = await C.read('land', 'royaltyInfo', [BigInt(S1), C.E(1000)]);
  ok('ERC-2981: 5% to the royalty receiver', rcv.toLowerCase() === C.deployed.royalties.toLowerCase() && amt === C.E(50));
  ok('unminted seed metadata is 404', (await api(`/api/nft/${S2}`)).status === 404);

  // 3. Release refused while the token stands; offers refused; buy refused.
  const rel = await api('/api/plots', { owner: A, seed: S1, release: true }, A);
  ok('release refused while the token exists', rel.status === 409 && /Burn/.test(rel.json.error), `${rel.status} ${rel.json?.error}`);
  const offer = await api('/api/plots', { owner: B, seed: S1, offer: 100, offerTx: '0x' + 'ab'.repeat(32) }, B);
  ok('offers refused in token mode', offer.status !== 200, `${offer.status} ${offer.json?.error}`);
  const buyOld = await api('/api/plots', { owner: B, seed: S1, buy: true, transferTx: '0x' + 'ab'.repeat(32) }, B);
  ok('the old wallet-to-wallet buy is refused', buyOld.status === 409 && /OpenSea/.test(buyOld.json.error), `${buyOld.status}`);

  // 4. A lists on the market contract, then mirrors it to the row.
  const listNoApprove = await C.write('a', 'market', 'list', [BigInt(S1), C.E(1000)]).catch((e) => ({ status: 'reverted', reason: e.shortMessage }));
  ok('listing without approving the market reverts', listNoApprove.status === 'reverted');
  await C.write('a', 'land', 'setApprovalForAll', [C.deployed.market, true]);
  const listed = await C.write('a', 'market', 'list', [BigInt(S1), C.E(1000)]);
  ok('listed on chain at 1000', listed.status === 'success');
  const mirrorWrong = await api('/api/plots', { owner: A, seed: S1, list: true, price: 5 }, A);
  ok('the row mirrors the chain price, not the body', mirrorWrong.status === 200 && mirrorWrong.json.claim.forSale === 1000 && mirrorWrong.json.onChain === true, JSON.stringify(mirrorWrong.json).slice(0, 160));
  const board = await api('/api/land?fresh=1', undefined, null, OP);
  const row = (board.json.rows ?? []).find((r) => r.seed === S1);
  ok('the land market shows the chain listing', !!row && row.price === 1000 && row.owner?.toLowerCase() === A, JSON.stringify(row ?? board.json).slice(0, 160));
  const notMine = await api('/api/plots', { owner: B, seed: S1, list: true, price: 7 }, B);
  ok('somebody else cannot list it', notMine.status === 409);

  // 5. B buys on chain; the game follows.
  const aBefore = await C.read('token', 'balanceOf', [C.addr('a')]);
  const tooCheap = await C.write('b', 'market', 'buy', [BigInt(S1), C.E(999)]).catch((e) => ({ status: 'reverted', reason: e.shortMessage }));
  ok('buy below the price reverts (price moved guard)', tooCheap.status === 'reverted');
  await C.write('b', 'token', 'approve', [C.deployed.market, C.E(1000)]);
  const bought = await C.write('b', 'market', 'buy', [BigInt(S1), C.E(1000)]);
  ok('bought on chain', bought.status === 'success' && (await C.ownerOf(S1)) === B);
  const aAfter = await C.read('token', 'balanceOf', [C.addr('a')]);
  const royaltyHeld = await C.read('token', 'balanceOf', [C.deployed.royalties]);
  ok('seller got 950, royalty receiver holds 50', aAfter - aBefore === C.E(950) && royaltyHeld === C.E(50), `${(aAfter - aBefore) / 10n ** 18n} / ${royaltyHeld / 10n ** 18n}`);
  ok('listing is gone from the board', Number(await C.read('market', 'listedCount')) === 0);
  // Before any sync, A tries to act as owner: the chain outranks the row.
  const staleList = await api('/api/plots', { owner: A, seed: S1, list: true, price: 5 }, A);
  ok('the seller cannot relist a plot the chain says is sold', staleList.status !== 200 || staleList.json.claim?.forSale == null, `${staleList.status} ${JSON.stringify(staleList.json).slice(0, 120)}`);
  const follow = await api('/api/plots', { owner: B, seed: S1, follow: true }, B);
  ok('follow moves the row to the buyer', follow.status === 200 && follow.json.claim.owner.toLowerCase() === B && follow.json.claim.forSale === undefined && follow.json.holder === B, JSON.stringify(follow.json).slice(0, 200));
  const synced = await op({ sync: true });
  ok('a second sync has nothing to move', synced.json.moved?.length === 0 && synced.json.released?.length === 0, JSON.stringify(synced.json));
  const tr = await op({ transfers: true });
  ok('the transfer is on record', tr.json.transfers?.some((t) => t.seed === S1 && t.from === A && t.to === B), JSON.stringify(tr.json).slice(0, 200));
  const board2 = await api('/api/land?fresh=1', undefined, null, OP);
  ok('the land market no longer lists it', !(board2.json.rows ?? []).some((r) => r.seed === S1));
  const meta2 = (await api(`/api/nft/${S1}`)).json;
  const ownerAttr = JSON.stringify(meta2).toLowerCase();
  ok('metadata survives the move', meta2?.name && /Fernrest/.test(meta2.name), ownerAttr.slice(0, 100));

  // 6. Royalties back to the holders: $EMERGE into the dividend pool, ETH held.
  const vaultBefore = (await api('/api/vault')).json;
  const poolBefore = vaultBefore.dividendPool ?? 0;
  await C.sendEth('a', C.deployed.royalties, C.E('0.25'));
  st = (await api('/api/nft')).json;
  ok('status shows royalties waiting', st.royaltiesWaiting?.some((w) => w.symbol === '$EMERGE' && w.amount === 50) && st.royaltiesWaiting.some((w) => w.symbol === 'ETH' && w.amount === 0.25), JSON.stringify(st.royaltiesWaiting));
  const vaultTokBefore = await C.read('token', 'balanceOf', [C.deployed.vault]);
  const swept = await op({ sweep: true });
  const em = swept.json.find?.((s) => s.symbol === '$EMERGE'), eth = swept.json.find?.((s) => s.symbol === 'ETH');
  ok('sweep books $EMERGE to dividends and holds ETH', em?.booked === 'dividends' && em.amount === 50 && !!em.txHash && eth?.booked === 'held' && eth.amount === 0.25, JSON.stringify(swept.json).slice(0, 300));
  const vaultTokAfter = await C.read('token', 'balanceOf', [C.deployed.vault]);
  ok('the vault received the 50 $EMERGE', vaultTokAfter - vaultTokBefore === C.E(50) && (await C.read('token', 'balanceOf', [C.deployed.royalties])) === 0n);
  const vaultAfter = (await api('/api/vault')).json;
  ok('the dividend pool grew by 50', (vaultAfter.dividendPool ?? 0) - poolBefore === 50, `${poolBefore} -> ${vaultAfter.dividendPool}`);
  const book = await op({ royalties: true });
  ok('the royalty book shows the sweep and the held ETH', book.json.swept?.length === 2 && book.json.held?.some((h) => h.symbol === 'ETH' && h.amount === 0.25), JSON.stringify(book.json).slice(0, 200));
  const swept2 = await op({ sweep: true });
  ok('nothing to sweep twice', swept2.json.every((s) => s.booked === 'nothing'), JSON.stringify(swept2.json).slice(0, 120));

  // 7. Airdrop: a row without a token is minted; already-minted rows are counted.
  const held2 = await api('/api/plots', { owner: B, reserve: true, seed: S2 }, B);
  const pay2 = await C.write('b', 'token', 'transfer', [C.deployed.vault, C.E(held2.json.price)]);
  const claimed2 = await api('/api/plots', { seed: S2, region: 'Test', worldName: 'Harbourfall', owner: B, ownerName: 'Bob', burnTx: pay2.hash }, B);
  ok('second claim', claimed2.status === 200);
  for (let i = 0; i < 20 && (await C.ownerOf(S2)) !== B; i++) await sleep(500);
  const drop = await op({ airdrop: true });
  ok('airdrop finds everything already minted', drop.json.alreadyMinted === 2 && drop.json.queued === 0, JSON.stringify(drop.json).slice(0, 200));
  ok('B holds both tokens', (await C.read('land', 'tokensOf', [C.addr('b')])).map(Number).sort().join() === [S1, S2].sort().join());

  // 8. Wallet-to-wallet transfer outside any market, then the cron door.
  // Both wallets are given a record first: the hand-over only writes into a
  // record that exists, since a stub carrying one seed would be merged over
  // the top of a real one on the player's own device.
  const record = (claims) => ({ name: 'Test', nameChanges: 0, nameTokens: 0, ledger: { earnedEmerge: 7 }, claims, prospected: [], listings: [], savedAt: Date.now() });
  await api('/api/player', { record: record([{ seed: S2, name: 'Harbourfall', region: 'Test', price: 0, claimedAt: Date.now(), owner: B, txHash: null }]) }, B);
  await api('/api/player', { record: record([]) }, A);
  await C.write('b', 'land', 'transferFrom', [C.addr('b'), C.addr('a'), BigInt(S2)]);
  const cron = await api('/api/nft?sync=1', undefined, null, OP);
  ok('the cron door syncs the transfer', cron.status === 200 && cron.json.synced?.moved?.some((m) => m.seed === S2 && m.to === A), JSON.stringify(cron.json).slice(0, 200));
  const row2 = (await api('/api/plots', { owner: A, seed: S2, follow: true }, A)).json;
  ok('the row is A’s now, keeping the world name', row2.claim?.owner?.toLowerCase() === A && row2.claim.worldName === 'Harbourfall', JSON.stringify(row2).slice(0, 160));
  // The receiving wallet has to be told it owns the plot, or the plot is a
  // thing the map shows and the player's own list of plots does not.
  const recA = (await api('/api/player', undefined, A)).json;
  ok('the receiving wallet’s record gains the plot', (recA.record?.claims ?? []).some((c) => c.seed === S2), JSON.stringify(recA.record?.claims ?? []).slice(0, 200));
  ok('and keeps what it already had', recA.record?.name === 'Test' && recA.record?.ledger?.earnedEmerge === 7, JSON.stringify(recA.record).slice(0, 160));
  const recB = (await api('/api/player', undefined, B)).json;
  ok('the sending wallet’s record lets it go', !(recB.record?.claims ?? []).some((c) => c.seed === S2), JSON.stringify(recB.record?.claims ?? []).slice(0, 200));
  // A transfer that happened before any of this existed: the row sits with
  // the right owner, so no sync will ever move it again and nothing would
  // put it back into the holder's record. Reading the record has to be
  // enough, or a plot sent between wallets stays missing from its owner's
  // own list for good — which is what a player reported.
  await api('/api/player', { record: record([]) }, A);
  const healed = (await api('/api/player', undefined, A)).json;
  ok('a record that never heard about a plot it holds is reconciled on read',
     (healed.record?.claims ?? []).some((c) => c.seed === S2), JSON.stringify(healed.record?.claims ?? []).slice(0, 200));
  ok('and the reconciled plot keeps the world’s name',
     (healed.record?.claims ?? []).find((c) => c.seed === S2)?.name === 'Harbourfall', JSON.stringify(healed.record?.claims ?? []).slice(0, 200));
  const other = (await api('/api/player', undefined, B)).json;
  ok('a wallet is not handed somebody else’s plot', !(other.record?.claims ?? []).some((c) => c.seed === S2), JSON.stringify(other.record?.claims ?? []).slice(0, 200));
  // The other half of the same report: a record still naming plots the wallet
  // sold or sent away. Which worlds pay is decided by claim order, so stale
  // entries at the front of it push the real ones past the limit — a player
  // holding one plot was told that plot does not pay.
  const ghosts = [11, 22, 33, 44, 55].map((seed, i) => ({ seed, name: `Ghost${seed}`, region: 'Gone', price: 0, claimedAt: 1000 + i, owner: A, txHash: null }));
  const inFlight = { seed: 99, name: 'JustClaimed', region: 'New', price: 0, claimedAt: Date.now(), owner: A, txHash: null };
  await api('/api/player', { record: { ...record([]), claims: [...ghosts, inFlight, { seed: S2, name: 'Harbourfall', region: 'Test', price: 0, claimedAt: 9_000_000, owner: A, txHash: null }] } }, A);
  const tidied = (await api('/api/player', undefined, A)).json;
  const claims = tidied.record?.claims ?? [];
  ok('land given up long ago, which the registry has forgotten, is swept out',
     !claims.some((c) => [11, 22, 33, 44, 55].includes(c.seed)), JSON.stringify(claims.map((c) => c.seed)));
  ok('a claim still on its way to the registry is kept', claims.some((c) => c.seed === 99), JSON.stringify(claims.map((c) => c.seed)));
  ok('the wallet still holds its real plot', claims.some((c) => c.seed === S2), JSON.stringify(claims.map((c) => c.seed)));
  ok('and its own plot is inside the earning limit again',
     [...claims].sort((a, b) => a.claimedAt - b.claimedAt).slice(0, 5).some((c) => c.seed === S2), JSON.stringify(claims.map((c) => c.seed)));
  // S1 is B's now. A record of A's naming it must not survive a read.
  await api('/api/player', { record: { ...record([]), claims: [{ seed: S1, name: 'Fernrest', region: 'Test', price: 0, claimedAt: 1, owner: A, txHash: null }] } }, A);
  const dropped = (await api('/api/player', undefined, A)).json;
  ok('a plot the registry gives to another wallet is dropped',
     !(dropped.record?.claims ?? []).some((c) => c.seed === S1), JSON.stringify((dropped.record?.claims ?? []).map((c) => c.seed)));


  // 9. Burn: the holder burns, the sync releases the row.
  const notHolderBurn = await C.write('b', 'land', 'burn', [BigInt(S2)]).catch((e) => ({ status: 'reverted' }));
  ok('only the holder can burn', notHolderBurn.status === 'reverted');
  await C.write('a', 'land', 'burn', [BigInt(S2)]);
  const rel2 = await op({ sync: true });
  ok('burnt plot released', rel2.json.released?.includes(S2), JSON.stringify(rel2.json));
  ok('its metadata is gone', (await api(`/api/nft/${S2}`)).status === 404);
  const free = await api('/api/plots', { owner: B, reserve: true, seed: S2 }, B);
  ok('the land is claimable again', free.status === 200, `${free.status} ${free.json?.error ?? ''}`);
  st = (await api('/api/nft')).json;
  ok('final status: one token, one row', st.mintedCount === 1 && st.rows === 1 && st.queue === 0, JSON.stringify({ m: st.mintedCount, r: st.rows, q: st.queue }));
})().catch((e) => { console.log('FAIL  crashed', e); process.exit(1); });
