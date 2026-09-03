# Contracts

Everything Emerge needs on chain, what each piece does, and the order to do it
in. There are two contracts and one wallet, and only one of them is ours.

| | What | Where it comes from |
|---|---|---|
| **$EMERGE** | The token. An ordinary ERC-20. | You deploy it (or already have). |
| **EmergeLand** | The land registry. An ERC-721 where the token id *is* the plot seed. | `contracts/EmergeLand.sol` |
| **The vault** | `0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062` — a wallet, not a contract. | Already exists. |
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

### 2. The land registry

`contracts/EmergeLand.sol` has no imports, so it compiles in Remix as it stands.
Constructor:

```solidity
constructor(address tokenAddress, address burnTo)
```

- `tokenAddress` — the $EMERGE contract from step 1.
- `burnTo` — the burn address. The same value you put in
  `NEXT_PUBLIC_BURN_ADDRESS`, or the zero address if you did not set one.

It deploys with the game's own pricing already in it:

```
basePrice   = 180
priceScale  = 800 × 10¹⁸
premiums    = valley 190, woodland 120, highland 165, wetland 110, steppe 95,
              coast 130, desert 85, swamp 100, grassland 175
```

so `priceOf(seed) = (180 + premium[biome(seed)]) × 800 $EMERGE`, which is
212,000 for desert up to 296,000 for a river valley. `biomeOf(seed)` is a
Solidity port of the game's own `biomeKindFor`, verified to agree with it across
5,030 seeds.

> **The one deliberate difference.** The game's in-browser price also adds a
> component for a plot's population and trade count. That needs the world
> generator, which cannot run on chain — so the contract prices from the biome
> alone, and **the game reads the price it displays from the contract** whenever
> one is deployed. The number on the button is always the number the transaction
> enforces.

### 3. Point the app at the contracts

```bash
NEXT_PUBLIC_EMERGE_TOKEN=0x…      # the ERC-20
NEXT_PUBLIC_EMERGE_REGISTRY=0x…   # EmergeLand
```

Both are read at build time, so a deployment has to be rebuilt after they
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

With the token set, the world map's balance comes from the wallet rather than
reading 2,000,000, and the plot price comes from the contract. With the registry
set as well, the claim panel says *"This is real ownership"* and names the token
id, and claiming asks for two signatures instead of one.

---

## What claiming actually does

```
approve(registry, price)        →  the token contract
claim(seed, worldName, price)   →  EmergeLand
```

Two signatures, and the player is told that before the first one. The approval
is for exactly this claim's price rather than an unlimited allowance: an
unlimited allowance is a standing permission to drain a wallet, and there is no
reason to ask for one here.

Inside `claim`, the contract:

1. refuses if the seed is already held;
2. refuses if `price > maxPrice` — so a pricing change between the quote and the
   signature reverts rather than quietly charging more;
3. `transferFrom`s the price straight to the burn address, and reverts if that
   fails;
4. mints token `seed` to the caller and records the world's name.

There is no moment in that sequence where a player has paid and does not own the
land.

## What the owner of the registry can and cannot do

**Can:** change `basePrice`, `priceScale` and any biome premium; change the burn
address; hand ownership to somebody else.

**Cannot:** take a plot, move a plot, mint a plot to anybody, or touch a single
$EMERGE. There is no function for any of it. A plot leaves a wallet only when
its holder transfers it or calls `release`, which burns the token and puts the
seed back on the market.

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
| Per wallet, per UTC day | `DAILY_EARN_CEILING` — 100,000 $EMERGE |
| Must hold land | `balanceOf` on the registry must be > 0 |
| Whole vault, per UTC day | `EMERGE_DAILY_EMISSION`, default 1,000,000 |
| Any single withdrawal | `MAX_PAYOUT_EMERGE` — 700,000 |
| Smallest withdrawal | `MIN_PAYOUT_EMERGE` — 1,000 |
| Withdrawals per wallet per day | `MAX_PAYOUTS_PER_DAY` — 24, one every 20 seconds |

So the worst a dishonest client can take is what the game was going to pay an
honest one, and only after buying a plot — which burns 212,000 $EMERGE or more
per identity. Set `EMERGE_DAILY_EMISSION` to something near your real player
count once you know it; it is the backstop that stops any single day emptying
the vault.

**The land gate answers false when no registry is deployed, and stewardship is
not paid at all.** It used to answer true, on the reasoning that there was no
on-chain fact to check — which was backwards: a live token with no registry
would have let every wallet in the world collect the daily ceiling having spent
nothing. Deposits and principal withdrawals work without a registry; only
earnings wait for it.

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

## Reading the registry without the game

The point of putting land on chain is that you do not have to ask us anything.

```solidity
ownerOf(seed)              // who holds a plot
worldName(seed)            // what they called it
priceOf(seed)              // what an unclaimed plot costs
claimedCount()             // how many plots exist
registry(start, count)     // a page of (seeds, owners, names)
balanceOf(address)         // how many plots a wallet holds
```

`registry` exists so the world map can draw every plot anybody holds in one call
rather than one call per plot.
