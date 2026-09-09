# Contracts

Everything Emerge needs on chain, what each piece does, and the order to do it
in. Four contracts and one wallet; three of the contracts are ours.

| | What | Where it comes from |
|---|---|---|
| **$EMERGE** | The token. An ordinary ERC-20. | You deploy it (or already have). |
| **EmergeLand** | The land, as tokens. An ERC-721 where the token id *is* the plot seed, with ERC-2981 royalties and marketplace metadata. | `contracts/EmergeLand.sol` |
| **EmergeRoyalties** | Where every marketplace pays the plot holders' share of a resale. Swept to the vault and booked into the dividend pool. | `contracts/EmergeRoyalties.sol` |
| **EmergeMarket** | The in-game land market: plots listed and bought for $EMERGE, the plot moving in the same transaction. | `contracts/EmergeMarket.sol` |
| **The vault** | `0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062` — a wallet, not a contract. Also the land contract's minter. | Already exists. |
| **The burn address** | `0x0000000000000000000000000000000000000000` | Nothing to deploy. |

---

## Where the money goes

Three directions, and they are deliberately different.

**Charges are burned.** Claiming a plot, surveying new land, renaming a world,
renaming a citizen, changing your own name, a pull on the gacha: every one of
them sends $EMERGE to the burn address and nothing comes back. The project takes
no cut of any of it and there is no address for one to accumulate in. The only
revenue the token carries is the trading fee on the coin itself, which this
application knows nothing about.

**Deposits are vaulted, not burned.** A deposit turns $EMERGE into Gold in a
settlement's treasury, and the same Gold can be taken back out. That is the
player's own money, so burning it would mean taking a deposit with nothing left
to return. Deposits transfer to the vault wallet.

**Payouts come out of the vault by hand.** A withdrawal or an earnings
collection cannot pay itself: the vault is a wallet, so somebody has to sign the
transfer out of it. The game therefore *queues* a request and says so on the
panel — see [The settlement queue](#the-settlement-queue). The 5% burn share is
not sent with the payout; it stays in the vault, to be burned deliberately.

---

## Deploying

### 1. The token

Any ERC-20 works. The game reads `decimals()`, `balanceOf(address)`,
`allowance(address,address)`, and asks the player to sign `transfer` and
`approve`. It never mints, never holds a key, and never has an owner role on it.

**If the token comes from a launchpad, check these five things first.** A
launchpad's default template is usually not a plain ERC-20, and three of these
will stop the game working on the day you launch rather than later:

| Feature | What it does here |
| --- | --- |
| **Fee on transfer** | Handled. Deposits are credited from the `Transfer` logs — what the vault *received* — not from the amount the calldata asked for, so a tax cannot be arbitraged by depositing and withdrawing. But every price in the game is quoted before tax, so players receive slightly less than the Bank says. Prefer zero tax, or exempt the vault. |
| **Max wallet / max holding** | **Breaks deposits.** The vault accumulates every deposit, so it will hit a max-wallet cap and start reverting. Exempt the vault address, or do not use the feature. |
| **Max transaction size** | **Breaks large claims and withdrawals.** A plot costs ~300,000 and `MAX_PAYOUT_EMERGE` is 700,000. Exempt the vault and the registry, or set the cap above both. |
| **Trading not enabled until launch** | Every transfer reverts until you switch it on. Turn it on before pointing the game at the token. |
| **Blacklist / pausable** | If the vault is ever blacklisted or the token paused, deposits and withdrawals both stop. Nothing is lost, but know who holds that switch. |

And the one that matters for the registry:

| **Reverts on transfer to `0x0`** | **Breaks every plot claim** if the registry is deployed with `burnByCall = false`. OpenZeppelin's `_transfer` does exactly this. Either deploy with `burnByCall = true` (if the token is burnable) or give `burnTo` a real address like `0x…dEaD`. |

### Pons v2, specifically

`PonsV2LauncherToken` was read at commit `845bd54`. It is a plain
`ERC20 + ERC20Burnable` with a fixed supply minted to the bonding curve, and
**no transfer hook of any kind** — no fee, no max wallet, no max transaction,
no blacklist, no pause, no trading gate, no `decimals` override. The v2 hook
(`PonsV2MemeHook`) implements only `_beforeInitialize` and `_afterSwap`, so it
touches pool swaps and never a plain transfer. The factory's `whitelistedLaunchers`
map governs who may *launch* a token, not who may move one.

Two consequences:

1. **Do not use the zero address as the burn target.** OpenZeppelin's
   `_transfer` reverts on it, which would break every charge and every claim.
2. **Use the real burn instead.** The token carries `burn(uint256)` and
   `burnFrom(address,uint256)`, so payments can be genuinely destroyed rather
   than parked. Set `NEXT_PUBLIC_TOKEN_BURNABLE=true` and deploy the registry
   with `burnByCall = true`; `totalSupply()` then actually falls, which is the
   claim a token project usually wants to be able to make.

> **One thing to check before you deploy.** Many ERC-20 implementations —
> OpenZeppelin's among them — **revert on a transfer to the zero address**. If
> yours does, every charge in the game fails with a rejected transaction. The
> game does not need a code change for this: set
> `NEXT_PUBLIC_BURN_ADDRESS` to a dead address your token will accept
> (`0x000000000000000000000000000000000000dEaD` is the usual one) and every
> burn goes there instead.

### 2. The land, as tokens

Three contracts, none with imports, so each compiles in Remix as it stands.
Deploy them in this order from the wallet that will own them.

**Compiler settings, before anything else.** Solidity 0.8.20 or later,
optimizer on (200 runs), and **EVM version `paris`** — in Remix that is the
"EVM VERSION" dropdown under Advanced Configurations. The compiler's default
target (`cancun`) emits opcodes some chains do not run yet; `paris` needs
nothing newer than the merge and is what the contract tests and the local
rehearsal below were compiled with. Gas on Robinhood Chain is paid in ETH
(the chain's own coin), so the deploying wallet and the vault both need a
little ETH, not $EMERGE.

**a. `EmergeRoyalties`** — the royalty receiver.

```solidity
constructor(address vault)   // 0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062
```

**b. `EmergeLand`** — the plots.

```solidity
constructor(string baseURI, string contractURI, address royaltyReceiver, uint96 royaltyBps)
```

- `baseURI` — `https://www.emergerh.world/api/nft/` (the trailing slash matters:
  `tokenURI(seed)` is this followed by the seed in decimal).
- `contractURI` — `https://www.emergerh.world/api/nft/collection`.
- `royaltyReceiver` — the `EmergeRoyalties` address from step a.
- `royaltyBps` — the holders' share of every resale in basis points. `500` is 5%.
  The contract refuses anything above `1000` (10%).

Then, still from the owner wallet: `setMinter(vault)`, with the vault wallet's
address, so the game can mint. Nothing else needs setting; the owner keeps
`setBaseURI`, `setContractURI`, `setRoyalty`, `setMinter`, `refreshMetadata`
and `refreshAll`.

**c. `EmergeMarket`** — the in-game market.

```solidity
constructor(address land, address token)   // EmergeLand, $EMERGE
```

It holds nothing and takes no fee of its own: a sale pays the seller and pays
the land contract's royalty to the royalty receiver, and that is all.

There is no pricing in any of these. **The game sells land the way it always
has** — a claim is paid for in $EMERGE, burned and verified against the chain
by `/api/plots` — and then the plot is minted to the buyer by the vault. One
price, computed in one place.

### 3. Point the app at the contracts

```bash
NEXT_PUBLIC_EMERGE_TOKEN=0x…        # the ERC-20
NEXT_PUBLIC_EMERGE_REGISTRY=0x…     # EmergeLand — set, and plots are tokens
NEXT_PUBLIC_EMERGE_MARKET=0x…       # EmergeMarket — set, and the land market sells on chain
NEXT_PUBLIC_EMERGE_ROYALTIES=0x…    # EmergeRoyalties — set, and the cron sweeps it
NEXT_PUBLIC_OPENSEA_CHAIN=…         # OpenSea's slug for the chain, for "View on OpenSea" links: the segment after /assets/ in any OpenSea URL for a Robinhood Chain token
NEXT_PUBLIC_ROBINHOOD_EXPLORER=…    # the chain's Blockscout, for "Verify on Robinhood Chain" links (https://…, no trailing path)
NEXT_PUBLIC_EMERGE_ROYALTY_BPS=500  # the royalty the land contract was deployed with, so the panel and the collection metadata say the same
NEXT_PUBLIC_SITE_URL=https://www.emergerh.world   # what the token metadata links back to
EMERGE_ROYALTY_TOKENS=USDG:0x…:6    # optional: other tokens royalties may arrive in, as SYMBOL:address:decimals, comma-separated
```

A testnet deployment (`NEXT_PUBLIC_CHAIN_TARGET=testnet`, chain id 46630)
reads `NEXT_PUBLIC_EMERGE_TOKEN_TESTNET`, `NEXT_PUBLIC_EMERGE_REGISTRY_TESTNET`,
`NEXT_PUBLIC_EMERGE_MARKET_TESTNET` and `NEXT_PUBLIC_EMERGE_ROYALTIES_TESTNET`
instead, so a test build can never point at the mainnet contracts by accident.

All are read at build time, so a deployment has to be rebuilt after they
change. Nothing else needs editing. The vault and burn addresses have working
defaults and only need setting to change them:

```bash
NEXT_PUBLIC_EMERGE_VAULT=0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062
NEXT_PUBLIC_BURN_ADDRESS=0x0000000000000000000000000000000000000000
```

### 4. Give the vault its key

Automatic withdrawals need the vault to be able to sign, which means the server
needs its private key:

```bash
EMERGE_VAULT_PRIVATE_KEY=0x…      # the key for NEXT_PUBLIC_EMERGE_VAULT
```

**Note the missing `NEXT_PUBLIC_` prefix.** That is what keeps the key out of
the browser bundle, and `lib/server/signer.ts` opens with `import 'server-only'`
so the build fails rather than succeeds if a client component ever imports it.
Set it as an encrypted environment variable in your host (in Vercel: Project →
Settings → Environment Variables, Production only, "Sensitive"). Never commit
it, and never give it the `NEXT_PUBLIC_` prefix even by accident.

Three things to check before this earns money:

- **The key must control the vault address.** The payout route derives the
  address from the key and refuses if it does not match
  `NEXT_PUBLIC_EMERGE_VAULT` — a mismatch would otherwise look to players like
  a game that owes them and will not pay.
- **The vault needs gas.** It signs its own transfers, so it needs the chain's
  native token. A vault with $EMERGE and no gas fails every withdrawal.
- **The vault needs $EMERGE to pay out with.** Deposits fund it, but it should
  be seeded so the first withdrawals do not wait on the first deposits.

Without the key the game still runs and still takes deposits; withdrawals are
refused with "the vault is not configured to pay out", and the Bank says so
rather than pretending.

### 5. A session secret

Every action that spends, earns or speaks for a wallet now needs that wallet to
have proved itself with one free signature. That proof is a cookie signed with:

```bash
EMERGE_SESSION_SECRET=…        # any long random string
```

If it is unset, one is derived from the vault key instead, so a deployment that
can pay people can always check them. Set it explicitly if you would rather the
two were independent — rotating it signs everybody out and nothing else.

Without either, the game refuses to pay out at all rather than paying on an
unproved say-so.

### 6. Shared storage is not optional any more

The settlement ledger lives in the shared store, so `KV_REST_API_URL` and
`KV_REST_API_TOKEN` must be set in production. On serverless each request runs
in a different instance, so a ledger in process memory would let every request
see a fresh set of daily caps — which is not a cap. Both `/api/deposits` and
`/api/payouts` refuse outright rather than half-work when the store is not
shared.

For the test network, the same two variables with a `_TESTNET` suffix, plus
`NEXT_PUBLIC_CHAIN_TARGET=testnet`.

### 7. Check it

Before the first mint, run the pre-flight from the repo with the deployment's
environment. It reads the chain and the site and writes nothing:

```bash
NEXT_PUBLIC_EMERGE_TOKEN=0x… NEXT_PUBLIC_EMERGE_REGISTRY=0x… NEXT_PUBLIC_EMERGE_MARKET=0x… \
NEXT_PUBLIC_EMERGE_ROYALTIES=0x… NEXT_PUBLIC_SITE_URL=https://www.emergerh.world \
node scripts/check-nft-chain.mjs
```

It confirms the RPC answers for chain 4663, the vault holds ETH for gas, the
token has 18 decimals, the land contract is Emerge Land with the vault as its
minter and the royalty receiver as its receiver, `baseURI` and `contractURI`
point at this site, the ERC-721/2981/4906 interfaces are declared, the market
sells this land for this token and is not paused, the royalty receiver sweeps
to the vault, and `/api/nft` on the site was built with the same addresses and
can sign. Anything that disagrees is named. Add `NEXT_PUBLIC_CHAIN_TARGET=testnet`
and the `…_TESTNET` addresses to check a testnet deployment first.

With the token set, the world map's balance comes from the wallet rather than
reading 2,000,000. With the land contract set as well, a plot's card says
*"Token #seed of Emerge Land"* with its OpenSea and explorer links, `GET
/api/nft` answers `live: true` with the minted count, and the first claim
after the deploy appears as a token in the buyer's wallet within the minute.

### Rehearsed end to end

Everything the game does with these contracts has been run against a live EVM
carrying chain id 4663 — a local node with the three contracts and an ERC-20
standing in for $EMERGE, with the app built against it and real signed
transactions on both sides. What passed, in order: a claim paid on chain and
verified by `/api/plots` (a payment short of the price refused, the same
payment refused twice); the vault minting the plot; `tokenURI`, the metadata,
the picture and `contractURI` as OpenSea reads them; release refused while the
token stands; the market refusing an unapproved listing, a listing at the
chain's price mirrored to the row and the land market; a buy below the price
refused, a buy at it paying the seller 95% and the royalty receiver 5%; the
seller unable to relist what the chain says is sold; the row following the
buyer; the sweep booking the $EMERGE royalty into the dividend pool and holding
ETH; the airdrop counting what is already minted; a wallet-to-wallet transfer
picked up by the cron door; a burn releasing the row and freeing the seed. And
in the browser, with a wallet that signs: listing from the On-Chain panel
(approval, then listing), buying from the world map (allowance, then the
purchase, then walking in), and giving the plot up (the burn, then the row).

The rehearsal is in the repo — `contracts/rehearsal/`, with its own README —
and runs against a local node in a few minutes, or against the testnet with
three funded keys.

What that rehearsal cannot prove is the real network itself — the public RPC,
the explorer's URL, OpenSea's slug for the chain — which is what the pre-flight
above and a first claim on the testnet are for.

---

## What claiming actually does

Nothing changed for the player: the plot is held for them, the price is burned
from their wallet, the burn is read off the chain by `/api/plots`, and the row
is written. Then, where the land contract is deployed:

5. the seed is queued to be minted to the buyer (`lib/server/nft.ts`), and the
   queue is drained at once and again every quarter hour by the cron;
6. the vault signs `mint(seed, buyer)` — or `mintBatch` for several — and the
   token appears in the buyer's wallet.

A claim never waits on the chain and never fails because of it: the mint is
queued, checked on chain before it goes (a seed already held by its claimant is
skipped, one held by somebody else is left to the sync), and a batch whose
reply was lost is kept in flight by its hash until the chain says one way or
the other. Nothing is minted twice.

## Turning the plots that already exist into tokens

The surprise. Once the three contracts are deployed and the app is rebuilt with
their addresses, one call mints every plot anybody holds to the wallet that
holds it:

```bash
curl -sS -X POST https://www.emergerh.world/api/nft \
  -H "Authorization: Bearer $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"airdrop":true}'
```

It reads the chain once, queues every claim row that has no token, and mints
in batches of thirty; run it again if it reports batches still waiting. It is
safe to run any number of times. `GET /api/nft` shows the count of rows, the
count minted, what is queued and what is in flight.

From then on the chain is the title. A plot sold on OpenSea, in the game's
market or wallet to wallet changes hands there, and `GET /api/nft?sync=1`
(the cron, every fifteen minutes, or the buyer's own map opening) moves the
row to the holder — with the era, the expansion, the cover and the banner the
plot has earned, and without the seller's listing, offers and hired hand. The
published settlement is re-stamped with the new owner, so the buyer walks
into the town as the seller left it. A burnt token drops its row, as giving
the plot up always did.

## What the owner of the land contract can and cannot do

**Can:** change the metadata address and the collection metadata; change the
royalty receiver and the royalty rate, up to 10%; name the minter; ask
marketplaces to re-read a plot's picture; hand ownership to somebody else.

**Cannot:** take a plot, move a plot, mint over a plot somebody holds, or touch
a single $EMERGE. There is no function for any of it. A plot leaves a wallet
only when its holder transfers it or burns it.

**The minter can:** mint a seed nobody holds, to anybody. That is the vault
key, and the only thing minting can do wrong is give a free plot away — which
is why `/api/plots` only queues a mint against a claim row it has itself
written against a verified burn.

---

## The settlement ledger

The vault signs automatically, so nothing stands between a request and a
transfer except what the server believes. This is how it decides.

Two kinds of money are owed, and they are on very different footings.

### Principal — cryptographically safe

A deposit is an on-chain transfer to the vault, so the server verifies it
against the chain rather than taking anybody's word. `POST /api/deposits`
carries only a transaction hash; the server then checks that the transaction
exists, succeeded, was a `transfer` to the vault, and **came from the wallet
claiming it**. That last check is the easy one to leave out and the one that
matters most — without it anybody could watch the chain and claim credit for
somebody else's deposit.

Each transaction hash is claimed with a set-if-absent write before it is
credited, so a replay cannot double-credit. Withdrawals debit the same counter
before the transfer is built, so **principal out can never exceed principal in.**
This half cannot be forged at all.

### Earnings — bounded, not verified

Stewardship yield is produced by the simulation, which runs in the player's
browser. No server can recompute it without running every world itself, so it
cannot be verified. It is capped instead, in three ways at once:

| Guard | Value |
| --- | --- |
| Per wallet, per UTC day | `DAILY_EARN_CEILING` — 1,000,000 $EMERGE, and its fair share of the day when everybody's judgement exceeds the vault's day |
| Must hold land | `balanceOf` on the registry must be > 0 |
| Whole vault, per UTC day | `EMERGE_DAILY_EMISSION`, default 10,000,000, shared out in proportion to judged yield |
| Any single withdrawal | `MAX_PAYOUT_EMERGE` — 700,000 |
| Smallest withdrawal | `MIN_PAYOUT_EMERGE` — 1,000 |
| Withdrawals per wallet per day | `MAX_PAYOUTS_PER_DAY` — 24, one every 20 seconds |

So the worst a dishonest client can take is what the game was going to pay an
honest one, and only after buying a plot — which burns 212,000 $EMERGE or more
per identity. Set `EMERGE_DAILY_EMISSION` to something near your real player
count once you know it; it is the backstop that stops any single day emptying
the vault.

**The land gate asks the chain where a registry is deployed, and the claim rows
where one is not — but only while the token is live.** The question it is really
asking is whether this identity paid to be here, and there are two ways to know.
With `EmergeLand` deployed, `balanceOf` answers it and nothing else is consulted.
Without it, `/api/plots` will not write a claim row until it has read the burn
off the chain itself — a real transaction, from that wallet, settled, worth at
least the plot price, and single-use — so the row is evidence of the same spend.

With no registry **and** no token, claiming costs nothing, a claim row proves
nothing, and the gate answers false. That is the case worth being strict about:
a live token with a free claim would have let every wallet in the world collect
the daily ceiling having spent nothing. Deposits and principal withdrawals never
depended on any of this.

One consequence worth knowing: rows written before the token went live were not
burn-checked, because there was nothing to check. Those wallets count as holding
land. If that matters for a given deployment, deploy the registry — the chain
then becomes the only authority again.

**The floor and the rate limits are not about the money, they are about the
gas.** Every payout is a transaction the *vault* pays for. Without a floor, a
wallet could spend its daily allowance one token at a time and make the vault
sign a hundred thousand transfers — and a collection of nine $EMERGE rounds its
five per cent burn down to nothing, so dust skipped the burn as well. Both are
closed by the same number.

### Concurrency

Every payout debits before it sends and gives the debit back if the send fails,
so the window where the same balance could be spent twice does not exist. The
signing itself is serialised by a short lock in the shared store: two
withdrawals arriving together would otherwise read the same nonce, build two
transactions on it, and the chain would keep one. Ten simultaneous withdrawals
against one balance were tested; one succeeded, nine were refused, and the
ledger landed on exactly zero.

### Proving the wallet

Before any of the above, the caller has to show the wallet is theirs. Without
that, "pay this address" is an instruction anybody can give for anybody: the
tokens would reach real players, which is not theft, and an attacker would
still be choosing when the day's budget empties and how much gas the vault
burns doing it.

So a wallet signs one plain sentence — free, not a transaction — and gets an
`HttpOnly`, `SameSite=Lax` cookie for a day. The sentence is composed by the
server and carries the host and a timestamp, so a signature harvested elsewhere
or an old one will not do. `POST /api/payouts`, `/api/gifts` and `/api/plots`
all require it, and a chat message badged with a wallet takes its author from
the session rather than the request — so the badge cannot be aimed at somebody
else's identity, which around a token is how people get robbed.

### What the vault key can and cannot do

`lib/server/signer.ts` is the only code that can move money without somebody
clicking something, and it is deliberately narrow: it sends `transfer(to,
amount)` on the configured $EMERGE contract and nothing else. It cannot mint,
approve, call an arbitrary contract, or send the chain's native token.

## Launching without the land contract

The game runs with only the token deployed. Claiming, burning, deposits and
automatic withdrawals all work; the difference is where ownership lives.

**The claim rows in the shared store become the deed.** There is no chain to
appeal to, so the route that writes them has to guarantee what
`EmergeLand.claim` used to guarantee in one transaction:

| The contract's guarantee | How it is reconstructed |
| --- | --- |
| Payment and title in one atomic step | A plot is **reserved** for its buyer before they are asked to pay, then the title is written only against a **burn read off the chain** — right payer, right amount, settled, not already spent. |
| `require(_owners[seed] == address(0))` | The row is written with `HSETNX`, so of any number of simultaneous claims exactly one wins. Verified: 1 winner of 50 concurrent writers. |
| The price the contract charges | `priceOfSeed` on the server, never the price in the request. |
| Ownership survives the client | Claims are keyed by wallet address, and the world map reads them back by address — so a player on a new device walks into their own world instead of being sold it twice. |

**What it does not reconstruct**, and should be said plainly: the deed is a row
in a database you control rather than a token in the holder's wallet. It cannot
be taken by another player, and it can be lost if the store is lost. So:

- **Back up Upstash.** Losing it is losing the deeds, not losing a cache.
- **Never raise `DATA_EPOCH` after launch.** It abandons every claim, which
  once people have paid means taking land they bought.
- Deploy `EmergeLand` when you can. Claims migrate by having each holder claim
  their seed on chain, and the relay then defers to `ownerOf` automatically.

## Selling a plot to another player

**Where plots are tokens**, a sale is a transaction on `EmergeMarket`:

1. The seller lists from the On-Chain panel. The first time, the wallet asks
   for `setApprovalForAll(market, true)` on the land contract — one signature,
   once — and then `list(seed, price)`. The plot stays in the seller's wallet.
   The registry row mirrors the chain's price so the world map shows it.
2. The buyer buys from the world map: `approve(market, price)` on $EMERGE if
   the allowance is short, then `buy(seed, price)`. Inside `buy` the listing
   is taken down, the royalty goes to `EmergeRoyalties`, the rest goes to the
   seller, and the plot moves to the buyer — all in one transaction, or none
   of it. The buyer's map then follows the chain at once.
3. A listing is only as good as the seller's holding and approval: a plot moved
   elsewhere, or an approval withdrawn, shows as not live on the board and
   `buy` refuses it.

A plot is also an ordinary ERC-721, so it sells on OpenSea or wallet to wallet
exactly the same way; the sync brings the row across within the quarter hour.
Offers through the game are off where plots are tokens: make one on OpenSea.

**Where they are not** (no land contract deployed), resale is the older
wallet-to-wallet flow: the seller lists, the buyer pays the seller directly and
the 5% fee to the vault, and `/api/plots` with `buy` verifies both transfers
and moves the row.

## Royalties, back to the holders

Every resale pays the land contract's royalty (ERC-2981) to `EmergeRoyalties`,
whichever marketplace settled it and whatever it was priced in. The cron
sweeps the receiver every quarter hour: $EMERGE goes to the vault and straight
into the holders' dividend pool, so the next weekly settlement pays it out
with the rest, in GLD, to everybody holding land. The chain's own coin or a
stablecoin also goes to the vault, is counted under its own heading
(`POST /api/nft {"royalties":true}` shows it), and is turned into $EMERGE by
hand. `POST /api/nft {"sweep":true}` runs a sweep now.

## Reading the registry without the game

The point of putting land on chain is that you do not have to ask us anything.

```solidity
ownerOf(seed)              // who holds a plot
tokenURI(seed)             // its metadata: name, picture, era, level, population
royaltyInfo(seed, price)   // who is paid on a resale, and how much
mintedCount()              // how many plots have ever been minted
registry(start, count)     // a page of (seeds, holders); a burnt plot reads as zero
tokensOf(address)          // every plot a wallet holds
balanceOf(address)         // how many
```

and on the market:

```solidity
listings(seed)             // seller, price, listedAt
listedCount()
board(start, count)        // a page of (seeds, sellers, prices, live)
```

`registry` and `board` exist so the world map can draw every plot and every
listing in one call rather than one call per plot.

## Metadata

`tokenURI(seed)` points at `/api/nft/{seed}`, which answers with the OpenSea
metadata standard: the world's name and region, a description, the picture at
`/api/nft/{seed}/image`, and attributes — biome, region, era, expanded, city
level, population, buildings, days settled, banner, when it was claimed. The
picture is an SVG drawn from the plot's own land and the owner's last
published settlement, cached ten minutes. Both are served by the app, so
changing them is a deploy, not a contract call; `refreshAll()` on the land
contract tells marketplaces to re-read.
