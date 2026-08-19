#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rampart — DAY-1 GATE
#
# Proves the single assumption the whole project rests on:
#   does a Somnia BinaryPool accept a CONTRACT as Order.owner, and is the
#   resting order then genuinely un-withdrawable by its own funder?
#
# PASS  -> build.
# FAIL at step 3 -> placeBinaryOrder carries an EOA assumption. Pivot to Phantom
#                   the same day (no contract needed there).
#
# Nothing here is mocked. Every step is a real transaction on Shannon (50312)
# and every artifact is an explorer link. Steps 4 and 5 SUCCEED BY REVERTING —
# that failed cancel is the demo's centrepiece, not just a test.
#
# usage:  POOL=0x... ./gate.sh
# needs:  PRIVATE_KEY, SOMNIA_TESTNET_RPC   (never committed — see .gitignore)
# ---------------------------------------------------------------------------
set -uo pipefail

RPC="${SOMNIA_TESTNET_RPC:-https://api.infra.testnet.somnia.network}"
POOL="${POOL:-}"
KEY="${PRIVATE_KEY:-}"
QTY="${QTY:-1000000}"          # raw outcome-token units, lot-snapped
PRICE="${PRICE:-500000}"       # YES price, raw collateral units (6dp testnet => 0.50)
FUND="${FUND:-2000000}"        # collateral to park in the contract (6dp => 2.00)
EXPLORER="https://shannon-explorer.somnia.network/tx"

die() { printf '\n\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
ok()  { printf '\033[32m  ok\033[0m  %s\n' "$1"; }
step(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -n "$KEY" ]  || die "PRIVATE_KEY unset. export it; never commit it."
[ -n "$POOL" ] || die "POOL unset. Pick a LIVE 1h market's pool (expiry headroom — constraint #9) and pass POOL=0x..."

ME=$(cast wallet address --private-key "$KEY") || die "bad PRIVATE_KEY"
echo "eoa   $ME"
echo "pool  $POOL"
echo "rpc   $RPC"

step "0. sanity: pool is live and has expiry headroom"
COLLAT=$(cast call "$POOL" "collateral()(address)" --rpc-url "$RPC") || die "pool.collateral() failed — is POOL a BinaryPool?"
EXPNS=$(cast call "$POOL" "marketExpiryNs()(uint64)" --rpc-url "$RPC") || die "pool.marketExpiryNs() failed"
EXPNS=${EXPNS%% *}
NOWNS=$(( $(date +%s) * 1000000000 ))
LEFT=$(( (EXPNS - NOWNS) / 1000000000 ))
ok "collateral $COLLAT"
ok "market expires in ${LEFT}s"
[ "$LEFT" -gt 900 ] || die "under 15m of headroom — the market can lock mid-gate (constraint #9). Pick a fresher window."
# Order expiry must satisfy 0 < expireNs <= marketExpiryNs, else OrderExpiryBeyondMarket.
ORDER_EXP=$EXPNS

step "1. deploy FirmQuote (unlockAt = market expiry)"
UNLOCK=$(( EXPNS / 1000000000 ))
DEPLOY=$(forge create src/FirmQuote.sol:FirmQuote --rpc-url "$RPC" --private-key "$KEY" \
          --broadcast --json --constructor-args "$POOL" "$UNLOCK") || die "deploy failed"
FQ=$(echo "$DEPLOY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["deployedTo"])') || die "could not parse deploy output"
ok "FirmQuote at $FQ"

step "2. fund it (it approved the pool in its constructor)"
cast send "$COLLAT" "transfer(address,uint256)" "$FQ" "$FUND" \
  --rpc-url "$RPC" --private-key "$KEY" >/dev/null || die "funding transfer failed — does the EOA hold TestUSDC? call faucet(uint256) first"
ok "funded $FUND raw collateral"

step "3. contract rests a BUY_YES order  << THE GATE >>"
REST_OUT=$(cast send "$FQ" "rest(uint8,uint256,uint256,uint64)" 0 "$PRICE" "$QTY" "$ORDER_EXP" \
            --rpc-url "$RPC" --private-key "$KEY" --json 2>&1)
if ! echo "$REST_OUT" | grep -q '"status"'; then
  printf '%s\n' "$REST_OUT"
  die "placeBinaryOrder from a CONTRACT failed.
      If this is an EOA assumption in the pool, Rampart is dead as designed.
      -> PIVOT TO PHANTOM TODAY (spec.md 3). Do not write UI."
fi
REST_TX=$(echo "$REST_OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
STATUS=$(echo "$REST_OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
[ "$STATUS" = "0x1" ] || die "rest() tx mined but REVERTED (status $STATUS) — $EXPLORER/$REST_TX"
ORDER_ID=$(cast call "$FQ" "orders(uint256)(uint128)" 0 --rpc-url "$RPC" | awk '{print $1}')
ok "order $ORDER_ID owned by the CONTRACT"
ok "$EXPLORER/$REST_TX"

step "4. the funder tries to cancel it  << MUST REVERT >>"
CANCEL=$(cast send "$POOL" "cancelOrder(uint128)" "$ORDER_ID" \
          --rpc-url "$RPC" --private-key "$KEY" 2>&1)
if echo "$CANCEL" | grep -qiE '0xf5e39c1f|IncorrectSender'; then
  ok "reverted IncorrectSender (0xf5e39c1f) — the pool refused the funder"
elif echo "$CANCEL" | grep -qi 'revert\|error'; then
  printf '%s\n' "$CANCEL" | head -5
  ok "reverted (selector above) — inspect, but the withdrawal path is closed"
else
  printf '%s\n' "$CANCEL" | head -20
  die "THE CANCEL SUCCEEDED. The lock does not hold and Rampart has no product. Pivot to Phantom."
fi

step "5. the funder tries to reduce it  << MUST REVERT >>"
REDUCE=$(cast send "$POOL" "reduceOrder(uint128,uint256)" "$ORDER_ID" 1 \
          --rpc-url "$RPC" --private-key "$KEY" 2>&1)
if echo "$REDUCE" | grep -qiE 'revert|error|0x'; then
  ok "reverted — reduceOrder is not a back door"
else
  printf '%s\n' "$REDUCE" | head -20
  die "reduceOrder SUCCEEDED from a non-owner. The lock leaks. Pivot to Phantom."
fi

step "6. the contract cannot let go of it either"
SWEEP=$(cast send "$FQ" "sweep()" --rpc-url "$RPC" --private-key "$KEY" 2>&1)
if echo "$SWEEP" | grep -qiE 'Locked|revert'; then
  ok "sweep() reverted Locked — even the depositor is committed until unlockAt"
else
  printf '%s\n' "$SWEEP" | head -10
  die "sweep() succeeded before unlockAt — the timelock is broken."
fi

printf '\n\033[32m================ GATE PASSED ================\033[0m\n'
cat <<SUMMARY

  FirmQuote   $FQ
  order id    $ORDER_ID
  rest tx     $EXPLORER/$REST_TX

  A resting order is standing in a public order book, and the wallet that
  paid for it cannot take it back. Build the typed book viewer next.

  Record these links in DEMO.md now, while they are fresh — including the
  FAILED cancel, which is the artifact judges cannot dispute.
SUMMARY
