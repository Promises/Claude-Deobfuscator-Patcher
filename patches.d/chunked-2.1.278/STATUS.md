# 2.1.278 port — IN PROGRESS, not usable yet

🔴 **These patches are 2.1.278-ONLY. Do not copy them into `patches.d/chunked/`.**
MEASURED: `002` and `003` here do NOT apply to the 2.1.263 tree. The live fleet
builds from 2.1.263, so installing these over the working set breaks it. The
patch set is version-specific and there is currently no mechanism selecting one
by version — `build.sh` picks a directory by FORMAT (monolithic vs chunked),
not by version. Wiring that up is a prerequisite for supporting both.

## State against 2.1.278

| patch | state |
|---|---|
| 001-session-hooks | applies unchanged |
| 002-claudiverse-sidecar | **ported here** — locals renamed `o`→`s`, `d`→`g` |
| 003-interactive-inject | **ported here** — stub `$k`→`Ey`, param `w`→`h` |
| 005-command-hooks | BLOCKED — see below |
| 006-account-banner | applies unchanged |
| 007-remote-answer | not started |
| 008-idle-signal | **regenerated here** (fuzzy placement, then re-diffed) |
| 009-compact-signal | applies unchanged |
| 010-cvstate-heartbeat | not started — injects minified `E`, `qc` |
| 011-spawn-trust | site found, not ported: unique `trustAccepted` in coreSchemas.js |
| 012-account-failover | not started — injects minified `Ako`, `Hw`, `Mot`, `pje` |

## What the port actually costs

Two different problems, and only one is mechanical.

**Context drift** — identifiers renamed around the hunk. Mechanical once the new
name is found. The editor-helpers stub renames EVERY release:
`$k` (2.1.263) → `iv` (2.1.265) → `Ey` (2.1.278), which is exactly why 003
aliases it at its definition site instead of naming it in the injected code.

**Module relocation** — the FILE the patch names no longer holds the code. Not
fixable by context at all; needs a pin in `tools-ts/anchor-rules.json`.
Already hit twice:
  * the query module (`query`/`queryLoop`/`queryWithObserverTap`/
    `withRetryGenerator`) → landed in `tools/LSPTool/formatters.js`.
    FIXED by the pin keyed on the `queryWithObserverTap` error string.
  * **005's command registry** → the command-group literals it sits among
    (`'daemon'`, `'logout'`) are scattered across `main.js` and several
    `_unmatched/` modules on 2.1.278. Needs its own pin, keyed on something
    still tree-unique — `'skillDoctor'`, used on 2.1.263, NO LONGER EXISTS.

## The hazard that must not be skipped on 010 and 012

Both inject MINIFIED identifiers on added lines (`E`, `qc` / `Ako`, `Hw`,
`Mot`, `pje`). A context-only re-anchor can apply cleanly while emitting a
reference to a name that means something ELSE in the new tree — 012's own
header records that happening on 2.1.260, where the injected `$k` was a live
message queue rather than the helpers stub: a green check that shipped a dead
feature, swallowed by the try/catch. Each of these must be bound at its
DEFINITION site and shown tree-unique, the way `__cvSubmitHelpers` already is.
For these two, "applies cleanly" is not evidence the patch works.

## Reproducing

`*.py` here are the port scripts: each asserts its anchor count before editing,
so an ambiguous or missing anchor fails loudly. 003's caught a real one — the
`bindHost(h) { this.#t = h; }` shape occurs THREE times in that file, so it is
scoped to `class PromptSubmitController` and asserts the unique error string
lands inside the region it edits.

Regenerate against a 2.1.278 deob tree:
    BUILD_VERSION=2.1.278 SKIP_PATCHES=1 ALLOW_UNPATCHED_BUILD=1 \
      DEOB_DIR=<tree> OUT_BIN=/tmp/x ./build.sh
then apply patches in build ORDER (008 and 010 sit 9 lines apart in one file,
so each diff must be taken against the tree with its predecessors applied).
