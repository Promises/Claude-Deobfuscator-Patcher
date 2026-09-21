# 2.1.278 port — IN PROGRESS, not usable yet

🔴 **These patches are 2.1.278-ONLY. Do not copy them into `patches.d/chunked/`.**
MEASURED: `002` and `003` here do NOT apply to the 2.1.263 tree. The live fleet
builds from 2.1.263, so installing these over the working set breaks it. The
patch set is version-specific and there is currently no mechanism selecting one
by version — `build.sh` picks a directory by FORMAT (monolithic vs chunked),
not by version. Wiring that up is a prerequisite for supporting both.

## State against 2.1.278 — 8/11 apply

| patch | state |
|---|---|
| 001-session-hooks | applies unchanged |
| 002-claudiverse-sidecar | **ported** — locals `o`→`s`, `d`→`g` |
| 003-interactive-inject | **ported** — stub `$k`→`Ey`, param `w`→`h` |
| 005-command-hooks | **BLOCKED — needs rediscovery** |
| 006-account-banner | applies unchanged |
| 007-remote-answer | **ported** — store local `v`→`dialogStore` |
| 008-idle-signal | **regenerated** (fuzzy placement, then re-diffed) |
| 009-compact-signal | applies unchanged |
| 010-cvstate-heartbeat | **BLOCKED — needs rediscovery** |
| 011-spawn-trust | **ported** — unique `trustAccepted` in coreSchemas.js |
| 012-account-failover | **BLOCKED — needs rediscovery** |

## The three that remain are NOT re-contexting

Each lost the landmark itself, so there is nothing to re-context against.

**005 — command registry.** All three 2.1.263 locators are gone from 2.1.278:
`'skillDoctor'` and `'pluginTypes'` (command groups, deleted upstream) and
`builtinCommandTable` (the property the registry was memoised on, 0 hits).
The nearest lookalike, `GP()`, is the TOOL list — it carries
`underlyingV1ToolName` and holds TWO `...[],` slots, so keying on that shape
would inject slash commands into the tool table. Needs a fresh tree-unique key
for the command table as 2.1.278 now builds it.

**010 — cvstate heartbeat.** Its anchor is the line
`(E($Oo, WOo), YVe(IQr, replStatusForActivity, EQr));` inside
`useReplStatusEffects`. On 2.1.278 that region is React-Compiler memo-cache
output and has been reshaped: `replStatusForActivity` survives, but only as a
DEFINITION, and the combined call line does not exist. One of its two injected
identifiers is already bound — the queue hook `qc` is `$d` on 2.1.278
(`$d().getMainThreadQueueLength()`); the effect alias `E` still needs binding,
and should be read off whatever anchor replaces that line rather than assumed.

**012 — account failover.** `withRetryGenerator` has 0 hits on 2.1.278. 🔴 That
name is a DEOBFUSCATOR RENAME, not a source symbol — this patch has been
anchored on a rename rule firing, and on 2.1.278 the withRetry rules decline
(`getRetryAfterHeader`, `getUnifiedRateLimitResetMs` both report
"declared file does not exist (services/api/withRetry.js)"). So the fix is
probably upstream of the patch: repair the rename rules, then re-context.
It also injects `Hw`, `Ako`, `Mot`, `pje`, each of which must be bound at its
definition site — 012's own header records a 2.1.260 case where a context-only
anchor applied cleanly and emitted a reference to a DIFFERENT live variable.

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
