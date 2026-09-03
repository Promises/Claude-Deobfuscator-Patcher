/**
 * Module Reconstruction — Convert flat deobfuscated files into ES modules.
 *
 * The deobfuscated output is a set of flat JS files split from a single bundle.
 * All declarations live at global scope. To enable TypeScript's language service
 * for scope-aware renaming, we need each file to be a proper ES module with
 * import/export statements.
 *
 * Algorithm:
 *   1. Parse all files → extract top-level declarations + all identifier references
 *   2. Build global declaration map: name → file that declares it
 *   3. For each file: add `export { ... }` for its declarations,
 *      add `import { ... } from '...'` for external references
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";

interface Section {
  index: number;
  original_filename: string;
  output_path: string;
  type: "preamble" | "section" | "tail";
  module_name?: string;
  module_kind?: "R" | "d";
}

interface Mapping {
  version: string;
  section_count: number;
  matched_count: number;
  sections: Section[];
}

// JS/Node globals that should never be imported
const JS_GLOBALS = new Set([
  // Values
  "undefined", "NaN", "Infinity", "globalThis", "arguments",
  // Constructors / namespaces
  "Object", "Function", "Boolean", "Symbol", "Error",
  "AggregateError", "EvalError", "RangeError", "ReferenceError",
  "SyntaxError", "TypeError", "URIError",
  "Number", "BigInt", "Math", "Date", "String", "RegExp",
  "Array", "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics",
  "JSON", "Promise", "Proxy", "Reflect",
  "Intl", "WebAssembly", "Iterator", "AsyncIterator",
  "FinalizationRegistry", "SuppressedError",
  // Node globals
  "process", "console", "Buffer", "global",
  "setTimeout", "setInterval", "setImmediate",
  "clearTimeout", "clearInterval", "clearImmediate",
  "queueMicrotask", "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams",
  "AbortController", "AbortSignal", "Event", "EventTarget",
  "MessageChannel", "MessagePort", "Worker",
  "crypto", "performance", "structuredClone",
  "atob", "btoa", "fetch", "Headers", "Request", "Response",
  "FormData", "Blob", "File",
  "ReadableStream", "WritableStream", "TransformStream",
  "CompressionStream", "DecompressionStream",
  // CJS module vars (injected by IIFE wrapper)
  "require", "module", "exports", "__filename", "__dirname",
  // Global functions
  "eval", "isFinite", "isNaN", "parseFloat", "parseInt",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
  "escape", "unescape",
  // Common Node.js requires that appear as bare identifiers
  "Stream", "Readable", "Writable", "Transform", "Duplex",
]);

/**
 * Extract declared names from a binding pattern (handles destructuring).
 */
function getDeclaredNames(node: ts.BindingName): string[] {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isObjectBindingPattern(node)) {
    return node.elements.flatMap((e) => getDeclaredNames(e.name));
  }
  if (ts.isArrayBindingPattern(node)) {
    return node.elements
      .filter((e): e is ts.BindingElement => !ts.isOmittedExpression(e))
      .flatMap((e) => getDeclaredNames(e.name));
  }
  return [];
}

/**
 * Analyze a JS file: extract top-level declarations and all identifier references.
 */
function analyzeFile(code: string): {
  declarations: string[];
  identifiers: Set<string>;
} {
  const sf = ts.createSourceFile(
    "mod.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  // Collect top-level declarations
  const declarations: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      declarations.push(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      declarations.push(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        declarations.push(...getDeclaredNames(decl.name));
      }
    }
  }

  // Collect all identifier tokens (excluding property-access names, labels, etc.)
  const identifiers = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      // Skip property access: obj.prop
      if (
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node
      ) {
        return;
      }
      // Skip property names in object literals: { key: value }
      if (
        parent &&
        ts.isPropertyAssignment(parent) &&
        parent.name === node
      ) {
        return;
      }
      // Skip method/property/accessor names in class/object
      if (
        parent &&
        (ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
        parent.name === node
      ) {
        return;
      }
      // Skip label names
      if (
        parent &&
        (ts.isLabeledStatement(parent) ||
          ts.isBreakStatement(parent) ||
          ts.isContinueStatement(parent)) &&
        (parent as any).label === node
      ) {
        return;
      }
      // Skip computed property names in M_() export maps — these are string names
      // The arrow function bodies ARE references though: { name: () => varRef }

      identifiers.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return { declarations, identifiers };
}

/**
 * Compute relative import path between two files in the project.
 */
function computeRelativePath(fromFile: string, toFile: string): string {
  const fromDir = path.dirname(fromFile);
  let rel = path.relative(fromDir, toFile);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/**
 * Strip the IIFE wrapper from the preamble.
 * Input starts with: (function(exports, require, module, __filename, __dirname) {
 */
function stripPreambleWrapper(code: string): string {
  const idx = code.indexOf("{");
  if (idx === -1) return code;
  // Verify this is the IIFE opening
  const before = code.slice(0, idx);
  if (!before.includes("function")) return code;
  return code.slice(idx + 1).trimStart();
}

/**
 * Strip the IIFE closing from the tail.
 * Input ends with: })({}, require, module, __filename, __dirname)
 */
function stripTailWrapper(code: string): string {
  // Find the last })( pattern
  const closingPattern = /\}\)\s*\(\s*\{\s*\}\s*,\s*require\s*,\s*module\s*,\s*__filename\s*,\s*__dirname\s*\)\s*$/;
  return code.replace(closingPattern, "").trimEnd();
}

/**
 * A STATIC import from the bun single-file-executable VFS, e.g.
 * `import{qP as W}from"/$bunfs/root/chunk-05nkt76d.js"`.
 *
 * ⚠️ NOT anchored to line start. Raw chunks are minified onto ONE line, so
 * several imports share it: `import{Se}from"/$…";import"/$…";import{L}from"/$…"`.
 * An `^`-anchored pattern matches only the FIRST of those and silently leaves
 * the rest — measured, that retargeted 7,383 of 13,317 specifiers and left 730
 * files still pointing at paths that do not exist.
 *
 * Group 1 is everything up to the specifier (so the clause is preserved
 * verbatim, including a bare side-effect `import"/$…"` with no clause at all);
 * group 2 is the specifier. Dynamic `import(…)` and `import.meta.require(…)`
 * are deliberately NOT matched — see retargetChunkImports.
 */
const BUNFS_IMPORT_RE =
  /(\bimport\s*(?:\{[^}]*\}|[\w$]+|\*\s+as\s+[\w$]+)?\s*(?:from\s*)?)["'](\/\$bunfs\/[^"']+)["']/g;

/**
 * A DYNAMIC bunfs specifier: `import("/$bunfs/…")` or
 * `import.meta.require("/$bunfs/…")`.
 *
 * Kept separate from BUNFS_IMPORT_RE because that pattern must NOT match these:
 * its optional-clause form would match the bare `import` of `import(` and
 * rewrite the specifier while leaving the call parenthesis, and more
 * importantly the two resolve from different tables.
 *
 * Group 1 is the callee plus its opening paren (preserved verbatim, so
 * `import.meta.require(` stays what it was); group 2 is the specifier.
 */
const BUNFS_DYNAMIC_RE =
  /(\bimport(?:\.meta\.require)?\s*\(\s*)["'](\/\$bunfs\/[^"']+)["']/g;

/**
 * Marker prefix for a dynamic specifier that could NOT be resolved to a chunk.
 *
 * It is a made-up URL PROTOCOL, which is the point: bun does not try to resolve
 * an unknown protocol at build time, so one unresolvable lazy edge no longer
 * fails the whole bundle, but the import still throws `Cannot find module
 * 'claudiverse-unresolved-chunk:/$bunfs/…'` if that code path ever runs.
 *
 * MEASURED (2026-09-03), positive-controlled both ways on a two-branch probe:
 * compiled clean, printed nothing extra when the branch was not taken, and threw
 * naming the original specifier when it was.
 *
 * Keeping the original specifier in the string is deliberate — the failure names
 * the exact chunk that was never identified, so it is diagnosable from a crash
 * report alone.
 */
export const UNRESOLVED_CHUNK_PREFIX = "claudiverse-unresolved-chunk:";

/**
 * Does this tree already carry a real ESM import graph?
 *
 * Chunked builds (>=2.1.242) are ~1400-1700 ESM chunks that ALREADY import and
 * export; monolithic builds (<=2.1.241) are one CJS bundle with none, which is
 * the case reconstruction was written for. Measured from the tree rather than a
 * version number, because the studio calls this with no version context — the
 * same reason renamer.ts measures its scope model instead of being told.
 *
 * MEASURED on the 2.1.259 tree: 1528 of 1649 files contain a /$bunfs import.
 * On the 2.1.238 tree: zero. The 0.2 threshold sits far from both.
 */
function hasNativeImportGraph(
  projectDir: string,
  mapping: Mapping,
): boolean {
  let withImports = 0;
  let total = 0;
  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;
    total++;
    BUNFS_IMPORT_RE.lastIndex = 0;
    if (BUNFS_IMPORT_RE.test(fs.readFileSync(fullPath, "utf-8"))) withImports++;
  }
  if (total === 0) return false;
  return withImports / total > 0.2;
}

/**
 * Rewrite a chunked tree's own /$bunfs import specifiers to the emitted files.
 *
 * WHY THIS INSTEAD OF SYNTHESISING IMPORTS. A chunk already declares everything
 * it needs, either locally or via its own `import`. Prepending a second
 * `import { jt } from './errors.js'` for a name the chunk ALREADY imports as
 * `import { jt } from "/$bunfs/root/chunk-p3vjhzt0.js"` binds `jt` twice, which
 * is a hard ESM error: MEASURED, that took the 2.1.259 tree to 5/400 files
 * parsing, 372 of the 395 failures being "Identifier X has already been
 * declared" and the other 23 the matching duplicate `export {...}`.
 *
 * The bunfs paths cannot simply be LEFT alone either: /$bunfs/root/chunk-*.js
 * does not exist in the emitted tree (measured: 0 such files), so TS module
 * resolution finds nothing and renamer.ts's multi-file engine — which exists
 * precisely to follow the import graph across chunks — would silently stop
 * propagating renames into import specifiers. Both forked copies of the
 * import-stripper (reassembler.ts stripModuleSyntax, renamer.ts
 * stripImportExport) also match RELATIVE specifiers only, so a surviving bunfs
 * import would be carried into the reassembled bundle and fail at runtime.
 *
 * So the graph is retargeted, not rebuilt. `extract_chunks.py --manifest`
 * already resolved every edge by exported-symbol intersection (13,317/13,317,
 * 0 ambiguous, 0 unresolved) and records a chunk INDEX per import, which
 * `_mapping.json` maps to the emitted output_path.
 *
 * DYNAMIC specifiers are retargeted TOO, from a separate table.
 *
 * They were once left alone on the grounds that they create no binding and so
 * cannot cause the duplicate-declaration failure above — true, and it kept the
 * ESM parse gate green, which is exactly why the real problem stayed invisible.
 * MEASURED 2026-09-03: step 4 bundling the 2.1.259 tree fails with
 * `Could not resolve: "/$bunfs/root/chunk-d9r2qdh8.js"` on the entry module's
 * `let { main } = await import(...)`. The app reaches `main` ONLY through that
 * dynamic import, so an unretargeted dynamic specifier is not a cosmetic
 * leftover — it is the edge the whole program hangs from.
 *
 * The dynamic table is built by extract_chunks.py resolve_dynamic() and written
 * beside the manifest as <manifest>-dynamic.json. It is a SEPARATE table
 * because the two populations are disjoint: measured on 2.1.259, of 757 distinct
 * dynamic specifiers ZERO also appear as a static import, so the static table
 * contributes nothing to them and they carry their own coverage figure
 * (1,127/1,487 sites; 500/757 specifiers).
 *
 * A dynamic specifier that stays unresolved is left verbatim. That is the
 * correct failure: bun then reports it by name at bundle time, whereas
 * rewriting it to a guess would resolve to the WRONG module silently.
 */
function retargetChunkImports(
  projectDir: string,
  mapping: Mapping,
  graphPath: string,
): void {
  const graph: Array<{
    index: number;
    imports: Array<{ path: string; clause: string; target: number | null }>;
  }> = JSON.parse(fs.readFileSync(graphPath, "utf-8"));

  // chunk index -> emitted output_path. The manifest's index IS the section
  // index: extract_chunks.py emits sections in chunk order (emit_splitter_compat).
  const indexToOutput = new Map<number, string>();
  for (const section of mapping.sections) {
    indexToOutput.set(section.index, section.output_path);
  }

  // The DYNAMIC specifier table, written beside the manifest by
  // extract_chunks.py. Absent for a graph produced before dynamic resolution
  // existed: that is not fatal here (static retargeting is unaffected), but it
  // IS reported, because a chunked build whose dynamic edges are all unresolved
  // cannot reach `main` and would fail at step 4 with a resolve error whose
  // cause is this missing file rather than the tree.
  const dynamicPath = graphPath.endsWith(".json")
    ? graphPath.slice(0, -5) + "-dynamic.json"
    : graphPath + ".dynamic";
  const dynamicSpecs: Record<string, number> = fs.existsSync(dynamicPath)
    ? JSON.parse(fs.readFileSync(dynamicPath, "utf-8"))
    : {};
  if (!fs.existsSync(dynamicPath)) {
    console.log(
      `  ⚠️  no dynamic specifier table at ${dynamicPath} — dynamic imports ` +
        `will NOT be retargeted (re-run extract_chunks.py --manifest)`,
    );
  }

  // ONE GLOBAL specifier -> chunk index table, not a per-chunk one.
  //
  // WHY GLOBAL. A bunfs specifier is a CONTENT-HASHED FILENAME, so it names the
  // same chunk everywhere it appears in the bundle — the mapping is a property of
  // the bundle, not of the importing chunk. Symbol intersection resolves it only
  // where a clause names symbols, but once ANY clause import in ANY chunk has
  // pinned `chunk-8nmvz1t1.js` to index N, that binding holds for every other
  // site quoting the same specifier, including bare side-effect ones that name no
  // symbols at all.
  //
  // MEASURED on 2.1.259 (the check that makes this safe rather than plausible):
  // 876 distinct specifiers are clause-resolved and ZERO of them resolve to two
  // different chunk indices anywhere in the bundle. So collapsing the per-chunk
  // tables into one loses no information and introduces no ambiguity — if a
  // specifier ever DID disagree between chunks, `conflicts` below would be
  // non-zero and this would be reported rather than silently picking a winner.
  //
  // This is what lifts side-effect coverage from 0: of 86,438 side-effect SITES,
  // 85,563 (98.99%) quote a specifier some clause import already pinned. The
  // remaining 875 sites are 5 specifiers naming chunks that export NOTHING, so no
  // clause import can ever name a symbol from them — those stay unresolved and
  // are reported, not guessed.
  const specToOutput = new Map<string, string>();
  const specToIndex = new Map<string, number>();
  let conflicts = 0;
  for (const chunk of graph) {
    for (const imp of chunk.imports) {
      if (imp.target === null) continue;
      const prev = specToIndex.get(imp.path);
      if (prev !== undefined && prev !== imp.target) {
        conflicts++;
        continue;
      }
      specToIndex.set(imp.path, imp.target);
      const out = indexToOutput.get(imp.target);
      if (out) specToOutput.set(imp.path, out);
    }
  }
  if (conflicts > 0) {
    // A specifier resolving to two chunks would mean the content hash is not a
    // stable identity, which would invalidate the global table entirely. Never
    // observed; loud if it ever happens rather than resolved by last-write-wins.
    throw new Error(
      `${conflicts} /$bunfs specifiers resolve to more than one chunk index. ` +
        `The global specifier table assumes a specifier names one chunk bundle-wide.`,
    );
  }

  let filesRewritten = 0;
  let specifiersRewritten = 0;
  let unresolved = 0;
  const unresolvedSpecs = new Set<string>();
  let dynRewritten = 0;
  let dynUnresolved = 0;
  const dynUnresolvedSpecs = new Set<string>();

  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;
    const code = fs.readFileSync(fullPath, "utf-8");

    let touched = false;
    let rewritten = code.replace(
      BUNFS_IMPORT_RE,
      (whole, head: string, spec: string) => {
        const out = specToOutput.get(spec);
        if (!out) {
          unresolved++;
          unresolvedSpecs.add(spec);
          // Same neutralisation as the dynamic pass below, for the same reason:
          // a /$bunfs path must resolve at BUILD time, so leaving it verbatim
          // fails the bundle. MEASURED on 2.1.259 these are 5 specifiers over
          // 875 sites, all BARE SIDE-EFFECT imports of chunks that export
          // nothing — no clause, dynamic or import.meta.require site names a
          // symbol from them anywhere, so symbol intersection cannot reach them.
          //
          // ⚠️ These are STATIC side-effect imports, so unlike a lazy edge they
          // run at module load, and neutralising one means its side effect
          // NEVER happens rather than happening late. That is a real behaviour
          // change and is why they stay listed by name above.
          //
          // ⚠️ AND IT IS NOT KNOWN TO BE HARMLESS. The tempting reading — that
          // an unresolved side-effect import must be an empty module, so
          // dropping it is a no-op — does NOT hold: 2.1.259 has 5 such
          // specifiers and only 4 empty-bodied chunks in the whole bundle, so
          // at least one of them names a chunk with a real body. They cannot be
          // told apart, because the reason they are unresolved is precisely
          // that nothing names a symbol from them.
          //
          // They are neutralised because the alternative is no chunked build at
          // all, not because they were shown to be inert. If a chunked binary
          // ever misbehaves in a way that smells like missing module-load
          // initialisation, these 5 are the first suspects.
          //
          // 🔴 DROPPED, NOT SENTINELLED — and the difference is the whole build.
          // The UNRESOLVED_CHUNK_PREFIX sentinel is correct for a DYNAMIC edge:
          // an unknown protocol survives bundling and throws only if that code
          // path runs. A STATIC bare import is hoisted and evaluated at load, so
          // the same sentinel throws IMMEDIATELY. MEASURED 2026-09-03: a build
          // that sentinelled these died on `--version` with
          //   Cannot find module 'claudiverse-unresolved-chunk:/$bunfs/root/chunk-ck0tqv1m.js'
          // That one specifier alone appears in 555 of 1649 files, so the
          // "fails only if its code path runs" reasoning does not transfer from
          // the dynamic case — there is no path that avoids it.
          //
          // Emitting nothing keeps the module-load side effect missing (the
          // hazard documented above, unchanged) but lets the binary start, which
          // is the only way to find out whether that side effect mattered.
          return "";
        }
        touched = true;
        specifiersRewritten++;
        return `${head}'${computeRelativePath(section.output_path, out)}'`;
      },
    );

    // Dynamic sites, from the separate table. Run AFTER the static pass; the two
    // patterns are disjoint (the static one does not match `import(` or
    // `import.meta.require(`, verified), so neither can rewrite the other's
    // sites or double-rewrite an already-relative specifier.
    rewritten = rewritten.replace(
      BUNFS_DYNAMIC_RE,
      (whole, head: string, spec: string) => {
        const idx = dynamicSpecs[spec];
        const out = idx === undefined ? undefined : indexToOutput.get(idx);
        if (!out) {
          dynUnresolved++;
          dynUnresolvedSpecs.add(spec);
          // An unresolved specifier CANNOT be left verbatim: /$bunfs/root/... is
          // a path the bundler must resolve at BUILD time even though the import
          // itself is deferred to runtime, so one unresolvable specifier fails
          // the whole bundle. MEASURED on 2.1.259: exactly one such specifier —
          // chunk-vy55rnd7.js, quoted once, in a bare `Promise.all([import(…)])`
          // preload that destructures nothing and so names no symbol anywhere —
          // was the single remaining bundle error.
          //
          // So the SPECIFIER is replaced by a module path that does not exist,
          // built from a name the bundler treats as external rather than
          // resolving. The call shape is left exactly as it was — only the
          // string inside the parentheses changes — because this regex does not
          // consume the closing paren and rewriting the callee would leave it
          // dangling (verified: doing so produced `Promise.reject(...)),`).
          //
          // That converts a build-time hard stop into a runtime failure on the
          // one code path that actually needs the module, which is the honest
          // shape of what is known: the edge is unresolved, not absent.
          // Silently dropping it would let a real dependency vanish with no
          // trace; this way the original specifier is still in the binary, in
          // the error the failing path throws.
          return `${head}'${UNRESOLVED_CHUNK_PREFIX}${spec}'`;
        }
        touched = true;
        dynRewritten++;
        return `${head}'${computeRelativePath(section.output_path, out)}'`;
      },
    );
    // The neutralisation above rewrites text, so the file must be written even
    // if no specifier was successfully retargeted in it.
    if (rewritten !== code) touched = true;

    if (touched) {
      fs.writeFileSync(fullPath, rewritten);
      filesRewritten++;
    }
  }

  console.log(
    `  Retargeted ${specifiersRewritten} static + ${dynRewritten} dynamic ` +
      `/$bunfs specifiers in ${filesRewritten} files`,
  );
  // Loud, because a surviving bunfs specifier resolves to nothing: renames stop
  // propagating through it and the reassembled bundle carries a dead import.
  // The distinct SPECIFIERS are listed, not just the site count — 875 sites
  // reads like 875 problems when it is 5 chunks quoted many times, and the
  // remedy (identify those chunks) is per-specifier.
  if (unresolved > 0) {
    console.log(
      `  🔴 ${unresolved} static /$bunfs sites could NOT be retargeted ` +
        `(${unresolvedSpecs.size} distinct specifiers)`,
    );
    for (const s of [...unresolvedSpecs].sort()) console.log(`       ${s}`);
  }
  // Dynamic residue is counted but NOT listed by name: it is a few hundred
  // specifiers, not a handful, and printing them all would bury the static list
  // above, which is the actionable one. An unresolved dynamic edge only breaks
  // the code path that takes it, and bun names it at bundle time if it is on
  // the reachable graph.
  if (dynUnresolved > 0) {
    console.log(
      `  ⚠️  ${dynUnresolved} dynamic /$bunfs sites could NOT be retargeted ` +
        `(${dynUnresolvedSpecs.size} distinct specifiers) — these stay lazy and ` +
        `fail only if their code path runs`,
    );
  }
}

/**
 * A RESOLVED-RELATIVE `import.meta.require('./x.js')` site.
 *
 * Group 1 is the specifier. Only relative specifiers match: a
 * `claudiverse-unresolved-chunk:` sentinel must NOT be touched here (see
 * bindStaticRequires for why).
 */
const RELATIVE_META_REQUIRE_RE =
  /import\.meta\.require\(\s*['"](\.[^'"]*)['"]\s*\)/g;

/**
 * A load of a file EMBEDDED IN THE ORIGINAL BINARY, e.g.
 * `ve('/$bunfs/root/loopAutonomousPreamble-07qcyhv4.md')`.
 *
 * These are bun standalone-executable assets — bundled skills, prompt
 * templates, `.node` addons — that live in the source binary's virtual
 * filesystem. The chunk tree records the PATH but never the CONTENT, so nothing
 * in the rebuilt tree can satisfy one.
 *
 * Matches any callee, not just the `ve` alias: `ve` is a minified re-export of
 * `import.meta.require` (`_unmatched/0006_G.js`: `ve = import.meta.require`)
 * and the alias is free to change between builds, whereas the `/$bunfs/root/`
 * specifier with a non-.js extension is the stable signal.
 */
const EMBEDDED_ASSET_RE =
  /['"]\/\$bunfs\/root\/[^'"]+\.(?:md|txt|node|mjs|html|json|wasm|zst)['"]/;

/** Global form, to visit EVERY asset reference in a module. */
const EMBEDDED_ASSET_RE_ALL = new RegExp(EMBEDDED_ASSET_RE.source, "g");

/**
 * Does this module reference an embedded asset in a position that runs when the
 * module is EVALUATED (as opposed to when some function is later called)?
 *
 * Only one lazy shape is recognised, deliberately: the CJS wrapper
 * `<name>.exports = ve('/$bunfs/root/…')`, whose enclosing `w(...)` returns a
 * thunk and therefore cannot fire at import time. Everything else -- including
 * anything this function cannot classify -- counts as import-time, so the
 * conservative answer remains the default and an unfamiliar shape keeps its
 * site as a runtime call rather than being silently hoisted.
 */
function importTimeAssetRef(text: string): boolean {
  EMBEDDED_ASSET_RE_ALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBEDDED_ASSET_RE_ALL.exec(text)) !== null) {
    // ⚠️ LOOK BACK A FIXED WINDOW, NOT TO THE START OF THE LINE. This runs at
    // step 2.5, BEFORE prettify (2.7), so the input is still minified and a
    // whole module can be one line -- a line-based rule saw the entire file as
    // "context" and classified everything as import-time, which is why the
    // narrowing silently had no effect the first time.
    const before = text.slice(Math.max(0, m.index - 80), m.index).trimEnd();
    // ⛔ NO EXEMPTION FOR THE CJS `exports = ve(…)` WRAPPER. It looks lazy --
    // `w(...)` does return a thunk -- but laziness of the WRAPPER says nothing
    // about whether anything CALLS it during module evaluation, and in this
    // bundle something does: services/compact/precomputedCompact.js builds
    //   dir = { simple_plan: iir(), visual_plan: air(), … }
    // at top level, invoking all three thunks on import. Exempting the shape
    // let that module be hoisted and moved the failure from a resolvable
    // "Cannot find module '../..'" to
    //   Cannot find module '/$bunfs/root/simple_plan-c1nffcyk.txt'
    // i.e. it made things worse, not better. Deciding this properly needs
    // call-graph reachability, not a syntactic look-back, so the conservative
    // answer stands.
    //
    // (b) A bare path CONSTANT. The hazard is the CALL, not the string: the
    //     module that named the very first missing asset holds
    //       var i = '/$bunfs/root/plugin-eval-quickref-…md.zst';
    //       var JSt = et(i, import.meta.dirname);
    //     where `et` is a real `fs.readFileSync` + zstd decode (see
    //     `_unmatched/0207_h4t.js`), NOT `import.meta.require`. That form works
    //     once the asset is embedded -- it is the whole point of the asset
    //     pass -- so treating the string literal as a hazard would keep a
    //     module unhoistable for a load that now succeeds.
    if (/(?:^|[;{}\s])(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=$/.test(before))
      continue;
    return true;
  }
  return false;
}

/**
 * Convert resolved-relative `import.meta.require(spec)` into a hoisted
 * `import * as NS from spec` plus a reference to NS at the call site.
 *
 * WHY THIS IS NEEDED AT ALL. `import.meta.require` resolves at RUNTIME against
 * the real filesystem. bun therefore never adds the target to the bundle, and a
 * single-file executable has no filesystem to resolve against — so the call
 * throws at the moment it runs. MEASURED on 2.1.259: the binary builds, reports
 * the right `--version`, and dies on the first real turn with
 *   Cannot find module '../_unmatched/0569_udsInboxShape.js' from '/$bunfs/root/…'
 * The path is CORRECT and the file EXISTS in the tree — retargeting already did
 * its job. It is the CALL FORM that cannot survive compilation.
 *
 * WHY A NAMESPACE IMPORT IS THE RIGHT TARGET FORM. Every site was inventoried
 * rather than assumed. On 2.1.259 there are 132 relative sites over 102 distinct
 * specifiers (87 distinct files), in exactly three shapes:
 *   - 81 bare namespace bindings — `var r_ = import.meta.require('…')`, whose
 *     members are read later (`r_.createCronScheduler`, verified present as a
 *     named export of the target);
 *   - 51 single-member reads — `… = import.meta.require('…').udsInboxShape`;
 *   - 35 destructures — `let { setOnEnqueue: p } = import.meta.require('…')`
 *     (a subset of the bare form: nothing follows the closing paren).
 * All three consume the result as a MODULE NAMESPACE OBJECT, and every target is
 * real ESM with a matching `export { … }`. So substituting the namespace binding
 * for the call preserves the semantics of all 132 without touching the
 * surrounding syntax — the member access, the destructuring pattern and the
 * comma-separated `var` list are all left byte-for-byte alone, which is why this
 * does not need to understand any of them.
 *
 * 🔴 THE COST, MEASURED AND ACCEPTED: THIS MAKES THE EDGE EAGER.
 * A static import is hoisted and its module evaluates at load, whereas
 * `import.meta.require` evaluated only when the line ran. Probed directly with
 * `bun build --compile` and positive-controlled both ways: a module whose top
 * level prints a side effect prints it BEFORE the entry's first line under
 * `import * as ns`, and NOT AT ALL under `await import()` when the branch is not
 * taken. So the timing change is real and is not hypothetical.
 *
 * That matters because bundler.ts documents a probe build that crashed by
 * eagerly invoking a native image-processor `.node` load. So the 87 target files
 * were checked for that specific hazard instead of being assumed benign: exactly
 * ONE (`_tentative/1260_modifiers.js`) mentions a `.node` at all, and its load
 * sits inside a lazily-called function that is wrapped in `try { … } catch {
 * return null }` — it does not run on import, and it cannot throw if it did.
 *
 * The alternative — rewriting to `await import()` to keep it lazy — is NOT
 * available: 132 of these sites are synchronous expressions in `var`
 * initialisers and destructuring patterns, and making them async would require
 * making every enclosing function async and every caller await it, which changes
 * far more behaviour than eager evaluation does.
 *
 * ⚠️ BOUND: this establishes that no target performs a native load ON IMPORT. It
 * does NOT establish that every target's top level is side-effect-free in
 * general. If a chunked binary ever misbehaves in a way that smells like
 * too-early initialisation, this eager-ing is the first suspect.
 *
 * SENTINEL SITES ARE DELIBERATELY LEFT ALONE. The 135 sites quoting
 * `claudiverse-unresolved-chunk:` name chunks that were never identified, so
 * there is nothing to import them FROM. They keep the call form on purpose: a
 * call runs only if its line runs, so they throw a named error on the one path
 * that needs them instead of at load. That reasoning was CHECKED here rather
 * than carried over — the same sentinel on a STATIC import killed `--version`
 * outright, because a hoisted import always evaluates. It is safe here for the
 * opposite reason it was fatal there: this population stays a call.
 */
function bindStaticRequires(projectDir: string, mapping: Mapping): void {
  let sitesRewritten = 0;
  let filesRewritten = 0;
  let missingTargets = 0;
  const missingSpecs = new Set<string>();
  let assetGuarded = 0;
  const assetGuardedSpecs = new Set<string>();
  let cycleGuarded = 0;
  const cycleGuardedSpecs = new Set<string>();

  /**
   * Is the site at `offset` inside a function/block body rather than at module
   * scope? Answered by brace depth, which is what decides whether keeping the
   * call form actually defers anything.
   *
   * Strings, template literals, comments and REGEX LITERALS are all skipped,
   * because a brace inside any of them is not a block. That matters here: the
   * tree is prettified but still full of minified data, and one unbalanced `{`
   * in a literal shifts the depth for the whole rest of the file and flips every
   * later decision — the guard would then either fire on module scope (the
   * failure this test exists to prevent) or stop firing on nested sites.
   *
   * 🔴 THE REGEX CASE IS NOT THEORETICAL — it was the bug. Without it, the `/*`
   * inside `n.replace(/\/*$/, '')` in entrypoints/sdk/coreSchemas.js reads as a
   * BLOCK-COMMENT OPEN, swallowing ~780 KB up to the next `*​/` and leaving the
   * depth permanently wrong. MEASURED: the module-scope site at offset 1,040,481
   * in that file scored depth 2 instead of 0, so it was treated as nested,
   * stayed a call, and the binary died with `Cannot find module
   * '../../_unmatched/0557_AGENT_VIEW_RELAUNCH_ENV_KEY.js'`.
   *
   * A `/` is a regex only where a value cannot precede it; that is decided by
   * the last significant character, which is the standard disambiguation and is
   * exercised by the division cases in the unit test.
   */
  function isNestedSite(code: string, offset: number): boolean {
    let depth = 0;
    let i = 0;
    let prev = "";
    while (i < offset) {
      const ch = code[i];
      if (ch === "/" && code[i + 1] === "/") {
        const nl = code.indexOf("\n", i);
        i = nl === -1 ? offset : nl + 1;
        continue;
      }
      if (ch === "/" && code[i + 1] === "*") {
        const end = code.indexOf("*/", i + 2);
        i = end === -1 ? offset : end + 2;
        continue;
      }
      if (ch === "/" && regexAllowedAfter(prev)) {
        // Regex literal: scan to the unescaped closing slash, honouring
        // character classes (a `/` inside `[...]` does not end the literal).
        i++;
        let inClass = false;
        while (i < offset) {
          const c = code[i];
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          else if (c === "\n") break; // unterminated — not a regex after all
          i++;
        }
        i++;
        prev = "/";
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < offset && code[i] !== quote) {
          if (code[i] === "\\") i++;
          i++;
        }
        i++;
        prev = quote;
        continue;
      }
      if (ch === "`") {
        // 🔴 A TEMPLATE LITERAL IS NOT AN OPAQUE STRING — it nests code.
        // Skipping to the next backtick treats the `}` of every `${…}` as a
        // block close, which drives the depth NEGATIVE and silently disables the
        // `depth > 0` test for the rest of the file. MEASURED on 2.1.259: in
        // services/compact/precomputedCompact.js the first `` `<${j}>` `` at
        // offset 2,237,206 takes depth below zero, and all three
        // pathValidation sites then score -9/-14/-15 instead of a positive
        // depth — so the cycle guard did not fire, the edge was hoisted, and the
        // binary died again on the SAME `Object.entries(a3)` TDZ read.
        //
        // Interpolations are therefore SKIPPED as balanced regions, so braces
        // inside them cancel out and the outer depth is untouched.
        i++;
        while (i < offset && code[i] !== "`") {
          if (code[i] === "\\") {
            i += 2;
            continue;
          }
          if (code[i] === "$" && code[i + 1] === "{") {
            let nest = 1;
            i += 2;
            while (i < offset && nest > 0) {
              if (code[i] === "\\") {
                i += 2;
                continue;
              }
              if (code[i] === "{") nest++;
              else if (code[i] === "}") nest--;
              i++;
            }
            continue;
          }
          i++;
        }
        i++;
        prev = "`";
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
    return depth > 0;
  }

  /**
   * Can a regex literal start after this significant character?
   *
   * `/` is division after a value (identifier, literal, `)`, `]`) and a regex
   * after an operator, `(`, `,`, `{`, `}`, `;`, `:` or `=`. Closers are the
   * discriminating cases: `a / b` must NOT be read as a regex, or the scan
   * swallows real code.
   */
  function regexAllowedAfter(prev: string): boolean {
    if (prev === "") return true;
    if (/[)\]}]/.test(prev)) return false;
    return !/[A-Za-z0-9_$"'`]/.test(prev);
  }

  /**
   * Static-import adjacency over the emitted tree, for the cycle guard below.
   *
   * Only STATIC relative imports are edges. An `import.meta.require` call is
   * deliberately excluded: it is precisely the lazy edge this pass is deciding
   * whether to make eager, so counting it would make every candidate look like
   * it already closed the loop and the guard would refuse everything.
   */
  const staticDeps = new Map<string, Set<string>>();
  function staticImportsOf(absPath: string): Set<string> {
    let deps = staticDeps.get(absPath);
    if (deps) return deps;
    deps = new Set<string>();
    staticDeps.set(absPath, deps);
    let text: string;
    try {
      text = fs.readFileSync(absPath, "utf-8");
    } catch {
      return deps;
    }
    const dir = path.dirname(absPath);
    const re = /\bfrom\s*['"](\.[^'"]*)['"]|\bimport\s*['"](\.[^'"]*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1] ?? m[2];
      if (spec) deps.add(path.resolve(dir, spec));
    }
    return deps;
  }

  /**
   * Would making `from -> to` a static import create an import CYCLE?
   *
   * 🔴 THIS GUARD EXISTS BECAUSE ITS ABSENCE WAS MEASURED, exactly as the
   * eager-ing hazard in this function's docstring predicted it would be.
   * Hoisting `import.meta.require('../../tools/PowerShellTool/pathValidation.js')`
   * inside `services/compact/precomputedCompact.js` created the cycle
   *   precomputedCompact -> pathValidation -> readOnlyValidation -> precomputedCompact
   * and `readOnlyValidation.js` evaluates a MODULE-SCOPE IIFE that calls
   * `De(e)`, which reads `a3` — a binding owned by precomputedCompact that is
   * still in its temporal dead zone when the cycle is entered. The rebuilt
   * binary died on the first real turn with
   *   TypeError: Object.entries requires that input parameter not be null or undefined
   * That IIFE is faithful to upstream (verified in the raw chunk); upstream
   * simply never has the cycle, because the edge stays LAZY there.
   *
   * Leaving the site as a call is the STATUS QUO for it, not a regression — the
   * same reasoning the embedded-asset guard above uses.
   *
   * A path that cannot be read contributes no edges, so an unreadable module
   * cannot hide a cycle behind itself; that errs toward hoisting, which is why
   * this guard is a complement to the asset guard rather than a replacement.
   */
  function wouldCycle(fromAbs: string, toAbs: string): boolean {
    if (fromAbs === toAbs) return true;
    const seen = new Set<string>([toAbs]);
    const stack = [toAbs];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const dep of staticImportsOf(cur)) {
        if (dep === fromAbs) return true;
        if (!seen.has(dep)) {
          seen.add(dep);
          stack.push(dep);
        }
      }
    }
    return false;
  }

  // Memo for loadsEmbeddedAsset, keyed by absolute path. The walk below is
  // transitive and the graph has ~1650 nodes with heavy sharing, so without
  // this the check is quadratic.
  const assetMemo = new Map<string, boolean>();

  /**
   * Does this module, or anything it STATICALLY imports, load an embedded
   * binary asset?
   *
   * 🔴 THIS GUARD EXISTS BECAUSE ITS ABSENCE WAS MEASURED, NOT PREDICTED.
   * Binding every relative `import.meta.require` made
   * `_unmatched/0965_AUTONOMOUS_LOOP_PREAMBLE.js` a static import in 5 files —
   * it had ZERO static importers before — and that module does
   * `var g = ve('/$bunfs/root/loopAutonomousPreamble-07qcyhv4.md')` at TOP
   * LEVEL. Eager evaluation therefore ran a load that upstream only ever ran
   * lazily, and the binary died on the first turn with
   *   Cannot find module '/$bunfs/root/loopAutonomousPreamble-07qcyhv4.md'
   * This is exactly the eager-evaluation hazard bindStaticRequires documents as
   * accepted-but-unproven; it turned out to be real, so it is now bounded here
   * rather than left as a caveat.
   *
   * TRANSITIVE, not direct: the importing module need not touch an asset itself
   * for eager evaluation to reach one through its own static imports.
   *
   * A module that cannot be read, or an import that cannot be resolved, counts
   * as UNSAFE. The failure mode of a false "safe" is a binary that dies at
   * startup; the failure mode of a false "unsafe" is one call site left as a
   * runtime `import.meta.require`, which is where it started.
   */
  function loadsEmbeddedAsset(absPath: string, seen = new Set<string>()): boolean {
    const memo = assetMemo.get(absPath);
    if (memo !== undefined) return memo;
    // A cycle is not evidence of an asset. Return false WITHOUT memoising: this
    // answer is only valid for the branch that is mid-walk, and caching it
    // would leak that assumption to unrelated callers.
    if (seen.has(absPath)) return false;
    seen.add(absPath);

    let text: string;
    try {
      text = fs.readFileSync(absPath, "utf-8");
    } catch {
      assetMemo.set(absPath, true);
      return true;
    }
    // 🔴 RECOVERING THE ASSET DOES NOT MAKE THE LOAD SAFE TO HOIST, and this is
    // the second time that assumption has been tested here. The load form is
    // `ve(path)` where `ve = import.meta.require`, and MEASURED with a
    // two-file probe: `import.meta.require` on an embedded `.md` does not
    // return its text, it PARSES IT AS JAVASCRIPT --
    //   SyntaxError: Invalid character: '#'  at <parse> (/$bunfs/root/doc.md:1:1)
    // -- and on a `.txt`, "Unexpected identifier". Embedding the bytes under
    // the right name (which tools/extract_assets.py now does) changes the error
    // from "Cannot find module" to a parse error; it does not make the call
    // work. Making these edges eager was tried and produced exactly that.
    //
    // Upstream never hits it because the sites stay LAZY: the real 2.1.259
    // binary completes a turn with these modules unevaluated. So the guard is
    // unconditional on purpose, and `recoveredAssets` is deliberately NOT
    // consulted here.
    // An asset load only matters if it runs AT IMPORT TIME. A reference inside
    // a CJS lazy wrapper does not: `w = (a,b) => () => (b || a(...), b.exports)`
    // returns a THUNK, so `w(function(_,m){ m.exports = ve('…') })` runs its
    // body on first require, never on module evaluation. Treating those as
    // hazards left whole modules unhoistable for a load that cannot fire --
    // and that is what kept `_unmatched/0899_MonitorTool.js` unresolvable, via
    // a transitive edge to three such wrappers in
    // services/compact/precomputedCompact.js.
    //
    // MEASURED before narrowing: of 175 asset references in the 2.1.259 tree,
    // 12 are this `exports =` form and 163 are not, so this exempts a small,
    // specific population rather than gutting the guard.
    if (importTimeAssetRef(text)) {
      assetMemo.set(absPath, true);
      return true;
    }

    const dir = path.dirname(absPath);
    const importRe = /\bfrom\s*['"](\.[^'"]*)['"]|\bimport\s*['"](\.[^'"]*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const child = path.resolve(dir, spec);
      if (loadsEmbeddedAsset(child, seen)) {
        assetMemo.set(absPath, true);
        return true;
      }
    }
    assetMemo.set(absPath, false);
    return false;
  }

  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;
    const code = fs.readFileSync(fullPath, "utf-8");
    RELATIVE_META_REQUIRE_RE.lastIndex = 0;
    if (!RELATIVE_META_REQUIRE_RE.test(code)) continue;

    // One namespace binding per DISTINCT specifier in this file. A specifier
    // quoted at several sites (measured: up to 5 in one file) must not produce
    // several `import * as` of the same module under different names — legal,
    // but it bloats the file and obscures the diff.
    const specToNs = new Map<string, string>();
    const fileDir = path.dirname(path.join(projectDir, section.output_path));

    RELATIVE_META_REQUIRE_RE.lastIndex = 0;
    const rewritten = code.replace(
      RELATIVE_META_REQUIRE_RE,
      (whole, spec: string, offset: number) => {
        // The specifier must name a file that actually exists, resolved the
        // same way the runtime would have. If it does not, converting the call
        // into a static import turns a runtime failure on one path into a
        // BUILD failure for the whole binary — strictly worse. Leave it as a
        // call and report it.
        const targetAbs = path.resolve(fileDir, spec);
        if (!fs.existsSync(targetAbs)) {
          missingTargets++;
          missingSpecs.add(spec);
          return whole;
        }
        // Leave the call alone when hoisting it would drag an embedded-asset
        // load into module-load time. Staying a call is the STATUS QUO for
        // this site, not a regression: it fails only if its own path runs,
        // which is what it did before this pass existed.
        if (loadsEmbeddedAsset(targetAbs)) {
          assetGuarded++;
          assetGuardedSpecs.add(spec);
          return whole;
        }
        // Hoisting this edge would close an import cycle and expose a
        // temporal-dead-zone read at module-evaluation time. See wouldCycle().
        //
        // ⚠️ ONLY WORTH GUARDING WHEN THE SITE IS ACTUALLY LAZY. The guard's
        // whole value is that keeping the call form defers evaluation — which
        // is true for a call inside a function, and FALSE for one in a
        // module-scope `var` initialiser, since that runs at load either way.
        // Worse than useless there: `import.meta.require` with a RELATIVE
        // specifier does not resolve inside a compiled single-file binary, so
        // the guarded site fails harder than the hoisted one would.
        // MEASURED on 2.1.259 — guarding without this depth test left
        //   var Mue = import.meta.require('../../_unmatched/0557_AGENT_VIEW_…')
        // a call in entrypoints/sdk/coreSchemas.js and the binary died at
        // startup with `Cannot find module '../../_unmatched/0557_…'`.
        // That site is safe to hoist despite its cycle: `Mue` is read only
        // inside a function body, and through `?.`, so the cycle-time value
        // being undefined cannot throw.
        // Measured split of the 31 candidate sites: 30 nested, 1 module-scope.
        if (
          isNestedSite(code, offset) &&
          wouldCycle(path.join(projectDir, section.output_path), targetAbs)
        ) {
          cycleGuarded++;
          cycleGuardedSpecs.add(spec);
          return whole;
        }
        let ns = specToNs.get(spec);
        if (!ns) {
          // Name derived from the specifier, so two different specifiers in one
          // file cannot collide. The `__cvReq` prefix is not a name the
          // minified upstream code can produce, so it cannot shadow a real
          // binding.
          ns = "__cvReq" + spec.replace(/[^A-Za-z0-9_$]/g, "_");
          specToNs.set(spec, ns);
        }
        sitesRewritten++;
        return ns;
      },
    );

    if (specToNs.size === 0) {
      if (rewritten !== code) fs.writeFileSync(fullPath, rewritten);
      continue;
    }

    // Imports are PREPENDED. ESM hoists declarations regardless of position, so
    // placement is not a correctness question, but putting them at the top
    // keeps the emitted file readable and matches what the rest of the tree
    // looks like.
    const header =
      [...specToNs].map(([spec, ns]) => `import * as ${ns} from '${spec}';`)
        .join("\n") + "\n";
    fs.writeFileSync(fullPath, header + rewritten);
    filesRewritten++;
    // The edges just added are real static imports now, so a LATER file's cycle
    // check must see them. Without this the guard would be evaluated against a
    // stale graph and could hoist an edge that closes a loop through one of
    // these — the cache is an optimisation, not a snapshot of the input tree.
    const selfAbs = path.join(projectDir, section.output_path);
    const deps = staticImportsOf(selfAbs);
    for (const spec of specToNs.keys()) deps.add(path.resolve(fileDir, spec));
  }

  console.log(
    `  Bound ${sitesRewritten} relative import.meta.require sites to static ` +
      `namespace imports in ${filesRewritten} files`,
  );
  if (assetGuarded > 0) {
    // Reported, because these are the sites that will still throw at runtime if
    // their path runs — and because a sudden change in this count between
    // versions means the embedded-asset surface moved.
    console.log(
      `  ⚠️  ${assetGuarded} sites left as calls (${assetGuardedSpecs.size} distinct ` +
        `specifiers) — hoisting them would eagerly load an embedded /$bunfs asset`,
    );
  }
  if (cycleGuarded > 0) {
    // Reported for the same reason as the asset guard: these sites still throw
    // if their path runs, and a jump in this count between versions means the
    // module graph's cycle structure moved.
    console.log(
      `  ⚠️  ${cycleGuarded} sites left as calls (${cycleGuardedSpecs.size} distinct ` +
        `specifiers) — hoisting them would close an import cycle`,
    );
  }
  if (missingTargets > 0) {
    // Left as calls on purpose (see above). Listed by specifier because the
    // remedy is per-specifier, and because a target that is missing from the
    // tree is a retargeting bug, not a bundling one.
    console.log(
      `  🔴 ${missingTargets} relative import.meta.require sites name a file ` +
        `that does not exist (${missingSpecs.size} distinct) — left as calls`,
    );
    for (const s of [...missingSpecs].sort()) console.log(`       ${s}`);
  }
}

/**
 * Main entry point: add import/export to all deobfuscated files.
 */
export function reconstructModules(projectDir: string): void {
  const mappingPath = path.join(projectDir, "_mapping.json");
  const mapping: Mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

  // A chunked tree is ALREADY a module graph. Synthesising a second set of
  // imports/exports over it re-declares names the chunk already imports, which
  // is invalid ESM — so that tree gets its own specifiers retargeted instead.
  if (hasNativeImportGraph(projectDir, mapping)) {
    const graphPath = path.resolve(
      projectDir,
      "..",
      ".deob_cache",
      "chunk-graph.json",
    );
    const fromEnv = process.env.CHUNK_GRAPH;
    const resolved = fromEnv && fs.existsSync(fromEnv) ? fromEnv : graphPath;
    if (!fs.existsSync(resolved)) {
      // No silent fallback to synthesis: that is exactly the path that produced
      // a tree where no file parses, while every step reported success.
      throw new Error(
        `Chunked tree detected but no chunk graph at ${resolved}. ` +
          `Re-run extract_chunks.py with --manifest, or set CHUNK_GRAPH=<path>.`,
      );
    }
    console.log(
      `Module reconstruction: chunked tree (${mapping.sections.length} sections) — ` +
        `native ESM graph present, retargeting specifiers instead of synthesising`,
    );
    retargetChunkImports(projectDir, mapping, resolved);
    // AFTER retargeting, never before: retargeting is what turns a /$bunfs
    // specifier into the relative path this pass keys on, so running it first
    // would see almost nothing to bind.
    bindStaticRequires(projectDir, mapping);
    return;
  }

  console.log(
    `Module reconstruction: ${mapping.sections.length} sections`,
  );

  // Phase 1: Strip IIFE wrappers and analyze all files
  const fileAnalysis = new Map<
    string,
    { declarations: string[]; identifiers: Set<string> }
  >();

  let preamblePath: string | null = null;

  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;

    let code = fs.readFileSync(fullPath, "utf-8");

    // Strip IIFE wrappers (non-destructive — only changes file if wrapper found)
    if (section.type === "preamble") {
      preamblePath = section.output_path;
      const stripped = stripPreambleWrapper(code);
      if (stripped !== code) {
        code = stripped;
        fs.writeFileSync(fullPath, code);
      }
    } else if (section.type === "tail") {
      const stripped = stripTailWrapper(code);
      if (stripped !== code) {
        code = stripped;
        fs.writeFileSync(fullPath, code);
      }
    }

    if (!code.trim()) continue;

    const analysis = analyzeFile(code);
    fileAnalysis.set(section.output_path, analysis);
  }

  // Phase 2: Build global declaration map (name → first declaring file)
  const globalDeclMap = new Map<string, string>();
  for (const [filePath, analysis] of fileAnalysis) {
    for (const decl of analysis.declarations) {
      if (!globalDeclMap.has(decl)) {
        globalDeclMap.set(decl, filePath);
      }
    }
  }

  console.log(
    `  ${globalDeclMap.size} global declarations across ${fileAnalysis.size} files`,
  );

  // Phase 3: Generate and write import/export for each file
  let totalImports = 0;
  let totalExports = 0;
  let filesModified = 0;

  for (const [filePath, analysis] of fileAnalysis) {
    const localDecls = new Set(analysis.declarations);

    // Find external references: identifiers used here but declared elsewhere
    const importMap = new Map<string, Set<string>>(); // source file → names

    for (const id of analysis.identifiers) {
      if (localDecls.has(id)) continue;
      if (JS_GLOBALS.has(id)) continue;

      const declFile = globalDeclMap.get(id);
      if (!declFile || declFile === filePath) continue;

      if (!importMap.has(declFile)) importMap.set(declFile, new Set());
      importMap.get(declFile)!.add(id);
    }

    // Build import lines (sorted for deterministic output)
    const importLines: string[] = [];
    const sortedSources = [...importMap.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [sourcePath, names] of sortedSources) {
      const relPath = computeRelativePath(filePath, sourcePath);
      const nameList = [...names].sort().join(", ");
      importLines.push(`import { ${nameList} } from '${relPath}';`);
      totalImports += names.size;
    }

    // Build export statement
    let exportLine: string;
    if (analysis.declarations.length > 0) {
      exportLine = `export { ${analysis.declarations.join(", ")} };`;
      totalExports += analysis.declarations.length;
    } else {
      exportLine = "export {};"; // Ensure file is treated as a module
    }

    // Only modify if there's something to add
    if (importLines.length === 0 && analysis.declarations.length === 0)
      continue;

    // Read current file and prepend imports / append exports
    const fullPath = path.join(projectDir, filePath);
    const code = fs.readFileSync(fullPath, "utf-8");

    const parts: string[] = [];
    if (importLines.length > 0) {
      parts.push(importLines.join("\n"));
      parts.push("");
    }
    parts.push(code);
    if (!code.endsWith("\n")) parts.push("");
    parts.push(exportLine);
    parts.push("");

    fs.writeFileSync(fullPath, parts.join("\n"));
    filesModified++;
  }

  console.log(
    `  Modified ${filesModified} files: ${totalImports} imports, ${totalExports} exports`,
  );
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log(
      "Usage: bun run src/module-reconstruct.ts <project_dir>",
    );
    process.exit(1);
  }
  reconstructModules(args[0]);
}
