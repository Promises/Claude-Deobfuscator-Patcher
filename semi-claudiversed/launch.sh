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
# Outside $HOME on purpose: Claude Code reads CLAUDE.md and .claude/CLAUDE.md in
# every ANCESTOR of the work dir, so any dir under $HOME inherits the operator's
# ~/.claude/CLAUDE.md whatever CLAUDE_CONFIG_DIR says. MEASURED 2026-10-02: a
# clean seat under ~/claudiverse-semi still obeyed its "read CLAUDE-ENV-INFO.md
# first" rule; the same seat under /Users/Shared did not.
WORKDIR="${2:-/Users/Shared/claudiverse-semi/$TITLE}"
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
    # ⛔ The binary is pinned on purpose. MEASURED 2026-10-02: a semi seat with a
    # fresh config ran the auto-updater, which took claude-semi (2.1.286) for the
    # user's install, installed 2.1.287 and repointed ~/.local/bin/claude.
    "DISABLE_AUTOUPDATER=1"
)
# Features handed to the proxy: every replaced feature with a `provides` name.
# The proxy writes those into the seat's own row (primary mode); the runtime
# reads the same list (CLAUDIVERSE_PROXY_PROVIDES) to stop duplicating them.
PROVIDES=$(python3 -c 'import json,sys; f=json.load(open(sys.argv[1]))["features"].values(); print(",".join(x["provides"] for x in f if x["state"]=="replaced" and x.get("provides")))' "$HERE/features.json")

if [ -z "${NO_PROXY_ROUTE:-}" ]; then
    HDRS="X-Claudiverse-Token: $CLAUDIVERSE_TOKEN"
    # One header per line: Claude Code splits ANTHROPIC_CUSTOM_HEADERS on newlines.
    [ -n "$PROVIDES" ] && HDRS="$HDRS"$'\n'"X-Claudiverse-Provides: $PROVIDES"
    ENVV+=(
        "ANTHROPIC_BASE_URL=${CLAUDIVERSE_URL%/}/proxy/seat/$TITLE"
        "ANTHROPIC_CUSTOM_HEADERS=$HDRS"
        "CLAUDE_CODE_GATEWAY_HINT_HEADERS=1"
        # A custom base URL turns off ToolSearch (every tool definition is sent
        # on every request: 110 vs 19 measured on 2.1.286) and the 1M picker.
        # This internal flag restores both. It does NOT restore Remote Control
        # (the binary says so). Underscore-prefixed: may vanish in any release.
        "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1"
        "CLAUDIVERSE_PROXY_PROVIDES=$PROVIDES"
    )
elif [ -n "$PROVIDES" ]; then
    echo "launch: features replaced by the proxy ($PROVIDES) need the proxy route" >&2; exit 1
fi

# 012 replaced: a POOLED seat. It holds no Anthropic credential; the proxy
# swaps the placeholder for a pool token per request and fails over itself.
# Scopes are the ones a leased token carries, or upstream treats the session as
# inference-only. A pooled seat only works through the proxy.
POOLED=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["features"]["012-failover"]["state"] != "patch")' "$HERE/features.json")
if [ "$POOLED" = True ]; then
    [ -z "${NO_PROXY_ROUTE:-}" ] || { echo "launch: 012 is replaced, so this seat needs the proxy route" >&2; exit 1; }
    ENVV+=(
        "CLAUDE_CODE_OAUTH_TOKEN=cv-pool"
        "CLAUDE_CODE_OAUTH_SCOPES=user:file_upload user:inference user:mcp_servers user:profile user:sessions:claude_code"
    )
fi

# 011 replaced: a CLEAN seat. Its own CLAUDE_CONFIG_DIR — none of the
# operator's MCP servers, hooks, plugins or global CLAUDE.md — seeded with only
# what a first run would otherwise stop and ask: onboarding done, and the work
# dir trusted (this pre-written entry is what replaces patch 011). Kept per
# seat, outside the work dir, and reused on relaunch so --resume finds its
# sessions; the trust entry is re-asserted every launch.
# A clean config has no login, so a clean seat must also be pooled.
CLEAN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["features"]["011-trust"]["state"] != "patch")' "$HERE/features.json")
if [ "$CLEAN" = True ]; then
    [ "$POOLED" = True ] || { echo "launch: 011 replaced needs 012 replaced too (a clean config has no login)" >&2; exit 1; }
    case "$(cd "$WORKDIR" && pwd -P)/" in
        "$HOME"/*) echo "launch: WARNING — $WORKDIR is under \$HOME, so the seat still reads ~/.claude/CLAUDE.md (not clean)" >&2 ;;
    esac
    CONFIG_DIR="$HOME/claudiverse-semi/.config/$TITLE"
    mkdir -p "$CONFIG_DIR"
    python3 - "$CONFIG_DIR/.claude.json" "$(cd "$WORKDIR" && pwd -P)" "$("$HERE/claude-semi" --version 2>/dev/null | awk '{print $1}')" <<'PY'
import json, os, sys
path, workdir, version = sys.argv[1:]
cfg = json.load(open(path)) if os.path.exists(path) else {}
cfg.setdefault("hasCompletedOnboarding", True)
cfg.setdefault("lastOnboardingVersion", version)
cfg.setdefault("projects", {}).setdefault(workdir, {})["hasTrustDialogAccepted"] = True
json.dump(cfg, open(path, "w"), indent=2)
PY
    ENVV+=("CLAUDE_CONFIG_DIR=$CONFIG_DIR")
else
    ENVV+=("CLAUDIVERSE_SKIP_TRUST=1")
fi

ARGS=()
for kv in "${ENVV[@]}"; do ARGS+=(-e "$kv"); done
tmux new-session -d -s "$TITLE" -x 200 -y 50 -c "$WORKDIR" "${ARGS[@]}" "$HERE/claude-semi"
[ -n "$PROVIDES" ] && echo "proxy provides: $PROVIDES (written into the seat's own row)"
[ "$CLEAN" = True ] && echo "clean seat: config in $CONFIG_DIR (trust pre-written, no operator MCP/hooks/plugins)"
[ "$POOLED" = True ] && echo "pooled seat: credentials come from the proxy (CLAUDE_CODE_OAUTH_TOKEN=cv-pool)"
echo "started $TITLE in $WORKDIR ($(head -1 "$HERE/BUILD.txt" 2>/dev/null || echo 'no BUILD.txt'))"
echo "  attach: tmux attach -t $TITLE    stop: tmux kill-session -t $TITLE"
