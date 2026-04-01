# Claude Code Deobfuscation & Renaming Pipeline

Recovers original function/class/variable names from the compiled Claude Code binary using structural pattern matching and TypeScript's language service for scope-aware renaming. Works across versions — the matching is based on AST patterns, not positional assumptions.

## Prerequisites

- **bun** (v1.3+) — runs all TypeScript tools
- **python3** — bundle splitter (esbuild format parser)
- **prettier** — installed as dev dep in `tools-ts/` (`bun install`)
- **Source reference** — `../claude-code` directory with original TypeScript source. Only needed for pattern generation/matching — not needed if using a pre-built `patterns-db.json` (future).

Binary auto-detected from `$HOME/.local/share/claude/versions/` (macOS).

## Pipeline Overview

```
Binary → Extract → Split → Match → Emit → Module Reconstruct → Rename → Prettify → Patch → Reassemble → Compile
```

| Step | Command | Input | Output |
|------|---------|-------|--------|
| 1. Extract | `entrypoint.sh extract` | Claude binary | `source.js` (~12MB) |
| 2. Deobfuscate | `entrypoint.sh deob` | `source.js` + source ref | `deobfuscated/` (4600+ split files) |
| 2.5. Module Reconstruct | `entrypoint.sh modrecon` | `deobfuscated/` | Same files + `import`/`export` added |
| 2.6. Rename | `entrypoint.sh rename` | `deobfuscated/` + source ref | Same files with identifiers renamed |
| 2.7. Prettify | `entrypoint.sh prettify` | `deobfuscated/` | Same files formatted with prettier |
| 3. Patch | `entrypoint.sh patch` | `deobfuscated/` + `patches.d/` | Patched files, git baseline tagged |
| 4. Reassemble | `entrypoint.sh reassemble` | `deobfuscated/` | `cli-runnable.js` (single file) |
| 5. Compile | `entrypoint.sh compile` | `cli-runnable.js` | `claude` (standalone binary) |

Run everything: `./entrypoint.sh build`

## How the Renaming Works

Three layers of matching, applied in priority order per module:

### Layer 1: Constraint Matching (inside-out, version-agnostic)

`tools-ts/src/constraint-renamer.ts`

Matches functions/classes by structural patterns that survive minification. Processes each matched module (deob file + source file pair).

**1a. Unique String Anchors** (confidence: 100%)

Find string literals that appear in exactly one deob function AND one source function.

```
Deob:   function My6() { return u7() && b1.clientType !== "claude-vscode"; }
Source: export function preferThirdPartyAuthentication() { return getIsNonInteractiveSession() && STATE.clientType !== 'claude-vscode' }

"claude-vscode" is unique → My6 = preferThirdPartyAuthentication
```

**1b. State Getter/Setter Matching** (confidence: 95%)

Identifies the STATE object (the variable with 100+ property accesses across all functions). Then matches simple getters (`function f() { return STATE.prop; }`) and setters (`function f(x) { STATE.prop = x; }`) by property name.

```
Deob:   function l1() { return b1.sessionId; }    (b1 = STATE, 150+ accesses)
Source: export function getSessionId() { return STATE.sessionId; }

Property "sessionId" matches → l1 = getSessionId
```

This single heuristic resolves ~120 functions in `bootstrap/state.js` alone.

**1c. Class Structure Matching** (confidence: 70-90%)

Compares class method names and property names. Score: `3 * method_overlap + 2 * property_overlap + pattern_bonus`. Greedy 1:1 assignment (highest score wins, no duplicates).

```
Deob:   class fO1 { intern(A) { if (A.charCodeAt(0) < 128) ... } get(A) { ... } }
Source: export class CharPool { intern(char) { if (char.charCodeAt(0) < 128) ... } get(index) { ... } }

Methods "intern", "get" match + charCodeAt+128 pattern bonus → fO1 = CharPool
```

**1d. Call Graph Propagation** (confidence: 80%)

For each resolved function, check what it calls. If the source function calls exactly one unresolved callee and the deob function calls exactly one unresolved callee, match them. Repeats up to 5 rounds.

```
Resolved: My6 = preferThirdPartyAuthentication
My6 calls u7() — only unresolved callee
Source calls getIsNonInteractiveSession() — only unresolved callee
→ u7 = getIsNonInteractiveSession
```

**1e. Export Map Validation** (confidence: 75%, fallback)

esbuild bundles contain export helper calls: `M_(exports, { originalName: () => minifiedVar })`. The helper name varies between versions (`M_`, `c1`, etc.) but the pattern is the same. If constraint matching missed an identifier, the export map fills the gap. If both disagree, the constraint match wins and a conflict is logged.

### Layer 2: Legacy Matching (fallback for modules without constraint hits)

`tools-ts/src/renamer.ts` — `buildModuleRenames()`

- **Export map** extraction (same as Layer 1e but as primary)
- **Class method overlap** (same algorithm as 1c)
- **Function signature matching**: async/generator flags + param count + shared string literals

### Layer 3: Scope-Aware Application (TypeScript Language Service)

After discovery, renames are applied using the TS Language Service `findRenameLocations()` on a single assembled file. This ensures local parameters that happen to share a name with a global function are NOT renamed.

**How it works:**

1. Concatenate all deob files (stripping module-reconstruct imports/exports) into one ~12MB string
2. Track section byte offsets for mapping positions back to split files
3. Create a TS Language Service with one virtual file
4. For each discovered rename: find declaration position → `findRenameLocations()` → collect all binding references
5. Map assembled-file positions back to individual sections using the offset table
6. Apply edits to split files in reverse position order

**Why this matters:**
```javascript
var dH = function() { ... };           // global — RENAMED to isEnvTruthy
function foo(dH) { return dH + 1; }   // parameter — NOT renamed (different binding)
```

### Prettify (Step 2.7)

`tools-ts/src/prettify.ts`

After renaming, all files are formatted with prettier (`printWidth: 100`). This breaks long single-line functions into readable multi-line format, giving patches small, stable context windows.

Before prettier:
```javascript
function getLogoDisplayData() { let H = process.env.DEMO_VERSION ?? { VERSION: "2.1.89", ... }.VERSION, _ = getDirectConnectServerUrl(), $ = isClaudeAISubscriber() ? getSubscriptionName() : "API Usage Billing"; return { version: H, billingType: $ }; }
```

After prettier:
```javascript
function getLogoDisplayData() {
  let H = process.env.DEMO_VERSION ?? { VERSION: "2.1.89", ... }.VERSION,
    _ = getDirectConnectServerUrl(),
    $ = isClaudeAISubscriber() ? getSubscriptionName() : "API Usage Billing";
  return { version: H, billingType: $ };
}
```

A patch targeting `getSubscriptionName()` now only needs one context line — version strings and URLs are on separate lines and won't cause false mismatches across versions.

The git baseline is tagged AFTER prettify, so patches are always written against the formatted output.

## Testing on the Installed Version

```bash
cd patch-ref

# Full build (skips completed steps)
./entrypoint.sh build

# Check status
./entrypoint.sh status

# Validate output
./claude --version
grep "function getSessionId" deobfuscated/bootstrap/state.js
grep "class CharPool" deobfuscated/ink/screen.js

# Runtime test
CLAUDIVERSE_TOKEN="..." CLAUDIVERSE_DEBUG=1 ./claude "say hi"
```

## Testing on an Archived Version

Archived versions are pre-extracted JS files in `versionref/`. They can be used as `source.js` directly.

```bash
cd patch-ref

# Clean previous artifacts
./entrypoint.sh clean

# Use archived version as source
cp versionref/2.1.70-cli.js source.js

# Run steps manually (skip extract since we provided source.js)
bun run tools-ts/src/deob.ts source.js ../claude-code deobfuscated
bun run tools-ts/src/module-reconstruct.ts deobfuscated
bun run tools-ts/src/renamer.ts deobfuscated ../claude-code deobfuscated/_mapping.json
bun run tools-ts/src/prettify.ts deobfuscated

# Validate
grep -c "^function [a-z][a-zA-Z]*[A-Z]" deobfuscated/bootstrap/state.js
# Expected: 170+ (97%+ of functions named)

grep "class CharPool" deobfuscated/ink/screen.js
# Expected: class CharPool
```

Available archived versions: `2.1.70` through `2.1.87` in `versionref/`.

## Testing from a Binary

If you have a Claude binary (not the extracted JS), copy it to the versions directory:

```bash
# Copy binary
cp /path/to/claude-binary ~/.local/share/claude/versions/X.X.XX

# Extract JS from binary for versionref archive (optional)
# The entrypoint.sh extract step does this automatically

# Build
./entrypoint.sh clean
./entrypoint.sh build
```

Binaries from `~/.local/share/claude/versions/` are auto-detected by version number (latest wins).

**Supported binary formats:**
- v2.1.70+: esbuild bundle with hashbang (`#!/usr/bin/env node`) or IIFE wrapper
- v2.1.22-2.1.39: older `@bun @bytecode` format — not yet supported by the splitter

## Testing a New Binary Version

When a new Claude Code version is released:

```bash
# It auto-installs to ~/.local/share/claude/versions/X.X.XX
./entrypoint.sh clean
./entrypoint.sh build

# Check matching quality
./entrypoint.sh status
./entrypoint.sh refactors

# Verify key files
grep -c "^function [a-z]" deobfuscated/bootstrap/state.js
grep "class StructuredIO" deobfuscated/cli/structuredIO.js
```

If matching quality drops, the source reference may be stale. Update `../claude-code` to match the new version's API surface.

## Version-Specific Quirks

| Version | Bundle format | Wrapper functions | Notes |
|---------|--------------|-------------------|-------|
| 2.1.22-2.1.39 | `@bun @bytecode` double IIFE | N/A | Not yet supported — 64K bytecode preamble |
| 2.1.70 | Hashbang script (`#!/usr/bin/env node`) | `E()` (ESM), `S()` (CJS) | No IIFE wrapper |
| 2.1.77 | Hashbang script | `E()`, `S()` | Same as 2.1.70 |
| 2.1.80-2.1.87 | IIFE-wrapped | `R()` (ESM), `d()` (CJS) | Standard format |
| 2.1.89 | IIFE-wrapped | `R()` (ESM), `d()` (CJS) | Same as 2.1.80 |

The splitter auto-detects wrapper function names from the preamble. The renamer strips hashbangs from the assembled file to avoid TS parse errors.

## Tested Versions

| Version | Renames | Locations | state.js named | Runtime |
|---------|---------|-----------|---------------|---------|
| 2.1.70 | 3,750 | 21,544 | 97% | working |
| 2.1.87 | 4,992 | 25,493 | ~97% | working |
| 2.1.89 | 5,002 | 28,225 | 99% | working |

## Key Files

| File | Purpose |
|------|---------|
| `entrypoint.sh` | Unified CLI/TUI — run steps, track state, generate patches |
| `build.sh` | Legacy linear build script (runs all steps) |
| `tools-ts/src/deob.ts` | Orchestrates split → match → emit |
| `tools-ts/src/constraint-renamer.ts` | Inside-out structural pattern matching |
| `tools-ts/src/renamer.ts` | Rename discovery + TS LS scope-aware application |
| `tools-ts/src/module-reconstruct.ts` | Adds import/export for TS LS scope analysis |
| `tools-ts/src/prettify.ts` | Formats all files with prettier for patch stability |
| `tools-ts/src/reassembler.ts` | Strips module syntax, restores IIFE, concatenates |
| `tools-ts/rename-db.json` | Collision suppression database (version-specific) |
| `patches.d/*.patch` | Git patches applied after prettification |
| `patches.d/modules/*.js` | Custom modules injected into the bundle |
| `.build-state.json` | Step completion tracking (gitignored) |

## Artifacts (gitignored)

| Artifact | Size | Description |
|----------|------|-------------|
| `source.js` | ~12MB | Extracted JS bundle |
| `.deob_cache/` | ~20MB | Intermediate: split modules, signatures, matches |
| `deobfuscated/` | ~12MB | Split + renamed + patched module files |
| `cli-runnable.js` | ~14MB | Reassembled single JS file |
| `claude` | ~80MB | Compiled standalone binary |
