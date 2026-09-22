# 2.1.280 port — BLOCKED UPSTREAM OF PATCHES. Do not build from this yet.

🔴 **2.1.280 CANNOT BE BUILT AT ALL — and not because of patches.**
Every 2.1.280 build fails in bun's bundling step:

    error: No matching export in ".../_unmatched/....js"

including `SKIP_PATCHES=1 ALLOW_UNPATCHED_BUILD=1` builds with no patches
applied. The defect is in the deobfuscator's module reconstruction, upstream of
the patch set. **Fix that first; until then no patch work here can yield a
binary.**

⚠️ **The .patch files in this directory are STALE.** They were generated against
a tree produced with an earlier trust-pin target (utils/config.js). That pin
BROKE 2.1.263 and was re-targeted to entrypoints/sdk/coreSchemas.ts, which
reshuffles module→file assignments again. Regenerate with the `.py` port
scripts against a current tree; do not trust the committed diffs.

🔴 **Lesson paid for twice in one session:** a pin is GLOBAL. It relocates its
module on every version, and relocating one module reshuffles the file the
others land in. After any pin change, re-run BOTH builds — 2.1.263 first,
because that is what the live fleet uses. The .py scripts survive this; the
generated .patch files do not.

## Applying (8)

001 (clean) · **002** · **003** · 006 (clean) · **007** · **008** (fuzzy,
re-diffed) · 009 (clean) · **011**   — bold = ported here, each verified by
applying to a pristine tree in build order and re-parsing the emitted file.

Every port CAPTURES minified locals instead of hardcoding them, because
hardcoding is exactly what broke the 2.1.278 scripts three days later:
  002  structuredIO arg `t`(.263)→`s`(.278)→`n`(.280); query `o`→`s`, `d`→`g`
  003  helpers stub `$k`→`iv`→`Ey`→`nm`, renamed EVERY release; bindHost arg
       `w`→`h`; private fields `#e`/`#t` discovered from the constructor
  007  store local `v`→`dialogStore`
  011  trust gate: file moved coreSchemas→auth→(pinned)config; local captured

## Blocked (3) — each needs a minified identifier BOUND, not guessed

**005 — command registry.** On 2.1.263 the table was memoised via
`builtinCommandTable ??= <fn>()`. On 2.1.278 that symbol was absent entirely;
on 2.1.280 it is back but refactored into a CLASS CACHE FIELD
(`builtinCommandTable = void 0`) in `_unmatched/0075_KV.js`, and the function
that builds the table is not in that file. `_unmatched/` is the low-confidence
bucket, so the path will move again — this one wants a pin once the builder is
found. Do NOT key on the `...[],` slot shape: the lookalike `GP()` is the TOOL
list (it carries `underlyingV1ToolName`) and holds two such slots, so a blind
match injects slash commands into the tool table.

**010 — cvstate heartbeat.** Host `useReplStatusEffects` survives and so does
`replWaitingForActivity`, but the status variable it reads — `replStatusForActivity`
on 2.1.263 — is now a React-Compiler memo local (`Fo`) inside a `pt[...]` cache
run. Queue hook IS bound: `qc`(.263) → `$d`(.278) → `Dd`(.280), reachable as
`Dd().getMainThreadQueueLength()`. The effect alias and the status local still
need binding, and a wrong status local yields a silently WRONG idle signal —
the seat would report ready while busy.

**012 — account failover.** The retry loop is in
`upstreamproxy/upstreamproxy.js` on 2.1.280 — an unpinned heuristic path (it was
`precomputedCompact.js` on .278). `withRetryGenerator` has 0 hits because that
name is a DEOBFUSCATOR RENAME, not a source symbol, and its rule declines.
Injects `Hw`, `Ako`, `Mot`, `pje`, all minified. 012's own header records a
2.1.260 case where a context-only anchor applied cleanly and emitted a
reference to a DIFFERENT live variable — a dead feature behind a green check.
Pin the module first (keyed on a telemetry literal such as
`api_request_no_response_exhausted`, measured unique to one raw module), then
re-context. ⚠️ Check for a pin collision first: the same key collided with the
existing subagent pin on an earlier attempt, and a collision is a hard build
failure.
