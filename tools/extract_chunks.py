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
  more than one chunk, and 13,317 of 13,317 CLAUSE imports resolve to exactly
  one chunk — zero ambiguous, zero unresolved.

  🔴 MIND THE DENOMINATOR. That "13,317 of 13,317" is a real measurement of a
  SUBSET, and was originally reported as "100% of imports", which it is not.
  IMPORT_RE requires a `{...}` clause, so BARE SIDE-EFFECT imports
  (`import"/$bunfs/root/chunk-xxxx.js";`) were never matched, never counted, and
  never reported as unresolved — they were invisible to both the numerator and
  the denominator. MEASURED on 2.1.259: 13,317 clause imports vs **86,438
  side-effect imports**, so true coverage is 13,317/99,755 = **13.3%**.

  This is a STRUCTURAL limit, not a tuning one: a side-effect import names no
  symbols, so there is nothing to intersect and this method cannot resolve it
  even in principle. Resolving them needs a different key (the bunfs path table,
  or emission order). Until then a chunked tree still contains ~86k specifiers
  pointing at /$bunfs paths that do not exist in the output.
  ⚠️ Such a tree still PARSES — a side-effect import of a missing path is
  syntactically valid — so an ESM parse gate cannot catch this. It surfaces at
  reassembly or at runtime.

Usage:
  extract_chunks.py <claude-binary> <out-dir> [--manifest manifest.json]
                    [--splitter-compat]

  --splitter-compat additionally emits the layout tools/splitter.py produces
  (NNNN_<module_name>.js + _manifest.json), so build.sh step 2 and everything
  after it consume a chunked build unchanged. See emit_splitter_compat().
"""
import json
import os
import re
import sys
from collections import defaultdict

BANNER = b"// Claude Code is a Beta product"
IMPORT_RE = re.compile(r'import\s*\{([^}]*)\}\s*from\s*"(/\$bunfs/root/[^"]+)"')

# Bare side-effect imports. Counted SEPARATELY and reported, because they cannot
# be resolved by symbol intersection (they name no symbols) — see the docstring.
# They are counted at all so the coverage figure carries its true denominator;
# leaving them unmatched is what made an earlier report claim 100%.
SIDE_EFFECT_IMPORT_RE = re.compile(
    r'import\s*["\'](/\$bunfs/root/chunk-[a-z0-9]+\.js)["\']'
)
EXPORT_RE = re.compile(r"export\s*\{([^}]*)\}\s*;?\s*$")

# The ONLY reliable monolithic/chunked discriminator.
#
# MEASURED 2026-09-03 on real upstream binaries: this marker is present in
# 2.1.39 / 2.1.89 / 2.1.90 (offsets 59638219 / 70189515 / 70648267) and absent
# from 2.1.259.
#
# ⚠️ The BANNER is NOT a discriminator. Monolithic binaries contain it too
# (7-9 times in the three probed above), so "banner present" says nothing.
# Nor is the bare CJS-wrapper prefix: 2.1.259 contains it twice, as the
# `@bun-cjs` and `@bytecode` entry stubs, which run into bytecode after 41
# chars. It is the `{// Claude Code` suffix that makes the marker specific.
MONOLITHIC_MARKER = (
    b"(function(exports, require, module, __filename, __dirname) {// Claude Code"
)


def is_chunked(binary_path):
    """True if this binary is a 2.1.242+ chunked build (no monolithic bundle)."""
    with open(binary_path, "rb") as fh:
        return fh.read().find(MONOLITHIC_MARKER) == -1


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
    stats = {
        "imports": 0,
        "resolved": 0,
        "ambiguous": 0,
        "unresolved": 0,
        "side_effect": 0,
    }
    for c in chunks:
        stats["side_effect"] += len(SIDE_EFFECT_IMPORT_RE.findall(c["text"]))
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


IDENT_RE = re.compile(r"^[A-Za-z_$][\w$]*$")


def module_names(chunks):
    """A unique, content-derived module_name per chunk.

    WHY NOT THE CHUNK FILENAME: chunk-<hash>.js names are content hashes that
    change every release — the same drifting-identifier problem that made
    _unmatched/<index>_<stem>.js anchor rules score 0-2/16 across versions.

    WHY NOT THE BARE FIRST EXPORT: it is content-derived and stable, but it is
    NOT UNIQUE, and module_name is a KEY — emitter.ts and matcher.ts both look
    modules up by it in a Map, so a collision silently makes two chunks share
    one match. MEASURED on 2.1.259: 21 first-export names are shared by 195
    chunks; `call` alone covers 102 and `default` 33.

    So: first export, disambiguated when it collides by appending the next
    exports until the name is unique. That keeps the common case (1454 of 1649
    chunks) a clean stable symbol name, and keeps the colliding ones stable too
    — they depend only on the chunk's own export list, not on its position.
    A chunk exporting nothing at all (34 on 2.1.259) falls back to its index,
    which is NOT release-stable; those are noted in the return value so callers
    can report the number rather than discover it later.
    """
    # Pass 1: how many chunks want each candidate name.
    wanted = defaultdict(int)
    for c in chunks:
        if c["exports"]:
            wanted[c["exports"][0]] += 1

    used = set()
    names = []
    unstable = 0
    for idx, c in enumerate(chunks):
        exports = [e for e in c["exports"] if IDENT_RE.match(e)]
        if not exports:
            name = f"chunk{idx:04d}"
            unstable += 1
        elif wanted[c["exports"][0]] == 1:
            name = exports[0]
        else:
            # Extend with further exports until unique among all chunks.
            name = exports[0]
            for extra in exports[1:]:
                if name not in used:
                    break
                name = f"{name}_{extra}"
        # Last-resort tiebreak: identical export lists (e.g. two chunks that
        # export only `call`). Index is not stable, so count it as such.
        if name in used:
            name = f"{name}_{idx:04d}"
            unstable += 1
        used.add(name)
        names.append(name)
    return names, unstable


def emit_splitter_compat(chunks, outdir):
    """Write the chunks in tools/splitter.py's own output layout.

    build.sh step 2 (deob.ts) reuses `.deob_cache/modules/` verbatim when a
    `_manifest.json` is already there, so producing that exact contract is the
    whole integration: matcher.ts, emitter.ts, module-reconstruct.ts, renamer.ts,
    prettify.ts and apply-scoped-renames.ts then run UNCHANGED on a chunked
    build. Every chunk is a `section`; there is no preamble and no tail, because
    a chunked build has no shared runtime preamble to carve off.
    """
    os.makedirs(outdir, exist_ok=True)
    names, unstable = module_names(chunks)

    sections = []
    for idx, (c, name) in enumerate(zip(chunks, names)):
        filename = f"{idx:04d}_{name}.js"
        with open(os.path.join(outdir, filename), "w") as fh:
            fh.write(c["text"])
        sections.append(
            {
                "index": idx,
                "filename": filename,
                "type": "section",
                "size": len(c["text"]),
                "module_name": name,
                # Chunks are ESM; splitter.py records the wrapper var name here,
                # and downstream only ever compares/echoes it.
                "module_kind": "esm",
                "has_glue": False,
                "hints": chunk_hints(c),
            }
        )

    manifest = {
        "source_file": "chunks",
        "source_size": sum(s["size"] for s in sections),
        "section_count": len(sections),
        "sections": sections,
    }
    with open(os.path.join(outdir, "_manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    return manifest, unstable


def chunk_hints(chunk):
    """The `hints` splitter.py attaches; emitter.ts reads hints.requires to
    classify a module as vendor. For a chunk the equivalent of a require() is
    its import specifiers, but those are all /$bunfs paths, which emitter.ts
    explicitly excludes from the vendor test — so only real bare requires count.
    """
    text = chunk["text"]
    hints = {}
    requires = re.findall(r'require\("([^"]+)"\)', text[:5000])
    if requires:
        hints["requires"] = list(dict.fromkeys(requires))[:10]
    strings = re.findall(r'"([A-Za-z][\w\-\./ ]{5,80})"', text[:10000])
    seen, unique = set(), []
    for s in strings:
        if s not in seen and s not in ("object", "function", "string", "number", "create"):
            seen.add(s)
            unique.append(s)
    if unique:
        hints["strings"] = unique[:10]
    return hints


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__.strip().splitlines()[-2])
    binary, outdir = sys.argv[1], sys.argv[2]
    manifest_path = None
    if "--manifest" in sys.argv:
        manifest_path = sys.argv[sys.argv.index("--manifest") + 1]
    splitter_compat = "--splitter-compat" in sys.argv

    if not is_chunked(binary):
        raise SystemExit(
            f"{binary} contains the monolithic bundle marker — it is a <=2.1.241 "
            "build. Use the fetch-versionref.sh slicer, not this extractor."
        )

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
    # Report the TRUE denominator. Printing only "resolved/clause-imports" reads
    # as full coverage — it was reported as "100% of imports" once, when it was
    # 13.3%. Side-effect imports are shown on the same line so the two numbers
    # cannot be separated from each other.
    all_imports = stats["imports"] + stats["side_effect"]
    pct = (100.0 * stats["resolved"] / all_imports) if all_imports else 0.0
    print(
        f"  clause imports : {stats['resolved']}/{stats['imports']} resolved"
        f"  ambiguous={stats['ambiguous']}  unresolved={stats['unresolved']}"
    )
    print(
        f"  side-effect    : {stats['side_effect']:,} UNRESOLVABLE by symbol"
        f" intersection (they name no symbols)"
    )
    print(f"  TOTAL COVERAGE : {stats['resolved']:,}/{all_imports:,} = {pct:.1f}%")
    # A partially-resolved graph is worse than a loud failure: downstream stages
    # would silently treat unresolved edges as absent dependencies. Checked
    # BEFORE the splitter-compat emission so a bad graph cannot produce a
    # `.deob_cache/modules/` that deob.ts would then happily reuse from cache.
    if stats["imports"] and stats["resolved"] != stats["imports"]:
        print(
            "  WARNING: graph incomplete — symbol-intersection did not pin every "
            "import. Do not build on this until it is explained.",
            file=sys.stderr,
        )
        return 1

    if splitter_compat:
        compat, unstable = emit_splitter_compat(chunks, outdir)
        print(f"  splitter-compat: {compat['section_count']} sections in {outdir}")
        print(f"  index-derived module names (not release-stable): {unstable}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
