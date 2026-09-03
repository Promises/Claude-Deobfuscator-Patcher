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

# `et26(<var>, import.meta.dirname)` -- the EAGER loader. A miss here is fatal
# at module-init time, which is the failure this tool exists to clear.
EAGER_CALL_RE = re.compile(r"et\d*\((\w+), import\.meta\.dirname\)")

BANNER = "// --- claudiverse: embedded asset imports (see tools/inject_assets.py)"


def eager_assets(source):
    """Assets loaded by a top-level, unconditional readFileSync."""
    names = set()
    for match in EAGER_CALL_RE.finditer(source):
        var = match.group(1)
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
    referenced = set(ASSET_REF_RE.findall(source))
    eager = eager_assets(source)

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
