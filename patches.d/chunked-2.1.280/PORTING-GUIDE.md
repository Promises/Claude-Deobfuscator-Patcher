# Porting the claudiverse patch set to a new Claude Code release

Written after taking the set from 2.1.263 to 2.1.278 and then 2.1.280. It is a
method, not a changelog — the specific names below rot, the technique does not.

## The one number that should shape your expectations

    patch set built for   applies on .263   on .278   on .280
    2.1.263                    11/11          4/11      3/11
    2.1.278 (hand-ported)       —             8/11      3/11

A hand-port has a shelf life of about three days. Only three patches (001, 006,
009) have survived every version untouched. Budget accordingly: the durable work
is pins and capture-based scripts, not re-contexting.

## Why patches break — in order of how often it actually happened

**1. Module relocation (most common).** The FILE a patch names stops holding the
code. The deobfuscator derives paths heuristically, so they move between
releases. The trust gate lived in `entrypoints/sdk/coreSchemas.js` on .278 and
`utils/auth.js` on .280 with a BYTE-IDENTICAL gate line — the patch failed purely
on path.

  *Fix:* a pin in `tools-ts/anchor-rules.json`. Measured control: across
  .278→.280 the two pinned modules kept their paths while the unpinned one moved.

**2. Minified identifiers in the injected code.** Every local renames each
release. The editor-helpers stub went `$k` → `iv` → `Ey` → `nm` across four.

  *Fix:* never hardcode one. Either alias it at its DEFINITION site (what 003
  does, so injected code names only `globalThis.__cvSubmitHelpers`), or CAPTURE
  it with a regex in the port script. The `.py` files here all do the latter —
  the .278 scripts hardcoded and broke in three days.

**3. Genuine restructuring.** Upstream refactors the code out of existence. No
technique helps; you rediscover.

## Method

1. Fetch and build a tree:

       ./fetch-versionref.sh <ver>
       # chunked builds also need the binary for build.sh:
       npm pack @anthropic-ai/claude-code-darwin-arm64@<ver>
       tar xzf *.tgz package/claude && mv package/claude versionref/<ver>-bin
       BUILD_VERSION=<ver> SKIP_PATCHES=1 ALLOW_UNPATCHED_BUILD=1 \
         DEOB_DIR=/tmp/t OUT_BIN=/tmp/x ./build.sh

2. `git init` the tree, commit a pristine baseline, then run
   `patches.d/chunked-2.1.280/reanchor.sh /tmp/t /tmp/out`. It applies in BUILD
   ORDER — load-bearing, because 008 and 010 sit nine lines apart in one file —
   and auto-regenerates anything fuzzy placement can land.

3. For each remaining failure, find the site by a SOURCE-STABLE token: an error
   message, a telemetry event name, a property name. Not a deobfuscator rename —
   `withRetryGenerator` has 0 hits on .280 because that name is produced by a
   rename RULE, and the rule declines.

4. Write a port script that asserts its anchor count BEFORE editing. This is not
   ceremony; it caught two real misfires:
     * `bindHost(x) { this.#t = x; }` occurs THREE times in useSwarmBanner.js —
       an unscoped replace patches the wrong class.
     * the lookalike command list `GP()` is the TOOL table (it carries
       `underlyingV1ToolName`) and holds two `...[],` slots — a blind match
       injects slash commands into the tool table.

5. Regenerate with `git diff -U6`, then verify: applies to a PRISTINE tree in
   build order, and `node --check` the emitted file.

## Adding a pin

`tools-ts/anchor-rules.json`, shape `{type, source, find:{text|regex}, description}`.

  * Pins match the RAW MINIFIED module cache (`.deob_cache/modules`), NOT the
    renamed tree. Verify your key there.
  * The key must resolve to ONE module. Count distinct module numbers —
    `chunk_NNNN.js` and `NNNN_name.js` are the same module twice.
  * ⚠️ CHECK THE MODULE IS NOT ALREADY CLAIMED. A collision is a hard build
    failure. Two of three pins tried here collided: the retry loop shares a
    module with `query()`, and the message queue shares one with
    `memoizeCapped` — which is where 001 and 009 already target.
  * A pin moves the WHOLE module, not just the symbol keyed on.

## The three still unwired on 2.1.280

`013-unwired-features.patch` records these at runtime so a seat says what it
cannot do. **Delete that patch once they land.**

### 005-command-hooks
Injects `...(globalThis.__commandHooks ? globalThis.__commandHooks.getCommands() : [])`
into the builtin slash-command array.
- .263 located it via `builtinCommandTable ??= <fn>()`. On .278 that symbol was
  ABSENT; on .280 it is back but refactored into a CLASS CACHE FIELD
  (`builtinCommandTable = void 0`) in `_unmatched/0075_KV.js`.
- **Open:** find the function that POPULATES the table — it is not in that file.
  Then pin its module (`_unmatched/` is the low-confidence bucket, so it will
  move again).
- ⛔ Do not key on the `...[],` slot shape. See the `GP()` trap above.

### 010-cvstate-heartbeat
Injects a 3s `setInterval` mirroring `{type:'cvstate', idle}`.
- Bound already: host `useReplStatusEffects`; `replWaitingForActivity` survives;
  queue hook `qc`(.263) → `$d`(.278) → `Dd`(.280), as
  `Dd().getMainThreadQueueLength()`.
- **Open:** the React effect alias, and the status local — `replStatusForActivity`
  on .263 is now a React-Compiler memo local (`Fo`, with `status: uo`
  destructured nearby) inside a `pt[...]` cache run.
- 🔴 A wrong status local yields a silently WRONG idle signal: the seat reports
  ready while busy, and an orchestrator acts on that. Verify BEHAVIOURALLY
  against a running seat, not by reading.

### 012-account-failover
Hooks the API retry loop for 429 failover, plus main.js for the OAuth refresh
callback.
- **Open:** the retry loop could not be located on .280. Tried and failed:
  telemetry literals (`api_request_*`), `.onError?.(`, 3-arg async generators
  (`RT`, `vm` — neither is it), the `for (let i = 1; i <= n + 1; i++)` counter
  shape (two hits, neither is it), `status === 429` (the hit in
  `upstreamproxy/upstreamproxy.js` is the proxy's own handler).
- Next things to try: follow the call chain from `queryLoop`'s API invocation
  down rather than searching for markers; or diff the .278 module against .280
  to see what the loop became.
- Injects `Hw`, `Ako`, `Mot`, `pje` — all minified, all needing definition-site
  binding.
- 🔴 012's own header records a 2.1.260 case where a context-only anchor applied
  cleanly and emitted a reference to a DIFFERENT live variable — a dead feature
  behind a green check. "Applies cleanly" is not evidence this one works.
