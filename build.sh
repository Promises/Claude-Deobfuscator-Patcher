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
#
# TWO BUNDLE FORMATS. Up to 2.1.241 the binary embeds ONE monolithic CJS bundle
# (sliced to versionref/<ver>-cli.js, split by tools/splitter.py). BISECTED
# 2026-09-03: from 2.1.242 it is `bun build --compile --bytecode` and the bundle
# is ~1400-1700 separate ESM chunks, which tools/extract_chunks.py recovers.
#
# FORMAT is resolved here and steps 1-2 branch on it. The discriminator is the
# presence of the monolithic start marker in the BINARY — see is_chunked() in
# tools/extract_chunks.py for why the banner and the bare CJS-wrapper prefix are
# both unusable as discriminators.
#
# A chunked version has no <ver>-cli.js (the slicer cannot produce one), so it
# is supplied as the native binary at versionref/<ver>-bin instead.
FORMAT=""
if [[ -n "$BUILD_VERSION" ]]; then
    VERSION="$BUILD_VERSION"
    SOURCE_CLI="$SCRIPT_DIR/versionref/${BUILD_VERSION}-cli.js"
    SOURCE_BIN="${SOURCE_BINARY:-$SCRIPT_DIR/versionref/${BUILD_VERSION}-bin}"
    if [[ -f "$SOURCE_CLI" ]]; then
        FORMAT="monolithic"
        echo "Source: $SOURCE_CLI (v$VERSION, from versionref, monolithic)"
    elif [[ -f "$SOURCE_BIN" ]]; then
        BINARY="$SOURCE_BIN"
        FORMAT="chunked"
        echo "Source: $SOURCE_BIN (v$VERSION, chunked binary)"
    else
        echo "No source for $BUILD_VERSION."
        echo "  monolithic (<=2.1.241): expected $SOURCE_CLI"
        echo "  chunked    (>=2.1.242): expected $SOURCE_BIN, or set SOURCE_BINARY=<path>"
        echo "  fetch a chunked binary with:"
        echo "    npm pack @anthropic-ai/claude-code-darwin-arm64@$BUILD_VERSION"
        echo "    tar xzf *.tgz package/claude"
        exit 1
    fi
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

# Probe the binary itself when the source is a binary (either branch above).
if [[ -z "$FORMAT" ]]; then
    if python3 -c "import sys; sys.path.insert(0, '$TOOLS_PY'); from extract_chunks import is_chunked; sys.exit(0 if is_chunked('$BINARY') else 1)"; then
        FORMAT="chunked"
    else
        FORMAT="monolithic"
    fi
    echo "  format: $FORMAT"
fi

if ! command -v bun &>/dev/null; then
    echo "bun is required. Install: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Step 1: Extract JS source
#
# Chunked builds skip source.js entirely: there is no single bundle to write,
# and step 2 consumes the chunk tree directly. The two monolithic sub-branches
# below are unchanged.
echo ""
echo "=== Step 1: Extract JS source ==="
if [[ "$FORMAT" = "chunked" ]]; then
    # Emit straight into the splitter's own layout so step 2 and everything
    # after it are untouched. See emit_splitter_compat() in extract_chunks.py.
    rm -rf "$SCRIPT_DIR/.deob_cache"
    python3 "$TOOLS_PY/extract_chunks.py" "$BINARY" \
        "$SCRIPT_DIR/.deob_cache/modules" \
        --manifest "$SCRIPT_DIR/.deob_cache/chunk-graph.json" \
        --splitter-compat

    # The chunks are only the CODE. The `.md`/`.txt` assets upstream embeds with
    # `import ... with { type: "file" }` survive into the tree as bare path
    # literals, so without this the rebuilt binary loads, prints --version, and
    # then dies on the first real turn with "embedded text asset is missing or
    # corrupt". --verify makes a wrong name->payload pairing fatal HERE rather
    # than silently shipping one asset's bytes under another asset's name.
    ASSET_DIR="$SCRIPT_DIR/.deob_cache/assets"
    python3 "$TOOLS_PY/extract_assets.py" "$BINARY" -o "$ASSET_DIR" --verify
elif [[ -f "${SOURCE_CLI:-}" ]]; then
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
#
# deob.ts reuses .deob_cache/modules/ when a _manifest.json is already there.
# That is exactly the seam the chunked path uses: step 1 has already written the
# modules in the splitter's layout, so deob.ts skips the split and goes straight
# to matching + emitting. The monolithic path must still clear the cache, or a
# stale split from a previous version would be silently reused.
echo ""
echo "=== Step 2: Deobfuscate (Python split + TS AST match) ==="
if [[ "$FORMAT" = "chunked" ]]; then
    # deob.ts uses this path ONLY to locate .deob_cache beside it, and to invoke
    # the splitter on a cache MISS. A chunked build has no bundle to split, so
    # point it at a name that does not exist: on the expected cache HIT this is
    # never read, and if the cache were ever missing the splitter fails loudly
    # instead of silently splitting a stale source.js from another version.
    rm -rf "$DEOB"
    SOURCE_FOR_DEOB="$SCRIPT_DIR/.chunked-no-bundle.js"
else
    rm -rf "$SCRIPT_DIR/.deob_cache" "$DEOB"
    SOURCE_FOR_DEOB="$SCRIPT_DIR/source.js"
fi
cd "$TOOLS_TS"
bun run src/deob.ts "$SOURCE_FOR_DEOB" "$DEOB"
cd "$SCRIPT_DIR"

# Step 2.5: Module reconstruction (add import/export for scope-aware renaming)
#
# Monolithic trees have NO imports, so they get a synthesised import/export graph
# — that is what makes step 2.6's renaming scope-aware. Chunked trees already ARE
# an ESM graph, so module-reconstruct.ts detects that and retargets their
# /$bunfs/root/chunk-*.js specifiers onto the emitted filenames instead of
# synthesising a second, duplicate set of bindings. CHUNK_GRAPH is passed
# explicitly because $DEOB is relocatable via DEOB_DIR and the cache is not.
#
# Runs BEFORE 2.5 on purpose. `ve('/$bunfs/root/x.md')` is
# `import.meta.require`, which PARSES the asset as JavaScript rather than
# returning its text (measured: SyntaxError at <parse> on both .md and .txt), so
# a module containing one cannot be safely hoisted. Turning those calls into
# embedded-file reads first is what lets 2.5's guard stop firing for them.
if [[ -d "${ASSET_DIR:-}" ]]; then
    echo ""
    echo "=== Step 2.4: Rewrite embedded-asset loads ==="
    python3 "$TOOLS_PY/rewrite_asset_loads.py" "$DEOB" "$ASSET_DIR"
fi

echo ""
echo "=== Step 2.5: Module reconstruction ==="
cd "$TOOLS_TS"
# ASSET_DIR lets the asset guard tell a RECOVERED embedded asset from a missing
# one. A module whose asset is missing cannot be bundled at all (bun resolves
# `/$bunfs/root/<asset>` at BUILD time and fails the whole binary), so those
# sites must keep the call form, while recovered ones become bundled lazy
# requires. Passed explicitly because $DEOB is relocatable via DEOB_DIR and the
# cache is not; absent on a monolithic build, where every asset then reads as
# missing and the old call-form behaviour is preserved.
CHUNK_GRAPH="$SCRIPT_DIR/.deob_cache/chunk-graph.json" \
    ASSET_DIR="$SCRIPT_DIR/.deob_cache/assets" \
    bun run src/module-reconstruct.ts "$DEOB"
cd "$SCRIPT_DIR"

# STOP_AFTER_STEP=2.5 — leave the tree exactly as step 2.6 will SEE it.
#
# Anchor rules resolve at 2.6, before the 2.7 prettify and before 2.6 itself has
# rewritten any names. Measuring anchors against a FINISHED tree therefore scores
# a different population than the build does (measured: 725 pre-rename vs 55
# post-rename on the same 2.1.238 tree). This hook is the only way to obtain the
# input the resolver actually gets, without re-implementing steps 2-2.5 by hand.
if [ "${STOP_AFTER_STEP:-}" = "2.5" ]; then
    echo ""
    echo "  STOP_AFTER_STEP=2.5 — pre-rename tree left at: $DEOB"
    exit 0
fi

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
if [ "${SKIP_PATCHES:-}" = "1" ] && [ "${ALLOW_UNPATCHED_BUILD:-}" != "1" ]; then
    # SKIP_PATCHES means "materialise the tree for inspection", NOT "build".
    # It MUST stop here. Falling through to steps 4-5 would compile an UNPATCHED
    # bundle — no sidecar, no session hooks, no trust skip — and write it to
    # $SCRIPT_DIR/claude, the binary every fleet seat spawns from. That build
    # reports a correct --version and starts normally; the only symptom is that
    # the whole claudiverse integration is silently absent.
    echo "  SKIP_PATCHES=1 — clean unpatched baseline left at: $DEOB"
    echo ""
    echo "Stopping before reassemble/compile (an unpatched build must never be produced)."
    echo "To build one deliberately (bringing up a new bundle FORMAT, where the"
    echo "question is whether the pipeline produces a running binary at all, and"
    echo "patches are a separate lane), set ALLOW_UNPATCHED_BUILD=1 and an OUT_BIN."
    exit 0
elif [ "${SKIP_PATCHES:-}" = "1" ]; then
    # Deliberately unpatched. The guard above is NOT weakened: it still fires for
    # every caller that does not ask for this by name, and the ONE thing it
    # exists to prevent — an unpatched build reaching the fleet — is enforced
    # here instead of by refusing to build, because the danger was never the
    # compile, it was the DESTINATION.
    #
    # So an unpatched build may not be written to $SCRIPT_DIR/claude, and an
    # explicit OUT_BIN is mandatory: defaulting to the live path is exactly the
    # accident the guard was written for. An unpatched binary reports a correct
    # --version and starts normally, so nothing downstream would notice.
    OUT_BIN_CHECK="${OUT_BIN:-claude}"
    case "$OUT_BIN_CHECK" in /*) OUT_PATH_CHECK="$OUT_BIN_CHECK";; *) OUT_PATH_CHECK="$SCRIPT_DIR/$OUT_BIN_CHECK";; esac
    if [ "$OUT_PATH_CHECK" = "$SCRIPT_DIR/claude" ]; then
        echo "🔴 ALLOW_UNPATCHED_BUILD=1 requires an explicit OUT_BIN that is not 'claude'."
        echo "   $SCRIPT_DIR/claude is the LIVE fleet binary — every new seat spawns from it."
        echo "   An unpatched build there is silently missing the whole claudiverse"
        echo "   integration while still reporting the right version."
        exit 1
    fi
    echo "  SKIP_PATCHES=1 + ALLOW_UNPATCHED_BUILD=1 — building an UNPATCHED binary."
    echo "  ⚠️  This binary has NO claudiverse integration (no sidecar, no session"
    echo "     hooks, no trust skip). It is for format bring-up only."
    echo "  tree: $DEOB   ->   $OUT_PATH_CHECK"
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

# Step 4: Reassemble (monolithic) or bundle (chunked)
#
# TWO TREE SHAPES NEED TWO DIFFERENT STEP 4s, and the difference is not cosmetic.
#
# A MONOLITHIC tree came from one CJS bundle where every declaration really did
# share one global scope, so reassembler.ts strips the imports/exports that
# module-reconstruct.ts synthesised and concatenates the sections back. That is
# a faithful inverse of how the tree was made.
#
# A CHUNKED tree is a genuine ESM graph of ~1650 separately-scoped modules, and
# upstream's bundler reused top-level names freely across them because it never
# had to place them in one scope. Concatenating THAT is not an inverse of
# anything — MEASURED on 2.1.259, it yields 9,585 "X has already been declared"
# errors, an identical count with side-effect imports stripped and with them
# left in, so the collisions come from the concatenation itself and no better
# strip regex can remove them. Bundling the same tree gives zero collisions.
#
# The dispatch is on a MEASURED property of the tree (presence of a
# preamble/tail section pair in _mapping.json), never a version number — the
# studio calls these tools with no version context, the same reason build.sh
# step 1, module-reconstruct.ts and renamer.ts all measure instead of being told.
echo ""
cd "$TOOLS_TS"
if bun run src/bundler.ts --is-chunked "$DEOB"; then
    echo "=== Step 4: Bundle (chunked tree) ==="
    bun run src/bundler.ts "$DEOB" "$SCRIPT_DIR/cli-runnable.js"
    cd "$SCRIPT_DIR"
    # Turn the surviving asset PATH LITERALS back into real file imports, so
    # step 5 embeds the bytes. Nothing else can do this: by the time the tree
    # exists the `with { type: "file" }` imports are already gone.
    if [[ -d "${ASSET_DIR:-}" ]]; then
        python3 "$TOOLS_PY/inject_assets.py" \
            "$SCRIPT_DIR/cli-runnable.js" "$ASSET_DIR"
    fi
else
    echo "=== Step 4: Reassemble ==="
    bun run src/reassembler.ts "$DEOB" "$SCRIPT_DIR/cli-runnable.js"
fi
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
# --external is scoped to the ONE made-up protocol module-reconstruct.ts uses to
# mark a chunk specifier it could not resolve (UNRESOLVED_CHUNK_PREFIX). Step 4's
# bundler declares the same thing, but this compile re-resolves the bundle's
# imports, so the flag is needed in BOTH places or the build fails here instead.
#
# Deliberately NOT a blanket external rule: only specifiers carrying that prefix
# are exempted, so a genuinely missing dependency still fails loudly. The import
# throws "Cannot find module 'claudiverse-unresolved-chunk:…'" naming the
# original chunk, and only on the code path that needs it. Harmless on a
# monolithic build, which contains no such specifier.
#
# --asset-naming is LOAD-BEARING, not cosmetic. bun's default is
# "[name]-[hash].[ext]", which would embed
#   plugin-eval-quickref-7cde824c.md.zst
# as
#   plugin-eval-quickref-7cde824c.md-<bunhash>.zst
# while the code still calls readFileSync("/$bunfs/root/<the original name>").
# MEASURED with a two-file probe: the default rewrote a test asset's name and
# "[name].[ext]" reproduced the upstream path byte-for-byte.
BUN_CONFIG_FILE="" bun build "$SCRIPT_DIR/cli-runnable.js" --compile \
    --asset-naming='[name].[ext]' \
    --external 'claudiverse-unresolved-chunk:*' --outfile "$OUT_PATH" 2>&1

echo ""
echo "Done! Patched binary: $OUT_PATH"
echo "Version: $("$OUT_PATH" --version 2>&1 || echo 'unknown')"
