#!/usr/bin/env bash
#
# build.sh — build the semi-claudiversed binary: the production hook set minus
# every feature features.json marks as replaced. Lets each patch be retired one
# at a time while the rest keep working, without touching the production
# binaries (../claude, ../claude-rel) or their runtime (../patches.d/modules).
#
#   ./build.sh            # newest versionref/<v>-bin
#   ./build.sh 2.1.286
#
# Output, all in this directory:
#   claude-semi                 the binary (previous one kept as claude-semi.prev)
#   patches.d/modules/          its OWN runtime: production's, then overlay/ on top
#   BUILD.txt                   what went into it
#
# The bootstrap loads the runtime from beside the binary, so a semi seat runs
# THIS directory's runtime copy. A semi-only runtime change goes in overlay/,
# never in ../patches.d/modules, which every production seat loads.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REF="$(cd "$HERE/.." && pwd)"
cd "$HERE"

VER="${1:-}"
if [ -z "$VER" ]; then
    VER=$(ls "$REF/versionref" | sed -n 's/^\(2\.[0-9]*\.[0-9]*\)-bin$/\1/p' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
fi
STOCK="$REF/versionref/${VER}-bin"
[ -f "$STOCK" ] || { echo "build: no stock binary $STOCK" >&2; exit 1; }

# Hooks still provided by a patch, and the canary suffix.
read -r SUFFIX_B64 HOOKS < <(python3 - "$HERE/features.json" <<'PY'
import base64, json, sys
cfg = json.load(open(sys.argv[1]))
hooks = []
for name, f in cfg["features"].items():
    if f["state"] not in ("patch", "replaced", "off"):
        sys.exit(f"features.json: {name} has unknown state {f['state']!r}")
    if f["state"] == "patch":
        hooks += f["hooks"]
if "006-canary" not in hooks:
    sys.exit("features.json: 006-canary must stay 'patch' — it is how a semi seat identifies itself")
print(base64.b64encode(cfg["suffix"].encode()).decode(), " ".join(hooks))
PY
)
SUFFIX=$(printf %s "$SUFFIX_B64" | base64 -d)
echo "== stock $VER"
echo "== hooks: $HOOKS"

rm -f claude-semi.new
python3 "$REF/tools/cvinject.py" "$STOCK" claude-semi.new --suffix "$SUFFIX" $HOOKS | tail -3

# Syntax gate: every module the build edited must parse wherever its stock
# twin parses. Same gate as a production upgrade.
REF="$REF" STOCK="$STOCK" python3 - <<'PY'
import os, subprocess, sys, tempfile
sys.path.insert(0, os.path.join(os.environ["REF"], "tools"))
from bunpack import Graph
a, b = Graph(os.environ["STOCK"]), Graph("claude-semi.new")
assert a.count == b.count, (a.count, b.count)
edited = [i for i in range(a.count) if a.modules[i].contents != b.modules[i].contents]
bad = []
with tempfile.TemporaryDirectory() as d:
    for i in edited:
        ok = {}
        for tag, g in (("stock", a), ("semi", b)):
            p = f"{d}/m{i}-{tag}.mjs"
            open(p, "wb").write(g.modules[i].contents)
            ok[tag] = subprocess.run(["node", "--check", p], capture_output=True).returncode == 0
        if ok["stock"] and not ok["semi"]:
            bad.append(i)
print(f"== syntax gate: {len(edited)} edited module(s), {len(bad)} broken")
if bad:
    sys.exit(f"build: modules {bad} no longer parse")
PY

VERSION_LINE=$(./claude-semi.new --version 2>/dev/null | head -1)
case "$VERSION_LINE" in
    *"$SUFFIX"*) echo "== $VERSION_LINE" ;;
    *) echo "build: canary missing from --version: $VERSION_LINE" >&2; exit 1 ;;
esac

# Runtime: production's modules, then this variant's overlay on top.
mkdir -p patches.d/modules overlay
rsync -a --delete "$REF/patches.d/modules/" patches.d/modules/
if [ -n "$(ls -A overlay)" ]; then
    rsync -a overlay/ patches.d/modules/
    echo "== overlay: $(ls overlay | tr '\n' ' ')"
fi

[ -e claude-semi ] && mv -f claude-semi claude-semi.prev
mv claude-semi.new claude-semi

{
    echo "built:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "stock:     $VER ($(shasum -a 256 "$STOCK" | cut -c1-16))"
    echo "cvinject:  $(git -C "$REF" log -1 --format=%h -- tools/cvinject.py)$(git -C "$REF" diff --quiet -- tools/cvinject.py || echo '+dirty')"
    echo "runtime:   $(git -C "$REF" log -1 --format=%h -- patches.d/modules)$(git -C "$REF" diff --quiet -- patches.d/modules || echo '+dirty')"
    echo "hooks:     $HOOKS"
    echo "replaced:  $(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(" ".join(n for n,f in c["features"].items() if f["state"]!="patch") or "none")' features.json)"
    echo "overlay:   $(ls overlay | tr '\n' ' ')"
    echo "binary:    $(shasum -a 256 claude-semi | cut -c1-16)"
} > BUILD.txt
cat BUILD.txt
