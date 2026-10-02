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

cat >/dev/null 2>&1    # the hook's JSON input; nothing in it is needed here

URL=${1%/}
SEAT=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$2")
[ -n "$URL" ] && [ -n "$SEAT" ] && [ -n "$CLAUDIVERSE_TOKEN" ] || exit 0

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

while :; do
    CODE=$(curl -sS -o "$BODY" -w '%{http_code}' -m 3660 \
        -H "Authorization: Bearer $CLAUDIVERSE_TOKEN" \
        "$URL/api/seats/$SEAT/inbox?wait=3600" 2>/dev/null) || CODE=000
    case "$CODE" in
        200) cat "$BODY" >&2; exit 2 ;;       # a prompt: wake the seat with it
        204) ;;                                # nothing yet: poll again
        409) exit 0 ;;                         # a newer poll took over
        401|403|404) exit 0 ;;                 # misconfigured: stop, don't hammer
        *) sleep 5 ;;                          # server unreachable (e.g. a swap)
    esac
done
