#!/usr/bin/env python3
"""
extract_chunks.py — recover the JS source from a CHUNKED Claude Code binary
(2.1.242 and later) and resolve its module graph.

WHY THIS EXISTS
  Up to and including 2.1.241 the binary embedded ONE monolithic CJS bundle,
  which tools/splitter.py carved into modules. BISECTED 2026-09-03: 2.1.241 is
  the last such build. From 2.1.242 the binary is `bun build --compile
  --bytecode` and the bundle is split into ~1400-1700 separate ESM chunk files
  mounted at /$bunfs/root/chunk-<hash>.js. The old start marker
  "(function(exports, require, module, __filename, __dirname) {// Claude Code"
  does not occur at all, which is why fetch-versionref.sh reports
  "JS source start marker absent" rather than producing a bad capture.

  The SOURCE IS STILL PLAIN TEXT. Only its packaging changed.

HOW A CHUNK IS FOUND (measured on 2.1.259: 1649 chunks, 32,748,649 bytes total)
  Each chunk body starts at the Anthropic banner comment and runs until the
  first non-printable byte, where the next bytecode blob begins. Bodies end in a
  bare `export{...};` — 1615 of 1649 on 2.1.259; the rest legitimately export
  nothing. All 1649 decode as UTF-8, and a 40-chunk random sample parsed as ESM
  under `node --check` (gate positive-controlled: broken ESM exits 1).

  The `// @bun @bytecode` marker is NOT a usable body delimiter — the first one
  belongs to the entry stub and is followed by 41 characters and then bytecode.

WHY THE MODULE GRAPH IS RESOLVED BY SYMBOLS, NOT BY FILENAME
  A body cannot be reliably attributed to its chunk-<hash>.js name: the bunfs
  path table is stored apart from the bodies, and for most chunks no path
  appears anywhere near the body (measured: 3 of 5 probes found nothing within
  3 KB). But the names are useless to us anyway — they are content hashes that
  change every release, the same drifting-identifier problem that made
  _unmatched/<index>_<stem>.js rules score 0-2/16 across versions.

  Instead each chunk is identified by WHAT IT EXPORTS. An import names several
  symbols from one chunk, so intersecting the owner sets pins it exactly.
  MEASURED on 2.1.259: 22,793 distinct exported symbols, 269 (1.2%) exported by
  more than one chunk, and yet **13,317 of 13,317 import statements (100%)
  resolve to exactly one chunk** — zero ambiguous, zero unresolved.

Usage:
  extract_chunks.py <claude-binary> <out-dir> [--manifest manifest.json]
"""
import json
import os
import re
import sys
from collections import defaultdict

BANNER = b"// Claude Code is a Beta product"
IMPORT_RE = re.compile(r'import\s*\{([^}]*)\}\s*from\s*"(/\$bunfs/root/[^"]+)"')
EXPORT_RE = re.compile(r"export\s*\{([^}]*)\}\s*;?\s*$")


def body_end(data, start):
    """A chunk body runs from the banner to the first non-printable byte."""
    n = len(data)
    j = start
    while j < n:
        c = data[j]
        if c == 0 or c == 0x0C or c < 9 or (13 < c < 32):
            break
        j += 1
    return j


def local_names(clause):
    """Local binding names from an import clause (`a as b` binds b)."""
    out = []
    for part in clause.split(","):
        part = part.strip()
        if not part:
            continue
        out.append(part.split(" as ")[-1].strip())
    return out


def imported_names(clause):
    """Source-side names in an import clause (`a as b` reads a)."""
    out = []
    for part in clause.split(","):
        part = part.strip()
        if not part:
            continue
        out.append(part.split(" as ")[0].strip())
    return out


def extract(binary_path):
    data = open(binary_path, "rb").read()

    starts = []
    i = data.find(BANNER)
    while i != -1:
        starts.append(i)
        i = data.find(BANNER, i + 1)
    if not starts:
        raise SystemExit(
            "no chunk banners found — is this a chunked build? "
            "(<=2.1.241 is monolithic; use the fetch-versionref.sh slicer)"
        )

    chunks = []
    for s in starts:
        raw = data[s : body_end(data, s)]
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as e:
            raise SystemExit(f"chunk at offset {s} is not valid UTF-8: {e}")
        chunks.append({"offset": s, "text": text})

    # Ownership map: exported symbol -> set of chunk indices.
    owner = defaultdict(set)
    for idx, c in enumerate(chunks):
        m = EXPORT_RE.search(c["text"].rstrip())
        c["exports"] = local_names(m.group(1)) if m else []
        for sym in c["exports"]:
            owner[sym].add(idx)

    # Resolve every import to a chunk index by intersecting owner sets.
    stats = {"imports": 0, "resolved": 0, "ambiguous": 0, "unresolved": 0}
    for c in chunks:
        c["imports"] = []
        for clause, path in IMPORT_RE.findall(c["text"]):
            stats["imports"] += 1
            cand = None
            for sym in imported_names(clause):
                o = owner.get(sym, set())
                cand = set(o) if cand is None else (cand & o)
            cand = cand or set()
            if len(cand) == 1:
                stats["resolved"] += 1
                target = next(iter(cand))
            elif len(cand) == 0:
                stats["unresolved"] += 1
                target = None
            else:
                stats["ambiguous"] += 1
                target = None
            c["imports"].append(
                {"path": path, "clause": clause.strip(), "target": target}
            )
    return chunks, stats


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__.strip().splitlines()[-2])
    binary, outdir = sys.argv[1], sys.argv[2]
    manifest_path = None
    if "--manifest" in sys.argv:
        manifest_path = sys.argv[sys.argv.index("--manifest") + 1]

    chunks, stats = extract(binary)
    os.makedirs(outdir, exist_ok=True)

    total = 0
    for idx, c in enumerate(chunks):
        name = f"chunk_{idx:04d}.js"
        c["file"] = name
        with open(os.path.join(outdir, name), "w") as fh:
            fh.write(c["text"])
        total += len(c["text"])

    manifest = [
        {
            "index": i,
            "file": c["file"],
            "offset": c["offset"],
            "bytes": len(c["text"]),
            "exports": c["exports"],
            "imports": c["imports"],
        }
        for i, c in enumerate(chunks)
    ]
    if manifest_path:
        with open(manifest_path, "w") as fh:
            json.dump(manifest, fh, indent=1)

    print(f"  chunks written : {len(chunks)}")
    print(f"  total source   : {total:,} bytes")
    print(
        f"  import graph   : {stats['resolved']}/{stats['imports']} resolved"
        f"  ambiguous={stats['ambiguous']}  unresolved={stats['unresolved']}"
    )
    # A partially-resolved graph is worse than a loud failure: downstream stages
    # would silently treat unresolved edges as absent dependencies.
    if stats["imports"] and stats["resolved"] != stats["imports"]:
        print(
            "  WARNING: graph incomplete — symbol-intersection did not pin every "
            "import. Do not build on this until it is explained.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
