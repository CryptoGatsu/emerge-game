#!/usr/bin/env bash
#
# Put Gold right by hand, for the one case the machinery cannot fix itself:
# a player paid a seller on chain and the settlement never completed, so the
# seller holds the $EMERGE and the buyer holds nothing.
#
# The Gold is owed to the player's plot like any other delivery, so it arrives
# the next time they open that world and cannot be taken twice.
#
# The secret is read from the environment and never written down here. Export
# it in your shell, or put it in a file only you can read and source that:
#
#   export EMERGE_CRON_SECRET='…'
#   scripts/make-good.sh 0xWALLET 1234 20000 "Gold for the purchase that did not settle"
#
# Arguments: wallet, plot seed, whole Gold, and an optional note for the feed.
set -euo pipefail

SITE="${EMERGE_SITE:-https://emergerh.world}"
: "${EMERGE_CRON_SECRET:?export EMERGE_CRON_SECRET before running this}"

if [ $# -lt 3 ]; then
  echo "usage: $0 <wallet> <seed> <gold> [note]" >&2
  exit 2
fi

WALLET="$1"; SEED="$2"; GOLD="$3"; NOTE="${4:-Gold put right by the team}"

curl -sS -X POST "$SITE/api/exchange" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EMERGE_CRON_SECRET" \
  -d "$(printf '{"action":"makeGood","address":"%s","seed":%s,"gold":%s,"note":%s}' \
        "$WALLET" "$SEED" "$GOLD" "$(printf '%s' "$NOTE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
echo
