# Chunked-format patches (2.1.242+)

`build.sh` selects this directory when the tree FORMAT is `chunked`, and
`patches.d/*.patch` when it is `monolithic`. The dispatch is on the measured
format, never on a version number.

## Why these exist as a separate set

The two formats do not share a file layout, so a hunk cannot be "path-fixed"
from one to the other — its target file frequently does not exist:

| monolithic path | chunked reality |
|---|---|
| `query.js` | gone; the code is inside `services/compact/precomputedCompact.js` (9.1 MB) |
| `screens/REPL.js` | gone; inside `components/PromptInput/useSwarmBanner.js` (2.9 MB) |
| `commands.js` | gone; the builtin command table is in `precomputedCompact.js` |
| `_preamble.js` | gone; there is no shared runtime preamble |
| `bootstrap/sessionState.js` | still exists, but as a pure re-export BARREL with no function bodies. The definitions are in `vendor/lodash/memoizeCapped.js` |
| `utils/config.js` (trust) | the chokepoint is `$o` in `entrypoints/sdk/coreSchemas.js` |

## 🔴 These patches are VERSION-LOCKED to 2.1.260

MEASURED, not assumed: all 9 patches **fail `git apply --check` against the
2.1.259 tree**. Chunked trees keep upstream's minified declarations and the
anchor pass rewrites only the *export aliases* in barrel files, so a function's
in-body name changes freely between releases:

| what | 2.1.259 | 2.1.260 |
|---|---|---|
| `getSessionId` | `Q` | `K` |
| query entrypoint | `aN` | `EM` |
| subagent lifecycle notifier | `ope` | `Fue` |
| `getVersionSuffix` chunk | `_unmatched/0003_dH.js` | `_unmatched/0003_Px.js` |

**Expect to re-author on every bump.** That is a property of the format, not a
shortcut taken here. Each patch header names the minified symbols it depends on.

Mitigation used throughout: minified names appear **only in context lines**,
never introduced on an added line, and each hunk retains a nearby *string
literal* or *property name* (which minifiers preserve) as its real anchor. So
drift makes a patch FAIL LOUDLY at apply time rather than apply-and-misbind.

## Runtime: `globalThis`, not bare `var`

A monolithic build concatenates every section into ONE scope, so the injected
modules' top-level `var __claudiverse` / `var __sessionHooks` are visible at
every call site. A chunked build is a real ESM graph where those are
**module-scoped**. Because every call site is `try`-guarded, the bare-var form
would be `undefined` and fail **silently**.

So `patches.d/modules/*.js` now also publish onto `globalThis` (a no-op on
monolithic), and these hunks read through `globalThis`.

Two supporting tool changes were required:

- `tools-ts/src/emitter.ts` — resolve `patches.d/modules` from the tool's own
  location instead of `dirname(outputDir)`. The old form silently copied
  nothing whenever `DEOB_DIR` pointed outside `patch-ref/`.
- `tools-ts/src/bundler.ts` — bundling is reachability-based and nothing
  imports `_custom/*`, so bun dropped the modules entirely. The bundler now
  generates an entry that side-effect-imports them before the real entry.

## Not carried over

- **004** (multi-account failover) is disabled by operator decision. Its module
  still ships but now self-guards: it registered a session hook that threw
  `ReferenceError: getGlobalConfig is not defined` on every session under ESM.
- **010** (cvstate heartbeat) has no chunked equivalent. It needs four REPL
  component locals; that component is now React-Compiler output where every
  local is a minified name in a numbered memo-cache slot, so there is nothing
  safe to bind. **008 is reduced in scope for the same reason** — read its
  header before relying on the idle signal.

## 🔴 010-cvstate-heartbeat IS NOT PORTED — MIGRATION BLOCKER, NOT AN OMISSION

010 is absent from this directory deliberately. Do NOT "fix" it by binding four
plausible-looking locals.

WHY IT WAS DECLINED. It needs four REPL locals that on 2.1.260 are minified names
inside numbered React-Compiler memo-cache slots. There is nothing semantic to key
on. A WRONG BIND HERE IS SILENT AND IS STRICTLY WORSE THAN THE ABSENCE: no
heartbeat is VISIBLE (the server simply never reconciles), whereas a lying
heartbeat reports a seat healthy while it is anything at all. Declining was the
right call; preserve it until a stable anchor exists.

WHY IT BLOCKS A FLEET MIGRATION. server room.ex:211 documents 010 as "a
lightweight ~3s reachability + task snapshot" that "self-heals a missed idle
frame". MEASURED in room.ex: there are exactly TWO paths to Router.went_idle —
patch 008's "idle" event (:377) and 010's cvstate reconcile (:311). turn_complete
is DELIBERATELY excluded (:373) because it fires while background agents and
queued work are still in flight. So 010 is the ONLY backstop, and on 2.1.260 it
is gone.

COMPOUNDING: 008 is itself ported with REDUCED SCOPE on 2.1.260 — no 400 ms
debounce, and the message-queue depth is NOT consulted. So both directions are
degraded at once:
  false IDLE  (idle claimed while work is queued)  -> 238 checks queue depth; 260 does not
  missed IDLE (never clears)                       -> 238 self-heals in ~3s; 260 never does
⛔ CORRECTION: an earlier version of this note said "cv-runner.mjs reaps on idle,
so a premature idle reaps a worker mid-flight". THAT IS FALSE. cv-runner.mjs:19-21
states the opposite outright: "this runner NEVER reaps on idleness, elapsed time,
or silence. It reaps on exactly one signal — the worker calling cv_task_done,
which itself refuses without a handoff." No idle signal can reap anything.

The real consequences, which are asymmetric:
  premature IDLE -> cv_send (reject-busy) delivers to a seat that still has
                    queued work. The message QUEUES BEHIND it rather than being
                    lost. Degrades the watcher's progress view. Recoverable.
  missed IDLE    -> the seat is marked busy with nothing to clear it. cv_send
                    bounces forever and cv_status cannot diagnose it (polling
                    makes the CALLER busy). UNRECOVERABLE without a restart.
So the 010 absence (missed idle) is far more severe than the 008 reduction
(premature idle). Note cv-runner's own header cites a seat that "reported busy
for four and a half hours" as the reason it refuses to trust idleness at all —
that is exactly the failure 010 exists to self-heal, and cv_send DOES trust it.

⚠️ NO AMOUNT OF SURFACE TESTING FINDS THIS. A live seat can only exercise what is
compiled in; a missing patch is an ABSENCE. It was found by diffing the applied
patch sets, not by driving the binary.


## 9 ASSETS SHIP UTF-16LE WITH NO BOM — PRE-EXISTING UPSTREAM, NOT A 260 REGRESSION

⛔ DO NOT REDISCOVER THESE AS A CHUNKED-FORMAT DEFECT. 2.1.238 HAS THEM TOO.

Found by driving the bundled skills (dataviz, claude-api), not by any presence
check — this is a CONTENT defect and every test we run passes on it: the asset is
present, loads without error, and is then mangled by every byte-wise reader. No
BOM, so nothing auto-detects it.

Known members include anti-patterns.md, choosing-a-form.md, color-formula.md,
components.md, marks-and-anatomy.md (dataviz), two files inside the claude-api
bundle, and SKILL-8zd8x5rj.md.

CAUSATION, four independent checks — our pipeline is INNOCENT:
 1. patched3's dataviz extraction vs the pre-patched3 extraction: byte-for-byte
    IDENTICAL, same 5 files defective in both.
 2. The loose copies in patch-ref/ are ALSO UTF-16LE (hexdump: 23 00 20 00 ...),
    so the encoding predates the embedding fix.
 3. Those loose copies DIFFER in length from the bundle output — consistent with
    older snapshots of the same upstream asset, not with us rewriting anything.
 4. tools/extract_assets.py writes asset["bytes"], the ORIGINAL chunk;
    decode_member() exists only to produce text for MATCHING and its result is
    never written. The extractor deliberately preserves the encoding.
=> The UTF-16LE encoding is in the UPSTREAM binary. File it as an upstream
   product defect. It is not in scope for the asset-embedding work and is not a
   reason to hold a migration.

⚠️ The instance we predicted was a DIFFERENT one (source-kit.mjs-51mswsdh.txt, a
mis-attribution). The warning did not predict this; the CATEGORY did —
presence != content, and an asset census only ever measures presence.
