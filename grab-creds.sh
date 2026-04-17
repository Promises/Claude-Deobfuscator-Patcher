#!/bin/bash
# Dumps the current logged-in account's credentials and config to a JSON file.
# Run once per account, giving each a label.
#
# Usage:
#   ./grab-creds.sh dump <label>        Dump current account to /tmp/claude-account-<label>.json
#   ./grab-creds.sh build               Build registry from all dumped accounts
#   ./grab-creds.sh list                List dumped account files

set -e

CMD="${1:-help}"
LABEL="${2}"

case "$CMD" in
  dump)
    if [ -z "$LABEL" ]; then
      echo "Usage: ./grab-creds.sh dump <label>"
      echo "Example: ./grab-creds.sh dump team"
      exit 1
    fi

    OUTFILE="/tmp/claude-account-${LABEL}.json"

    # Read keychain
    KEYCHAIN_DATA=$(security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w 2>/dev/null || \
                    security find-generic-password -s "Claude Code" -a "$(whoami)" -w 2>/dev/null || echo "")

    # Read config
    python3 - "$LABEL" "$KEYCHAIN_DATA" "$OUTFILE" << 'PYEOF'
import json, sys, os

label = sys.argv[1]
keychain_raw = sys.argv[2]
outfile = sys.argv[3]
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

# First account is primary
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
    echo "  ./grab-creds.sh dump <label>   Dump current login to /tmp/claude-account-<label>.json"
    echo "  ./grab-creds.sh build          Build registry from all dumps (first = primary)"
    echo "  ./grab-creds.sh list           List dumped files"
    echo ""
    echo "Workflow:"
    echo "  1. Login as account A:  claude auth login"
    echo "  2. Dump it:            ./grab-creds.sh dump primary"
    echo "  3. Login as account B:  claude auth login"
    echo "  4. Dump it:            ./grab-creds.sh dump team"
    echo "  5. Build registry:     ./grab-creds.sh build"
    ;;
esac
