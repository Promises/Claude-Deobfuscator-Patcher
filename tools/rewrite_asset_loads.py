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

VE_CALL_RE = re.compile(
    r"""\bve\(\s*['"](/\$bunfs/root/([A-Za-z0-9_.\-]+))['"]\s*\)"""
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
WRAPPED_REQUIRE_RE = re.compile(
    r"""\b[\w$]+\(\s*import\.meta\.require\(\s*['"]"""
    r"""(?:claudiverse-unresolved-chunk:)?"""
    r"""/\$bunfs/root/(chunk-[a-z0-9]{8}\.js)['"]\s*\)\s*\)"""
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


def rewrite_file(path, assets_dir, available, text_asset):
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
            # The wrapper (`Zts`) already accepts a plain string, so handing it
            # the text directly preserves its contract exactly.
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
        # import.meta.dir is `/$bunfs/root` in a compiled binary, so the retry
        # lands there. The direct read is tried first so an absolute path (dev
        # runs, tests) keeps working unchanged, and a non-ENOENT error is
        # re-thrown rather than being masked by the fallback.
        "const __cvReadAsset = (p) => {",
        "  let b;",
        "  try { b = __cvReadFileSync(p); }",
        "  catch (e) {",
        "    if (e && e.code !== 'ENOENT') throw e;",
        "    b = __cvReadFileSync(import.meta.dir + '/' + String(p).replace(/^.*\\//, ''));",
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

    files = 0
    sites = 0
    wrapped = 0
    skipped = set()
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
            wrapped_here = WRAPPED_REQUIRE_RE.findall(text) if text_asset else []
            if not found and not wrapped_here:
                continue
            for _full, name in found:
                if name not in available:
                    skipped.add(name)
            n = rewrite_file(path, args.assets, available, text_asset)
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


if __name__ == "__main__":
    main()
