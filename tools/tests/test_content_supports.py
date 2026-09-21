#!/usr/bin/env python3
"""Positive control for extract_assets.content_supports().

Run: python3 tools/tests/test_content_supports.py

WHY THIS EXISTS. content_supports is a GATE — build.sh passes --verify and
refuses to build when any asset's name/payload pairing is contradicted. A gate
that cannot fail is decoration, and the plural-stem tolerance added for 2.1.278
is exactly the kind of change that can quietly turn a gate vacuous. So the
first two cases here are the control: a name paired with an unrelated body must
still come back contradicted. If those ever start passing, the gate is dead and
every later asset check is worthless.

The 2.1.278 case: kit-modules.js-ef8b6d2e.txt.zst reduces to the single token
"modules". Its body is a 256-member concatenation of collector/*.js — a bundle
of modules, so the name is right — but the text says "module", never the
plural. One absent plural marked the pair contradicted and --verify refused the
build at step 2, long before any patch was attempted.
"""
import importlib.util
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ea", root / "tools" / "extract_assets.py")
ea = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ea)
cs = ea.content_supports

CASES = [
    # --- the control: a real mispairing must still be CAUGHT ---
    ("gate catches: unrelated body",
     ("permissions_external-0f27b1d1.txt.zst", b"the quick brown fox jumps over the lazy dog"), {}, False),
    ("gate catches: unrelated body (2)",
     ("telemetry-aabbccdd.md.zst", b"nothing in here about that subject at all"), {}, False),

    # --- the 2.1.278 regression ---
    ("plural name, singular body -> confirmed",
     ("kit-modules.js-ef8b6d2e.txt.zst", b"//// collector/collector.js\nexport const module = 1"), {}, True),

    # --- the tolerance must not over-reach ---
    ("token 'apis' (len 4) does NOT stem",
     ("apis-aabbccdd.txt.zst", b"this document mentions api only"), {}, False),
    ("singular token, plural body",
     ("collector-aabbccdd.txt.zst", b"collectors everywhere"), {}, True),

    # --- claiming stays exact: looseness here would INVENT pairings ---
    ("strict: plural not satisfied by singular",
     ("kit-modules.js-ef8b6d2e.txt.zst", b"the word module appears"), {"strict": True}, False),
    ("strict: exact token still claims",
     ("kit-modules.js-ef8b6d2e.txt.zst", b"the word modules appears"), {"strict": True}, True),

    # --- un-checkable must stay None, never True ---
    ("no discriminating tokens -> None", ("index.json", b"anything"), {}, None),
]


def main():
    failed = 0
    for label, args, kw, want in CASES:
        got = cs(*args, **kw)
        ok = got == want
        failed += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  {label:46} got={got!s:5} want={want}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
