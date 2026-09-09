# Contract tests

Compiled with `solc` and run on an in-process EVM (`@ethereumjs/vm`), so they
need no node, no key and no network.

```bash
cd contracts/test
npm init -y >/dev/null && npm i solc@0.8.28 @ethereumjs/vm@8 @ethereumjs/evm@3 @ethereumjs/util@9 @ethereumjs/common@4
for f in ../EmergeLand.sol ../EmergeRoyalties.sol ../EmergeMarket.sol MockToken.sol; do node compile.js $f; done   # EVM=paris by default; EVM=cancun to compare
node contracts.test.js
```

`contracts.test.js` covers minting (minter only, no double mint, batches),
transfers and burning, metadata and royalties, the market (approval, listing,
buying with the royalty split, stale listings, cancelling, pausing, zero
royalty) and the royalty sweep, for both $EMERGE and the chain's own coin.

`compile.js` targets the `paris` EVM (set `EVM=…` to change it), the same
setting to use in Remix: the compiler's default `cancun` target emits opcodes
some chains do not run yet, and a deployment that hits one reverts with
"invalid opcode" before the constructor runs.
