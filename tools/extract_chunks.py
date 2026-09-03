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

  MEASURED AND REJECTED — the bunfs path table as an alternative key. The task of
  zipping the table against body order fails because the two are uncorrelated:
  taking each resolved specifier's FIRST occurrence outside any chunk body and
  sorting by that offset yields a chunk-index sequence whose adjacent pairs are
  increasing 528/875 = 60.3% of the time, against 49.8% for a shuffled control
  and the ~100% a real correlation would give. Every one of the 107,806 name
  occurrences in the binary is a full `/$bunfs/root/…` path (zero bare names), so
  there is no separate ordered module table to read — what looks like one is a
  string interning pool scattered across the bytecode blobs.

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
            # Not a guess: every surviving candidate was shown to hand back the
            # SAME binding, from the same chunk, for every symbol any site
            # actually reads off this specifier. See equivalent_reexporters.
            stats["facade_tiebreak"] += 1
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

    # Dynamic (lazy) edges, resolved on their OWN symbol evidence — the static
    # table cannot help, since the two specifier populations are disjoint.
    dynamic, dyn_stats = resolve_dynamic(chunks, owner)
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
