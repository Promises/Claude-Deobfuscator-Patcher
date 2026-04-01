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
 * Main entry point: add import/export to all deobfuscated files.
 */
export function reconstructModules(projectDir: string): void {
  const mappingPath = path.join(projectDir, "_mapping.json");
  const mapping: Mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

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
