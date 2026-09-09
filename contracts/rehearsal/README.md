# Rehearsing the land contracts on a live EVM

Everything the game does with `EmergeLand`, `EmergeMarket` and
`EmergeRoyalties`, run for real against a node that carries Robinhood Chain's
chain id: the app built against the contracts, the vault key signing mints and
sweeps on the server, and players signing claims, listings, purchases and
burns from a browser. No stubs — every hash is a mined transaction, and every
check reads the chain back.

`api.test.js` drives the routes (52 checks): a claim paid on chain and
verified, the vault minting it, `tokenURI` and the metadata OpenSea reads,
release refused while the token stands, listing and buying on the market with
the 95/5 split, the row following the buyer, the sweep booking the royalty into
the dividend pool, the airdrop, a wallet-to-wallet transfer picked up by the
cron door, a burn releasing the row. `browser.test.js` drives the interface
with a wallet that really signs (22 checks): listing from the On-Chain panel,
buying from the world map, giving the plot up.

## Running it locally

```bash
# 1. A node with chain id 4663 and funded dev accounts.
npx ganache -p 8545 --chain.chainId 4663 --chain.networkId 4663 -d --wallet.defaultBalance 1000

# 2. Compile (paris EVM) and deploy; prints the environment for the build.
cd contracts/test && for f in ../EmergeLand.sol ../EmergeRoyalties.sol ../EmergeMarket.sol MockToken.sol; do node compile.js $f; done
cd ../rehearsal && node deploy.js

# 3. Build and start the app with what deploy.js printed, plus the vault key
#    (ganache -d account 0, a public development key), fast confirmations and
#    the test secrets the scripts expect.
NEXT_PUBLIC_ROBINHOOD_RPC_URL=http://127.0.0.1:8545 NEXT_PUBLIC_ROBINHOOD_CHAIN_ID=4663 \
NEXT_PUBLIC_EMERGE_TOKEN=… NEXT_PUBLIC_EMERGE_REGISTRY=… NEXT_PUBLIC_EMERGE_MARKET=… NEXT_PUBLIC_EMERGE_ROYALTIES=… \
NEXT_PUBLIC_EMERGE_VAULT=0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1 NEXT_PUBLIC_OPENSEA_CHAIN=robinhood \
NEXT_PUBLIC_SITE_URL=http://localhost:3471 npx next build
EMERGE_VAULT_PRIVATE_KEY=0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d \
EMERGE_DEPOSIT_CONFIRMATIONS=1 EMERGE_RECEIPT_WAIT_MS=5000 \
EMERGE_SESSION_SECRET=this-is-a-test-secret-for-the-market-route EMERGE_CRON_SECRET=test-cron \
npx next start -p 3471

# 4. The tests. The signer stands in for the wallet extension in the browser run.
node api.test.js
node signer.js &  node browser.test.js
```

Every `NEXT_PUBLIC_*` value is baked in at build time, so a redeploy of the
contracts means a rebuild of the app. The app's in-memory store is fresh on
every start, and the node's state is fresh on every start of ganache; run
both fresh for a clean pass.

## Running it on the testnet

Point `RPC_URL` and `CHAIN_ID` (46630) at the testnet, `VAULT_KEY`,
`PLAYER_A_KEY` and `PLAYER_B_KEY` at three funded wallets, and `TOKEN_ADDRESS`
at the test token (or leave it unset and `deploy.js` deploys the stand-in);
build the app with `NEXT_PUBLIC_CHAIN_TARGET=testnet` and the `…_TESTNET`
addresses; set `SITE` to wherever it is served. `chain.js` reads all of these.
The same tests then run against the real network — the one thing a local node
cannot rehearse.

Everything here is test tooling. The keys in `chain.js` are ganache's
published development keys and control nothing anywhere real.
