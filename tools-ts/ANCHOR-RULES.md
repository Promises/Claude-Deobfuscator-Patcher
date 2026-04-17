# Anchor Rules Guide

User-defined structural rename rules for the deobfuscation pipeline. Anchors find minified identifiers by AST patterns that survive minification, then rename them via the TypeScript Language Service.

## How It Works

1. **Root rule** finds a pattern in a file, walks up the AST to a containing scope (function/class/etc), extracts the minified name
2. **Walk rules** chain from resolved anchors, traversing the AST to find related identifiers (params, locals, callees, etc.)
3. **Global renames** (functions, classes, module-level vars) go through the TS Language Service — one rename propagates across all files
4. **Scoped renames** (params, locals via `param:` and `local:` walks) are applied post-prettify within the function body only

### Pipeline Integration

Anchors run at two points in the build pipeline:

| Step | What runs | File state |
|------|-----------|------------|
| `rename` | Root rules + walk rules resolve. Global renames via TS LS. | Post-modrecon, pre-prettify |
| `prettify` | Scoped renames (`param:`, `local:`, `contains:` walks) applied. | Post-rename, post-prettify |

Global renames use exact AST positions, so they must run before prettify reformats the code. Scoped renames use text replacement by function name, so they run after prettify when the code is readable and functions have their renamed names.

## Rule Types

### Root Rule

Finds a pattern in a deobfuscated file and anchors a scope.

```json
{
    "id": "myAnchor",
    "description": "human-readable description",
    "file": "utils/config.js",
    "find": { "string_literal": "approved" },
    "scope": "function",
    "rename": "getCustomApiKeyStatus"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | no | Identifier for dependent walk rules (defaults to `rename`) |
| `description` | no | Human-readable description |
| `file` | **yes** | Path relative to `deobfuscated/` |
| `find` | **yes** | Pattern to locate in the file (see Find Criteria) |
| `scope` | **yes** | AST scope to walk up to (see Scope Types) |
| `rename` | no* | New name for the matched scope |
| `anchor_only` | no | If `true`, resolve the anchor but emit no rename |
| `class` | no | Also rename the enclosing class (when `scope: "method"`) |

\* Required unless `anchor_only: true`

### Walk Rule

Starts from a resolved anchor and traverses to find another identifier.

```json
{
    "from": "myAnchor",
    "walk": "param:0",
    "rename": "truncatedApiKey",
    "id": "optionalId",
    "description": "first parameter"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `from` | **yes** | References another rule's `id` or `rename` |
| `walk` | **yes** | Walk expression (see Walk Types) |
| `rename` | **yes** | New name for the discovered identifier |
| `id` | no | Identifier for further chaining |
| `description` | no | Human-readable description |
| `find` | no | Find criteria to narrow position within parent before walking (see Find Criteria) |

Walk rules without a `rename` that produces a real identifier (e.g. `return:comma:4`) serve as **intermediate anchors** — they resolve to an AST region for further walks.

When `find` is specified, the engine first locates the pattern within the parent node's scope, then starts the walk from the deepest AST node at that position. This enables patterns like "find a string, walk up to its parent if-statement."

## Find Criteria

Used in root rules to locate a pattern in the file.

| Type | Example | Matches |
|------|---------|---------|
| `{ "text": "..." }` | `{ "text": "startGlobalConfigFreshnessWatcher" }` | Substring in raw file text |
| `{ "regex": "..." }` | `{ "regex": "mtimeMs.*Date\\.now\\(\\)" }` | Regex against raw file text |
| `{ "string_literal": "..." }` | `{ "string_literal": "approved" }` | String literal in AST (exact match) |
| `{ "string_startswith": "..." }` | `{ "string_startswith": "saveGlobalConfig" }` | String literal starting with prefix |
| `{ "string_endswith": "..." }` | `{ "string_endswith": "GH #3117." }` | String literal ending with suffix |
| `{ "string_contains": "..." }` | `{ "string_contains": "refusing to write" }` | String literal containing substring |
| `{ "number": N, "op": "..." }` | `{ "number": 128, "op": "<" }` | Numeric literal, optionally inside binary expression |
| `{ "property_assignment": { "key": "...", "value": "..." } }` | `{ "property_assignment": { "key": "type", "value": "tool_result" } }` | Object property in AST (key and/or value, at least one required) |
| `{ "function_name": "..." }` | `{ "function_name": "getGlobalConfig" }` | Function by name (only works post-rename or for already-named functions) |

**Tip:** `string_literal` and `property_assignment` are AST-level — they won't match inside comments or nested strings. `text` and `regex` match raw source text.

## Scope Types

Used in root rules to specify what AST scope to walk up to from the found pattern.

| Scope | Matches |
|-------|---------|
| `function` | Any function (declaration or expression) |
| `async_function` | Async non-generator function |
| `generator` | Generator function (`function*`) |
| `async_generator` | Async generator (`async function*`) |
| `method` | Class method |
| `class` | Class declaration or expression |
| `arrow` | Arrow function |

## Walk Types

### Parameters & Locals

| Walk | Description | Scoped? |
|------|-------------|---------|
| `param:N` | Nth parameter (0-indexed) | yes |
| `local:array_init` | First variable initialized to `[]` | yes |
| `local:for_of_binding` | First for-of loop variable | yes |
| `local:for_of_binding:N` | Nth for-of loop variable | yes |
| `local:yield_star_result` | Variable assigned from `yield*` | yes |
| `local:call_result` | First variable initialized to a function call | yes |
| `local:call_result_callee` | Callee of the first `let x = fn()` call | no |

**Scoped** walks rename the identifier only within the function body (applied post-prettify). Non-scoped walks produce global renames via the TS Language Service.

### Callees & References

| Walk | Description |
|------|-------------|
| `yield_star_callee` | Function called via `yield*` |
| `call_string_arg:VALUE:callee` | Callee of a call with string argument VALUE (VALUE can contain colons) |
| `call_string_contains:SUBSTR:callee` | Callee of a call with string argument containing SUBSTR |
| `method_arg_callee:METHOD` | In `.METHOD(X())`, returns callee `X` |
| `only_bare_call` | The callee name, only if there's exactly one zero-argument call in the body |
| `callee` | From a call expression node, returns the callee identifier |

### Structural

| Walk | Description |
|------|-------------|
| `return:comma:N` | Return statement with N-part comma expression (intermediate anchor) |
| `return:postfix_increment_operand` | Operand of `X++` inside a return |
| `contains:TEXT:assign_target` | Assignment target (`X = ...`) containing TEXT |
| `contains:TEXT:assign_target:N` | Nth such assignment target |
| `contains:TEXT:member_access_target` | Identifier accessed as `X.TEXT` |
| `if:condition_refs:ANCHOR_ID` | If-statement whose condition references a resolved anchor (intermediate anchor) |
| `postfix_increment_operand` | First `X++` or `++X` in the node region |
| `standalone_increment` | First `X++;` as a standalone statement |
| `closest_parent:TYPE` | Walk up AST to nearest parent of TYPE (`if`, `while`, `for`, `call`, `return`, `expression_statement`) |
| `condition_callee` | From an if/while node, return the callee of the condition (`if (fn(x))` → `fn`) |
| `binary_other_operand` | From a node inside a binary expression (via `find`), return the identifier on the other side (`if (_H === 'compact')` with find on `'compact'` → `_H`) |

### Class

| Walk | Description |
|------|-------------|
| `enclosing_class` | Name of the enclosing class |
| `method:find:TEXT` | Method whose body contains TEXT |

### Export Map (Bulk Rename)

| Walk | Description |
|------|-------------|
| `export_map` | Find the object literal containing `key: () => MINIFIED_NAME` and return it as a positional anchor |

Used with `"rename": "__export_map"` to bulk-rename all entries in a CJS export map. The pattern matches objects like:

```js
M_(exports, {
    waitForScrollIdle: () => RIH,
    setMeter: () => Ee_,
    // ...
});
```

Each `key: () => minifiedName` entry becomes a global rename (`minifiedName -> key`). Each entry also registers a chainable anchor with ID `<file>_fun_<key>` (e.g. `bootstrap/state.js_fun_setMeter`).

**Example rule:**

```json
{
    "from": "getTotalCacheReadInputTokens",
    "walk": "export_map",
    "rename": "__export_map",
    "id": "state_exports",
    "description": "bulk rename all bootstrap/state.js exports from the export map"
}
```

This requires an existing anchor in the same file (here `getTotalCacheReadInputTokens`) — the walk searches the file for the object literal containing `() => ANCHOR_MINIFIED_NAME`, then extracts all entries.

## Chaining

Walk rules form dependency chains. A walk can reference any previously resolved anchor by `id` or `rename`. Chains resolve iteratively (up to 10 rounds).

**Example chain:** Find `getGlobalConfig` from `getCustomApiKeyStatus`:

```
getCustomApiKeyStatus (root: string_literal "approved")
  |-- local:call_result_callee -> getGlobalConfig (id: getGlobalConfig)
       |-- return:comma:4 -> (intermediate, id: getGlobalConfig_returnExpr)
       |    |-- contains:Date.now():assign_target -> globalConfigCache
       |    +-- contains:size:assign_target -> lastReadFileStats
       |-- if:condition_refs:globalConfigCache -> (intermediate, id: cacheHitBranch)
       |    +-- postfix_increment_operand -> configCacheHits
       +-- standalone_increment -> configCacheMisses
```

---

## Anchor Dev Tool

Interactive REPL and CLI for developing and testing anchor rules without repeated full builds.

### Starting the tool

```bash
cd patch-ref

# REPL mode (interactive)
bun run tools-ts/src/anchor-dev.ts deobfuscated tools-ts/anchor-rules.json

# CLI mode (non-interactive, for scripting and LLM use)
bun run tools-ts/src/anchor-dev.ts deobfuscated -- "from STATE ; inspect ; callers"

# CLI: multiple commands separated by ;
bun run tools-ts/src/anchor-dev.ts deobfuscated -- "anchors setMeter"
```

In CLI mode, `resolve` runs automatically unless the first command is `build`, `resolve`, or `help`. Commands are separated by `;`. No REPL prompt, no colors — output is pipe-friendly.

### Commands

#### Build commands

| Command | Description |
|---------|-------------|
| `build global` | Clean build to modrecon (pre-rename state for global anchor dev) |
| `build scoped` | Clean build through prettify with ANCHOR_ONLY (for scoped anchor dev) |
| `build full` | Same as `build scoped` |
| `build rename` | Re-run rename + prettify only (fast, assumes modrecon already done) |
| `build clean` | Just clean |
| `build <steps>` | Pass arbitrary steps to entrypoint.sh |

#### Resolution

| Command | Description |
|---------|-------------|
| `resolve` | Run all anchor rules, show all renames and anchor-only entries |
| `resolve <id>` | Show result for a specific anchor |
| `anchors [filter]` | List all resolved anchor IDs with optional substring filter |

#### Navigation

| Command | Description |
|---------|-------------|
| `from <id>` | Set context to a resolved anchor (by id or rename name) |
| `find <type> <value> [file]` | Test a find criteria against a file |
| `scope <type>` | From last `find` result, walk up to a scope type |

#### Inspection

| Command | Description |
|---------|-------------|
| `inspect` | Full summary: params, locals, strings, calls |
| `params` | List function parameters with index |
| `locals` | List local variable declarations with initializer summaries |
| `strings` | List all string literals in scope |
| `returns` | List return statements (shows comma expression lengths) |
| `calls` | List function calls |
| `members` | List property accesses (`X.foo`) |
| `callers [name]` | Find references/callers across all deobfuscated files |
| `source [N]` | Print source code (default 30 lines) |

#### Walk testing

| Command | Description |
|---------|-------------|
| `walk <expr>` | Try a walk expression from current context, show result |

#### Other

| Command | Description |
|---------|-------------|
| `mode [global\|scoped]` | Show or switch mode |
| `rules` | List all rules from anchor-rules.json |
| `applied` | List renames applied this session |
| `help` | Show command list |
| `quit` | Exit |

---

## Step-by-Step: Creating a New Anchor

This is the complete workflow for identifying a function in obfuscated code and writing anchor rules that rename it. Follow these steps in order.

### Step 1: Identify the target

You need to rename a minified function. Start by reading the deobfuscated file and understanding what the function does. Look for:

- What strings does it contain? (best anchors)
- What APIs does it call? (`.statSync`, `.existsSync`, etc.)
- What property keys does it use? (`modelUsage`, `customApiKeyResponses`)
- What structural patterns does it have? (comma returns, generators, async generators)

### Step 2: Find a unique stable pattern

The pattern must:
1. **Exist in the pre-rename file** — anchors resolve before renames are applied
2. **Be unique within the file** — if two functions contain `"error"`, you need a more specific pattern
3. **Survive minification** — string literals, property keys, and API names survive; variable names don't
4. **Be version-stable** — prefer patterns from the original source, not artifacts of a specific build

**Priority order for find criteria:**
1. `string_literal` — most reliable, survives minification unchanged
2. `property_assignment` — structural, AST-level match
3. `regex` — flexible but fragile to reformatting
4. `text` — raw substring, simplest but least precise

**Use the dev tool to explore:**
```
find string_literal cacheReadInputTokens bootstrap/state.js
scope function
inspect
strings
```

### Step 3: Determine scope type

Look at the function's declaration style:

| Code pattern | Scope type |
|-------------|------------|
| `function foo() {}` | `function` |
| `async function foo() {}` | `async_function` |
| `function* foo() {}` | `generator` |
| `async function* foo() {}` | `async_generator` |
| `class Foo { bar() {} }` (the method) | `method` |
| `class Foo {}` (the class itself) | `class` |
| `const foo = () => {}` | `arrow` |

**Important:** If you use `function` as the scope, it matches ANY function type (async, generator, etc.). Use the specific type only when you need to disambiguate between functions in the same file that contain the same string.

**Use the dev tool to check:**
```
find string_literal approved utils/config.js
scope function
inspect
```

### Step 4: Write the root rule

```json
{
    "id": "myFunction",
    "description": "myFunction -- does X via Y",
    "file": "utils/config.js",
    "find": { "string_literal": "approved" },
    "scope": "function",
    "rename": "myFunction"
}
```

- Set `id` if you plan to chain walk rules from this anchor
- Set `anchor_only: true` if the function itself doesn't need renaming, but you need it as a stepping stone

### Step 5: Chain walk rules for related identifiers

Once you have the root anchor, walk to params, locals, callees, and structural patterns:

```json
{ "from": "myFunction", "walk": "param:0", "rename": "config" },
{ "from": "myFunction", "walk": "local:call_result_callee", "rename": "getGlobalConfig", "id": "getGlobalConfig" },
{ "from": "getGlobalConfig", "walk": "contains:modelUsage:member_access_target", "rename": "STATE" }
```

**Use the dev tool to discover walks:**
```
from myFunction
params          # see parameter names and indices
locals          # see local variables and their initializers
calls           # see what functions are called
members         # see property accesses
returns         # see return statements and comma expression lengths
walk param:0    # test a walk
walk local:call_result_callee   # test another walk
```

### Step 6: Use intermediate anchors for precision

When a function has complex structure, narrow the search scope with intermediate anchors:

```json
{
    "from": "getGlobalConfig",
    "walk": "return:comma:4",
    "id": "getGlobalConfig_returnExpr",
    "description": "4-part comma return in getGlobalConfig"
}
```

This doesn't emit a rename — it creates a positional anchor on the comma expression. Further walks from `getGlobalConfig_returnExpr` only search within that expression:

```json
{ "from": "getGlobalConfig_returnExpr", "walk": "contains:Date.now():assign_target", "rename": "globalConfigCache" }
```

Without the intermediate anchor, `contains:Date.now():assign_target` would search the entire function body and might match the wrong assignment.

### Step 7: Test with the dev tool

```
resolve                    # run all rules, check for failures
from getGlobalConfig       # inspect the resolved anchor
source 50                  # see the code
walk return:comma:4        # test the walk
```

### Step 8: Build and verify

```
build rename               # fast: re-runs rename + prettify only
```

Or from a terminal:
```bash
./entrypoint.sh clean && ANCHOR_ONLY=1 ./entrypoint.sh extract deob modrecon rename prettify
```

Then check the output:
```bash
grep "getGlobalConfig" deobfuscated/utils/config.js
grep "function getCustomApiKeyStatus(truncatedApiKey)" deobfuscated/utils/config.js
```

---

## Deciding: Global vs Scoped Rename

| Question | Global | Scoped |
|----------|--------|--------|
| What is it? | Module-level function, class, exported var | Function parameter, local variable |
| Where is it renamed? | All files via TS Language Service | Only within the parent function body |
| When does it run? | `rename` step | End of `prettify` step |
| Walk prefix? | No prefix, or `local:call_result_callee`, `yield_star_callee`, etc. | `param:`, `local:`, `contains:` |
| Can chain further? | Yes, via `id` | Yes, via `id` (but the anchor still references the scoped name) |

**Rule of thumb:** If the identifier is declared at module scope (`var X = ...` at the top level, `function X() {}` at the top level), it's global. If it's inside a function body (`let x = ...`, function params), it's scoped.

---

## Common Patterns

### Rename a function by a unique string it contains

```json
{
    "file": "bootstrap/state.js",
    "find": { "string_literal": "cacheReadInputTokens" },
    "scope": "function",
    "rename": "getTotalCacheReadInputTokens"
}
```

### Rename a function's parameter

```json
{ "from": "getTotalCacheReadInputTokens", "walk": "param:0", "rename": "usage" }
```

### Rename the callee of a local `let x = fn()` call

```json
{ "from": "getCustomApiKeyStatus", "walk": "local:call_result_callee", "rename": "getGlobalConfig", "id": "getGlobalConfig" }
```

This is global — the callee `fn` is a module-level function, so TS LS renames it everywhere.

### Rename a module-level var via member access

Find a function that accesses `STATE.modelUsage`, rename the object:

```json
{ "from": "getTotalCacheReadInputTokens", "walk": "contains:modelUsage:member_access_target", "rename": "STATE" }
```

### Use an intermediate anchor to target a specific return expression

```json
{ "from": "getGlobalConfig", "walk": "return:comma:4", "id": "returnExpr" },
{ "from": "returnExpr", "walk": "contains:Date.now():assign_target", "rename": "globalConfigCache" }
```

### Chain through an if-statement that references a resolved anchor

```json
{ "from": "getGlobalConfig", "walk": "if:condition_refs:globalConfigCache", "id": "cacheHitBranch" },
{ "from": "cacheHitBranch", "walk": "postfix_increment_operand", "rename": "configCacheHits" }
```

### Rename a function found via generator yield*

```json
{
    "file": "query.js",
    "find": { "string_literal": "completed" },
    "scope": "async_generator",
    "rename": "query"
},
{ "from": "query", "walk": "yield_star_callee", "rename": "queryLoop" }
```

### Rename a function passed as argument to a method

In `NodeFsOperations().statSync(getGlobalClaudeFile())`:

```json
{ "from": "getGlobalConfig", "walk": "method_arg_callee:statSync", "rename": "getGlobalClaudeFile" }
```

### Bulk rename an entire file from its CJS export map

If a file has a `M_(exports, { key: () => minified, ... })` pattern, one rule renames all exports:

```json
{
    "id": "myAnchor",
    "file": "bootstrap/state.js",
    "find": { "string_literal": "cacheReadInputTokens" },
    "scope": "function",
    "rename": "getTotalCacheReadInputTokens"
},
{
    "from": "myAnchor",
    "walk": "export_map",
    "rename": "__export_map",
    "id": "state_exports",
    "description": "bulk rename all bootstrap/state.js exports"
}
```

This finds the object literal containing `() => PIH` (the anchor's minified name), then extracts every `key: () => identifier` pair as a rename. Each entry also registers a chainable anchor with ID `bootstrap/state.js_fun_<key>`.

To explore the generated anchors:

```
anchors bootstrap/state.js_fun_setMeter
from bootstrap/state.js_fun_setMeter
inspect
```

---

### Find a string inside a function, walk up to the parent if, get the condition callee

Uses `find` in a walk rule to locate a position, then `closest_parent:if` and `condition_callee`:

```json
{
    "from": "utils/config.js_fun_saveGlobalConfig",
    "find": { "string_contains": "refusing to write" },
    "walk": "closest_parent:call",
    "id": "fallbackCall"
},
{ "from": "fallbackCall", "walk": "callee", "rename": "logForDebugging" },
{ "from": "fallbackCall", "walk": "closest_parent:if", "id": "authLossIf" },
{ "from": "authLossIf", "walk": "condition_callee", "rename": "wouldLoseAuthState" }
```

This matches the pattern `if ($Z_(K)) { h("...refusing to write...") }` and renames both `h` → `logForDebugging` and `$Z_` → `wouldLoseAuthState`.

---

## Testing

### Quick test (against current deobfuscated files)

```bash
cd patch-ref

# Test anchor resolution (no build needed, uses current deobfuscated/ state)
ANCHOR_VERBOSE=1 bun -e '
const { applyAnchorRules } = require("./tools-ts/src/anchor-rules.ts");
const results = applyAnchorRules("deobfuscated", "tools-ts/anchor-rules.json");
for (const r of results) {
    console.log("  " + r.minified + " -> " + r.original + " (" + r.confidence + "%) -- " + r.reason);
}
'
```

**Important:** Anchor rules run against **pre-rename** files. If you've already built through `rename`, the files have changed. Either:
- Build only through `modrecon` first: `./entrypoint.sh clean && ./entrypoint.sh extract deob modrecon`
- Or test after a fresh `clean` + partial build

### Anchor-only build (fast iteration)

```bash
# Full clean build, skipping constraint renamer (~4s rename vs ~95s)
./entrypoint.sh clean && ANCHOR_ONLY=1 ./entrypoint.sh extract deob modrecon rename prettify

# Or reset just the rename step (only resets the step state, NOT the files)
# NOTE: reset only resets the build state tracker -- files remain modified.
# For a clean state, use a full clean build instead.
./entrypoint.sh reset rename && ANCHOR_ONLY=1 ./entrypoint.sh rename prettify
```

### Full build (with constraint renamer)

```bash
./entrypoint.sh clean && ./entrypoint.sh extract deob modrecon rename prettify
```

### Verify results

```bash
# Check a specific rename landed
grep "getGlobalConfig" deobfuscated/utils/config.js

# Check scoped renames (params/locals)
grep "function getCustomApiKeyStatus(truncatedApiKey)" deobfuscated/utils/config.js
```

## Debugging

### Verbose output

```bash
# Anchor rule resolution details (shows skips and failures)
ANCHOR_VERBOSE=1 ./entrypoint.sh rename

# TS Language Service skip reasons
RENAME_VERBOSE=1 ./entrypoint.sh rename

# Both
ANCHOR_VERBOSE=1 RENAME_VERBOSE=1 ./entrypoint.sh rename
```

### Common issues

**Walk fails ("walk X failed")**
- The parent node was found but the walk expression didn't match. Check the pre-rename code — the structure may differ from what you expect.
- Use `ANCHOR_VERBOSE=1` with the quick test script to see which walks fail.

**Rename not applied (in `_renames.json` but not in file)**
- The TS LS couldn't find the declaration in the assembled file. Check if the identifier is declared inside a function wrapper (init functions like `R(() => { ... })`).
- `RENAME_VERBOSE=1` will show `skip (no decl)` or `skip (no locs)`.

**Collision with constraint renamer**
- If an anchor and constraint renamer disagree on a name, the anchor wins (non-anchor entries are dropped).
- If two constraint results collide (same original, different minified), both are dropped.

**Scoped renames not applying**
- Scoped renames only run for `param:` and `local:` walks, plus `contains:` walks.
- The parent function must be findable by its **renamed** name in the post-prettify file.
- Walk-derived anchors (from chains) are resolved by re-running `applyAnchorRules` during the scoped rename pass.

**`function_name` find doesn't match**
- `function_name` matches the current name in the file. Pre-rename, functions have minified names. Use a content-based `find` (string_literal, regex, property_assignment) instead.
- `function_name` is mainly useful for post-rename passes or functions that already have their original name.

**`reset rename` doesn't reset file changes**
- `entrypoint.sh reset rename` only resets the build step state tracker. The deobfuscated files remain modified from the previous rename run. For truly clean state, use `./entrypoint.sh clean && ...` with the full pipeline.

---

## Writing Good Anchors

### Choose stable patterns

Prefer patterns that won't change between versions:
- **String literals** (`"approved"`, `"cacheReadInputTokens"`) — these are in the original source and survive minification
- **Property names** (`customApiKeyResponses`, `modelUsage`) — object keys are preserved
- **Method names** (`.statSync`, `.existsSync`) — built-in API calls are stable
- **Property assignments** (`{ type: "tool_result" }`) — structural patterns in data objects

Avoid:
- Minified identifiers (`T_`, `Gd`, `sP`) — these change every version
- Renamed identifiers (`getGlobalConfig`) — these only exist post-rename
- Position-dependent patterns (first function, second variable) — fragile to additions

### Chain from stable to unstable

Start with a root anchor on something unique and stable, then walk to the identifiers you actually want to rename:

```
"approved" (stable string) -> getCustomApiKeyStatus (function)
  -> local:call_result_callee -> getGlobalConfig (the real target)
    -> further walks into getGlobalConfig's body
```

### Use intermediate anchors

When you need to narrow scope, use `anchor_only` or id-only walks:

```json
{ "from": "fn", "walk": "return:comma:4", "id": "returnExpr" }
```

This resolves to the comma expression AST node. Further walks from `returnExpr` search only within that expression, not the whole function.

### One anchor, many renames

A single root anchor can drive dozens of renames through walk chains. The `getCustomApiKeyStatus` anchor resolves 10+ identifiers across `getGlobalConfig` and its callers.

### Use export maps for bulk coverage

If a file has a CJS export map (`M_(exports, { originalName: () => minified, ... })`), a single `export_map` walk can rename every export in one rule. The `bootstrap/state.js` export map produces 212 renames from one walk rule.

### Verify uniqueness

Before adding a `string_literal` find, check that the string is unique within the target file:

```bash
grep -c '"approved"' deobfuscated/utils/config.js
```

If it appears multiple times, the anchor will match the first occurrence. Either use a more specific pattern, or combine with a narrower scope type (e.g. `async_generator` instead of `function`).

---

## Anchor Dev Tool Workflow Examples

### Exploring a new file for anchor candidates

```
build global
find string_literal cacheReadInputTokens bootstrap/state.js
scope function
inspect
strings
source 20
```

### Testing a walk chain interactively

```
resolve
from getCustomApiKeyStatus
locals                          # see: _ = Tp()  --> that's getGlobalConfig
walk local:call_result_callee   # -> Tp (the minified name)
from getGlobalConfig            # switch to the resolved anchor
returns                         # see: [0] [comma:2]  [1] [comma:4]
walk return:comma:4             # -> positional anchor
```

### Prototyping a new root rule

```
find string_literal RetryError services/api/withRetry.js
scope function
inspect
params
walk param:0
```

If it looks right, add the rule to `anchor-rules.json` and run:
```
build rename
resolve
```

### CLI mode: quick lookups

```bash
# Inspect a specific anchor
bun run tools-ts/src/anchor-dev.ts deobfuscated -- "from STATE ; inspect ; callers"

# List all export-map anchors for a file
bun run tools-ts/src/anchor-dev.ts deobfuscated -- "anchors bootstrap/state.js_fun_"

# Find what calls a function
bun run tools-ts/src/anchor-dev.ts deobfuscated -- "from bootstrap/state.js_fun_setMeter ; callers"

# Explore a new file
bun run tools-ts/src/anchor-dev.ts deobfuscated -- "find string_literal RetryError services/api/withRetry.js ; scope function ; inspect"
```
