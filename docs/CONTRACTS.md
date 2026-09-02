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

### 3. Point the app at them

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

For the test network, the same two variables with a `_TESTNET` suffix, plus
`NEXT_PUBLIC_CHAIN_TARGET=testnet`.

### 4. Check it

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

## The settlement queue

`/api/payouts` holds requests to be paid out of the vault. A row records the
address, the amount, the world it came from, and the burn share left behind; it
is marked settled with the transaction hash that paid it.

**It is a queue of requests, not a balance.** The ledger a request is computed
from lives in the player's browser, so a forged request is a POST anybody can
write. That is why it is reviewed before it is paid rather than paid
automatically, why the server recomputes the amounts from the Gold rather than
believing them, and why a single request is capped. A person reads the queue.

The honest fix is a vault contract that holds the tokens and enforces its own
accounting — earnings signed by a key the game controls, or a Merkle root
published per epoch and claimed by each player. That is a larger piece of work
than this round, and until it exists no surface in the game says a payout has
arrived before it has.

---

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
