#!/usr/bin/env bash
#
# Put an era right by hand: a player paid for the step and it never arrived —
# the chain slow to confirm past the browser's patience, the connection gone
# between the wallet and the registry, or the write failing after the payment
# was taken. The registry marks the era on the plot's row; the player's world
# picks it up from the row the next time it polls, on every device.
#
# The gate and the charge are your judgement here. Ownership is still the
# registry's: the wallet must hold the plot.
#
# The secret is read from the environment and never written down here:
#
#   export EMERGE_CRON_SECRET='…'
#   scripts/advance-era.sh 0xWALLET 1234 2 0xTXHASH
#
# Arguments: wallet, plot seed, the era to advance TO (2 = Township, 3 =
# Industrial, 4 = Modern, 5 = AI), and the payment's transaction hash when
# you have it. Given, the hash is marked spent on this step so it cannot also
# be redeemed on account later; without it the step is simply granted.
#
# Find the seed from the public registry, no secret needed:
#
#   curl -sL https://emergerh.world/api/plots \
#     | python3 -c 'import json,sys; [print(c["seed"], c["worldName"], c.get("era", 1)) \
#         for c in json.load(sys.stdin)["claims"] if "0xWALLET".lower() in c["owner"].lower()]'
set -euo pipefail

# The bare domain redirects to www, and curl drops the Authorization header
# when a redirect crosses hosts — so every call here came back "Not for this
# door" until it was pointed at www directly.
SITE="${EMERGE_SITE:-https://www.emergerh.world}"
: "${EMERGE_CRON_SECRET:?export EMERGE_CRON_SECRET before running this}"

if [ $# -lt 3 ]; then
  echo "usage: $0 <wallet> <seed> <era> [txHash]" >&2
  exit 2
fi

WALLET="$1"; SEED="$2"; ERA="$3"; TX="${4:-}"

curl -sS -X POST "$SITE/api/plots" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $EMERGE_CRON_SECRET" \
  -d "$(printf '{"owner":"%s","seed":%s,"advance":true,"era":%s,"burnTx":"%s"}' "$WALLET" "$SEED" "$ERA" "$TX")"
echo
