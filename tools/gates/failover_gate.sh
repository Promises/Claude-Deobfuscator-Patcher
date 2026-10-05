#!/bin/bash
# Seeded-429 failover gate (012), run against the REAL binary.
#   tools/gates/failover_gate.sh <binary> <label> [preset-token]
# A mock Anthropic API (mock_anthropic.js) answers 429 to tok-personal and a
# streamed reply to anything else; the fake pool leases tok-personal and hands
# out tok-work on a rate_limited report.
# PASS: tokens=["tok-personal","tok-work"], pool rate_limited=1, answer=MOCK-OK.
# Controls, both REQUIRED for the result to mean anything (2026-10-05):
#   positive — the live claude-rel must PASS the same run;
#   negative — the stock binary with preset tok-personal must NEVER switch
#              (measured: 8x tok-personal, then timeout).
# The 2.1.286 port's harness was never committed and had to be rebuilt.
S=$(cd "$(dirname "$0")" && pwd); PR=$(cd "$S/../.." && pwd); OUT=${TMPDIR:-/tmp}
BIN=$1; LABEL=$2; PRESET=$3
P=$((40000 + RANDOM % 10000)); A=$((P + 1))
node $PR/patches.d/modules/tests/fake_pool.js $P > /dev/null & POOL=$!
node $S/mock_anthropic.js $A > /dev/null & MOCK=$!
sleep 1
H=$(mktemp -d)
env -i HOME=$H PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin TERM=dumb \
  ANTHROPIC_BASE_URL=http://127.0.0.1:$A DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  CLAUDIVERSE_URL=http://127.0.0.1:$P CLAUDIVERSE_TOKEN=test-token CLAUDIVERSE_TITLE=failover-gate \
  CLAUDIVERSE_RUNTIME=$PR/patches.d/modules/cv-runtime.mjs \
  ${PRESET:+CLAUDE_CODE_OAUTH_TOKEN=$PRESET} \
  timeout 90 "$BIN" -p "say hi" > $OUT/out-$LABEL.txt 2> $OUT/err-$LABEL.txt
RC=$?
SEEN=$(curl -s http://127.0.0.1:$A/__seen); POOLHITS=$(curl -s http://127.0.0.1:$P/__hits)
kill $POOL $MOCK 2>/dev/null; rm -rf $H
echo "[$LABEL] exit=$RC tokens=$SEEN pool=$POOLHITS answer=$(head -c 80 $OUT/out-$LABEL.txt | tr '\n' ' ')"
