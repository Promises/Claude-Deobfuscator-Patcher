/**
 * Rename minified identifiers back to original names.
 *
 * Strategy:
 * 1. Parse the M_() export map in each module — this directly maps
 *    original export names to minified variable names
 * 2. Match classes by method overlap, functions by signature
 * 3. Use TypeScript Language Service for scope-aware renaming:
 *    - Files must have import/export (from module-reconstruct.ts)
 *    - findRenameLocations traces each binding through the import graph
 *    - Local parameters with the same name are NOT renamed (correct scoping)
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { RenameDB } from "./rename-db-types";
import { constraintMatch } from "./constraint-renamer";

export interface RenameEntry {
  minified: string;
  original: string;
  source: string; // where we learned this: "export_map", "class_method", "propagation"
  file: string;   // which deobfuscated file
}

export interface RenameMap {
  entries: RenameEntry[];
  byMinified: Map<string, RenameEntry>;
  byOriginal: Map<string, RenameEntry>;
}

/**
 * Extract export mappings from a module's M_() call.
 * Pattern: M_(exportObj, { exportName: () => minifiedVar, ... })
 */
const JS_RESERVED = new Set([
  "break", "case", "catch", "continue", "debugger", "default", "delete",
  "do", "else", "finally", "for", "function", "if", "in", "instanceof",
  "new", "return", "switch", "this", "throw", "try", "typeof", "var",
  "void", "while", "with", "class", "const", "enum", "export", "extends",
  "import", "super", "implements", "interface", "let", "package", "private",
  "protected", "public", "static", "yield", "await",
]);

function extractExportMap(code: string): Map<string, string> {
  const map = new Map<string, string>();

  // Parse with TS
  const sf = ts.createSourceFile("module.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  function visit(node: ts.Node) {
    // Look for M_(X, { name: () => var, ... }) or similar export helper calls
    if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.arguments.length === 2 &&
        ts.isObjectLiteralExpression(node.arguments[1])) {

      const helperName = node.expression.text;
      const obj = node.arguments[1] as ts.ObjectLiteralExpression;

      for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            ts.isArrowFunction(prop.initializer)) {

          const exportName = prop.name.text;
          const body = prop.initializer.body;

          if (ts.isIdentifier(body) && !JS_RESERVED.has(exportName)) {
            // { exportName: () => minifiedVar }
            map.set(body.text, exportName);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return map;
}

/**
 * Extract class method names and map them to the class variable name.
 * Classes have methods with original names (not minified by esbuild).
 * If the source reference has a class with those methods, we can rename the class.
 */
function extractClassInfo(code: string): Array<{
  className: string;
  methods: string[];
  properties: string[];
  offset: number;
}> {
  const classes: Array<{ className: string; methods: string[]; properties: string[]; offset: number }> = [];
  const sf = ts.createSourceFile("module.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text || "";
      const methods: string[] = [];
      const properties: string[] = [];

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methods.push(member.name.text);
        }
        if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methods.push(member.name.text);
        }
        if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          properties.push(member.name.text);
        }
      }

      if (methods.length > 0 || properties.length > 0) {
        classes.push({ className: name, methods, properties, offset: node.getStart(sf) });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return classes;
}

interface FuncInfo {
  name: string;
  paramCount: number;
  isAsync: boolean;
  isGenerator: boolean;
  strings: string[];
  offset: number;
}

/**
 * Extract function definitions — name, param count, contained strings.
 */
function extractFunctions(code: string, scriptKind: ts.ScriptKind = ts.ScriptKind.JS): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  const sf = ts.createSourceFile("module.js", code, ts.ScriptTarget.Latest, true, scriptKind);

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const strings: string[] = [];
      function findStrings(n: ts.Node) {
        if (ts.isStringLiteral(n) && n.text.length >= 4) strings.push(n.text);
        ts.forEachChild(n, findStrings);
      }
      findStrings(node.body);

      funcs.push({
        name: node.name.text,
        paramCount: node.parameters.length,
        isAsync: !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
        isGenerator: !!node.asteriskToken,
        strings,
        offset: node.getStart(sf),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return funcs;
}

/**
 * Extract exported function/variable names from a TypeScript source file.
 */
function extractSourceExports(code: string, filename: string): Array<{
  name: string;
  kind: "function" | "class" | "variable" | "type" | "interface" | "enum";
  isAsync: boolean;
  isGenerator: boolean;
  paramCount: number;
  strings: string[];
}> {
  const exports: Array<{
    name: string;
    kind: "function" | "class" | "variable" | "type" | "interface" | "enum";
    isAsync: boolean;
    isGenerator: boolean;
    paramCount: number;
    strings: string[];
  }> = [];
  const scriptKind = filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, scriptKind);

  function collectStrings(node: ts.Node): string[] {
    const strings: string[] = [];
    function walk(n: ts.Node) {
      if (ts.isStringLiteral(n) && n.text.length >= 4) strings.push(n.text);
      ts.forEachChild(n, walk);
    }
    walk(node);
    return strings;
  }

  function visit(node: ts.Node) {
    const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) {
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      exports.push({
        name: node.name.text,
        kind: "function",
        isAsync: !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
        isGenerator: !!node.asteriskToken,
        paramCount: node.parameters.length,
        strings: node.body ? collectStrings(node.body) : [],
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      exports.push({
        name: node.name.text,
        kind: "class",
        isAsync: false,
        isGenerator: false,
        paramCount: 0,
        strings: collectStrings(node),
      });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          // Check if it's an arrow function
          let isAsync = false, isGenerator = false, paramCount = 0;
          if (decl.initializer) {
            if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
              isAsync = !!decl.initializer.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
              isGenerator = ts.isFunctionExpression(decl.initializer) ? !!decl.initializer.asteriskToken : false;
              paramCount = decl.initializer.parameters.length;
            }
          }
          exports.push({
            name: decl.name.text,
            kind: "variable",
            isAsync,
            isGenerator,
            paramCount,
            strings: decl.initializer ? collectStrings(decl.initializer) : [],
          });
        }
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      exports.push({ name: node.name.text, kind: "type", isAsync: false, isGenerator: false, paramCount: 0, strings: [] });
    } else if (ts.isInterfaceDeclaration(node)) {
      exports.push({ name: node.name.text, kind: "interface", isAsync: false, isGenerator: false, paramCount: 0, strings: [] });
    } else if (ts.isEnumDeclaration(node)) {
      exports.push({ name: node.name.text, kind: "enum", isAsync: false, isGenerator: false, paramCount: 0, strings: [] });
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return exports;
}

/**
 * Match deobfuscated functions to source exports by signature.
 * For modules without M_() export maps, we match by:
 * 1. async/generator flags (exact match required)
 * 2. param count (exact match preferred, ±1 tolerated)
 * 3. shared string literals (strong signal)
 */
function matchFunctionsBySignature(
  deobFuncs: FuncInfo[],
  sourceExports: ReturnType<typeof extractSourceExports>,
): Map<string, string> {
  const renames = new Map<string, string>();

  // Only match function/variable exports (skip types, interfaces)
  const funcExports = sourceExports.filter(e =>
    e.kind === "function" || e.kind === "variable" || e.kind === "class"
  );

  // Skip if too many of either — ambiguous
  if (deobFuncs.length === 0 || funcExports.length === 0) return renames;

  // Single export, single function — direct match if signatures align
  if (funcExports.length === 1 && deobFuncs.length === 1) {
    const src = funcExports[0];
    const deob = deobFuncs[0];
    if (src.isAsync === deob.isAsync && src.isGenerator === deob.isGenerator) {
      renames.set(deob.name, src.name);
    }
    return renames;
  }

  // Score-based matching for multi-export modules
  const used = new Set<string>();
  const candidates: Array<{ deob: string; src: string; score: number }> = [];

  for (const deob of deobFuncs) {
    for (const src of funcExports) {
      let score = 0;

      // Async/generator must match
      if (src.isAsync !== deob.isAsync) continue;
      if (src.isGenerator !== deob.isGenerator) continue;

      score += 1; // base match

      // Param count
      if (src.paramCount === deob.paramCount) score += 3;
      else if (Math.abs(src.paramCount - deob.paramCount) === 1) score += 1;
      else continue; // too different

      // Shared strings — strongest signal
      const srcStrings = new Set(src.strings);
      const shared = deob.strings.filter(s => srcStrings.has(s));
      score += shared.length * 5;

      if (score >= 2) {
        candidates.push({ deob: deob.name, src: src.name, score });
      }
    }
  }

  // Greedy assignment by score
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (used.has(c.src) || renames.has(c.deob)) continue;
    renames.set(c.deob, c.src);
    used.add(c.src);
  }

  return renames;
}

/**
 * Apply renames to a JS source string.
 * Uses the TS compiler to find all identifier references and rename them.
 */
export function applyRenames(code: string, renames: Map<string, string>, filename = "module.js"): string {
  const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  // Collect all identifier positions that should be renamed
  const replacements: Array<{ start: number; end: number; newText: string }> = [];

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const newName = renames.get(node.text);
      if (newName && node.text !== newName) {
        // Don't rename property access names (they're already the original)
        // Only rename variable/function declarations and references
        const parent = node.parent;

        // Skip: property assignments in object literals { foo: ... }
        if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return;
        // Skip: property access .foo
        if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return;
        // Skip: import/export specifiers
        if (parent && (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))) return;
        // Skip: the export map itself M_(x, { name: () => var })
        // (the export name should stay as-is, we rename the var reference)

        replacements.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          newText: newName,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);

  // Apply replacements in reverse order to preserve offsets
  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.newText + result.slice(r.end);
  }

  return result;
}

/**
 * Build rename map for a single matched module.
 */
export function buildModuleRenames(
  deobCode: string,
  sourceCode: string,
  sourcePath: string
): Map<string, string> {
  const renames = new Map<string, string>();

  // 1. Export map — the primary source of renames
  const exportMap = extractExportMap(deobCode);
  for (const [minified, original] of exportMap) {
    renames.set(minified, original);
  }

  // 2. Class matching — if source has class Foo with methods bar, baz
  // and deob has class X with same methods, rename X → Foo
  const deobClasses = extractClassInfo(deobCode);
  const scriptKind = sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceSf = ts.createSourceFile(sourcePath, sourceCode, ts.ScriptTarget.Latest, true, scriptKind);

  const sourceClasses: Array<{ name: string; methods: string[]; properties: string[] }> = [];
  function findSourceClasses(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const methods: string[] = [];
      const properties: string[] = [];
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methods.push(member.name.text);
        }
        if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methods.push(member.name.text);
        }
        if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          properties.push(member.name.text);
        }
      }
      sourceClasses.push({ name: node.name.text, methods, properties });
    }
    ts.forEachChild(node, findSourceClasses);
  }
  findSourceClasses(sourceSf);

  // Score each deob class against each source class using methods + properties
  const classUsed = new Set<string>();
  const classCandidates: Array<{ deobName: string; srcName: string; score: number }> = [];

  for (const deobClass of deobClasses) {
    if (deobClass.methods.length + deobClass.properties.length < 2) continue;
    const deobMethodSet = new Set(deobClass.methods);
    const deobPropSet = new Set(deobClass.properties);

    for (const srcClass of sourceClasses) {
      const methodOverlap = srcClass.methods.filter(m => deobMethodSet.has(m)).length;
      const propOverlap = srcClass.properties.filter(p => deobPropSet.has(p)).length;
      const score = methodOverlap * 3 + propOverlap * 2;
      if (methodOverlap + propOverlap >= 2 && score >= 4) {
        classCandidates.push({ deobName: deobClass.className, srcName: srcClass.name, score });
      }
    }
  }

  // Greedy 1:1 assignment — highest score wins, no duplicate targets
  classCandidates.sort((a, b) => b.score - a.score);
  for (const c of classCandidates) {
    if (!c.deobName || c.deobName === c.srcName) continue;
    if (classUsed.has(c.srcName) || renames.has(c.deobName)) continue;
    renames.set(c.deobName, c.srcName);
    classUsed.add(c.srcName);
  }

  // 3. Source export matching — for modules without M_() export maps,
  // match deobfuscated functions to source exports by signature.
  // Skip source names already claimed by earlier steps.
  if (exportMap.size === 0) {
    const alreadyClaimed = new Set(renames.values());
    const sourceExports = extractSourceExports(sourceCode, sourcePath)
      .filter(e => !alreadyClaimed.has(e.name));
    const alreadyRenamed = new Set(renames.keys());
    const deobFuncs = extractFunctions(deobCode)
      .filter(f => !alreadyRenamed.has(f.name));
    const sigRenames = matchFunctionsBySignature(deobFuncs, sourceExports);
    for (const [minified, original] of sigRenames) {
      if (!renames.has(minified)) {
        renames.set(minified, original);
      }
    }
  }

  return renames;
}

/**
 * Find positions of declaration identifiers at any depth in the AST.
 * Searches recursively — handles declarations inside IIFE wrappers,
 * E()/R() blocks, and other nested scopes.
 * Returns map of name → character offset (first occurrence wins).
 */
function findDeclPositions(code: string, fileName: string): Map<string, number> {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const positions = new Map<string, number>();

  function extractBindingPositions(name: ts.BindingName) {
    if (ts.isIdentifier(name)) {
      if (!positions.has(name.text)) {
        positions.set(name.text, name.getStart(sf));
      }
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) extractBindingPositions(el.name);
    } else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (!ts.isOmittedExpression(el)) extractBindingPositions(el.name);
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (!positions.has(node.name.text)) {
        positions.set(node.name.text, node.name.getStart(sf));
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      if (!positions.has(node.name.text)) {
        positions.set(node.name.text, node.name.getStart(sf));
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        extractBindingPositions(decl.name);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return positions;
}

/**
 * Strip import/export lines from module-reconstructed code.
 * Returns the raw code suitable for concatenation into a single file.
 */
function stripImportExport(code: string): string {
  // Only strip imports from relative paths (added by module-reconstruct),
  // NOT original code imports from "process", "fs", "crypto", etc.
  code = code.replace(
    /^import\s+\{[^}]*\}\s+from\s+['"]\.\.?\/[^'"]+['"];?\s*\n?/gm,
    "",
  );
  // Strip export lines added by module-reconstruct
  code = code.replace(/^export\s+\{[^}]*\};?\s*\n?/gm, "");
  return code;
}

/**
 * Scope-aware renaming using TS Language Service on a single assembled file.
 *
 * Instead of loading 4688 module files (slow due to cross-file module resolution),
 * we concatenate all code into ONE file. TS natively understands function scope,
 * var hoisting, and parameter shadowing within a single file — no modules needed.
 *
 * Steps:
 * 1. Concatenate all sections (stripping import/export) into one string
 * 2. Track section byte offsets for mapping positions back to split files
 * 3. Create TS LS on the single file
 * 4. For each rename: find declaration position, call findRenameLocations
 * 5. Map returned positions back to individual files, apply edits
 */
function renameWithLanguageService(
  projectDir: string,
  mapping: any,
  renameTasks: Array<{ minified: string; original: string; declFile: string }>,
): { totalRenames: number; fileRenames: Map<string, number> } {
  // Phase 1: Assemble all sections into one string, tracking offsets
  const sections: Array<{
    outputPath: string;
    start: number; // offset in assembled string
    length: number;
    code: string; // stripped code for this section
  }> = [];
  const sectionByPath = new Map<string, number>(); // outputPath → index in sections[]

  const assembledParts: string[] = [];
  let currentOffset = 0;

  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;

    let code = fs.readFileSync(fullPath, "utf-8");
    code = stripImportExport(code);
    // Strip hashbang (v2.1.70+ uses #!/usr/bin/env node instead of IIFE)
    if (code.startsWith("#!")) {
      code = code.replace(/^#![^\n]*\n?/, "");
    }

    const idx = sections.length;
    sections.push({
      outputPath: section.output_path,
      start: currentOffset,
      length: code.length,
      code,
    });
    sectionByPath.set(section.output_path, idx);

    assembledParts.push(code);
    currentOffset += code.length;
  }

  const assembled = assembledParts.join("");
  console.log(
    `  TS LS: assembled ${sections.length} sections (${(assembled.length / 1024 / 1024).toFixed(1)} MB)`,
  );

  // Phase 2: Create TS LS on the single assembled file
  const virtualFileName = path.resolve(projectDir, "__assembled__.js");
  const snapshot = ts.ScriptSnapshot.fromString(assembled);

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [virtualFileName],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fn) =>
      fn === virtualFileName ? snapshot : undefined,
    getCurrentDirectory: () => path.resolve(projectDir),
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.Latest,
      noEmit: true,
      strict: false,
    }),
    getDefaultLibFileName: () => ts.getDefaultLibFilePath({}),
    fileExists: (fn) => fn === virtualFileName || ts.sys.fileExists(fn),
    readFile: (fn) =>
      fn === virtualFileName ? assembled : ts.sys.readFile(fn),
  };

  const service = ts.createLanguageService(
    host,
    ts.createDocumentRegistry(),
  );

  // Phase 3: Find declaration positions in the assembled file
  // For each rename task, locate the declaration in the assembled file
  const assembledPositions = findDeclPositions(assembled, virtualFileName);

  console.log(
    `  TS LS: ${assembledPositions.size} declarations found in assembled file`,
  );

  // Phase 4: For each rename, call findRenameLocations
  const allEdits: Array<{
    start: number;
    end: number;
    newText: string;
  }> = [];
  let renamesResolved = 0;
  let renamesSkipped = 0;

  // Deduplicate: only process each unique minified name once
  const processed = new Set<string>();

  for (const { minified, original } of renameTasks) {
    if (processed.has(minified)) continue;
    processed.add(minified);

    const pos = assembledPositions.get(minified);
    if (pos === undefined) {
      renamesSkipped++;
      continue;
    }

    const locations = service.findRenameLocations(
      virtualFileName,
      pos,
      false,
      false,
    );
    if (!locations || locations.length === 0) {
      renamesSkipped++;
      continue;
    }

    for (const loc of locations) {
      allEdits.push({
        start: loc.textSpan.start,
        end: loc.textSpan.start + loc.textSpan.length,
        newText: original,
      });
    }

    renamesResolved++;
  }

  console.log(
    `  TS LS: ${renamesResolved} renames resolved (${allEdits.length} locations), ${renamesSkipped} skipped`,
  );

  // Phase 5: Map assembled-file positions back to individual sections
  // and apply edits to the split files
  const editsBySection = new Map<
    number,
    Array<{ start: number; end: number; newText: string }>
  >();

  for (const edit of allEdits) {
    // Binary search for which section contains this offset
    let lo = 0,
      hi = sections.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sections[mid].start <= edit.start) lo = mid;
      else hi = mid - 1;
    }

    const sec = sections[lo];
    const localStart = edit.start - sec.start;
    const localEnd = edit.end - sec.start;

    if (!editsBySection.has(lo)) editsBySection.set(lo, []);
    editsBySection.get(lo)!.push({
      start: localStart,
      end: localEnd,
      newText: edit.newText,
    });
  }

  // Apply edits to each section's ORIGINAL file (with import/export intact)
  // We need to adjust positions because the original file has import lines
  // at the top that were stripped during assembly.
  let totalRenames = 0;
  const fileRenames = new Map<string, number>();

  for (const [secIdx, edits] of editsBySection) {
    const sec = sections[secIdx];
    const fullPath = path.join(projectDir, sec.outputPath);
    const originalCode = fs.readFileSync(fullPath, "utf-8");

    // Calculate the offset added by import/export lines
    // The stripped code (sec.code) maps 1:1 to positions in the assembled file.
    // We need to find where sec.code starts within originalCode.
    const strippedCode = sec.code;
    const importOffset = findCodeOffset(originalCode, strippedCode);

    // Sort edits in reverse order for safe replacement
    const sorted = edits.sort((a, b) => b.start - a.start);

    let result = originalCode;
    for (const edit of sorted) {
      const adjStart = edit.start + importOffset;
      const adjEnd = edit.end + importOffset;
      result =
        result.slice(0, adjStart) + edit.newText + result.slice(adjEnd);
    }

    fs.writeFileSync(fullPath, result);
    fileRenames.set(sec.outputPath, edits.length);
    totalRenames += edits.length;
  }

  return { totalRenames, fileRenames };
}

/**
 * Calculate the byte offset between the stripped code and the original file.
 * The stripped code starts with the first non-import/non-blank line.
 * Returns the offset to add to stripped positions to get original positions.
 */
function findCodeOffset(original: string, stripped: string): number {
  // Find where the stripped content starts in the original
  // Use a reliable substring match on the first meaningful content
  const trimmed = stripped.replace(/^\s+/, "");
  const needle = trimmed.slice(0, Math.min(60, trimmed.indexOf("\n") >>> 0 || 60));
  if (!needle) return 0;

  const idx = original.indexOf(needle);
  if (idx < 0) return 0;

  // The offset is: (position in original) - (position in stripped)
  // stripped might have leading whitespace that we trimmed
  const strippedLeading = stripped.length - trimmed.length;
  return idx - strippedLeading;
}

/**
 * Process all matched modules in a deobfuscated project.
 *
 * Two-pass approach:
 *   Pass 1: Discover renames from all matched modules
 *   Pass 2: Apply renames using TS Language Service (scope-aware)
 *
 * Files must have import/export from module-reconstruct.ts before calling this.
 */
export function renameProject(
  projectDir: string,
  sourceRefDir: string,
  mappingPath: string,
  dbPath?: string,
): { totalRenames: number; fileRenames: Map<string, number> } {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

  // Load rename DB if provided
  let db: RenameDB | null = null;
  if (dbPath && fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  }

  // Pass 1: Discover renames via constraint matching + export maps
  const renameTasks: Array<{
    minified: string;
    original: string;
    declFile: string;
  }> = [];
  const seen = new Map<string, string>(); // minified → original (dedup)

  for (const section of mapping.sections) {
    if (!section.matched_source || section.confidence === "low") continue;

    const deobPath = path.join(projectDir, section.output_path);
    const sourcePath = path.join(sourceRefDir, section.matched_source);

    if (!fs.existsSync(deobPath) || !fs.existsSync(sourcePath)) continue;

    const deobCode = fs.readFileSync(deobPath, "utf-8");
    const sourceCode = fs.readFileSync(sourcePath, "utf-8");

    // Primary: constraint matching (inside-out, version-agnostic)
    const { matches: constraintMatches } = constraintMatch(
      deobCode, sourceCode, section.matched_source,
    );

    // Fallback: export map + signature matching
    let legacyRenames = buildModuleRenames(deobCode, sourceCode, section.matched_source);

    if (db) {
      legacyRenames = applyDBFilters(legacyRenames, section.matched_source, db);
    }

    // Merge: constraint matches take priority, then legacy
    for (const m of constraintMatches) {
      if (seen.has(m.minified)) continue;
      seen.set(m.minified, m.original);
      renameTasks.push({
        minified: m.minified,
        original: m.original,
        declFile: section.output_path,
      });
    }

    for (const [minified, original] of legacyRenames) {
      if (seen.has(minified)) continue;
      seen.set(minified, original);
      renameTasks.push({
        minified,
        original,
        declFile: section.output_path,
      });
    }
  }

  console.log(`  Discovered ${seen.size} unique renames (${renameTasks.length} tasks)`);

  // Pass 2: Scope-aware renaming via TS Language Service
  return renameWithLanguageService(projectDir, mapping, renameTasks);
}

/**
 * Apply DB filters to a set of computed renames.
 * Suppressed names are skipped unless manually resolved.
 */
function applyDBFilters(
  renames: Map<string, string>,
  sourcePath: string,
  db: RenameDB,
): Map<string, string> {
  const fileEntry = db.files[sourcePath];
  if (!fileEntry) return renames;

  const filtered = new Map<string, string>();
  for (const [minified, original] of renames) {
    // Check if this original name is suppressed
    if (fileEntry.suppressed?.[original]) {
      const entry = fileEntry.suppressed[original];
      // Only allow through if manually resolved for this file
      if (entry.resolved_as === original) {
        filtered.set(minified, original);
      }
      // Otherwise suppressed — skip
      continue;
    }
    filtered.set(minified, original);
  }

  return filtered;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log("Usage: bun run src/renamer.ts <project_dir> <source_ref_dir> <mapping.json> [rename-db.json]");
    process.exit(1);
  }

  const [projectDir, sourceRefDir, mappingPath, dbPath] = args;
  console.log("Renaming identifiers...");
  const { totalRenames, fileRenames } = renameProject(projectDir, sourceRefDir, mappingPath, dbPath);

  console.log(`\nRenamed ${totalRenames} identifiers across ${fileRenames.size} files`);
  const sorted = [...fileRenames.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\nTop 20 files by rename count:");
  for (const [file, count] of sorted.slice(0, 20)) {
    console.log(`  ${String(count).padStart(4)} renames  ${file}`);
  }
}
