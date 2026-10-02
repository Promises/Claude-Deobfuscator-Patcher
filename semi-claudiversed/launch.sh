#!/usr/bin/env bash
#
# launch.sh — start a test seat on the semi-claudiversed binary, in its own
# tmux session.
#
#   ./launch.sh <title> [workdir]            through the API proxy (default)
#   NO_PROXY_ROUTE=1 ./launch.sh <title>     straight to Anthropic
#
# Needs CLAUDIVERSE_URL and CLAUDIVERSE_TOKEN in the environment. The seat gets
# the sidecar's variables (the runtime is still loaded for every feature that
# is still a patch) and, unless disabled, the proxy's:
#   ANTHROPIC_BASE_URL=$CLAUDIVERSE_URL/proxy/seat/<title>
#   ANTHROPIC_CUSTOM_HEADERS="X-Claudiverse-Token: …"
#   CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
# so the sidecar's row (<title>) and the proxy's row (proxy:<title>) record
# the same traffic.
#
# Separate from orchestrator/cv-spawn.sh on purpose: this is a test harness for
# the variant, and the fleet spawner is not changed for it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TITLE="${1:?usage: launch.sh <title> [workdir]}"
WORKDIR="${2:-$HOME/claudiverse-semi/$TITLE}"
: "${CLAUDIVERSE_URL:?CLAUDIVERSE_URL must be set}"
: "${CLAUDIVERSE_TOKEN:?CLAUDIVERSE_TOKEN must be set}"

[ -x "$HERE/claude-semi" ] || { echo "launch: no claude-semi — run ./build.sh first" >&2; exit 1; }
if tmux has-session -t "=$TITLE" 2>/dev/null; then
    echo "launch: a tmux session named $TITLE already exists" >&2; exit 1
fi
mkdir -p "$WORKDIR"

ENVV=(
    "CLAUDIVERSE_URL=$CLAUDIVERSE_URL"
    "CLAUDIVERSE_TOKEN=$CLAUDIVERSE_TOKEN"
    "CLAUDIVERSE_TITLE=$TITLE"
    "CLAUDIVERSE_SKIP_TRUST=1"
)
if [ -z "${NO_PROXY_ROUTE:-}" ]; then
    ENVV+=(
        "ANTHROPIC_BASE_URL=${CLAUDIVERSE_URL%/}/proxy/seat/$TITLE"
        "ANTHROPIC_CUSTOM_HEADERS=X-Claudiverse-Token: $CLAUDIVERSE_TOKEN"
        "CLAUDE_CODE_GATEWAY_HINT_HEADERS=1"
    )
fi

ARGS=()
for kv in "${ENVV[@]}"; do ARGS+=(-e "$kv"); done
tmux new-session -d -s "$TITLE" -x 200 -y 50 -c "$WORKDIR" "${ARGS[@]}" "$HERE/claude-semi"
echo "started $TITLE in $WORKDIR ($(head -1 "$HERE/BUILD.txt" 2>/dev/null || echo 'no BUILD.txt'))"
echo "  attach: tmux attach -t $TITLE    stop: tmux kill-session -t $TITLE"
