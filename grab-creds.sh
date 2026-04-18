#!/bin/bash
# Dumps the current logged-in account's credentials and config to a JSON file.
# Run once per account, giving each a label.
#
# Usage:
#   ./grab-creds.sh login <label> [priority]  Login, capture creds, restore original (all-in-one)
#   ./grab-creds.sh dump <label> [priority]  Dump current account (priority: lower = tried first, default 99)
#   ./grab-creds.sh build                    Build registry from all dumped accounts
#   ./grab-creds.sh list                     List dumped account files

set -e

CMD="${1:-help}"
LABEL="${2}"
PRIORITY="${3:-99}"

KEYCHAIN_SERVICE="Claude Code-credentials"
KEYCHAIN_ACCOUNT="$(whoami)"
BACKUP_DIR="/tmp/claude-creds-backup"

case "$CMD" in
  login)
    if [ -z "$LABEL" ]; then
      echo "Usage: ./grab-creds.sh login <label> [priority]"
      echo "Example: ./grab-creds.sh login team 2"
      exit 1
    fi

    echo "=== Login & capture: $LABEL (priority: $PRIORITY) ==="

    # 1. Back up current keychain entry
    mkdir -p "$BACKUP_DIR"
    EXISTING_KEYCHAIN=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || echo "")
    if [ -n "$EXISTING_KEYCHAIN" ]; then
      echo "$EXISTING_KEYCHAIN" > "$BACKUP_DIR/keychain.bak"
      echo "  Backed up keychain entry"
    fi

    # 2. Back up oauthAccount from config
    python3 -c "
import json, os
config_path = os.path.expanduser('~/.claude.json')
with open(config_path) as f:
    config = json.load(f)
backup = config.get('oauthAccount', {})
with open('$BACKUP_DIR/oauthAccount.json', 'w') as f:
    json.dump(backup, f)
"
    echo "  Backed up oauthAccount config"

    # 3. Clear keychain so Claude sees no auth
    security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" 2>/dev/null || true
    echo "  Cleared keychain (login will prompt fresh auth)"

    # 4. Run claude auth login
    echo ""
    echo ">>> Starting claude auth login..."
    echo ">>> Complete the login in your browser, then it will continue automatically."
    echo ""
    claude auth login
    LOGIN_EXIT=$?

    if [ $LOGIN_EXIT -ne 0 ]; then
      echo "Login failed (exit $LOGIN_EXIT). Restoring backup..."
      # Restore keychain
      if [ -f "$BACKUP_DIR/keychain.bak" ]; then
        security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$(cat "$BACKUP_DIR/keychain.bak")" -U 2>/dev/null
      fi
      exit 1
    fi

    echo ""
    echo ">>> Login successful. Dumping credentials..."

    # 5. Dump the new creds (reuses dump logic via self-call)
    "$0" dump "$LABEL" "$PRIORITY"

    # 6. Restore original keychain + config
    echo ""
    echo ">>> Restoring original credentials..."
    security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" 2>/dev/null || true
    if [ -f "$BACKUP_DIR/keychain.bak" ]; then
      security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$(cat "$BACKUP_DIR/keychain.bak")" -U 2>/dev/null
      echo "  Restored keychain"
    fi

    # Restore oauthAccount in config
    python3 -c "
import json, os
config_path = os.path.expanduser('~/.claude.json')
with open(config_path) as f:
    config = json.load(f)
with open('$BACKUP_DIR/oauthAccount.json') as f:
    config['oauthAccount'] = json.load(f)
with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
"
    echo "  Restored oauthAccount config"

    # Cleanup
    rm -rf "$BACKUP_DIR"
    echo ""
    echo "=== Done! Captured $LABEL, original session intact ==="
    ;;

  dump)
    if [ -z "$LABEL" ]; then
      echo "Usage: ./grab-creds.sh dump <label> [priority]"
      echo "Example: ./grab-creds.sh dump team 2"
      exit 1
    fi

    OUTFILE="/tmp/claude-account-${LABEL}.json"

    # Read keychain
    KEYCHAIN_DATA=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || \
                    security find-generic-password -s "Claude Code" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null || echo "")

    # Read config
    python3 - "$LABEL" "$KEYCHAIN_DATA" "$OUTFILE" "$PRIORITY" << 'PYEOF'
import json, sys, os

label = sys.argv[1]
keychain_raw = sys.argv[2]
outfile = sys.argv[3]
priority = int(sys.argv[4]) if len(sys.argv) > 4 else 99
config_path = os.path.expanduser("~/.claude.json")

with open(config_path) as f:
    config = json.load(f)

account_info = config.get("oauthAccount", {})

# Parse keychain data
keychain = {}
if keychain_raw:
    try:
        keychain = json.loads(keychain_raw)
    except json.JSONDecodeError:
        # Raw API key (not JSON)
        keychain = {"apiKey": keychain_raw}

oauth_tokens = keychain.get("claudeAiOauth", {})

dump = {
    "label": label,
    "priority": priority,
    "accountInfo": {
        "accountUuid": account_info.get("accountUuid"),
        "emailAddress": account_info.get("emailAddress"),
        "organizationUuid": account_info.get("organizationUuid"),
        "organizationRole": account_info.get("organizationRole"),
        "organizationName": account_info.get("organizationName"),
    },
    "credentials": {
        "accessToken": oauth_tokens.get("accessToken"),
        "refreshToken": oauth_tokens.get("refreshToken"),
        "expiresAt": oauth_tokens.get("expiresAt"),
        "scopes": oauth_tokens.get("scopes"),
        "subscriptionType": oauth_tokens.get("subscriptionType"),
        "rateLimitTier": oauth_tokens.get("rateLimitTier"),
    },
    "apiKey": keychain.get("apiKey"),
    "keychainRaw": keychain_raw[:50] + "..." if len(keychain_raw) > 50 else keychain_raw,
}

with open(outfile, "w") as f:
    json.dump(dump, f, indent=2)
    f.write("\n")

email = dump["accountInfo"].get("emailAddress", "?")
sub = dump["credentials"].get("subscriptionType", "?")
has_oauth = bool(dump["credentials"].get("accessToken"))
has_key = bool(dump.get("apiKey"))
print(f"Dumped: {outfile}")
print(f"  Label: {label}")
print(f"  Email: {email}")
print(f"  Subscription: {sub}")
print(f"  Has OAuth tokens: {has_oauth}")
print(f"  Has API key: {has_key}")
PYEOF
    ;;

  build)
    # Find all dump files and build registry
    python3 << 'PYEOF'
import json, uuid, os, glob

config_path = os.path.expanduser("~/.claude.json")
dump_files = sorted(glob.glob("/tmp/claude-account-*.json"))

if not dump_files:
    print("No account dumps found. Run './grab-creds.sh dump <label>' first.")
    exit(1)

print(f"Found {len(dump_files)} account dump(s):")
dumps = []
for f in dump_files:
    with open(f) as fh:
        d = json.load(fh)
        dumps.append(d)
        print(f"  {d['label']}: {d['accountInfo'].get('emailAddress', '?')} ({d['credentials'].get('subscriptionType', '?')})")

with open(config_path) as f:
    config = json.load(f)

accounts = []
account_credentials = {}

for d in dumps:
    aid = str(uuid.uuid4())
    has_oauth = bool(d["credentials"].get("accessToken"))
    has_key = bool(d.get("apiKey"))

    entry = {
        "id": aid,
        "label": d["label"],
        "type": "oauth" if has_oauth else "api-key",
        "priority": d.get("priority", 99),
        "accountUuid": d["accountInfo"].get("accountUuid"),
        "emailAddress": d["accountInfo"].get("emailAddress"),
        "organizationUuid": d["accountInfo"].get("organizationUuid"),
    }
    if has_key and not has_oauth:
        entry["apiKeyPrefix"] = d["apiKey"][:12]

    accounts.append(entry)

    # Store credentials
    creds = {}
    if has_oauth:
        creds = {
            "accessToken": d["credentials"]["accessToken"],
            "refreshToken": d["credentials"]["refreshToken"],
            "expiresAt": d["credentials"]["expiresAt"],
            "scopes": d["credentials"]["scopes"],
            "subscriptionType": d["credentials"]["subscriptionType"],
            "rateLimitTier": d["credentials"]["rateLimitTier"],
        }
    if has_key:
        creds["apiKey"] = d["apiKey"]
    account_credentials[aid] = creds

# Sort by priority (lower = higher priority), first is primary
accounts.sort(key=lambda a: a["priority"])
registry = {
    "version": 1,
    "primaryAccountId": accounts[0]["id"],
    "accounts": accounts,
}

config["accountRegistry"] = registry
config["accountCredentials"] = account_credentials

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")

print()
print("=== Registry built ===")
for a in accounts:
    primary = " [PRIMARY]" if a["id"] == registry["primaryAccountId"] else ""
    print(f"  {a['label']}{primary} — {a['type']} ({a.get('emailAddress', '?')})")
print()
print("Done! All credentials stored in ~/.claude.json accountCredentials.")
PYEOF
    ;;

  list)
    echo "Dumped account files:"
    ls -1 /tmp/claude-account-*.json 2>/dev/null || echo "  (none found)"
    ;;

  *)
    echo "Usage:"
    echo "  ./grab-creds.sh login <label> [priority]  Login & capture (backs up + restores current session)"
    echo "  ./grab-creds.sh dump <label> [priority]   Dump current login to /tmp/claude-account-<label>.json"
    echo "  ./grab-creds.sh build                     Build registry (sorted by priority, first = primary)"
    echo "  ./grab-creds.sh list                      List dumped files"
    echo ""
    echo "Workflow:"
    echo "  1. ./grab-creds.sh login pro 1       # login as pro (highest priority)"
    echo "  2. ./grab-creds.sh login team 2      # login as team (failover)"
    echo "  3. ./grab-creds.sh build             # build registry"
    echo ""
    echo "Priority: lower number = tried first. Default 99."
    ;;
esac
