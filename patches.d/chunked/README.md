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
