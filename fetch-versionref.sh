#!/usr/bin/env bash
#
# fetch-versionref.sh — capture the JS bundle out of a published Claude Code
# release into versionref/<ver>-cli.js, ready for `BUILD_VERSION=<ver> ./build.sh`.
#
# Usage:
#   ./fetch-versionref.sh 2.1.170 2.1.175 2.1.181 ...
#   ./fetch-versionref.sh --stride 5 2.1.170 2.1.238     # every ~5th published version in range
#
# WHERE THE SOURCE LIVES, AND WHY THIS SCRIPT EXISTS
#
# The @anthropic-ai/claude-code npm tarball does NOT contain cli.js — it is a
# ~25 KB installer that pulls a per-platform native package. Checked on both
# 2.1.156 (stored here) and 2.1.238: neither ships JS. The bundle is embedded in
# the native binary shipped by @anthropic-ai/claude-code-darwin-arm64, so that is
# what we download and slice.
#
# The slice markers are IDENTICAL to the ones build.sh uses on a locally
# installed binary — this script is the same extraction, just sourced from npm
# instead of ~/.local/share/claude/versions, so no `claude install` is needed.
#
# VERIFIED 2026-08-21: re-extracting 2.1.168 through this path reproduces the
# already-stored versionref/2.1.168-cli.js BYTE FOR BYTE
# (sha256 8981c0701420941dca29d59cf83e5286bed1bfec1ee787f1e502010f09d65a1a,
# 16,251,040 bytes). The method is not assumed to match the historical one; it
# was measured against it.
#
# The ~250 MB native binary is deleted after slicing; only the ~16-28 MB cli.js
# is kept.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSIONREF="$SCRIPT_DIR/versionref"
PKG="@anthropic-ai/claude-code-darwin-arm64"

command -v npm >/dev/null || { echo "fetch-versionref: npm not found" >&2; exit 1; }
mkdir -p "$VERSIONREF"
FAILED_VERSIONS=""

# --stride N <from> <to>: expand to every ~Nth PUBLISHED version in the range.
# Not every number is published (2.1.180, 2.1.230 do not exist), so each target
# snaps to the nearest version that actually exists rather than being skipped.
if [ "${1:-}" = "--stride" ]; then
    STRIDE="$2"; FROM="$3"; TO="$4"
    VERSIONS=$(npm view "$PKG" versions --json | STRIDE="$STRIDE" FROM="$FROM" TO="$TO" python3 -c '
import json, os, sys
pub = json.load(sys.stdin)
key = lambda v: tuple(int(x) for x in v.split("."))
lo, hi, stride = key(os.environ["FROM"]), key(os.environ["TO"]), int(os.environ["STRIDE"])
avail = sorted({v for v in pub if lo <= key(v) <= hi}, key=key)
if not avail:
    sys.exit("no published versions in range")
patch = lambda v: key(v)[2]
out = []
for want in range(patch(avail[0]), patch(avail[-1]) + 1, stride):
    out.append(min(avail, key=lambda v: (abs(patch(v) - want), patch(v))))
if avail[-1] not in out:
    out.append(avail[-1])          # always pin the newest end of the range
seen = set()
print(" ".join(v for v in out if not (v in seen or seen.add(v))))
')
    echo "Selected: $VERSIONS"
else
    VERSIONS="$*"
fi

[ -n "${VERSIONS// /}" ] || { echo "usage: fetch-versionref.sh <ver>... | --stride N <from> <to>" >&2; exit 2; }

for VER in $VERSIONS; do
    OUT="$VERSIONREF/${VER}-cli.js"
    if [ -f "$OUT" ]; then
        echo "== $VER: already captured ($(wc -c <"$OUT" | tr -d ' ') bytes) — skipping"
        continue
    fi

    echo "== $VER: downloading"
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/versionref-XXXXXX")"
    # Always clean up the 250 MB binary, including on a mid-loop failure.
    trap 'rm -rf "$WORK"' EXIT

    ( cd "$WORK" && npm pack "${PKG}@${VER}" >/dev/null 2>&1 ) || {
        echo "   FAILED: npm pack ${PKG}@${VER}" >&2; rm -rf "$WORK"; trap - EXIT; continue; }

    TGZ="$(find "$WORK" -maxdepth 1 -name '*.tgz' | head -1)"
    [ -n "$TGZ" ] || { echo "   FAILED: no tarball produced for $VER" >&2; rm -rf "$WORK"; trap - EXIT; continue; }

    tar xzf "$TGZ" -C "$WORK" package/claude || {
        echo "   FAILED: no package/claude in tarball for $VER" >&2; rm -rf "$WORK"; trap - EXIT; continue; }

    echo "== $VER: slicing"
    # `|| SLICE_FAILED=1` is load-bearing: this script runs under `set -e`, and the
    # slicer sys.exit()s on an unrecognised bundle. Without the guard, ONE bad
    # version aborts the whole batch and every later version is silently never
    # attempted — the run looks like it merely stopped early. MEASURED 2026-09-03:
    # a 5-version fetch captured 2.1.239, hit the bytecode/chunked format at
    # 2.1.243, and never tried 248/252/259.
    SLICE_FAILED=""
    BIN="$WORK/package/claude" OUT="$OUT" VER="$VER" python3 <<'PYEOF' || SLICE_FAILED=1
import os, sys

data = open(os.environ["BIN"], "rb").read()

start = data.find(b"(function(exports, require, module, __filename, __dirname) {// Claude Code")
if start == -1:
    sys.exit("   FAILED: JS source start marker absent")
end = data.find(b"cli_after_main_complete", start)
if end == -1:
    sys.exit("   FAILED: end marker cli_after_main_complete absent")
close = data.find(b"})\n", end)
if close == -1:
    close = data.find(b"})\x00", end)
if close == -1:
    sys.exit("   FAILED: closing }) absent")
close += 2

src = data[start:close]

# A slice that ran past its intended end still LOOKS like a success — it is a
# large file with the right head and tail. Two cheap invariants that a runaway
# slice violates: the opening wrapper must occur exactly once, and the payload
# must be text. Without these, a bad capture is only noticed much later, when
# the deobfuscator produces nonsense.
n = src.count(b"(function(exports, require, module, __filename, __dirname) {// Claude Code")
if n != 1:
    sys.exit(f"   FAILED: wrapper marker appears {n}x in slice (expected 1) — slice overran")
try:
    text = src.decode("utf-8")
except UnicodeDecodeError as e:
    sys.exit(f"   FAILED: slice is not valid UTF-8 ({e}) — binary data captured")

open(os.environ["OUT"], "w").write(text)
print(f"   wrote {len(src):,} bytes -> {os.path.basename(os.environ['OUT'])}")
PYEOF

    if [ -n "$SLICE_FAILED" ]; then
        echo "   SKIPPED $VER (see failure above); continuing with the rest" >&2
        FAILED_VERSIONS="$FAILED_VERSIONS $VER"
        rm -f "$OUT"
        rm -rf "$WORK"
        trap - EXIT
        continue
    fi

    # Syntax gate. The slice is a parenthesised function expression, so it must
    # parse standalone; a truncated or overrun capture does not. This fails LOUDLY
    # and removes the artifact — a half-captured cli.js left on disk would be
    # picked up by build.sh as if it were good.
    if command -v node >/dev/null; then
        if node --check "$OUT" 2>/dev/null; then
            echo "   syntax OK"
        else
            echo "   FAILED: $OUT does not parse — removing" >&2
            rm -f "$OUT"
        fi
    else
        echo "   WARNING: node not found, syntax gate SKIPPED for $VER" >&2
    fi

    rm -rf "$WORK"
    trap - EXIT
done

echo ""
# Deliberately not `grep` — it is shadowed by a wrapper on at least one machine
# in this fleet and rejects the flags you would reach for, turning this into a
# silent zero.
echo "versionref captures: $(ls -v "$VERSIONREF" | /usr/bin/grep -c 'cli\.js$')"

# Report failures at the END too. A failure printed mid-run scrolls away behind
# the next version's output, so a batch that captured 1 of 5 reads as a success
# if you only look at the tail.
if [ -n "${FAILED_VERSIONS// /}" ]; then
    echo ""
    echo "🔴 NOT captured:$FAILED_VERSIONS"
    echo "   BISECTED 2026-09-03: 2.1.241 is the LAST single-blob build; 2.1.242 is"
    echo "   the FIRST chunked one. From 2.1.242 the binary is bun --bytecode with the"
    echo "   bundle split into ~1375 ESM chunk files (/\$bunfs/root/chunk-<hash>.js),"
    echo "   so the single-blob slicer above cannot work. The JS source IS still plain"
    echo "   text in the binary; it needs a per-chunk extractor, not a new marker."
    exit 1
fi
