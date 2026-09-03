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

  ⚠️ Such a tree still PARSES — a side-effect import of a missing path is
  syntactically valid — so an ESM parse gate cannot catch this. It surfaces at
  reassembly or at runtime.

  📌 CORRECTED 2026-09-03. The limit is structural PER IMPORT SITE but NOT per
  SPECIFIER, and the difference is almost the whole problem. A bunfs specifier is
  a CONTENT-HASHED FILENAME, so it names the same chunk everywhere in the bundle.
  Once any clause import anywhere has pinned `chunk-8nmvz1t1.js` to index N, that
  binding holds for every bare `import"…8nmvz1t1.js"` too. So the per-chunk
  tables collapse into ONE bundle-wide specifier->index table.
  MEASURED on 2.1.259: 876 distinct specifiers are clause-resolved and ZERO
  resolve to two different indices, so the collapse is lossless; it lifts
  side-effect coverage from 0 to 85,563 of 86,438 SITES (98.99%). The table is
  built and applied in module-reconstruct.ts retargetChunkImports(), which raises
  the retarget count from 12,905 to 98,880.
  The residue is 875 sites naming 5 specifiers that are referenced ONLY by bare
  side-effect imports — no clause, no dynamic, no import.meta.require site names
  them anywhere — so no symbol-bearing reference exists to intersect. Those 5 are
  genuinely irreducible under this method and are listed by name at retarget time.

  ⛔ RETRACTED — "MEASURED AND REJECTED: the bunfs path table as an alternative
  key". That verdict was WRONG, it stood here as settled fact, and it very nearly
  cost the whole chunked port. Read the retraction before trusting any other
  "rejected" note in this file.

  What it said: zipping the table against body order fails because the two are
  uncorrelated — each resolved specifier's first occurrence outside a chunk body,
  sorted by offset, gives a chunk-index sequence increasing 528/875 = 60.3% of
  adjacent pairs, against 49.8% for a shuffled control. Those numbers are real
  and reproducible.

  Why it was wrong: THEY MEASURE THE WRONG BYTES. "First occurrence outside a
  body" lands in the BYTECODE STRING-INTERNING POOLS at ~70/77 MB, which are
  scattered by construction and so genuinely score ~60%. The real module table is
  a single 109,643-byte run of NUL-terminated `/$bunfs/root/` strings at offset
  199,408,182 — found STRUCTURALLY (exactly one run of >=20 such strings
  qualifies), not by a heuristic over every occurrence. Against it: 875/875 =
  100.0% adjacent-increasing on the independently symbol-pinned specifiers, and
  1642 names vs 1649 bodies with exactly 7 non-uniform steps summing to exactly 7
  — every gap closed, interpolation forced, 0 ambiguous.

  ⚠️ THE LESSON, because this file is where the next person will look: a control
  that fires (49.8% shuffled vs 60.3% real) proves the STATISTIC discriminates.
  It says nothing about whether the sample is the right sample. Both this note
  and a later independent re-test (voting 99 .zst entries against 141 zstd
  frames, best base agreeing 2/99) were confidently wrong the same way, and the
  agreement between two wrong measurements read as confirmation.

  Injectivity is what finally adjudicated: the table map is injective (0 of 1642
  double-claimed) while the symbol-derived map is not (4 indices claimed 2-3x,
  which is impossible), and all 6 disagreements sit on exactly those over-claimed
  indices. Prefer a structural invariant over a correlation score.

Usage:
  extract_chunks.py <claude-binary> <out-dir> [--manifest manifest.json]
                    [--splitter-compat]

  --splitter-compat additionally emits the layout tools/splitter.py produces
  (NNNN_<module_name>.js + _manifest.json), so build.sh step 2 and everything
  after it consume a chunked build unchanged. See emit_splitter_compat().
"""
import bisect
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
# The same clause NOT anchored to end of text — used only to recover chunks whose
# named export is followed by an `export default`. See the owner map in extract().
ANY_EXPORT_RE = re.compile(r"export\s*\{([^}]*)\}")

# Shared by destructured_names() and module_names().
IDENT_RE = re.compile(r"^[A-Za-z_$][\w$]*$")

# ---------------------------------------------------------------------------
# DYNAMIC specifiers: `import(...)` and `import.meta.require(...)`.
#
# These are the LAZY-LOAD edges. The app is lazily loaded — the entry chunk
# reaches `main` through a dynamic import, so the static closure is only 6 of
# 1649 chunks — and they must STAY dynamic in the rebuilt bundle: a probe build
# that forced all 1649 chunks to evaluate eagerly printed the right version and
# then crashed, because a chunk that is lazy upstream eagerly invoked a native
# image-processor.node load.
#
# They resolve by the SAME exported-symbol intersection as clause imports,
# because a dynamic site usually names symbols too:
#     let{profileCheckpoint:m}=await import("/$bunfs/root/chunk-z8bmvqx9.js")
# Each shape below is a different way a site names them. All of them feed one
# intersection per specifier, so several weak sites can pin a chunk no single
# site could.
#
# ⚠️ A dynamic specifier and a static one are DISJOINT populations here.
# MEASURED on 2.1.259: of 757 distinct dynamic specifiers, ZERO also appear as a
# static import, so the bundle-wide static table contributes NOTHING to them —
# they must be resolved on their own evidence. (That also means the two tables
# cannot contradict each other, and measured they do not: 0 conflicts.)
# ---------------------------------------------------------------------------
_SPEC = r"/\$bunfs/root/[^\"']+"

# NOTE: these are built by CONCATENATION, not str.format — the patterns contain
# regex braces (`\{`, `{2}`) that .format() would try to interpret as fields.
#
# `let{a:x,b:y} = await import("spec")` / `= import.meta.require("spec")`
DYN_DESTRUCTURE_RE = re.compile(
    r"\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:import|import\.meta\.require)"
    r"\s*\(\s*[\"'](" + _SPEC + r")[\"']\s*\)"
)
# `import("spec").then(({a:x}) => ...)`
DYN_THEN_DESTRUCTURE_RE = re.compile(
    r"(?:import|import\.meta\.require)\s*\(\s*[\"'](" + _SPEC + r")[\"']\s*\)"
    r"\s*\.then\s*\(\s*(?:async\s*)?\(?\{([^{}]*)\}"
)
# `import("spec").then(m => m.sym)` — backreference ties the param to its use.
DYN_THEN_MEMBER_RE = re.compile(
    r"(?:import|import\.meta\.require)\s*\(\s*[\"'](" + _SPEC + r")[\"']\s*\)"
    r"\s*\.then\s*\(\s*(?:async\s*)?\(?([\w$]+)\)?\s*=>\s*\2\.([\w$]+)"
)
# `(await import("spec")).sym`
DYN_AWAIT_MEMBER_RE = re.compile(
    r"\(\s*await\s+import\s*\(\s*[\"'](" + _SPEC + r")[\"']\s*\)\s*\)\s*\.([\w$]+)"
)
# `import.meta.require("spec").sym`
DYN_DIRECT_MEMBER_RE = re.compile(
    r"(?:import\.meta\.require|import)\s*\(\s*[\"'](" + _SPEC + r")[\"']\s*\)"
    r"\s*\.([\w$]+)"
)
# `let[{a},{b}] = await Promise.all([import(s1), import(s2)])` — positional.
DYN_PROMISE_ALL_RE = re.compile(
    r"\[([^\[\]]*)\]\s*=\s*await\s+Promise\.all\(\s*\[([^\[\]]*)\]\s*\)"
)
# `X = import.meta.require("spec")` binding a NAMESPACE, whose members are then
# read as `X.sym` elsewhere in the same chunk.
# `X = import.meta.require("spec")` and the THUNK form
# `X = () => import.meta.require("spec")`, whose members are read as `X().sym`.
# Both bind the namespace to X; only the read shape differs, and
# namespace_members() understands both.
DYN_NAMESPACE_RE = re.compile(
    r"([\w$]+)\s*=\s*(?:\(\s*\)\s*=>\s*)?(?:await\s+)?"
    r"(?:import\.meta\.require|import)"
    r"\s*\(\s*[\"'](" + _SPEC + r")[\"']\s*\)"
)
# Every dynamic SITE, for the coverage denominator.
DYN_SITE_RE = re.compile(
    r"\b(?:import|import\.meta\.require)\s*\(\s*[\"'](" + _SPEC + r")[\"']"
)
# A bare quoted specifier, used to pick the specifier out of one Promise.all
# element once the elements have been split positionally.
QUOTED_SPEC_RE = re.compile(r"[\"'](" + _SPEC + r")[\"']")

# A namespace variable whose members are read more than this many times is
# almost certainly not a module namespace (it is a plain object being used
# heavily), so only its first member is used as evidence rather than
# intersecting a large set that would empty out on one false member.
NAMESPACE_MEMBER_LIMIT = 8

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


# ---------------------------------------------------------------------------
# THE BUNFS MODULE TABLE — the direct specifier -> chunk-index key.
#
# 🔴 THIS SUPERSEDES THE DOCSTRING'S "MEASURED AND REJECTED" VERDICT ON THE PATH
# TABLE. That rejection was real but it measured the WRONG BYTES. It took "each
# resolved specifier's FIRST occurrence outside any chunk body" — which lands in
# the bytecode STRING-INTERNING POOLS (measured: dense clusters at ~69.9 MB and
# ~77.5 MB, where bunfs paths sit interleaved with unrelated literals like
# "getNativeModule" and "claude_code_github_action") — and correctly found that
# pool order carries no module order: 60.3% adjacent-increasing against a 49.8%
# shuffled control.
#
# There IS a real table, and it is somewhere else: ONE contiguous run of
# NUL-terminated /$bunfs/root/ strings, 109,643 bytes at offset 199,408,182 on
# 2.1.259. It is found by structure, not by a hardcoded offset — the run regex
# below requires >=20 consecutive entries, and MEASURED on 2.1.259 exactly ONE
# run in the whole binary qualifies, so there is nothing to choose between.
#
# MEASURED on 2.1.259, and this is the check that makes it usable rather than
# plausible: the table's first-occurrence order for chunk-*.js names is an exact
# ORDER-ISOMORPHISM onto body order. Against the 876 specifiers independently
# pinned by symbol intersection, adjacent pairs are increasing 875/875 = 100.0%
# (the rejected pool scored 60.3%). The table holds 1642 distinct chunk names to
# 1649 bodies, and the alignment has exactly 7 non-uniform steps summing to
# exactly 7 — the 7 bodies (5, 8, 10, 12, 14, 16, 23) that carry no VFS path
# because bun never gave them one. So every gap is closed and interpolation is
# forced, not fitted: all 1642 names map, ZERO ambiguous.
#
# WHY IT MATTERS: symbol intersection can only see a chunk that EXPORTS NAMED
# SYMBOLS. A chunk whose only export is `export default` contributes nothing to
# any owner set and can never be the result of an intersection — measured, 27 of
# 1649 chunks on 2.1.259 — and the consumers that crashed the rebuild read
# exactly `.default`. The table does not care what a chunk exports.
#
# 🔴 IT IS ALSO MORE CORRECT THAN THE SYMBOL METHOD, NOT MERELY WIDER. A
# specifier names one chunk, so the map MUST be injective. MEASURED on 2.1.259:
# the table map is injective (0 indices claimed twice of 1642), while the
# symbol-derived dynamic table is NOT — 4 indices are claimed by 2-3 specifiers
# each, which is impossible. The two tables disagree on 6 of their 505 shared
# specifiers, and all 6 sit on exactly those over-claimed indices; the table
# assigns each collision's members to distinct chunks whose bodies match the
# consumers. So on every observed conflict the table is right and the
# intersection over-claimed, which is why check_table_agrees_with_symbols()
# below treats a disagreement outside that pattern as fatal rather than
# tie-breaking silently.
# ---------------------------------------------------------------------------
BUNFS_TABLE_RUN_RE = re.compile(rb"(?:/\$bunfs/root/[!-~]{1,120}\x00){20,}")
BUNFS_CHUNK_NAME_RE = re.compile(r"^/\$bunfs/root/chunk-[a-z0-9]+\.js$")


def bunfs_table_order(data):
    """The chunk-*.js specifiers in bunfs module-table order, deduplicated.

    Returns [] when no table is found, which is a legitimate outcome for a build
    whose packaging changed — callers fall back to symbol intersection alone
    rather than failing, because that is what produced every working build so
    far.

    The table lists most names TWICE (a `chunk-x.js` / `chunk-x.js` pair per
    entry on 2.1.259) and also carries non-chunk paths (`/$bunfs/root/cli`,
    `*.node`, `*.md`). First-occurrence order over the chunk-*.js subset is what
    aligns with body order; dict.fromkeys preserves it.
    """
    runs = BUNFS_TABLE_RUN_RE.findall(data)
    if not runs:
        return []
    # The module table is the single large run; interning-pool fragments are
    # short and interleaved with non-path literals, so they cannot form a run of
    # >=20 consecutive bunfs paths. Taking the longest is a tiebreak that has
    # never had to fire (measured: exactly one qualifying run on 2.1.259).
    blob = max(runs, key=len)
    names = []
    for raw in blob.split(b"\x00"):
        if not raw:
            continue
        try:
            s = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if BUNFS_CHUNK_NAME_RE.match(s):
            names.append(s)
    return list(dict.fromkeys(names))


def bunfs_specifier_map(data, anchors, total_bodies=None):
    """specifier -> chunk index, from the bunfs table aligned by `anchors`.

    `anchors` is {specifier: index} already pinned by symbol intersection. They
    are what ties table POSITION to body INDEX: the table gives a total order but
    no absolute numbering, so without at least one anchor it says nothing.

    Between two anchors whose table gap and body gap are EQUAL, every name in
    between is forced and is filled in. Where the gaps differ, unnamed bodies sit
    in the interval and the assignment is NOT determined — those names are left
    out rather than guessed, which is the same refusal the rest of this file
    makes for an ambiguous intersection.

    Returns ({}, reason) when the table cannot be used at all.
    """
    order = bunfs_table_order(data)
    if not order:
        return {}, "no bunfs module table found"
    pos = {spec: i for i, spec in enumerate(order)}
    pairs = sorted((pos[s], idx) for s, idx in anchors.items() if s in pos)
    if len(pairs) < 2:
        return {}, f"only {len(pairs)} anchors land in the table"

    # The table is only usable if its order AGREES with body order on the
    # anchors. A single inversion means the two are not the same sequence and
    # every interpolation below would be fiction.
    inversions = sum(1 for a, b in zip(pairs, pairs[1:]) if b[1] <= a[1])
    if inversions:
        return {}, (
            f"table order is not monotonic in body order "
            f"({inversions} inversions over {len(pairs)} anchors)"
        )

    table_pos = [p for p, _ in pairs]
    body_idx = [b for _, b in pairs]
    out = {}
    for k, spec in enumerate(order):
        j = bisect.bisect_left(table_pos, k)
        if j < len(table_pos) and table_pos[j] == k:
            out[spec] = body_idx[j]
            continue
        if j == 0:
            # Before the first anchor there is no lower bound, so an unnamed body
            # out there would shift every name silently. Skipped, not guessed.
            continue
        if j == len(table_pos):
            # AFTER the last anchor there normally is no bound either — except
            # when the counts leave no slack. If the names remaining after the
            # last anchor exactly equal the bodies remaining after it, every one
            # of those bodies must be named and the assignment is FORCED, not
            # fitted: one unnamed body in the tail would make the two counts
            # differ, so this is a real arithmetic constraint rather than an
            # assumption that the tail is dense.
            #
            # MEASURED on 2.1.259: last anchor is table 1616 -> body 1623,
            # leaving 25 names and 25 bodies. The forced assignment is then
            # cross-checked against evidence the table did not supply — 17 of
            # those 25 specifiers were independently resolved by dynamic symbol
            # intersection, and all 17 AGREE with the forced tail, 0 conflicts.
            # (Without this branch those 4 stragglers stay unresolved: measured
            # 753/757 dynamic specifiers instead of 757/757.)
            if total_bodies is None:
                continue
            last_p, last_b = table_pos[-1], body_idx[-1]
            if (len(order) - 1 - last_p) != (total_bodies - 1 - last_b):
                continue
            out[spec] = last_b + (k - last_p)
            continue
        lo_p, lo_b = table_pos[j - 1], body_idx[j - 1]
        hi_p, hi_b = table_pos[j], body_idx[j]
        if hi_p - lo_p == hi_b - lo_b:
            out[spec] = lo_b + (k - lo_p)
    return out, None


def check_table_map(table_map, symbol_map, label, exempt=()):
    """Fail loudly if the table map is not injective or contradicts `symbol_map`.

    Two properties are asserted, and they are different checks:

    INJECTIVITY is a property of the table alone. A specifier is a content-hashed
    filename naming ONE chunk, so two specifiers mapping to one index means the
    alignment slipped. Measured on 2.1.259 the table map is injective and the
    symbol-derived dynamic map is not, which is the evidence that the table is
    the better key rather than merely the wider one.

    AGREEMENT is checked only where the symbol method itself is trustworthy —
    against indices it claims EXACTLY ONCE. Where symbol intersection
    over-claimed an index (measured: 4 indices, 2-3 claimants each), it is known
    wrong by the injectivity argument above, so counting those as disagreements
    would reject the correct table on the strength of the broken one.
    """
    dupes = defaultdict(list)
    for spec, idx in table_map.items():
        dupes[idx].append(spec)
    collided = {i: s for i, s in dupes.items() if len(s) > 1}
    if collided:
        sample = list(collided.items())[:3]
        raise SystemExit(
            f"bunfs table map is not injective ({len(collided)} chunk indices "
            f"claimed by more than one specifier, e.g. {sample}). The table's "
            f"order no longer aligns with body order; refusing to build on it."
        )

    sym_claims = defaultdict(list)
    for spec, idx in symbol_map.items():
        sym_claims[idx].append(spec)
    disagree = [
        (spec, symbol_map[spec], table_map[spec])
        for spec in symbol_map
        if spec in table_map
        and symbol_map[spec] != table_map[spec]
        and len(sym_claims[symbol_map[spec]]) == 1
        and spec not in exempt
    ]
    if disagree:
        raise SystemExit(
            f"bunfs table disagrees with {len(disagree)} unambiguous {label} "
            f"symbol resolutions, e.g. {disagree[:5]}. Two independent methods "
            f"contradicting each other means one is wrong; refusing to guess."
        )
    return len(collided)


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


def destructured_names(clause):
    """Source-side names from an object destructuring pattern.

    `{a: x, b, c = 1}` READS a, b and c — the local aliases (x) are irrelevant,
    because what pins the chunk is which symbols it EXPORTS. Anything that is
    not a plain identifier (rest elements, nested patterns, computed keys) is
    dropped rather than guessed: a wrong name would empty the intersection and
    silently turn a resolvable specifier into an unresolved one.
    """
    out = []
    for part in clause.split(","):
        part = part.strip()
        if not part:
            continue
        name = part.split(":")[0].strip().split("=")[0].strip()
        if IDENT_RE.match(name):
            out.append(name)
    return out


def split_top_level(text):
    """Split on commas that are not nested inside (), [] or {}."""
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return parts


def namespace_members(text, var, owner):
    """Symbols read off a variable that holds a module NAMESPACE.

    `X = await import("spec")` (or a bare positional binding in a Promise.all)
    names no symbols at the import itself — they appear later as `X.sym`. Those
    member reads are the evidence.

    Only members that SOME chunk exports are kept: a read of a plain property
    would otherwise empty the intersection and lose an otherwise-resolvable
    specifier. Above NAMESPACE_MEMBER_LIMIT reads the variable is more likely a
    plain object than a namespace.

    ⚠️ IN THAT CASE THE ANSWER IS "NO EVIDENCE", NOT "THE FIRST MEMBER".
    Returning `members[:1]` looked conservative and was actively harmful: it is
    the ALPHABETICALLY first surviving member of a variable already judged not
    to be a namespace, so it contributes a chunk index chosen essentially at
    random, and because every site's evidence is INTERSECTED, one such guess
    empties the set and loses a specifier that other sites had pinned
    correctly.

    MEASURED on 2.1.259: `/$bunfs/root/chunk-jhsvw76x.js` is destructured at
    real sites naming `getCoordinatorSystemPrompt` and `isCoordinatorMode`,
    both owned by chunk 930 alone — a clean, unambiguous resolution. But the
    same specifier is also assigned to a variable used as a plain object with
    30 member reads (`abort`, `cursorOffset`, `signal`, …), of which exactly one
    (`id`) happens to be exported by an unrelated chunk 778. The old rule
    returned `['id']`, the intersection 930 ∩ 778 came out empty, and the
    specifier stayed unresolved — which is what made the rebuilt binary die
    with "Cannot find module 'claudiverse-unresolved-chunk:…chunk-jhsvw76x.js'"
    on the first real turn.

    ⚠️ THE LIMIT IS APPLIED TO THE RAW READ COUNT, BEFORE FILTERING. Applying
    it after the `m in owner` filter measures the wrong thing: the poisoning
    variable above has 30 member reads but only ONE of them (`id`) is exported
    by any chunk, so the post-filter count is 1, the "not a namespace" test
    never fires, and the single spurious member is returned as if it were
    evidence. Judging plain-object-ness on how the variable is USED is the
    whole point of the heuristic.

    Two read shapes count, because both appear in this bundle:
      `X.sym`   — X holds the namespace directly;
      `X().sym` — X is a THUNK, `X = () => import.meta.require(spec)`, so the
                  members are read off the call result.
    The thunk form is not a stylistic variant to be tidied away: measured on
    2.1.259, `/$bunfs/root/chunk-3tvkz7s9.js` has FOUR sites and every one is a
    bare binding whose only evidence is `ihe().detectSurfaces`,
    `ihe().engineFor`, `ihe().sinksFor`, `ihe().watchedForSurfaces` — all four
    owned by chunk 923 alone. Matching only `X.sym` saw no evidence at all and
    left the specifier unresolved, which is what made the rebuilt binary die
    with "Cannot find module 'claudiverse-unresolved-chunk:…chunk-3tvkz7s9.js'".
    """
    direct = set(re.findall(r"\b" + re.escape(var) + r"\.([\w$]+)\b", text))
    thunk = set(re.findall(r"\b" + re.escape(var) + r"\(\)\.([\w$]+)\b", text))
    # `X().sym` also matches the `X.sym`-style scan? No: the `\.` there is
    # preceded by `)`, not by the identifier, so the two sets are disjoint and
    # the counts below do not double-count.
    raw = direct | thunk
    if len(raw) > NAMESPACE_MEMBER_LIMIT:
        return []
    members = sorted(m for m in raw if m in owner)
    return members


def symbol_origin(chunk, sym):
    """Where does `chunk` get the value it exports as `sym`?

    Returns ("import", source_spec, source_name) when the exported local binding
    is one this chunk IMPORTED — i.e. the chunk is a re-export facade for that
    symbol and the real definition lives elsewhere — or None when the binding is
    defined locally (or cannot be traced), which is deliberately NOT treated as
    equivalent to anything.
    """
    m = EXPORT_RE.search(chunk["text"].rstrip())
    if not m:
        return None
    local = None
    for part in m.group(1).split(","):
        part = part.strip()
        if not part:
            continue
        bits = part.split(" as ")
        if bits[-1].strip() == sym:
            local = bits[0].strip()
            break
    if local is None:
        return None
    for clause, spec in IMPORT_RE.findall(chunk["text"]):
        for part in clause.split(","):
            part = part.strip()
            if not part:
                continue
            bits = part.split(" as ")
            if bits[-1].strip() == local:
                return ("import", spec, bits[0].strip())
    return None


def equivalent_reexporters(chunks, indices, syms):
    """Do all `indices` re-export the SAME definition for every symbol in `syms`?

    WHY THIS EXISTS. A specifier whose owner set has more than one chunk is
    normally unresolvable and is dropped, because picking one would silently
    load the wrong module. But some ambiguity is not a real choice: upstream
    emits several small FACADE chunks that re-export one definition, so two
    candidates can be provably interchangeable *for the symbols actually read*.

    MEASURED case on 2.1.259, which is why this is here rather than a
    hypothetical: `chunk-yb117e5b.js` is read at 3 sites and every one of them
    reads only `END_CONVERSATION_TOOL_NAME`. Its owner set is chunks 827 and
    948 — different export sets overall (11 symbols vs 2), so they are NOT the
    same module — but BOTH obtain that one symbol by `import{Ab}from
    "/$bunfs/root/chunk-kc9zg8bj.js"`. The value handed to the call site is
    therefore identical whichever is chosen.

    The test is per-SYMBOL and requires an IMPORTED origin from an identical
    (specifier, source-name) pair in every candidate. A locally DEFINED binding
    returns None from symbol_origin and fails the check, because two chunks
    defining their own `Ab` would be two different values that merely share a
    name — exactly the silent-wrong-module case this whole resolver refuses.

    BOUND: this establishes equivalence only for `syms` — the symbols some site
    was observed to read. It does NOT claim the candidates are interchangeable
    in general, and they usually are not.
    """
    if not syms:
        return False
    for sym in syms:
        origins = set()
        for idx in indices:
            o = symbol_origin(chunks[idx], sym)
            if o is None:
                return False
            origins.add(o)
        if len(origins) != 1:
            return False
    return True


def resolve_dynamic(chunks, owner):
    """Resolve dynamic/import.meta.require specifiers to chunk indices.

    Returns (spec -> index, stats). Evidence from EVERY site naming a specifier
    is intersected together, so two sites that each leave several candidates can
    still pin one chunk between them.

    A specifier is emitted ONLY when the intersection is exactly one chunk.
    Ambiguous (>1) and empty (0) intersections are counted and dropped — an
    unresolved lazy edge degrades to the specifier being left alone, which is
    recoverable, whereas a WRONG edge silently loads the wrong module at
    runtime and is not.
    """
    candidates = defaultdict(list)
    # Every symbol any site reads off a specifier, kept alongside the candidate
    # sets so an ambiguous specifier can be re-examined per-symbol below.
    needed_syms = defaultdict(set)

    def observe(spec, syms):
        syms = [s for s in syms if s]
        if not syms:
            return
        needed_syms[spec].update(syms)
        inter = None
        for sym in syms:
            owners = owner.get(sym, set())
            inter = set(owners) if inter is None else (inter & owners)
        candidates[spec].append(inter or set())

    for c in chunks:
        text = c["text"]
        for clause, spec in DYN_DESTRUCTURE_RE.findall(text):
            observe(spec, destructured_names(clause))
        for spec, clause in DYN_THEN_DESTRUCTURE_RE.findall(text):
            observe(spec, destructured_names(clause))
        for spec, _param, sym in DYN_THEN_MEMBER_RE.findall(text):
            observe(spec, [sym])
        for spec, sym in DYN_AWAIT_MEMBER_RE.findall(text):
            observe(spec, [sym])
        for spec, sym in DYN_DIRECT_MEMBER_RE.findall(text):
            observe(spec, [sym])

        # Positional Promise.all destructuring. The left and right sides must
        # have the SAME element count or the positions do not correspond — the
        # right side may hold non-bunfs entries such as import("path"), and
        # dropping those would shift every position after them.
        for lhs, rhs in DYN_PROMISE_ALL_RE.findall(text):
            targets = split_top_level(rhs)
            bindings = split_top_level(lhs)
            if len(targets) != len(bindings):
                continue
            for binding, target in zip(bindings, targets):
                spec_m = QUOTED_SPEC_RE.search(target)
                if not spec_m:
                    continue
                binding = binding.strip()
                pattern = re.match(r"^\{(.*)\}$", binding, re.S)
                if pattern:
                    observe(spec_m.group(1), destructured_names(pattern.group(1)))
                elif IDENT_RE.match(binding):
                    # A BARE positional binding — `let[o,{a},{b}] = await
                    # Promise.all([...])` — binds the whole namespace, so the
                    # symbols are the members read off it later.
                    observe(spec_m.group(1), namespace_members(text, binding, owner))

        # Namespace binding: X = import.meta.require("spec"), read later as X.sym.
        for var, spec in DYN_NAMESPACE_RE.findall(text):
            observe(spec, namespace_members(text, var, owner))

    resolved = {}
    stats = {
        "evidenced": len(candidates),
        "ambiguous": 0,
        "empty": 0,
        "facade_tiebreak": 0,
        # Specifiers whose index was chosen ARBITRARILY among value-equivalent
        # candidates. Not evidence of identity — see the facade_tiebreak branch.
        "tiebroken": set(),
    }
    for spec, sets in candidates.items():
        inter = None
        for s in sets:
            if not s:
                continue
            inter = set(s) if inter is None else (inter & s)
        if not inter:
            stats["empty"] += 1
        elif len(inter) == 1:
            resolved[spec] = next(iter(inter))
        elif equivalent_reexporters(chunks, inter, needed_syms[spec]):
            # Not a guess about the VALUE: every surviving candidate was shown to
            # hand back the SAME binding, from the same chunk, for every symbol
            # any site reads off this specifier. See equivalent_reexporters.
            #
            # ⚠️ But it IS a guess about the IDENTITY. `min(inter)` picks the
            # lowest-numbered candidate, which is arbitrary — the claim proved is
            # only that the candidates are interchangeable for `syms`, not that
            # this one is the chunk the specifier names. So these are recorded in
            # `tiebroken` and EXEMPTED from the bunfs-table agreement check:
            # counting an arbitrary pick as an unambiguous resolution would let
            # it veto the table. MEASURED on 2.1.259, chunk-yb117e5b.js is
            # exactly this case — tiebroken to 827 (a 3,692-byte module) while
            # the table says 948, a 124-byte facade exporting precisely the one
            # symbol every site reads. The table is right and the tiebreak was
            # arbitrary, which is why it must not be treated as evidence.
            stats["facade_tiebreak"] += 1
            stats["tiebroken"].add(spec)
            resolved[spec] = min(inter)
        else:
            stats["ambiguous"] += 1
    return resolved, stats


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
    #
    # EXPORT_RE is anchored to END OF TEXT, so it sees a named export clause only
    # when nothing follows it. MEASURED on 2.1.259 that loses 2 chunks (1313,
    # 1439) whose `export{...}` is followed by an `export default`, e.g.
    #   ...;export{E as EventStreamSerde};export default {get EventStreamSerde(){…}};
    # Their symbols were absent from every owner set, so no import naming them
    # could resolve. ANY_EXPORT_RE is the same clause without the anchor, and the
    # two are unioned rather than swapped: the anchored form is what the rest of
    # this file (symbol_origin, module_names) agrees with for the ordinary case.
    owner = defaultdict(set)
    for idx, c in enumerate(chunks):
        m = EXPORT_RE.search(c["text"].rstrip())
        c["exports"] = local_names(m.group(1)) if m else []
        extra = []
        if not m:
            for clause in ANY_EXPORT_RE.findall(c["text"]):
                extra.extend(local_names(clause))
        for sym in c["exports"] + extra:
            owner[sym].add(idx)

    # Resolve every import to a chunk index by intersecting owner sets.
    stats = {
        "imports": 0,
        "resolved": 0,
        "ambiguous": 0,
        "unresolved": 0,
        "side_effect": 0,
        "side_effect_unresolved": 0,
        "side_effect_unresolved_specs": 0,
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

    # Score the side-effect sites against the bundle-wide specifier table — the
    # same table module-reconstruct.ts rebuilds from this manifest — so the
    # coverage reported is the coverage step 2.5 will actually reach, not an
    # optimistic or a pessimistic proxy for it.
    resolved_specs = {
        imp["path"]
        for c in chunks
        for imp in c["imports"]
        if imp["target"] is not None
    }
    missing = set()
    for c in chunks:
        for spec in SIDE_EFFECT_IMPORT_RE.findall(c["text"]):
            if spec not in resolved_specs:
                stats["side_effect_unresolved"] += 1
                missing.add(spec)
    stats["side_effect_unresolved_specs"] = len(missing)

    # THE BUNFS MODULE TABLE. Built from the specifiers symbol intersection
    # already pinned (they anchor table position to body index) and then used to
    # resolve every OTHER specifier the table names — including the ones symbol
    # intersection is structurally blind to, i.e. chunks whose only export is
    # `export default`. See bunfs_specifier_map().
    static_map = {}
    for c in chunks:
        for imp in c["imports"]:
            if imp["target"] is not None:
                static_map[imp["path"]] = imp["target"]
    table_map, table_reason = bunfs_specifier_map(
        data, static_map, total_bodies=len(chunks)
    )
    stats["table_specs"] = len(table_map)
    stats["table_reason"] = table_reason

    # Dynamic (lazy) edges, resolved on their OWN symbol evidence — the static
    # table cannot help, since the two specifier populations are disjoint.
    dynamic, dyn_stats = resolve_dynamic(chunks, owner)

    # Cross-check BEFORE anything consumes the table: injective, and consistent
    # with every symbol resolution the symbol method itself claims unambiguously.
    if table_map:
        check_table_map(table_map, static_map, "static")
        check_table_map(
            table_map, dynamic, "dynamic", exempt=dyn_stats["tiebroken"]
        )

    # The table is authoritative where the two differ, but only in the exact
    # place that was ADJUDICATED: an index the symbol method claimed more than
    # once cannot be right for every claimant, and check_table_map has already
    # made any other kind of disagreement fatal.
    stats["dyn_corrected"] = 0
    stats["dyn_added"] = 0
    dyn_named = set()
    for c in chunks:
        dyn_named.update(DYN_SITE_RE.findall(c["text"]))
    for spec, idx in table_map.items():
        if spec in dynamic:
            if dynamic[spec] != idx:
                dynamic[spec] = idx
                stats["dyn_corrected"] += 1
        elif spec in dyn_named:
            # A dynamic specifier the symbol method never reached — typically a
            # default-only chunk (no named exports to intersect) or a site that
            # names no symbols. The table knows it regardless of what it exports.
            dynamic[spec] = idx
            stats["dyn_added"] += 1

    # The static side-effect residue: specifiers named ONLY by bare
    # `import"/$bunfs/…"`, which module-reconstruct.ts otherwise DROPS, silently
    # losing that module's load-time side effect. They are unreachable by symbol
    # intersection by construction (a bare import names no symbols) but the table
    # names them like any other. Written onto the import records so the existing
    # bundle-wide specifier table in retargetChunkImports() picks them up with no
    # change to that consumer.
    stats["side_effect_recovered"] = 0
    recovered_specs = set()
    for c in chunks:
        have = {imp["path"] for imp in c["imports"]}
        for spec in SIDE_EFFECT_IMPORT_RE.findall(c["text"]):
            if spec in resolved_specs or spec in have:
                continue
            idx = table_map.get(spec)
            if idx is None:
                continue
            c["imports"].append({"path": spec, "clause": "", "target": idx})
            have.add(spec)
            recovered_specs.add(spec)
            stats["side_effect_recovered"] += 1
    # Re-score the side-effect residue AFTER recovery, so the printed coverage is
    # what step 2.5 will actually reach rather than the pre-table figure.
    if recovered_specs:
        resolved_specs |= recovered_specs
        stats["side_effect_unresolved"] = 0
        still_missing = set()
        for c in chunks:
            for spec in SIDE_EFFECT_IMPORT_RE.findall(c["text"]):
                if spec not in resolved_specs:
                    stats["side_effect_unresolved"] += 1
                    still_missing.add(spec)
        stats["side_effect_unresolved_specs"] = len(still_missing)

    stats["dyn_sites"] = 0
    for c in chunks:
        stats["dyn_sites"] += len(DYN_SITE_RE.findall(c["text"]))
    dyn_specs = set()
    for c in chunks:
        dyn_specs.update(DYN_SITE_RE.findall(c["text"]))
    stats["dyn_specs"] = len(dyn_specs)
    stats["dyn_resolved_specs"] = len(dynamic)
    stats["dyn_resolved_sites"] = 0
    for c in chunks:
        for spec in DYN_SITE_RE.findall(c["text"]):
            if spec in dynamic:
                stats["dyn_resolved_sites"] += 1
    stats["dyn_ambiguous"] = dyn_stats["ambiguous"]
    stats["dyn_empty"] = dyn_stats["empty"]

    # A dynamic specifier resolving differently from the static table would mean
    # the content hash is not a stable identity. Measured: the populations are
    # disjoint, so this is vacuously true today — it is checked anyway so that a
    # future release which DOES share a specifier between the two cannot pick a
    # silent winner.
    for spec, target in dynamic.items():
        if spec in resolved_specs:
            static_target = next(
                imp["target"]
                for c in chunks
                for imp in c["imports"]
                if imp["path"] == spec and imp["target"] is not None
            )
            if static_target != target:
                raise SystemExit(
                    f"{spec} resolves to chunk {target} dynamically but "
                    f"{static_target} statically — specifier identity is not stable."
                )

    return chunks, stats, dynamic


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

    chunks, stats, dynamic = extract(binary)
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
        # Dynamic edges go in a SIBLING file, not a new key on the manifest:
        # the manifest is a bare JSON LIST indexed positionally by
        # module-reconstruct.ts, so it has nowhere to put a bundle-wide table
        # without changing its shape and breaking that consumer.
        dyn_path = manifest_path.replace(".json", "-dynamic.json")
        if dyn_path == manifest_path:
            dyn_path = manifest_path + ".dynamic"
        with open(dyn_path, "w") as fh:
            json.dump(dynamic, fh, indent=1, sort_keys=True)

    print(f"  chunks written : {len(chunks)}")
    print(f"  total source   : {total:,} bytes")
    # The bunfs module table, reported on its OWN line and with its own
    # denominator, because it is a different key from symbol intersection and a
    # reader must be able to see which one carried the graph.
    if stats.get("table_reason"):
        print(f"  bunfs table    : UNUSED — {stats['table_reason']}")
    else:
        print(
            f"  bunfs table    : {stats['table_specs']}/{len(chunks)} specifiers"
            f" pinned by module-table order"
            f"  (dyn +{stats['dyn_added']} added, {stats['dyn_corrected']} corrected;"
            f" side-effect +{stats['side_effect_recovered']} sites recovered)"
        )
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
    # Side-effect sites are scored against the SAME bundle-wide specifier table
    # module-reconstruct.ts builds, so the coverage printed here is the coverage
    # step 2.5 will actually achieve. Reporting them as flatly "UNRESOLVABLE"
    # (as this did) understated it by 85,563 sites: unresolvable by intersecting
    # THIS site's symbols is not the same as unresolvable in the bundle, because
    # a content-hashed specifier is pinned by any one clause import of it.
    se_resolved = stats["side_effect"] - stats["side_effect_unresolved"]
    print(
        f"  side-effect    : {se_resolved:,}/{stats['side_effect']:,} resolved via"
        f" the bundle-wide specifier table"
        f"  ({stats['side_effect_unresolved_specs']} specifiers never named"
        f" with symbols anywhere)"
    )
    # Dynamic edges are reported on their OWN denominator and are NOT folded
    # into the static total. They are a different population (disjoint
    # specifiers) resolved by different evidence, and an unresolved dynamic
    # edge has a different consequence: the specifier is simply left alone,
    # and the lazy import fails only if that code path is taken.
    print(
        f"  dynamic import : {stats['dyn_resolved_sites']:,}/{stats['dyn_sites']:,}"
        f" sites  ({stats['dyn_resolved_specs']}/{stats['dyn_specs']} specifiers;"
        f" {stats['dyn_ambiguous']} ambiguous, {stats['dyn_empty']} no-evidence)"
    )
    total_resolved = stats["resolved"] + se_resolved
    pct = (100.0 * total_resolved / all_imports) if all_imports else 0.0
    print(f"  TOTAL COVERAGE : {total_resolved:,}/{all_imports:,} = {pct:.1f}% (static)")
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
