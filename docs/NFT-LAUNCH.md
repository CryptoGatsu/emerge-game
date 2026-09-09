# Plots as NFTs: the mainnet launch, step by step

Everything below is Robinhood Chain mainnet, chain id 4663, gas in ETH. Nothing
here touches the testnet. Values that are already decided are written in;
the three contract addresses are what you get from deploying.

| Fact | Value |
| --- | --- |
| Chain | Robinhood Chain, id `4663`, RPC `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` (built in) |
| OpenSea | chain slug `robinhood`, so a plot is `https://opensea.io/item/robinhood/<land contract>/<seed>` (built in) |
| $EMERGE | `0x4Cd8bBfa2ED66d8f4c328e15617a2a24141219Ce` |
| Vault (mints, sweeps, already holds `EMERGE_VAULT_PRIVATE_KEY`) | `0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062` |
| Metadata | `https://www.emergerh.world/api/nft/` per plot, `…/api/nft/collection` for the collection |
| Royalty | 5% (`500` basis points) of every resale, to the holders' dividend pool |

## 1. Deploy the three contracts (Remix, one wallet, in this order)

Open each file from `contracts/` in Remix. Compiler **0.8.20 or newer**,
optimizer **on**, and under Advanced Configurations set **EVM version to
`paris`** — leave it on the default and the land contract reverts with
"invalid opcode" before it is even constructed. Deploy from the wallet you
want to own the contracts (the owner can later change the metadata URLs,
the royalty and the minter; nothing else). MetaMask on Robinhood Chain,
"Injected Provider" in Remix. Each deploy costs a little ETH.

**a. `EmergeRoyalties.sol`** — constructor argument:

```
vault_ = 0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062
```

Write down its address: **ROYALTIES**.

**b. `EmergeLand.sol`** — constructor arguments, in this order:

```
baseURI_          = https://www.emergerh.world/api/nft/        (the trailing slash matters)
contractURI_      = https://www.emergerh.world/api/nft/collection
royaltyReceiver_  = ROYALTIES                                   (from step a)
royaltyBps_       = 500
```

Write down its address: **LAND**. Then, still from the owner wallet, call
**`setMinter`** on it with `0x282f8A442E50B0dcFeDBE5693d075cb7a66E6062`.
Without this the game cannot mint: the vault is the only wallet the server
can sign with, and the contract only lets the minter mint.

**c. `EmergeMarket.sol`** — constructor arguments:

```
land_   = LAND
token_  = 0x4Cd8bBfa2ED66d8f4c328e15617a2a24141219Ce
```

Write down its address: **MARKET**.

## 2. Put the variables in Vercel and redeploy

Project → Settings → Environment Variables, Production. All three are
`NEXT_PUBLIC_` because the browser needs them too; they are read at build
time, so **redeploy after saving them**.

```
NEXT_PUBLIC_EMERGE_REGISTRY   = LAND
NEXT_PUBLIC_EMERGE_MARKET     = MARKET
NEXT_PUBLIC_EMERGE_ROYALTIES  = ROYALTIES
```

Already set and unchanged: `NEXT_PUBLIC_EMERGE_TOKEN`, `EMERGE_VAULT_PRIVATE_KEY`,
`CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`. The explorer and the OpenSea slug are
built in. Set `NEXT_PUBLIC_EMERGE_ROYALTY_BPS` only if you deployed with a
royalty other than 500.

The vault needs ETH for gas: every mint and every royalty sweep is a
transaction it signs. A few dollars' worth covers hundreds of mints.

## 3. Check before minting anything

The easiest way needs nothing installed: once the site is redeployed with
the three variables, open this in a browser or curl, with your cron secret:

```bash
curl -sS https://www.emergerh.world/api/nft?check=1 -H "Authorization: Bearer $CRON_SECRET"
```

It answers as plain text, one line per check, and ends with "Everything
agrees." or names what to fix.

The same checks also exist as a script for a computer with the repo checked
out (`git clone`, `npm install`, then this from the repo folder):

```bash
NEXT_PUBLIC_EMERGE_TOKEN=0x4Cd8bBfa2ED66d8f4c328e15617a2a24141219Ce \
NEXT_PUBLIC_EMERGE_REGISTRY=LAND NEXT_PUBLIC_EMERGE_MARKET=MARKET NEXT_PUBLIC_EMERGE_ROYALTIES=ROYALTIES \
NEXT_PUBLIC_SITE_URL=https://www.emergerh.world node scripts/check-nft-chain.mjs
```

It reads the chain and the site and writes nothing. Every line should say
`ok`: the vault is the minter, the URLs point at the site, the market sells
this land for this token, the receiver sweeps to the vault, and the site was
built with the same addresses and can sign. If a line says `FAIL`, it names
what to fix; do not go on until it is clean.

## 4. Mint every plot that already exists

One call. It reads the chain, queues every claimed plot that has no token,
and mints them to their holders thirty at a time:

```bash
curl -sS -X POST https://www.emergerh.world/api/nft \
  -H "Authorization: Bearer $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"airdrop":true}'
```

It mints up to ninety plots per call and answers with `"waiting": n` for
what is still queued; **run it again until `waiting` is 0.** It is safe any
number of times, a plot already minted is skipped, and the cron drains the
same queue every fifteen minutes anyway. `GET
https://www.emergerh.world/api/nft` shows rows, minted count, queue and
anything in flight.

That is the launch. Players open their plot and see "Token #seed of Emerge
Land" with the OpenSea and explorer links; the token is in their wallet.

## What is priced in what

- **The in-game land market is priced in $EMERGE.** `EmergeMarket` only
  takes $EMERGE: a buyer approves the price, the contract pays the seller
  95% and the royalty receiver 5%, and the plot moves, in one transaction.
- **OpenSea is priced in USDG.** OpenSea does not offer $EMERGE as a payment
  token on Robinhood Chain, so the collection is listed and bought in USDG
  there. Add USDG in the collection's payment-token settings once you have
  claimed the page. Sellers may also see the chain's own coin (ETH) and
  wrapped ETH offered; whichever a buyer pays in, OpenSea pays the same 5%
  to the same royalty receiver, because it reads the rate from the contract
  (ERC-2981).
- **Royalties in $EMERGE go straight into the dividend pool** when the cron
  sweeps the receiver, every fifteen minutes.
- **Royalties in anything else — USDG, ETH, wrapped ETH — are swept to the
  vault and held**, counted under their own heading, until they are turned
  into $EMERGE by hand and added to the pool. Gold never becomes tokens;
  this is the other direction, and it is a deliberate manual step so the
  vault never swaps unattended.

The server watches USDG without being told: it reads the stepping-stone
token out of `EMERGE_SWAP_PATH`, which the GLD dividend swap already sets.
Wrapped ETH is built in. Anything else is named in `EMERGE_ROYALTY_TOKENS`
as `SYMBOL:address:decimals`. Each token's decimals are read from the token
itself rather than trusted from that setting, so a stablecoin can never be
counted as if it had eighteen.

### What is waiting, and turning it into $EMERGE

```bash
curl -sS -X POST https://www.emergerh.world/api/nft \
  -H "Authorization: Bearer $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"royalties":true}'
```

`held` is what the vault is holding for the holders and has not yet converted,
per token; `swept` is every sweep so far. To convert: sell the held USDG for
$EMERGE from the vault wallet, then add the proceeds to the pool. Do it when
the amount is worth the trade, not on a schedule.

## Does the collection start by itself?

Yes. One contract is one collection on OpenSea and on Blockscout: **every
token the land contract ever mints is in it**, now and later, because the
collection *is* the contract. There is nothing to register. OpenSea picks the
contract up from its first `Transfer` event — the first mint — and reads the
name, description, image and royalty from `contractURI()` and each plot's
picture and attributes from `tokenURI()`. It can take OpenSea a few minutes
to index a new contract after the first mint. Once it shows, connect the
owner wallet on OpenSea to claim the collection page and edit its banner
and links; the on-chain royalty is already there.

Future plots are minted the moment they are claimed: the claim is paid and
verified as it always was, the row is written, and the server queues a mint
to the buyer and sends it straight away from the vault. If the chain is slow
or the vault is briefly out of gas, the queue keeps the mint and the cron
(`/api/nft?sync=1`, every fifteen minutes) sends it on the next pass; nothing
is lost and nothing mints twice. So the three things that keep the collection
complete are: `NEXT_PUBLIC_EMERGE_REGISTRY` set to the one land contract,
the vault named as its minter, and the vault holding a little ETH.

## Changing the picture later

The metadata and the picture are served by the site, not stored on chain, so
a new picture is a deploy of the site. Each plot's picture is already drawn
from its own land and the owner's last published settlement. After a change
that should show everywhere at once, call `refreshAll()` on the land contract
from the owner wallet; it emits the ERC-4906 signal that tells OpenSea to
re-read every token.
