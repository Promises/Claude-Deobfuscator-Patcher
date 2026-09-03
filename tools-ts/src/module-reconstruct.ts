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
 * SCOPE — what this deliberately does NOT touch. Only STATIC imports are in the
 * manifest, so only static imports are retargeted. Measured on 2.1.259 the tree
 * also holds 1,104 `await import('/$bunfs/…')` and 320
 * `import.meta.require('/$bunfs/…')` sites. Those are runtime specifiers, not
 * bindings: they create no top-level name, so they cannot cause the duplicate-
 * declaration failure this fixes, and leaving them alone keeps the ESM parse
 * gate green. They ARE still dead paths for a reassembled bundle, which is a
 * step-4 concern and is reported by the counter below rather than assumed away.
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

  // Per chunk, bunfs specifier -> resolved target output_path. Built from the
  // manifest rather than re-parsed, so the resolution stays the measured one.
  const targetsByChunk = new Map<number, Map<string, string>>();
  for (const chunk of graph) {
    const m = new Map<string, string>();
    for (const imp of chunk.imports) {
      if (imp.target === null) continue;
      const out = indexToOutput.get(imp.target);
      if (out) m.set(imp.path, out);
    }
    targetsByChunk.set(chunk.index, m);
  }

  let filesRewritten = 0;
  let specifiersRewritten = 0;
  let unresolved = 0;

  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;
    const code = fs.readFileSync(fullPath, "utf-8");
    // Absent chunk == empty target map, so the replace below counts its
    // specifiers as unresolved the same way as any other miss. Counting whole
    // FILES here instead would mix two units in one total — that reported
    // "18240 unresolved" against a graph holding only 13,317 imports.
    const targets = targetsByChunk.get(section.index) ?? new Map<string, string>();

    let touched = false;
    const rewritten = code.replace(
      BUNFS_IMPORT_RE,
      (whole, head: string, spec: string) => {
        const out = targets.get(spec);
        if (!out) {
          unresolved++;
          return whole;
        }
        touched = true;
        specifiersRewritten++;
        return `${head}'${computeRelativePath(section.output_path, out)}'`;
      },
    );

    if (touched) {
      fs.writeFileSync(fullPath, rewritten);
      filesRewritten++;
    }
  }

  console.log(
    `  Retargeted ${specifiersRewritten} /$bunfs specifiers in ${filesRewritten} files`,
  );
  // Loud, because a surviving bunfs specifier resolves to nothing: renames stop
  // propagating through it and the reassembled bundle carries a dead import.
  if (unresolved > 0) {
    console.log(`  🔴 ${unresolved} /$bunfs specifiers could NOT be retargeted`);
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
