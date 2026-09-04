#!/usr/bin/env python3
"""Wire recovered assets into the bundle so `bun build --compile` embeds them.

THE PROBLEM
-----------
Upstream embeds its `.md`/`.txt` assets with `import x from "..." with { type:
"file" }`, which puts the bytes in the compiled binary's VFS. What survives
into the deobfuscated chunk tree is only the RESULT of that import: a bare
string literal naming the path.

    var i50 = "/$bunfs/root/plugin-eval-quickref-7cde824c.md.zst";
    JSt = et26(i50, import.meta.dirname);          // fs.readFileSync(path)

A string literal is not an import, so bun has no reason to embed anything, and
the rebuilt binary throws "embedded text asset is missing or corrupt" the first
time `et26` runs -- at module-init time, unconditionally, so `--version` passes
(it exits before that module initialises) while every real turn dies.

THE FIX
-------
Prepend one real `with { type: "file" }` import per asset to the bundle. That
makes bun embed the bytes; the imports are otherwise unused, so nothing else in
the graph changes.

The embedded path must come out byte-identical to the literal the code already
holds. By default `bun build` rewrites asset names with `[name]-[hash].[ext]`
-- MEASURED: `sample-abcd1234.md.zst` was embedded as
`sample-abcd1234.md-m9p3ptba.zst`, which `readFileSync` would then miss. So the
compile step must pass `--asset-naming='[name].[ext]'`, and this tool asserts
that its caller does (see build.sh step 5).

ONLY THE EAGER ASSETS ARE REQUIRED. Assets reached through `import.meta.require`
(bound as `ve2` in the bundle) are lazy: they fail only if that code path runs.
The `et26` sites are top-level and unconditional. Both sets are injected when
available -- the eager ones are what unblocks a turn.
"""

import argparse
import os
import re
import sys

# Any `/$bunfs/root/<name>` naming a non-JS asset. `.js` entries are chunk
# specifiers and are handled by the module graph, not by this tool.
ASSET_REF_RE = re.compile(
    r"/\$bunfs/root/([A-Za-z0-9_.\-]+\.(?:md|txt|node|zst))"
)

# The SAME asset after step 4's bundle has consumed its file import.
#
# 🔴 THE `/$bunfs/root/` PREFIX IS NOT PRESENT ON EVERY ASSET REFERENCE — THAT
# WAS THE BUG. This tool ran on the bundle and matched with ASSET_REF_RE alone,
# which keys on that prefix. But step 2.4 (rewrite_asset_loads.py) replaces the
# `ve('/$bunfs/root/x.md')` CALL with a real
#     import __cvAssetN from '<dir>/x.md' with { type: "file" };
# and step 4's `bun build --target=bun` then RESOLVES that import, emitting the
# payload as a SIDECAR file next to the bundle and collapsing the binding to a
# bare relative string:
#     var loopAutonomousPreamble_07qcyhv4_default = "./loopAutonomousPreamble-07qcyhv4.md";
# By the time this tool sees the bundle there is no `/$bunfs/root/` text and no
# import left, so `referenced` missed all of them, `inject` was empty for this
# class, and step 5 had nothing to embed.
#
# MEASURED on the shipped claude-260-patched: 80 assets appear ONLY in this
# relative form and 0 of 83 loose assets had their bytes in the binary. The
# binary still worked when launched from patch-ref/ purely because the sidecars
# step 4 wrote sit there, so `readFileSync("./x.md")` resolved against the CWD —
# from any other directory it died with ENOENT on the retry path.
#
# Matching the `= "./<name>"` ASSIGNMENT form specifically, not any occurrence
# of the name: a bare filename is far too weak a signal to key an embed on, and
# this is the exact shape bun emits for a consumed file import.
BUNDLED_ASSET_REF_RE = re.compile(
    r"""=\s*["']\./([A-Za-z0-9_.\-]+\.(?:md|txt|node|zst|mjs))["']"""
)

# `<loader>(<var>, import.meta.dirname)` -- the EAGER loader. A miss here is
# fatal at module-init time, which is the failure this tool exists to clear.
#
# 🔴 THE LOADER NAME IS NOT A STABLE KEY — THAT WAS THE BUG.
# This was `et\d*\(`, keyed on the minified name the loader happened to carry
# on 2.1.238-2.1.259. The name is bundler-assigned and moves between releases.
# MEASURED on the 2.1.260 bundle, by censusing every call whose second argument
# is `import.meta.dirname`:
#     101 Ke20 · 4 aJ · 1 cqt         (`et`-prefixed: ZERO)
# So `eager_assets()` returned an EMPTY SET, `missing_eager` was empty, and the
# build printed the reassuring "(0 of them eagerly loaded, all present)" — a
# vacuous pass, because the population it checked was empty rather than clean.
#
# The knock-on was a SILENT HANG, not a clean error. `_unmatched/0225_b_t.js`
# does `b_t = Ke20(i49, import.meta.dirname)` at module scope with
# `i49 = "/$bunfs/root/plugin-eval-quickref-7cde824c.md.zst"`. The asset WAS
# recovered and simply never injected, so the compiled binary threw
# `embedded text asset is missing or corrupt` inside an async init chain that
# never settled: `-p` produced no stdout, no stderr and exit 124 under timeout.
# The error is only visible by running the bundle under `bun cli-runnable.js`,
# which is how it was found.
#
# `import.meta.dirname` as the second argument is the stable signal — it is what
# makes the call a FILESYSTEM-RELATIVE read in the first place, so it cannot be
# renamed the way the loader can.
#
# ⚠️ BUT ONLY THE **SYNCHRONOUS** LOADER IS EAGER, AND A FALSE POSITIVE HERE IS
# NOT HARMLESS. The bundle has TWO loaders over the same argument shape.
# MEASURED on 2.1.260:
#   - `Ke20` — SYNCHRONOUS (`Bun.zstdDecompressSync`; not an `async function`),
#     101 sites. These run at module init: genuinely eager.
#   - `aJ`   — ASYNC (`async function`, `await Bun.zstdDecompress`), 4 sites,
#     all inside async functions and wrapped in try/catch. Lazy by construction.
#   - `cqt`  — a PATH RESOLVER, not a loader: its 1 site is inside a template
#     literal in `aJ`'s catch-block error message.
# A missing asset here is a HARD `raise SystemExit`, so classing `aJ` as eager
# FAILS THE BUILD over `payload.template.html.asset` — never recovered, lazily
# called, error-handled: exactly the population this tool documents as skippable.
#
# So the callee set is DISCOVERED from the bundle and then FILTERED BY ITS OWN
# DEFINITION (see sync_loader_names): a loader is eager iff its definition is
# not `async`. That keys on the property which actually makes a site eager, and
# it survives renaming — which is the whole point, since the name is what
# regressed.
EAGER_CALL_RE = re.compile(
    r"([A-Za-z_$][\w$]*)\(\s*(\w+)\s*,\s*import\.meta\.dirname\s*\)"
)

# `function NAME(` optionally preceded by `async`, used to classify a loader.
# `%(name)s` (not str.format) because the pattern contains a literal `{`.
LOADER_DEF_RE = (
    r"(?:(async)\s+)?function\s+%(name)s\s*\([^)]*\)\s*\{"
)

# A loader DECODES what it read. `cqt` on 2.1.260 is a pure path JOIN --
# `return d57(t6) ? t6 : c67(e6, t6)` -- and reads no file at all, yet its one
# site (inside `aJ`'s catch-block error message) has the same
# `(<var>, import.meta.dirname)` shape. Without this, `cqt` was classified as a
# synchronous loader and dragged `payload.template.html.asset` back into the
# must-be-present set, failing the build on an asset nothing eagerly loads.
#
# `zstdDecompress` is the discriminating token: both real loaders call it
# (`Bun.zstdDecompressSync` in the sync one, `await Bun.zstdDecompress` in the
# async one) and the path resolver does not.
LOADER_BODY_TOKEN = "zstdDecompress"

BANNER = "// --- claudiverse: embedded asset imports (see tools/inject_assets.py)"


def is_sync_loader(source, name):
    """Is `name` a SYNCHRONOUS asset LOADER in this bundle?

    Two conditions, both structural:
      1. it actually loads -- its body decodes the bytes it read
         (LOADER_BODY_TOKEN), which excludes the path-resolver helper; and
      2. it is not `async` -- an async loader must be awaited, so its sites run
         only when that code path does, making them lazy.

    Returns False for a name with no visible `function NAME(...) {` definition,
    so an unrecognised shape is treated as lazy rather than failing the build
    on a guess.
    """
    m = re.search(LOADER_DEF_RE % {"name": re.escape(name)}, source)
    if not m:
        return False
    if m.group(1) is not None:
        return False
    # ⚠️ SCAN ONLY THIS FUNCTION'S OWN BODY, brace-matched.
    # A fixed-size window was tried and was WRONG: `cqt` is 3 lines long and is
    # immediately followed in the bundle by `aJ` and `Ke20`, so a 400-character
    # window read THEIR `zstdDecompress` and classified the path resolver as a
    # loader -- reinstating the very false positive this check removes.
    depth = 0
    i = m.end() - 1  # the opening `{`
    while i < len(source):
        c = source[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return LOADER_BODY_TOKEN in source[m.end():i]


def eager_assets(source):
    """Assets loaded at module init by a SYNCHRONOUS filesystem read.

    Two-stage on purpose: discover every `<fn>(<var>, import.meta.dirname)`
    callee present in this bundle, then keep only those whose own definition is
    synchronous. Neither stage names a minified identifier, which is what makes
    this survive the renaming that broke the previous `et\\d*` key.
    """
    sync_names = {}
    names = set()
    for match in EAGER_CALL_RE.finditer(source):
        fn, var = match.group(1), match.group(2)
        if fn not in sync_names:
            sync_names[fn] = is_sync_loader(source, fn)
        if not sync_names[fn]:
            continue
        decl = re.search(
            r"\b" + re.escape(var) + r'\s*=\s*"/\$bunfs/root/([^"]+)"', source
        )
        if decl:
            names.add(decl.group(1))
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", help="cli-runnable.js, edited in place")
    ap.add_argument("assets", help="directory produced by extract_assets.py")
    args = ap.parse_args()

    source = open(args.bundle, encoding="utf-8").read()
    if BANNER in source:
        print("  assets already injected; nothing to do")
        return

    available = set(os.listdir(args.assets)) if os.path.isdir(args.assets) else set()
    # BOTH reference forms. See BUNDLED_ASSET_REF_RE: an asset whose file import
    # step 4 already consumed no longer carries the `/$bunfs/root/` prefix, and
    # keying on that prefix alone is what silently shipped an unembedded binary.
    bunfs_refs = set(ASSET_REF_RE.findall(source))
    bundled_refs = set(BUNDLED_ASSET_REF_RE.findall(source))
    referenced = bunfs_refs | bundled_refs
    eager = eager_assets(source)

    # 🔴 CONTROL: an EMPTY eager set is not a clean bill of health.
    #
    # "0 eagerly loaded, all present" is exactly what a BROKEN detector prints,
    # and that is precisely how the `et\d*` regression shipped a hanging binary
    # (see EAGER_CALL_RE). `import.meta.dirname` is present in every release
    # this pipeline targets, so if the bundle mentions it at all and yet no
    # eager site was recognised, the detector — not the bundle — is what
    # changed. Fail loudly instead of reporting a vacuous pass.
    if not eager and "import.meta.dirname" in source:
        raise SystemExit(
            "eager-asset detector matched NOTHING although the bundle uses "
            "import.meta.dirname — EAGER_CALL_RE no longer recognises this "
            "release's loader. Refusing to report a vacuous 'all present'; "
            "fix the pattern, because the resulting binary hangs silently."
        )

    # A missing EAGER asset is a build-stopping error: the binary would compile
    # and then die on the first turn, which is exactly the failure mode this
    # tool removes. Report all of them at once rather than one per rebuild.
    missing_eager = sorted(eager - available)
    if missing_eager:
        raise SystemExit(
            "cannot satisfy eagerly-loaded assets: "
            + ", ".join(missing_eager)
            + f"\n(looked in {args.assets}) -- rebuilding without them would "
            "produce a binary that fails on the first turn."
        )

    # 🔴 CONTROL: a bundled-form reference is ALWAYS a must-embed.
    #
    # An asset in this form got there because step 2.4 rewrote its load into a
    # real file import and step 4 then consumed it, leaving `readFileSync` on a
    # CWD-relative path. Unlike the `/$bunfs/root/` population — where a
    # non-recovered asset is legitimately lazy and correctly skipped — there is
    # no benign reason for one of these to go un-injected: the code WILL read it
    # off disk relative to wherever the user happened to launch the binary.
    #
    # Fatal rather than a warning because the symptom is invisible from the
    # build directory (the step-4 sidecars sit there and mask it) and only
    # appears as an ENOENT for users running from anywhere else — which is
    # exactly how this shipped in a binary that had been called verified.
    unembeddable = sorted(bundled_refs - available)
    if unembeddable:
        raise SystemExit(
            f"{len(unembeddable)} asset(s) are referenced by a bundle-relative "
            "path but were not recovered: "
            + ", ".join(unembeddable[:10])
            + ("..." if len(unembeddable) > 10 else "")
            + f"\n(looked in {args.assets}) -- these cannot fall back to a lazy "
            "load; the binary would read them from the CWD and fail for any "
            "user not standing in the build directory."
        )

    inject = sorted(referenced & available)
    if not inject:
        print("  no recovered assets match this bundle; nothing to inject")
        return

    lines = [BANNER]
    for i, name in enumerate(inject):
        rel = os.path.join(args.assets, name)
        lines.append(
            f'import __asset{i} from {rel!r} with {{ type: "file" }};'
        )
    # Keep the bindings reachable so no minifier or tree-shaker can decide the
    # imports are dead and drop the bytes with them.
    refs = ", ".join(f"__asset{i}" for i in range(len(inject)))
    lines.append(f"globalThis.__claudiverseAssets = [{refs}];")
    lines.append("")

    open(args.bundle, "w", encoding="utf-8").write(
        "\n".join(lines) + source
    )

    print(
        f"  injected {len(inject)} asset imports "
        f"({len(eager)} of them eagerly loaded, all present)"
    )
    # Reported separately because the two populations have DIFFERENT failure
    # modes, and collapsing them is what hid this bug: a missing bunfs-form
    # asset is a lazy path that may never run, while a missing bundled-form one
    # is an unconditional CWD-relative read.
    print(
        f"    {len(bundled_refs)} from bundle-relative specifiers "
        f"(file imports consumed by step 4), "
        f"{len(bunfs_refs)} from /$bunfs/root/ paths"
    )
    unreferenced = sorted(referenced - available)
    if unreferenced:
        print(
            f"  {len(unreferenced)} referenced asset(s) not recovered "
            "(lazy import.meta.require paths only): "
            + ", ".join(unreferenced[:6])
            + ("..." if len(unreferenced) > 6 else "")
        )


if __name__ == "__main__":
    main()
