/* The land, the royalties and the market, exercised on an EVM: minting, moving, selling, paying the holders' pool. */
const { make } = require('./evm.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
(async () => {
  const e = await make();
  const deployer = e.who(0xA0), minter = e.who(0xA1), alice = e.who(0xB1), bob = e.who(0xB2), carol = e.who(0xB3), vault = e.who(0xC0);
  for (const a of [deployer, minter, alice, bob, carol, vault]) await e.fund(a);
  const addr = (a) => a.toString();
  const token = await e.deploy('MockToken', deployer);
  const royalties = await e.deploy('EmergeRoyalties', deployer, [addr(vault)], [{ type: 'address' }]);
  const land = await e.deploy('EmergeLand', deployer, ['https://www.emergerh.world/api/nft/', 'https://www.emergerh.world/api/nft/collection', addr(royalties.address), 500n], [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint96' }]);
  const market = await e.deploy('EmergeMarket', deployer, [addr(land.address), addr(token.address)], [{ type: 'address' }, { type: 'address' }]);

  // ---- minting
  let r = await e.call(land, alice, 'mint', [1120n, addr(alice)]);
  ok(!r.ok && r.reason === 'not minter', 'nobody but the minter mints: ' + r.reason);
  r = await e.call(land, deployer, 'setMinter', [addr(minter)]); ok(r.ok, 'the owner names the minter');
  r = await e.call(land, minter, 'mint', [1120n, addr(alice)]); ok(r.ok && r.logs.some((l) => l.eventName === 'Minted'), 'the minter mints a plot to its holder');
  r = await e.call(land, minter, 'mint', [1120n, addr(bob)]); ok(!r.ok && r.reason === 'already minted', 'a held plot cannot be minted over: ' + r.reason);
  r = await e.call(land, minter, 'mint', [0n, addr(bob)]); ok(!r.ok && r.reason === 'no such plot', 'seed zero is no plot');
  r = await e.call(land, minter, 'mintBatch', [[1000n, 1050n, 1080n], [addr(bob), addr(bob), addr(carol)]]); ok(r.ok, 'a batch mints the pre-contract plots to their holders');
  r = await e.call(land, minter, 'mintBatch', [[1n, 2n], [addr(bob)]]); ok(!r.ok && r.reason === 'length mismatch', 'a ragged batch is refused');
  r = await e.call(land, alice, 'ownerOf', [1120n]); ok(r.ok && r.result.toLowerCase() === addr(alice).toLowerCase(), 'ownerOf reads the holder');
  r = await e.call(land, alice, 'balanceOf', [addr(bob)]); ok(r.ok && r.result === 2n, 'balanceOf counts');
  r = await e.call(land, alice, 'mintedCount', []); ok(r.ok && r.result === 4n, 'mintedCount: ' + r.result);
  r = await e.call(land, alice, 'registry', [0n, 10n]); ok(r.ok && r.result[0].length === 4 && r.result[1][3].toLowerCase() === addr(carol).toLowerCase(), 'the registry pages seeds and holders');
  r = await e.call(land, alice, 'tokensOf', [addr(bob)]); ok(r.ok && r.result.map(Number).sort().join() === '1000,1050', 'tokensOf lists a wallet\'s plots: ' + r.result);
  r = await e.call(land, alice, 'tokenURI', [1120n]); ok(r.ok && r.result === 'https://www.emergerh.world/api/nft/1120', 'tokenURI is the base plus the seed: ' + r.result);
  r = await e.call(land, alice, 'tokenURI', [999n]); ok(!r.ok, 'tokenURI of an unminted plot reverts');
  r = await e.call(land, alice, 'royaltyInfo', [1120n, 1_000_000n]); ok(r.ok && r.result[0].toLowerCase() === addr(royalties.address).toLowerCase() && r.result[1] === 50_000n, 'royaltyInfo: 5% to the receiver');
  r = await e.call(land, alice, 'supportsInterface', ['0x2a55205a']); ok(r.ok && r.result === true, 'declares ERC-2981');
  r = await e.call(land, alice, 'supportsInterface', ['0x5b5e139f']); ok(r.ok && r.result === true, 'declares ERC-721 Metadata');
  r = await e.call(land, alice, 'setRoyalty', [addr(alice), 100n]); ok(!r.ok && r.reason === 'not owner', 'only the owner sets royalties');
  r = await e.call(land, deployer, 'setRoyalty', [addr(royalties.address), 2000n]); ok(!r.ok && r.reason === 'royalty too high', 'a royalty above ten percent is refused');
  r = await e.call(land, deployer, 'setBaseURI', ['https://x/']); ok(r.ok && r.logs.some((l) => l.eventName === 'BatchMetadataUpdate'), 'a new base URI asks marketplaces to refresh');
  await e.call(land, deployer, 'setBaseURI', ['https://www.emergerh.world/api/nft/']);
  r = await e.call(land, deployer, 'refreshMetadata', [1120n]); ok(r.ok && r.logs.some((l) => l.eventName === 'MetadataUpdate'), 'a single plot can be refreshed');

  // ---- transfers and burning
  r = await e.call(land, bob, 'transferFrom', [addr(alice), addr(bob), 1120n]); ok(!r.ok && r.reason === 'not allowed', 'nobody moves a plot they do not hold');
  r = await e.call(land, alice, 'transferFrom', [addr(alice), addr(bob), 1120n]); ok(r.ok, 'the holder moves their plot');
  r = await e.call(land, alice, 'ownerOf', [1120n]); ok(r.ok && r.result.toLowerCase() === addr(bob).toLowerCase(), 'and the chain says so');
  r = await e.call(land, deployer, 'transferFrom', [addr(bob), addr(deployer), 1120n]); ok(!r.ok, 'the contract owner cannot take a plot');
  r = await e.call(land, bob, 'transferFrom', [addr(bob), addr(alice), 1120n]); ok(r.ok, 'moved back');
  r = await e.call(land, bob, 'burn', [1000n]); ok(r.ok && r.logs.some((l) => l.eventName === 'Burned'), 'a holder gives a plot up');
  r = await e.call(land, bob, 'ownerOf', [1000n]); ok(!r.ok, 'a burnt plot has no owner');
  r = await e.call(land, minter, 'mint', [1000n, addr(carol)]); ok(r.ok, 'a given-up plot can be claimed and minted again');
  r = await e.call(land, alice, 'mintedCount', []); ok(r.ok && r.result === 4n, 'and is listed once in the registry: ' + r.result);
  r = await e.call(land, alice, 'burn', [1000n]); ok(!r.ok, 'nobody burns another\'s plot');

  // ---- the market
  await e.call(token, deployer, 'mint', [addr(bob), 10_000_000n * 10n ** 18n]);
  const price = 300_000n * 10n ** 18n;
  r = await e.call(market, alice, 'list', [1120n, price]); ok(!r.ok && r.reason === 'approve the market first', 'listing needs the market approved: ' + r.reason);
  r = await e.call(land, alice, 'setApprovalForAll', [addr(market.address), true]); ok(r.ok, 'the seller approves the market');
  r = await e.call(market, bob, 'list', [1120n, price]); ok(!r.ok && r.reason === 'not yours', 'only the holder lists');
  r = await e.call(market, alice, 'list', [1120n, price]); ok(r.ok && r.logs.some((l) => l.eventName === 'Listed'), 'listed');
  r = await e.call(market, alice, 'board', [0n, 10n]); ok(r.ok && r.result[0].length === 1 && r.result[2][0] === price && r.result[3][0] === true, 'the board shows it live');
  r = await e.call(market, bob, 'buy', [1120n, price]); ok(!r.ok && r.reason === 'allowance', 'a buyer must approve the payment first: ' + r.reason);
  await e.call(token, bob, 'approve', [addr(market.address), price]);
  r = await e.call(market, bob, 'buy', [1120n, price - 1n]); ok(!r.ok && r.reason === 'price moved', 'a price above what the buyer agreed is refused');
  r = await e.call(market, alice, 'buy', [1120n, price]); ok(!r.ok && r.reason === 'your own plot', 'a seller cannot buy their own listing');
  r = await e.call(market, bob, 'buy', [1120n, price]); ok(r.ok && r.logs.some((l) => l.eventName === 'Sold'), 'bought');
  r = await e.call(land, bob, 'ownerOf', [1120n]); ok(r.ok && r.result.toLowerCase() === addr(bob).toLowerCase(), 'the plot moved to the buyer');
  r = await e.call(token, bob, 'balanceOf', [addr(alice)]); ok(r.ok && r.result === price * 95n / 100n, 'the seller got 95%: ' + r.result / 10n ** 18n);
  r = await e.call(token, bob, 'balanceOf', [addr(royalties.address)]); ok(r.ok && r.result === price * 5n / 100n, 'the royalty receiver got 5%: ' + r.result / 10n ** 18n);
  r = await e.call(market, bob, 'board', [0n, 10n]); ok(r.ok && r.result[0].length === 0, 'the listing is gone from the board');
  r = await e.call(market, bob, 'buy', [1120n, price]); ok(!r.ok && r.reason === 'not for sale', 'and cannot be bought twice');

  // A listing goes stale when the plot moves elsewhere: shown as not live, refused to buy, and anybody holding it can clear it.
  await e.call(land, bob, 'setApprovalForAll', [addr(market.address), true]);
  r = await e.call(market, bob, 'list', [1120n, price]); ok(r.ok, 'the buyer relists');
  await e.call(land, bob, 'transferFrom', [addr(bob), addr(carol), 1120n]);
  r = await e.call(market, alice, 'board', [0n, 10n]); ok(r.ok && r.result[3][0] === false, 'a plot moved elsewhere shows as not live');
  await e.call(token, deployer, 'mint', [addr(alice), price]); await e.call(token, alice, 'approve', [addr(market.address), price]);
  r = await e.call(market, alice, 'buy', [1120n, price]); ok(!r.ok && r.reason === 'not for sale', 'a stale listing cannot be bought: ' + r.reason);
  r = await e.call(market, alice, 'cancel', [1120n]); ok(!r.ok && r.reason === 'not yours', 'a stranger cannot cancel it');
  r = await e.call(market, carol, 'cancel', [1120n]); ok(r.ok, 'the new holder can clear it');
  // Withdrawn approval also makes a listing dead.
  await e.call(land, carol, 'setApprovalForAll', [addr(market.address), true]);
  await e.call(market, carol, 'list', [1120n, price]);
  await e.call(land, carol, 'setApprovalForAll', [addr(market.address), false]);
  r = await e.call(market, alice, 'buy', [1120n, price]); ok(!r.ok && r.reason === 'not for sale', 'a listing whose approval was withdrawn is not for sale');
  r = await e.call(market, carol, 'cancel', [1120n]); ok(r.ok, 'the seller cancels');
  // Pause.
  await e.call(land, carol, 'setApprovalForAll', [addr(market.address), true]);
  await e.call(market, carol, 'list', [1120n, price]);
  await e.call(market, deployer, 'setPaused', [true]);
  r = await e.call(market, alice, 'buy', [1120n, price]); ok(!r.ok && r.reason === 'market paused', 'a paused market sells nothing');
  await e.call(market, deployer, 'setPaused', [false]);
  r = await e.call(market, alice, 'buy', [1120n, price]); ok(r.ok, 'and sells again once unpaused');
  // Zero royalty: the seller gets everything.
  await e.call(land, deployer, 'setRoyalty', [addr(royalties.address), 0n]);
  await e.call(land, alice, 'setApprovalForAll', [addr(market.address), true]);
  await e.call(market, alice, 'list', [1120n, 1000n]);
  await e.call(token, deployer, 'mint', [addr(bob), 1000n]); await e.call(token, bob, 'approve', [addr(market.address), 1000n]);
  const before = (await e.call(token, bob, 'balanceOf', [addr(alice)])).result;
  r = await e.call(market, bob, 'buy', [1120n, 1000n]); ok(r.ok, 'a sale with no royalty goes through');
  const after = (await e.call(token, bob, 'balanceOf', [addr(alice)])).result; ok(after - before === 1000n, 'and the seller gets the whole price');
  await e.call(land, deployer, 'setRoyalty', [addr(royalties.address), 500n]);

  // ---- royalties sweep
  const held = (await e.call(token, bob, 'balanceOf', [addr(royalties.address)])).result;
  ok(held === price * 5n / 100n * 2n, 'two sales\' royalties are waiting: ' + held / 10n ** 18n);
  r = await e.call(royalties, alice, 'sweep', [addr(token.address)]); ok(r.ok && r.logs.some((l) => l.eventName === 'Swept'), 'anybody may sweep');
  r = await e.call(token, bob, 'balanceOf', [addr(vault)]); ok(r.ok && r.result === held, 'the vault received it all');
  r = await e.call(token, bob, 'balanceOf', [addr(royalties.address)]); ok(r.ok && r.result === 0n, 'nothing stays behind');
  ok(await e.sendValue(alice, royalties.address, 5n * 10n ** 18n), 'the receiver takes the chain\'s own coin');
  const vaultEth = await e.balance(vault);
  r = await e.call(royalties, bob, 'sweep', ['0x0000000000000000000000000000000000000000']); ok(r.ok && r.result === 5n * 10n ** 18n, 'and sweeps it: ' + r.result);
  ok((await e.balance(vault)) - vaultEth === 5n * 10n ** 18n, 'to the vault');
  r = await e.call(royalties, alice, 'setVault', [addr(alice)]); ok(!r.ok && r.reason === 'not owner', 'only the owner moves the vault');
  r = await e.call(royalties, bob, 'sweep', [addr(token.address)]); ok(r.ok && r.result === 0n, 'an empty sweep is a no-op');

  console.log(`contracts: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
