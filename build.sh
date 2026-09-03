#!/bin/bash
set -e
export PYTHONDONTWRITEBYTECODE=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_PY="$SCRIPT_DIR/tools"
TOOLS_TS="$SCRIPT_DIR/tools-ts"
SOURCE_REF="$SCRIPT_DIR/../claude-source-reference-2.1.88"

# Deobfuscation output tree. Overridable so two versions can be materialised
# side by side — authoring a version-stable anchor means diffing the tree the
# patch was written against with the one it now has to apply to, and a single
# shared path makes that impossible (step 2 starts with `rm -rf`).
#   DEOB_DIR=/tmp/deob-2.1.238 SKIP_PATCHES=1 BUILD_VERSION=2.1.238 ./build.sh
DEOB="${DEOB_DIR:-$SCRIPT_DIR/deobfuscated}"

# Source selection. Default: extract from the latest locally-installed binary.
# Override: BUILD_VERSION=2.1.168 builds from versionref/<ver>-cli.js instead
# (no install needed — used to build/test against a specific captured version).
if [[ -n "$BUILD_VERSION" ]]; then
    VERSION="$BUILD_VERSION"
    SOURCE_CLI="$SCRIPT_DIR/versionref/${BUILD_VERSION}-cli.js"
    if [[ ! -f "$SOURCE_CLI" ]]; then
        echo "No versionref cli.js for $BUILD_VERSION at $SOURCE_CLI"
        exit 1
    fi
    echo "Source: $SOURCE_CLI (v$VERSION, from versionref)"
else
    # Find Claude binary (macOS)
    VERSIONS_DIR="$HOME/.local/share/claude/versions"
    BINARY=$(ls -v "$VERSIONS_DIR" 2>/dev/null | tail -1)

    if [[ -z "$BINARY" ]]; then
        echo "No Claude versions found in $VERSIONS_DIR"
        exit 1
    fi

    BINARY="$VERSIONS_DIR/$BINARY"
    VERSION=$(basename "$BINARY")
    echo "Source: $BINARY (v$VERSION)"
fi

if ! command -v bun &>/dev/null; then
    echo "bun is required. Install: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Step 1: Extract JS source
echo ""
echo "=== Step 1: Extract JS source ==="
if [[ -n "$BUILD_VERSION" ]]; then
    # versionref cli.js is the raw extracted function (no trailing invocation);
    # append the same call the binary-extraction path adds.
    SOURCE_CLI="$SOURCE_CLI" python3 << PYEOF
import os
src = open(os.environ['SOURCE_CLI']).read()
src += '({}, require, module, __filename, __dirname)'
open('$SCRIPT_DIR/source.js', 'w').write(src)
print(f'  Loaded {len(src)} bytes from versionref')
PYEOF
else
    python3 << PYEOF
data = open('$BINARY', 'rb').read()

start_marker = b'(function(exports, require, module, __filename, __dirname) {// Claude Code'
start = data.find(start_marker)
if start == -1:
    raise SystemExit('Could not find JS source start')

end_marker = b'cli_after_main_complete'
end = data.find(end_marker, start)
if end == -1:
    raise SystemExit('Could not find JS source end marker')

close = data.find(b'})\n', end)
if close == -1:
    close = data.find(b'})\x00', end)
if close == -1:
    raise SystemExit('Could not find closing })')
close += 2

source = data[start:close].decode('utf-8', errors='replace')
source += '({}, require, module, __filename, __dirname)'

open('$SCRIPT_DIR/source.js', 'w').write(source)
print(f'  Extracted {len(source)} bytes')
PYEOF
fi

# Step 2: Deobfuscate
echo ""
echo "=== Step 2: Deobfuscate (Python split + TS AST match) ==="
rm -rf "$SCRIPT_DIR/.deob_cache" "$DEOB"
cd "$TOOLS_TS"
bun run src/deob.ts "$SCRIPT_DIR/source.js" "$DEOB"
cd "$SCRIPT_DIR"

# Step 2.5: Module reconstruction (add import/export for scope-aware renaming)
echo ""
echo "=== Step 2.5: Module reconstruction ==="
cd "$TOOLS_TS"
bun run src/module-reconstruct.ts "$DEOB"
cd "$SCRIPT_DIR"

# Step 2.6: Rename minified identifiers (scope-aware via TS Language Service)
echo ""
echo "=== Step 2.6: Rename identifiers ==="
cd "$TOOLS_TS"
# Anchors-only rename (export maps + anchor rules, version-independent). This is
# the migration target and matches the Patcher Studio output that patches are
# authored against, so patches apply identically here and in the studio.
bun run src/renamer.ts "$DEOB" "$SOURCE_REF" "$DEOB/_mapping.json" --no-source-ref
cd "$SCRIPT_DIR"

# Step 2.7: Prettify
echo ""
echo "=== Step 2.7: Prettify ==="
cd "$TOOLS_TS"
bun run src/prettify.ts "$DEOB"
cd "$SCRIPT_DIR"

# Step 2.8: Scoped param/local renames (runs after prettify, uses renamed function names)
echo ""
echo "=== Step 2.8: Scoped renames ==="
cd "$TOOLS_TS"
bun run src/apply-scoped-renames.ts "$DEOB" "$TOOLS_TS/anchor-rules.json"
cd "$SCRIPT_DIR"

# Step 3: Apply git patches
#
# 🔴 THERE IS NO -C0 FALLBACK HERE, AND THERE MUST NEVER BE ONE AGAIN.
#
# This step used to retry a failed patch with `git apply -C0`. -C0 requires ZERO
# context lines to match, so it places a hunk BY LINE NUMBER ALONE. Measured on
# the 2.1.168 -> 2.1.238 bump (2026-08-21): all 11 patches failed exact apply,
# and the -C0 retry "succeeded" for 7 of them by injecting their bodies at
# arbitrary offsets. 001-session-hooks landed AFTER the module's `export {...}`
# statement, outside any function:
#
#     export { bgu, N1s, ... };
#         try { if (typeof __sessionHooks !== 'undefined') { ... } } catch (e) {}
#
# That is syntactically VALID. It compiles, runs once at module load, and does
# nothing — forever, with no error. The build reported success throughout.
#
# A patch that does not apply cleanly is a patch whose anchor has drifted; the
# answer is to re-anchor and regenerate it, never to place it blind. Failing
# loudly here is the whole safety property of this step.
echo ""
echo "=== Step 3: Apply patches ==="
PATCH_FAILURES=()
if [ "${SKIP_PATCHES:-}" = "1" ]; then
    # SKIP_PATCHES means "materialise the tree for inspection", NOT "build".
    # It MUST stop here. Falling through to steps 4-5 would compile an UNPATCHED
    # bundle — no sidecar, no session hooks, no trust skip — and write it to
    # $SCRIPT_DIR/claude, the binary every fleet seat spawns from. That build
    # reports a correct --version and starts normally; the only symptom is that
    # the whole claudiverse integration is silently absent.
    echo "  SKIP_PATCHES=1 — clean unpatched baseline left at: $DEOB"
    echo ""
    echo "Stopping before reassemble/compile (an unpatched build must never be produced)."
    exit 0
elif [ -d "$SCRIPT_DIR/patches.d" ]; then
    # Init git so git apply works
    cd "$DEOB"
    git init -q && git add -A && git commit -q -m "baseline" 2>/dev/null

    for patch in "$SCRIPT_DIR/patches.d"/*.patch; do
        [ -f "$patch" ] || continue
        echo "  Applying $(basename "$patch")..."
        # --check first so a partially-applied multi-hunk patch cannot leave the
        # tree half-modified: either every hunk applies or none does.
        if git apply --check "$patch" 2>/dev/null; then
            git apply "$patch"
            echo "    ok"
        else
            echo "    FAILED (does not apply cleanly):"
            git apply "$patch" 2>&1 | sed 's/^/      /'
            PATCH_FAILURES+=("$(basename "$patch")")
        fi
    done
    cd "$SCRIPT_DIR"
else
    echo "  No patches.d/ directory — skipping"
fi

if [ "${#PATCH_FAILURES[@]}" -gt 0 ]; then
    echo ""
    echo "🔴 ${#PATCH_FAILURES[@]} patch(es) did not apply:"
    printf '     %s\n' "${PATCH_FAILURES[@]}"
    echo ""
    echo "   Refusing to build. A binary built from a partially-patched tree looks"
    echo "   identical to a good one — it compiles, runs, and reports the right"
    echo "   version, while the missing hooks simply never fire."
    echo "   Re-anchor the drifted symbols and regenerate the patch."
    echo "   To inspect the tree anyway: SKIP_PATCHES=1 DEOB_DIR=... ./build.sh"
    exit 1
fi

# Step 4: Reassemble
echo ""
echo "=== Step 4: Reassemble ==="
cd "$TOOLS_TS"
bun run src/reassembler.ts "$DEOB" "$SCRIPT_DIR/cli-runnable.js"
cd "$SCRIPT_DIR"

# Step 5: Compile
#
# ⚠️ $SCRIPT_DIR/claude IS THE LIVE FLEET BINARY. cv-spawn.sh's DEFAULT_BIN points
# straight at it, so every seat spawned from this point on runs whatever this step
# last wrote — an untested build reaches the fleet with no further gate. Running
# processes keep their own inode and are unaffected; the exposure is NEW spawns.
#
# So a build of a version you are still bringing up must NOT land here. Set
# OUT_BIN to park it beside the live one until it has been tested:
#   OUT_BIN=claude-2.1.238 BUILD_VERSION=2.1.238 ./build.sh
# Default is unchanged, so existing callers keep their behaviour.
OUT_BIN="${OUT_BIN:-claude}"
case "$OUT_BIN" in /*) OUT_PATH="$OUT_BIN";; *) OUT_PATH="$SCRIPT_DIR/$OUT_BIN";; esac

echo ""
echo "=== Step 5: Compile ==="
if [ "$OUT_PATH" = "$SCRIPT_DIR/claude" ]; then
    echo "  ⚠️  writing the LIVE fleet binary ($OUT_PATH) — every new spawn picks this up"
else
    echo "  output: $OUT_PATH (live fleet binary untouched)"
fi
BUN_CONFIG_FILE="" bun build "$SCRIPT_DIR/cli-runnable.js" --compile --outfile "$OUT_PATH" 2>&1

echo ""
echo "Done! Patched binary: $OUT_PATH"
echo "Version: $("$OUT_PATH" --version 2>&1 || echo 'unknown')"
