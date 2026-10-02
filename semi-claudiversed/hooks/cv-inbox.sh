#!/bin/sh
#
# cv-inbox.sh <server-url> <seat> — the seat's inbox, as an asyncRewake hook.
# Replaces 003's prompt delivery on semi seats without touching the binary.
#
# Run in the background on SessionStart, UserPromptSubmit and Stop. It
# long-polls GET /api/seats/<seat>/inbox for the seat's next prompt. On one, it
# prints the prompt to stderr and exits 2: Claude Code then wakes the seat with
# it, idle or not (measured on stock 2.1.286). The server keeps only the newest
# poll per seat; an older one is answered 409 and exits quietly.
#
# Needs CLAUDIVERSE_TOKEN in the environment (launch.sh sets it).

# The hook's JSON input names the event that started this poller. The live
# poller is always the newest, so its event is the seat's latest transition:
# SessionStart/Stop = it just went idle, UserPromptSubmit = it just went busy.
# The server uses that to recover readiness after a restart wipes it.
EVENT=$(python3 -c 'import json, sys
try: print(json.load(sys.stdin).get("hook_event_name", ""))
except Exception: print("")' 2>/dev/null)

URL=${1%/}
TITLE=$2
SEAT=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$2")
[ -n "$URL" ] && [ -n "$SEAT" ] && [ -n "$CLAUDIVERSE_TOKEN" ] || exit 0
[ -n "${CV_INBOX_LOG:-}" ] && echo "$(date -u +%H:%M:%S) start event=$EVENT" >> "$CV_INBOX_LOG"

# Where this seat runs and how it was started (the app's machine picker,
# fleet grouping and runner filter) — a seat with no sidecar reports it here.
PLACE=$(python3 -c 'import os, socket, urllib.parse
q = {"host": os.environ.get("CLAUDIVERSE_HOST") or socket.gethostname(),
     "fleet": os.environ.get("CLAUDIVERSE_FLEET", ""),
     "origin": os.environ.get("CLAUDIVERSE_ORIGIN", "manual"),
     "notify": "1" if os.environ.get("CLAUDIVERSE_NOTIFY") == "1" else "0"}
print(urllib.parse.urlencode({k: v for k, v in q.items() if v}))' 2>/dev/null)

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

while :; do
    # 55 s, not longer: for a seat with no sidecar this poll is also its
    # heartbeat — the server reads the seat as connected while one is open, and
    # stops its session when none has been for about three minutes.
    CODE=$(curl -sS -o "$BODY" -w '%{http_code}' -m 70 \
        -H "Authorization: Bearer $CLAUDIVERSE_TOKEN" \
        "$URL/api/seats/$SEAT/inbox?wait=55&event=$EVENT&$PLACE" 2>/dev/null) || CODE=000
    [ -n "${CV_INBOX_LOG:-}" ] && echo "$(date -u +%H:%M:%S) poll event=$EVENT -> $CODE" >> "$CV_INBOX_LOG"
    case "$CODE" in
        200) cat "$BODY" >&2; exit 2 ;;       # a prompt: wake the seat with it
        204) ;;                                # nothing yet: poll again
        205) # interrupt: press Escape in this seat's own pane, like the
             # operator would. TMUX_PANE is inherited from Claude Code's pane;
             # launch.sh names the tmux session after the seat as a fallback.
             tmux send-keys -t "${TMUX_PANE:-=$TITLE}" Escape 2>/dev/null
             # An interrupted turn fires no Stop hook, so this poller stays
             # the newest one: it must now say "idle", not the busy event it
             # was started with, or a server restart reads the seat as busy.
             EVENT=Stop
             [ -n "${CV_INBOX_LOG:-}" ] && echo "$(date -u +%H:%M:%S) interrupt -> Escape to ${TMUX_PANE:-=$TITLE}" >> "$CV_INBOX_LOG" ;;
        409) exit 0 ;;                         # a newer poll took over
        401|403|404) exit 0 ;;                 # misconfigured: stop, don't hammer
        *) sleep 5 ;;                          # server unreachable (e.g. a swap)
    esac
done
