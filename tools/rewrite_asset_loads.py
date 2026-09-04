#!/usr/bin/env python3
"""Rewrite `ve('/$bunfs/root/<asset>')` into a real embedded-file read.

WHY THIS EXISTS
---------------
`ve` is the tree's alias for `import.meta.require` (`_unmatched/0006_G.js`:
`ve = import.meta.require`). Upstream calls it on `.md`/`.txt` assets:

    var g = ve('/$bunfs/root/loopAutonomousPreamble-07qcyhv4.md');

That call CANNOT work in a rebuilt binary, and embedding the asset does not fix
it. MEASURED with a two-file probe compiled by `bun build --compile`:
`import.meta.require` on an embedded `.md` PARSES IT AS JAVASCRIPT --
`SyntaxError: Invalid character: '#' at <parse> (/$bunfs/root/doc.md:1:1)` --
and on a `.txt` gives `Unexpected identifier`. So recovering the payload only
moves the failure from "Cannot find module" to a parse error.

Upstream survives this because the modules holding these calls are never
evaluated: the real 2.1.259 binary completes a turn with them cold. Our tree
cannot rely on that, because module-reconstruct.ts has to bind relative
`import.meta.require` specifiers to something bundled, and a static import is
bundled but EAGER (positive-controlled: the target's top-level side effect
fires before the entry's first line even when the consuming branch is not
taken). That eager evaluation is what runs the `ve()` call.

So the call itself is replaced with the form that DOES work, verified by probe:

    import __cvAsset0 from '<dir>/<asset>' with { type: "file" };
    ...
    var g = readFileSync(__cvAsset0, 'utf8');   // -> "# Autonomous loop check\\n"

Only assets that were actually RECOVERED are rewritten. A call naming an asset
we do not have is left exactly as it was -- rewriting it would swap a lazy
failure for a guaranteed one.
"""

import argparse
import os
import re
import subprocess
import sys

# An asset load through ANY callee, e.g. `ve('/$bunfs/root/x.md')`.
#
# 🔴 THE CALLEE NAME IS NOT A STABLE KEY — THAT WAS THE BUG.
# This was `\bve\(`, hardcoding the minified alias of `import.meta.require`.
# The alias is bundler-assigned and moves between releases: it is `ve` on
# 2.1.259 (`_unmatched/0006_G.js`) but `Ee` on 2.1.260
# (`_unmatched/0006_pe.js:44`). MEASURED: with the hardcoded name this pass
# rewrote 8 files on 2.1.259 and 0 files on 2.1.260 — a silent no-op, since
# "rewrote 0" is a legal output for a release with no assets and nothing
# distinguished the two cases. The knock-on was that every asset-loading module
# stayed unhoistable, so module-reconstruct.ts's asset guard kept firing and
# left `import.meta.require('./0979_LOOP_FILE_DYNAMIC_SENTINEL.js')` a call,
# which does not resolve in a compiled binary: the 2.1.260 turn died with
# `Cannot find module './0979_LOOP_FILE_DYNAMIC_SENTINEL.js'`.
#
# The `/$bunfs/root/` specifier with an asset extension is the stable signal —
# the same reasoning EMBEDDED_ASSET_RE in module-reconstruct.ts already applies
# and states explicitly. Matching any identifier callee is safe because the
# SPECIFIER, not the callee, is what identifies the site: nothing else in the
# bundle calls a function on a `/$bunfs/root/` path literal, and a
# non-recovered asset is still left untouched by the `available` check below.
#
# `import.meta.require(...)` is accepted directly too, so a release that stops
# aliasing does not silently fall through the same hole.
VE_CALL_RE = re.compile(
    r"""(?:\bimport\.meta\.require|\b[A-Za-z_$][\w$]*)"""
    r"""\(\s*['"](/\$bunfs/root/([A-Za-z0-9_.\-]+))['"]\s*\)"""
)

# A `/$bunfs/root/<asset>` path literal in CALL POSITION — `<anything>(` before
# it and `)` after — with no assumption about what the callee is named.
#
# This is the CONTROL that gives the "rewrote N" report a reachable negative.
# Deliberately independent of VE_CALL_RE's callee alternation, so a further
# drift in the call syntax cannot silence both at once.
#
# ⚠️ SCOPED TO THE CALL FORM ON PURPOSE — a broader "any occurrence of the path"
# rule was tried first and was WRONG: it flagged 109 sites, of which the large
# majority are bare path CONSTANTS (`var i = '/$bunfs/root/plugin-eval-…zst'`,
# `_unmatched/0225_b_t.js:11`) that this pass does not own and must not touch.
# Those are read by upstream's own `readFileSync`+zstd helper and are handled
# later by inject_assets.py, exactly as module-reconstruct.ts's importTimeAssetRef
# documents. Only a CALL on the path is this pass's responsibility.
ASSET_REF_RE = re.compile(
    r"""[\w$.]\(\s*['"]/\$bunfs/root/([A-Za-z0-9_.\-]+)['"]\s*\)"""
)

# A TEXT asset wearing a `.js` chunk name.
#
# `chunk-8y31br3w.js` is not a module: its consumer does
#     var X2e = Zts(import.meta.require('…/chunk-8y31br3w.js'))
# where `Zts(e) = typeof e === "string" ? e : e.default`, and then uses X2e as a
# STRING -- `X2e.match(new RegExp(`<${e}>([\s\S]*?)</${e}>`))`. So the specifier
# has to resolve to text, and no amount of symbol-intersection work can resolve
# it to a chunk, because there is no chunk to find.
#
# The payload was identified by CONTENT, not by name: the asset recovered as
# `permissions_external-0f27b1d1.txt.zst` is the only one containing exactly the
# `<...>` sections that call extracts -- `external`, `settings_deny_rules`,
# `user_allow_rules_to_replace`, `user_environment_to_replace`,
# `user_hard_deny_rules_to_replace`, `user_soft_deny_rules_to_replace`.
#
# MEASURED: this shape occurs ONCE in the whole 2.1.259 bundle, so the mapping
# is a single narrow special case rather than a general mechanism. It is keyed
# on the WRAPPED-REQUIRE SHAPE, and the target asset is looked up by that
# tag-set signature below, so a release that renames either side fails loudly
# instead of silently wiring up the wrong text.
#
# 🔴 "OCCURS ONCE" WAS TRUE OF 2.1.259 AND FALSE OF 2.1.260 — the shape is NOT
# self-identifying, and treating it as such shipped a broken binary.
# MEASURED on 2.1.260 there are TWO wrapped-require sites, not one:
#     Ves(import.meta.require("/$bunfs/root/chunk-dqhh3ptk.js"))   <- text
#     en (import.meta.require("/$bunfs/root/chunk-57gabfb9.js"))   <- A MODULE
# and `en` is not a string coercer at all:
#     function en(e){ if (typeof e === "object" && e !== null
#                        && "registerPlugin" in e
#                        && typeof e.registerPlugin === "function") … }
# i.e. it VALIDATES A PLUGIN MODULE. Rewriting its argument to asset text made
# `skills/bundled/loremIpsum.js:208` call `.registerPlugin()` on a string, and
# the rebuilt binary died with an UNHANDLED REJECTION —
#   TypeError: __cvReadAsset8(...).registerPlugin is not a function
# which, on the `-p` path, surfaced as a SILENT HANG with exit 124 and zero
# bytes on both streams. It was only visible after instrumenting the bundle
# with a `process.on('unhandledRejection')` hook and recompiling.
#
# So the WRAPPER, not the call shape, decides. `is_string_coercer()` below
# requires the wrapper body to actually coerce to a string (the `typeof e ===
# "string" ? e : e.default` contract the mapping depends on). A site whose
# wrapper is unrecognised is LEFT ALONE, which restores the documented
# "narrow special case" claim as something enforced rather than asserted.
WRAPPED_REQUIRE_RE = re.compile(
    r"""\b([\w$]+)\(\s*import\.meta\.require\(\s*['"]"""
    r"""(?:claudiverse-unresolved-chunk:)?"""
    r"""/\$bunfs/root/(chunk-[a-z0-9]{8}\.js)['"]\s*\)\s*\)"""
)

# `Zts(e) = typeof e === "string" ? e : e.default` -- the wrapper contract that
# makes handing the consumer plain text correct. Matched on the DEFINITION, in
# either `function NAME(a){…}` or `NAME = (a) => …` form.
STRING_COERCER_RE = (
    r"""(?:function\s+%(name)s\s*\(\s*(\w+)\s*\)\s*\{[^}]{0,120}?"""
    r"""typeof\s+\1\s*===?\s*["']string["']"""
    r"""|\b%(name)s\s*=\s*\(?\s*(\w+)\s*\)?\s*=>[^;]{0,120}?"""
    r"""typeof\s+\2\s*===?\s*["']string["'])"""
)

# The sections the consumer extracts. An asset must contain ALL of them to be
# accepted as the target -- a signature, not a guess.
TEXT_ASSET_SIGNATURE = (
    b"<external>",
    b"<settings_deny_rules>",
    b"<user_allow_rules_to_replace>",
    b"<user_environment_to_replace>",
)

MARKER = "__cvAssetText"


def find_signature_asset(assets_dir):
    """The recovered asset holding every section in TEXT_ASSET_SIGNATURE.

    Returns its filename, or None. Requires a UNIQUE match: if two assets carry
    the signature the mapping is not determined, and guessing between them would
    wire the consumer to the wrong text.
    """
    hits = []
    for name in sorted(os.listdir(assets_dir)):
        path = os.path.join(assets_dir, name)
        try:
            raw = open(path, "rb").read()
        except OSError:
            continue
        if raw[:4] == b"\x28\xb5\x2f\xfd":
            proc = subprocess.run(
                ["zstd", "-d", "-q", "-c"], input=raw, capture_output=True
            )
            if proc.returncode != 0:
                continue
            body = proc.stdout
        else:
            body = raw
        if all(tag in body for tag in TEXT_ASSET_SIGNATURE):
            hits.append(name)
    return hits[0] if len(hits) == 1 else None


def is_string_coercer(name, sources):
    """Does `name` coerce its argument to a STRING (the Zts contract)?

    Only such a wrapper may be handed raw asset text. `en` on 2.1.260 is the
    counter-example this exists to reject: it tests
    `"registerPlugin" in e && typeof e.registerPlugin === "function"`, so it
    wants a MODULE and breaks on a string.

    Searched across every source, because a wrapper is routinely defined in a
    different file from the site that calls it. Unknown => False, so an
    unrecognised wrapper is left alone rather than rewritten on a guess.
    """
    pat = re.compile(STRING_COERCER_RE % {"name": re.escape(name)})
    return any(pat.search(text) for text in sources)


def rewrite_file(path, assets_dir, available, text_asset, coercers):
    src = open(path, encoding="utf-8").read()
    if MARKER in src:
        return 0

    used = {}

    def use(name):
        if name not in used:
            used[name] = f"{MARKER}{len(used)}"
        return used[name]

    def sub(match):
        name = match.group(2)
        if name not in available:
            return match.group(0)
        return f"__cvReadAsset({use(name)})"

    out = VE_CALL_RE.sub(sub, src)

    if text_asset:
        def sub_wrapped(match):
            # ONLY a string-coercing wrapper. It already accepts a plain
            # string, so handing it the text directly preserves its contract
            # exactly. Any other wrapper wants a MODULE and is left untouched
            # (see WRAPPED_REQUIRE_RE for the `en`/`registerPlugin` case that
            # made this check necessary).
            if match.group(1) not in coercers:
                return match.group(0)
            return f"__cvReadAsset({use(text_asset)})"

        out = WRAPPED_REQUIRE_RE.sub(sub_wrapped, out)

    if not used:
        return 0

    header = [
        "import { readFileSync as __cvReadFileSync } from 'fs';",
        # Named distinctly so it cannot collide with a minified upstream
        # binding, and defined once per file.
        #
        # zstd-aware, mirroring upstream's own `et26` (`_unmatched/0207_h4t.js`):
        # a recovered asset is stored EXACTLY as the binary held it, so a
        # `.md.zst` / `.txt.zst` is still compressed on disk. Sniffing the magic
        # rather than the extension keeps this correct if a name and its
        # encoding ever disagree.
        # 🔴 RESOLVE AGAINST THE EMBED ROOT, NOT THE CWD.
        # A `with { type: "file" }` import yields a path like
        # `./loopAutonomousPreamble-07qcyhv4.md`, and readFileSync resolves a
        # relative path against process.cwd() — inside a compiled binary that is
        # wherever the user ran it, not `/$bunfs/root`. MEASURED 2026-09-04, the
        # REPL died with:
        #   ENOENT: no such file or directory, open './loopAutonomousPreamble-07qcyhv4.md'
        # ⚠️ `-p` did NOT catch this. That path reads no asset, so a green
        # `-p 'reply with exactly: OK'` exercised ZERO of the asset lane — the
        # check that proved the turn works is blind to this whole class.
        # import.meta.dir is `/$bunfs/root` in a compiled binary, so that read
        # serves from the BUNDLE. It is deliberately FIRST — see below.
        #
        # 🔴 THE BUNDLE IS TRIED BEFORE THE LITERAL PATH, AND THE ORDER IS THE
        # WHOLE POINT. This was the other way round, and that ordering is what
        # let a build-input defect ship while every test reported success.
        #
        # `p` is the RELATIVE specifier a `with { type: "file" }` import yields
        # (`./visual_plan-169gvcqt.txt`), and readFileSync resolves a relative
        # path against process.cwd(). So consulting it first means: any cwd that
        # happens to hold a copy satisfies the read, the bundle is never
        # exercised, and an asset MISSING FROM THE BUNDLE is invisible.
        #
        # MEASURED 2026-09-04, and this is not hypothetical — it shipped:
        # `claude-260-patched` passed every check from `patch-ref/` (where the
        # build's own sidecar copies sit) and died from any other cwd with
        #   ENOENT: open '/$bunfs/root/loopAutonomousPreamble-07qcyhv4.md'
        # Exactly 7 assets were genuinely unembedded; the cwd-first order hid all
        # 7 in the one directory the build is developed in, and cv-runner.mjs
        # launches every fleet worker with --workdir <git worktree>, i.e. never
        # that directory.
        #
        # Bundle-first inverts the failure mode: a missing build input now fails
        # in EVERY cwd, including the build directory, so it cannot be masked by
        # a stray local copy. The literal path is kept as the fallback so an
        # ABSOLUTE path still works for dev runs and tests, and a non-ENOENT
        # error is re-thrown rather than swallowed by the retry.
        #
        # ⚠️ Note `-p 'reply with exactly: OK'` reads NO asset, so it is green
        # while this entire lane is broken. Exercising an asset path requires a
        # module that actually loads one; see the probe described in the commit.
        "const __cvReadAsset = (p) => {",
        "  let b;",
        "  try { b = __cvReadFileSync(import.meta.dir + '/' + String(p).replace(/^.*\\//, '')); }",
        "  catch (e) {",
        "    if (e && e.code !== 'ENOENT') throw e;",
        "    b = __cvReadFileSync(p);",
        "  }",
        "  const z = b.length >= 4 && b[0] === 40 && b[1] === 181"
        " && b[2] === 47 && b[3] === 253;",
        "  return (z ? Bun.zstdDecompressSync(b) : b).toString('utf8');",
        "};",
    ]
    for name, ident in used.items():
        spec = os.path.join(assets_dir, name)
        header.append(
            f"import {ident} from {spec!r} with {{ type: \"file\" }};"
        )
    open(path, "w", encoding="utf-8").write("\n".join(header) + "\n" + out)
    return len(used)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tree", help="deobfuscated tree root")
    ap.add_argument("assets", help="directory produced by extract_assets.py")
    args = ap.parse_args()

    if not os.path.isdir(args.assets):
        print("  no asset directory; skipping ve() rewrite")
        return
    available = set(os.listdir(args.assets))
    text_asset = find_signature_asset(args.assets)

    # Every wrapper name appearing in a wrapped-require site, classified ONCE
    # against the whole tree (a wrapper is often defined in another file).
    # Only string coercers may have their argument replaced with asset text.
    all_sources = []
    wrapper_names = set()
    for root, _dirs, names in os.walk(args.tree):
        for fname in names:
            if not fname.endswith(".js"):
                continue
            try:
                text = open(os.path.join(root, fname), encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue
            all_sources.append(text)
            for wname, _chunk in WRAPPED_REQUIRE_RE.findall(text):
                wrapper_names.add(wname)
    coercers = {w for w in wrapper_names if is_string_coercer(w, all_sources)}
    rejected_wrappers = wrapper_names - coercers
    del all_sources

    files = 0
    sites = 0
    wrapped = 0
    skipped = set()
    # Sites this pass SHOULD have handled, found without using VE_CALL_RE.
    #
    # 🔴 THE FAILURE THIS EXISTS TO CATCH: "rewrote 0" is indistinguishable
    # from "there was nothing to rewrite" — which is exactly how the hardcoded
    # `ve` alias produced a silent no-op on 2.1.260 and cost a whole debugging
    # cycle. ASSET_REF_RE keys on the specifier ALONE, with no callee at all,
    # so it cannot share VE_CALL_RE's failure mode: if the call syntax drifts
    # again, this still counts the sites and the mismatch below is fatal.
    residual_refs = set()
    for root, _dirs, names in os.walk(args.tree):
        for fname in names:
            if not fname.endswith(".js"):
                continue
            path = os.path.join(root, fname)
            try:
                text = open(path, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue
            found = VE_CALL_RE.findall(text)
            # Only coercer-wrapped sites are rewritten, so only those are
            # counted -- otherwise the report would claim credit for sites
            # sub_wrapped() deliberately left alone.
            wrapped_here = (
                [w for w, _c in WRAPPED_REQUIRE_RE.findall(text)
                 if w in coercers]
                if text_asset else []
            )
            if not found and not wrapped_here:
                continue
            for _full, name in found:
                if name not in available:
                    skipped.add(name)
            n = rewrite_file(
                path, args.assets, available, text_asset, coercers
            )
            if n:
                files += 1
                sites += n
                wrapped += len(wrapped_here)

    print(
        f"  rewrote {sites} ve() asset loads in {files} files "
        "to embedded-file reads"
    )
    if wrapped:
        print(
            f"  mapped {wrapped} text-asset-as-chunk site(s) to {text_asset}"
        )
    if rejected_wrappers:
        # Reported because this is the distinction that decides correctness,
        # and because a wrapper moving between the two classes is exactly the
        # kind of release drift that silently broke this pass before.
        print(
            f"  {len(rejected_wrappers)} wrapped-require site(s) left as "
            "module loads — wrapper is not a string coercer: "
            + ", ".join(sorted(rejected_wrappers))
        )
    elif text_asset is None:
        # Not fatal: a release without that consumer simply has nothing to map.
        # Reported so a SILENT disappearance is visible, since the symptom
        # otherwise shows up much later as an unresolved-chunk runtime error.
        print(
            "  no uniquely-signatured text asset found — "
            "wrapped-require sites (if any) left untouched"
        )
    if skipped:
        # Left as calls on purpose. Reported because each one is a module that
        # still cannot be safely hoisted, which is what keeps the
        # import.meta.require guard in module-reconstruct.ts firing.
        print(
            f"  {len(skipped)} asset(s) referenced but not recovered — "
            "their ve() calls were left untouched"
        )

    # 🔴 CONTROL: a RECOVERED asset still loaded through a bare call is a
    # rewrite this pass was supposed to make and did not.
    #
    # Re-walks the tree AFTER rewriting, and re-derives the site set from
    # ASSET_REF_RE — which has no callee in it at all — so it cannot fail the
    # same way VE_CALL_RE did. A `__cvReadAsset(__cvAssetN)` site no longer
    # quotes the path, so a successful rewrite removes itself from this set;
    # what remains is genuinely unhandled.
    #
    # FATAL rather than a warning, because the downstream symptom is a
    # `Cannot find module` from deep inside a compiled binary, ~10 minutes and
    # one 100 MB link away from the cause. Non-recovered assets are excluded:
    # leaving those alone is the documented, correct behaviour.
    for root, _dirs, names in os.walk(args.tree):
        for fname in names:
            if not fname.endswith(".js"):
                continue
            path = os.path.join(root, fname)
            try:
                text = open(path, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue
            for ref in ASSET_REF_RE.findall(text):
                if ref in available:
                    residual_refs.add((os.path.relpath(path, args.tree), ref))

    if residual_refs:
        print(
            f"  🔴 {len(residual_refs)} recovered asset(s) still referenced by "
            "path after the rewrite pass — the call form was not recognised"
        )
        for rel, ref in sorted(residual_refs)[:20]:
            print(f"       {rel}: {ref}")
        raise SystemExit(
            "asset-load rewrite is a no-op for sites that exist — refusing to "
            "build a binary that will die on 'Cannot find module' at runtime"
        )


if __name__ == "__main__":
    main()
