#!/usr/bin/env bash
#
# Hand in a Gold purchase that was paid for but never settled.
#
# For payments made before the exchange kept its own record of them: the
# $EMERGE left the buyer's wallet, the seller received it, and the Gold was
# never handed over. Give this the buyer's wallet, the plot the Gold should go
# to, the order they were buying, how much Gold, and the transaction hash from
# their wallet history.
#
# Nothing is taken on trust. The transfer is read off the chain and has to be a
# real one, from that buyer to that order's seller, for that price, and not
# already spent. If it is, the trade completes properly: the seller's order is
# decremented, the Gold is owed to the buyer's plot, the fee is burned, and it
# appears in both players' History.
#
#   export EMERGE_CRON_SECRET='…'
#   scripts/settle-payment.sh 0xBUYER 1234 <orderId> 20000 0xTXHASH
#
set -euo pipefail

SITE="${EMERGE_SITE:-https://emergerh.world}"
: "${EMERGE_CRON_SECRET:?export EMERGE_CRON_SECRET before running this}"

if [ $# -lt 5 ]; then
  echo "usage: $0 <buyer-wallet> <seed> <order-id> <gold> <txhash>" >&2
  exit 2
fi

curl -sS -X POST "$SITE/api/exchange" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EMERGE_CRON_SECRET" \
  -d "$(printf '{"action":"recoverPaid","address":"%s","seed":%s,"id":"%s","qty":%s,"txHash":"%s"}' \
        "$1" "$2" "$3" "$4" "$5")"
echo
