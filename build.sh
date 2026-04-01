#!/bin/bash
set -e
export PYTHONDONTWRITEBYTECODE=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_PY="$SCRIPT_DIR/tools"
TOOLS_TS="$SCRIPT_DIR/tools-ts"
SOURCE_REF="$SCRIPT_DIR/../claude-code"

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

if ! command -v bun &>/dev/null; then
    echo "bun is required. Install: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Step 1: Extract JS source from binary
echo ""
echo "=== Step 1: Extract JS source ==="
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

# Step 2: Deobfuscate
echo ""
echo "=== Step 2: Deobfuscate (Python split + TS AST match) ==="
rm -rf "$SCRIPT_DIR/.deob_cache"
cd "$TOOLS_TS"
bun run src/deob.ts "$SCRIPT_DIR/source.js" "$SOURCE_REF" "$SCRIPT_DIR/deobfuscated"
cd "$SCRIPT_DIR"

# Step 3: Apply git patches
echo ""
echo "=== Step 3: Apply patches ==="
if [ -d "$SCRIPT_DIR/patches.d" ]; then
    # Init git so git apply works
    cd "$SCRIPT_DIR/deobfuscated"
    git init -q && git add -A && git commit -q -m "baseline" 2>/dev/null

    for patch in "$SCRIPT_DIR/patches.d"/*.patch; do
        [ -f "$patch" ] || continue
        echo "  Applying $(basename "$patch")..."
        git apply "$patch" 2>&1 || {
            echo "  WARNING: Exact match failed, trying with fuzz..."
            git apply -C0 "$patch" 2>&1 || echo "  FAILED: $(basename "$patch")"
        }
    done
    cd "$SCRIPT_DIR"
else
    echo "  No patches.d/ directory — skipping"
fi

# Step 4: Reassemble
echo ""
echo "=== Step 4: Reassemble ==="
cd "$TOOLS_TS"
bun run src/reassembler.ts "$SCRIPT_DIR/deobfuscated" "$SCRIPT_DIR/cli-runnable.js"
cd "$SCRIPT_DIR"

# Step 5: Compile
echo ""
echo "=== Step 5: Compile ==="
BUN_CONFIG_FILE="" bun build "$SCRIPT_DIR/cli-runnable.js" --compile --outfile "$SCRIPT_DIR/claude" 2>&1

echo ""
echo "Done! Patched binary: $SCRIPT_DIR/claude"
echo "Version: $("$SCRIPT_DIR/claude" --version 2>&1 || echo 'unknown')"
