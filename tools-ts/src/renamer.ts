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
import { applyAnchorRules } from "./anchor-rules";

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
  // Literal keywords. These are NOT in the ECMAScript "reserved word" list
  // proper, but they are equally illegal as binding names — and they DO occur
  // as export names (zod does `export { _null as null }`, whose minified
  // export map reads `null:()=>tXy`). Omitting them is what let the renamer
  // rewrite the *binding* tXy to `null`, emitting `null:()=>null` and a bare
  // `null` in the flattened export list — a hard parse error.
  "null", "true", "false",
]);

/**
 * Names that are legal bindings but must never be a rename TARGET, because
 * binding them shadows a global that the rest of the bundle depends on.
 *
 * Everything is bundled into ONE scope, so a module-level `var undefined` in
 * any single module shadows the global `undefined` for EVERY other module in
 * the bundle. Measured on 2.1.238: zod exports a schema factory as `undefined`
 * (`_unmatched/0264_NNo.js`, export map `undefined:()=>eXy`). Renaming the
 * binding eXy to `undefined` emitted `undefined: () => undefined` plus a bare
 * `undefined` in the flattened export list, after which every `x !== undefined`
 * in the bundle compared against a FUNCTION. The first casualty on the startup
 * path was `Lr.of` (`_tentative/0137_index.js`): `this.#t.get(e)` returned the
 * primitive undefined, `t !== undefined` evaluated TRUE, and `of` returned the
 * cached-miss value, so `startCapturingEarlyInput` crashed on `e.capturing`.
 *
 * This class is strictly nastier than the JS_RESERVED one above. `null` was a
 * hard PARSE error — loud, and it failed the build. These names parse fine,
 * compile fine, report the right --version, and silently corrupt comparisons
 * anywhere in the bundle. Keep them out by name.
 *
 * `NaN`/`Infinity` are the same shape (writable-in-sloppy-mode globals that
 * comparisons rely on); `globalThis` likewise. None of them appear as export
 * names today — they are listed so a future bundle cannot reintroduce the bug.
 */
const SHADOWS_GLOBAL = new Set([
  "undefined", "NaN", "Infinity", "globalThis",
]);

/**
 * Is `name` legal as a JavaScript *binding* identifier?
 *
 * A rename target is used as a declaration name, so it must satisfy the full
 * IdentifierName grammar AND not be a reserved word or literal keyword. Export
 * *names* are laxer (any IdentifierName, plus string literals, so `null` is a
 * fine export name) — but we rename the binding, not the export alias, so the
 * strict rule is the one that applies.
 *
 * Note the class this guards: `catch`, `default`, `enum`, `export`, `function`,
 * `import`, `instanceof` and `void` all appear as export names in this bundle
 * and reach the same code path. They were surviving only because they happened
 * to be listed above; this predicate makes the coverage structural instead of
 * enumerated, so a name outside the list (`null`) can no longer slip through.
 *
 * SHADOWS_GLOBAL covers the second class: names that ARE valid identifiers, so
 * the grammar check below passes them, but whose binding would shadow a global
 * the rest of the single-scope bundle reads (`undefined`). See that set.
 */
function isValidBindingName(name: string): boolean {
  if (!name) return false;
  if (JS_RESERVED.has(name)) return false;
  if (SHADOWS_GLOBAL.has(name)) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

export function extractExportMap(code: string): Map<string, string> {
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

          if (ts.isIdentifier(body) && isValidBindingName(exportName)) {
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
 * Does this tree have ONE shared top-level scope, or one scope PER FILE?
 *
 * This is the discriminator between the two bundle formats, and it is measured
 * from the tree itself rather than passed down from build.sh — the renamer is
 * also called by the studio, which has no FORMAT variable to hand it.
 *
 * Up to 2.1.241 the binary embeds ONE monolithic CJS bundle. esbuild gave every
 * declaration in it a bundle-unique name, so concatenating the split files back
 * into one virtual file re-creates the original single scope faithfully. MEASURED
 * on the 2.1.238 tree: of 60,885 top-level declarations in the assembled file,
 * exactly ONE name is declared twice.
 *
 * From 2.1.242 the bundle is ~1400-1700 separate ESM chunks, each with its OWN
 * top-level scope, so short names are reused freely between chunks. MEASURED on
 * the 2.1.259 tree: 10,558 names are declared more than once at top level, the
 * worst (`x`) 192 times. Concatenating those merges 192 unrelated declarations
 * into one TS symbol; `findRenameLocations` then walks the merged control-flow
 * graph and dies with "Maximum call stack size exceeded" inside
 * getTypeAtFlowNode. That is NOT a marginal stack shortfall — it reproduces
 * identically under --stack-size=8000000 with a raised ulimit -s — and it is
 * CUMULATIVE rather than caused by any one chunk: assembling sections 0..1200
 * resolves fine, 0..1400 throws, and neither half of the tree throws alone.
 *
 * So the ratio, not the version, decides. A tree whose names are essentially
 * unique per bundle can be flattened; one with heavy cross-file reuse must keep
 * its per-file scopes. The threshold is deliberately far from both measured
 * values (1/60885 = 0.002% vs 10558/19809 = 53%) so neither format sits near it.
 */
function hasSharedTopLevelScope(perFileDecls: Map<string, Set<string>>): boolean {
  const seen = new Set<string>();
  let dupes = 0;
  let total = 0;
  for (const decls of perFileDecls.values()) {
    for (const name of decls) {
      total++;
      if (seen.has(name)) dupes++;
      else seen.add(name);
    }
  }
  if (total === 0) return true;
  return dupes / total < 0.02;
}

/**
 * Top-level declaration names for one file. Mirrors the statement kinds that
 * findDeclPositions/module-reconstruct treat as declarations, so the scope
 * discriminator and the rename machinery agree about what a declaration is.
 */
function topLevelDeclNames(code: string, fileName: string): Set<string> {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out = new Set<string>();
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) out.add(name.text);
    else if (ts.isObjectBindingPattern(name)) for (const el of name.elements) bind(el.name);
    else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) out.add(stmt.name.text);
    else if (ts.isClassDeclaration(stmt) && stmt.name) out.add(stmt.name.text);
    else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) bind(decl.name);
    }
  }
  return out;
}

/**
 * A reusable rename "engine": the assembled single-file program + TS Language
 * Service + declaration-position index. Building this is the one-time setup cost
 * (~1.7s) shared by the whole-bundle rename and the per-file on-demand rename, so
 * BOTH paths see identical assembly, identical decl positions, and identical TS
 * binding — guaranteeing per-file output can never diverge from the full build.
 */
interface RenameSection {
  outputPath: string;
  start: number; // offset in the assembled string
  length: number;
  code: string; // stripped code for this section
}
interface RenameEngine {
  sections: RenameSection[];
  sectionByPath: Map<string, number>;
  assembled: string;
  virtualFileName: string;
  service: ts.LanguageService;
  assembledPositions: Map<string, number>;
}

function buildRenameEngine(projectDir: string, mapping: any): RenameEngine {
  // Phase 1: Assemble all sections into one string, tracking offsets
  const sections: RenameSection[] = [];
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
      // Identifier rename on plain JS (checkJs off) never consults the standard
      // library or module resolution, so skip all of that — it's pure binding/
      // scope work. Cuts program setup without changing rename locations.
      noLib: true,
      lib: [],
      types: [],
      skipLibCheck: true,
      noResolve: true,
      skipDefaultLibCheck: true,
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
  const assembledPositions = findDeclPositions(assembled, virtualFileName);
  console.log(
    `  TS LS: ${assembledPositions.size} declarations found in assembled file`,
  );

  return { sections, sectionByPath, assembled, virtualFileName, service, assembledPositions };
}

interface Edit { start: number; end: number; newText: string }

/**
 * Rename engine for CHUNKED bundles (2.1.242+), where each chunk is a real ESM
 * module with its own top-level scope.
 *
 * Instead of concatenating, this hands the TS Language Service the module graph
 * as it actually is: one source file per chunk, with real `import`/`export` and
 * real module resolution. Each chunk's `de` is then its own symbol, so TS never
 * has to merge 93 unrelated declarations — which is precisely what made the
 * single-file engine recurse to death.
 *
 * MEASURED on the 2.1.259 tree: the name `de` is declared at top level in 93
 * separate chunks. Under this engine all 93 resolve, each to its own scope
 * (617 locations for the largest, single digits for the rest), in ~6.5 s total;
 * under the concatenating engine the first query throws.
 *
 * A chunk is renamed by its OWN declarations only. Cross-chunk propagation still
 * happens, because findRenameLocations follows the import graph — that is the
 * whole reason module-reconstruct adds import/export in step 2.5 — so renaming a
 * binding also rewrites the import specifiers that reference it in other chunks.
 */
interface MultiFileEngine {
  /** absolute path → the section's output_path, for writing results back */
  fileToOutputPath: Map<string, string>;
  outputPathToFile: Map<string, string>;
  fileNames: string[];
  service: ts.LanguageService;
  /** absolute file → (decl name → offset of its first top-level declaration) */
  declPositions: Map<string, Map<string, number>>;
  /** decl name → every file that declares it at top level */
  declaringFiles: Map<string, string[]>;
  texts: Map<string, string>;
}

function buildMultiFileEngine(
  projectDir: string,
  mapping: any,
  fileTexts: Map<string, string>,
): MultiFileEngine {
  const root = path.resolve(projectDir);
  const fileNames: string[] = [];
  const texts = new Map<string, string>();
  const fileToOutputPath = new Map<string, string>();
  const outputPathToFile = new Map<string, string>();

  for (const section of mapping.sections) {
    const abs = path.resolve(root, section.output_path);
    const code = fileTexts.get(section.output_path);
    if (code === undefined) continue;
    fileNames.push(abs);
    texts.set(abs, code);
    fileToOutputPath.set(abs, section.output_path);
    outputPathToFile.set(section.output_path, abs);
  }

  const snapshots = new Map<string, ts.IScriptSnapshot>();
  for (const [f, c] of texts) snapshots.set(f, ts.ScriptSnapshot.fromString(c));

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "1",
    getScriptSnapshot: (fn) => snapshots.get(path.resolve(fn)),
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.Latest,
      noEmit: true,
      strict: false,
      // Real ESM resolution — this is the point of this engine. Unlike the
      // single-file path we must NOT set noResolve, or the import graph goes
      // unread and cross-chunk references stop resolving.
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      // Still no standard library: identifier rename on plain JS never consults
      // it, and loading lib.d.ts across ~1650 files is pure cost.
      noLib: true,
      lib: [],
      types: [],
      skipLibCheck: true,
      skipDefaultLibCheck: true,
    }),
    getDefaultLibFileName: () => ts.getDefaultLibFilePath({}),
    fileExists: (fn) => texts.has(path.resolve(fn)),
    readFile: (fn) => texts.get(path.resolve(fn)),
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  // Index every file's own top-level declarations and where they start.
  const declPositions = new Map<string, Map<string, number>>();
  const declaringFiles = new Map<string, string[]>();
  for (const abs of fileNames) {
    const positions = findDeclPositions(texts.get(abs)!, abs);
    declPositions.set(abs, positions);
    for (const name of positions.keys()) {
      let arr = declaringFiles.get(name);
      if (!arr) declaringFiles.set(name, (arr = []));
      arr.push(abs);
    }
  }

  console.log(
    `  TS LS (multi-file): ${fileNames.length} chunks, ${declaringFiles.size} distinct top-level names`,
  );

  return { fileToOutputPath, outputPathToFile, fileNames, service, declPositions, declaringFiles, texts };
}

/**
 * Resolve rename tasks against the per-chunk module graph.
 *
 * Returns edits grouped by the file they land in, in that FILE's coordinates
 * (not assembled coordinates) — the chunked path never builds an assembled
 * string, so there is no global coordinate space to map back from.
 *
 * ONE query per task, against the chunk that OWNS the symbol.
 *
 * A minified name is not unique in a chunked bundle (`x` is declared at top
 * level in 192 different chunks of 2.1.259), so "rename the symbol called x" is
 * not a well-formed request — there are 192 unrelated symbols with that name and
 * the evidence identifies exactly one of them. Every task carries the declFile it
 * was learned from: the chunk whose export map named it, or the chunk an anchor
 * rule matched. That chunk is the owner, and renaming any of the other 191 would
 * assert something the evidence never established.
 *
 * Querying only the owner is also what makes this affordable. MEASURED on the
 * 2.1.259 task set: renaming every declaring chunk is 31,404 findRenameLocations
 * calls for 2,086 tasks (15x amplification, worst single name 192) and did not
 * finish in 20 minutes at 7 GB RSS; owner-only is 2,086 calls.
 *
 * Cross-chunk references still update, because findRenameLocations follows the
 * ESM import graph out of the owning chunk — that is what step 2.5 builds it for.
 */
function runMultiFileRenameQueries(
  engine: MultiFileEngine,
  renameTasks: Array<{ minified: string; original: string; declFile?: string }>,
): { editsByFile: Map<string, Edit[]>; renamesResolved: number; renamesSkipped: number } {
  const { service, declaringFiles, declPositions, outputPathToFile } = engine;
  const editsByFile = new Map<string, Edit[]>();
  let renamesResolved = 0;
  let renamesSkipped = 0;
  const processed = new Set<string>();

  for (const { minified, original, declFile } of renameTasks) {
    if (processed.has(minified)) continue;
    processed.add(minified);

    // Prefer the owning chunk. Anchor tasks carry the sentinel "__anchor__"
    // rather than a real path, and an export map can name a binding the chunk
    // re-exports without declaring; in both cases fall back to the unique
    // declaring chunk, and give up if the name is declared in several (we have
    // no evidence for which one is meant).
    const owner = declFile ? outputPathToFile.get(declFile) : undefined;
    let targetFile: string | undefined;
    if (owner && declPositions.get(owner)?.has(minified)) {
      targetFile = owner;
    } else {
      const declFiles = declaringFiles.get(minified);
      if (declFiles && declFiles.length === 1) targetFile = declFiles[0];
    }

    if (!targetFile) {
      if (process.env.RENAME_VERBOSE) {
        const n = declaringFiles.get(minified)?.length ?? 0;
        console.warn(`    skip (${n === 0 ? "no decl" : `ambiguous: ${n} declaring chunks`}): ${minified} → ${original}`);
      }
      renamesSkipped++;
      continue;
    }

    const pos = declPositions.get(targetFile)!.get(minified)!;
    let locations: readonly ts.RenameLocation[] | undefined;
    try {
      locations = service.findRenameLocations(targetFile, pos, false, false);
    } catch (err) {
      // One pathological symbol must not abort the whole rename pass — the
      // alternative is losing every later rename too.
      console.warn(
        `    skip (LS error): ${minified} → ${original} in ${engine.fileToOutputPath.get(targetFile)}: ${(err as Error).message.slice(0, 60)}`,
      );
      renamesSkipped++;
      continue;
    }
    if (!locations || locations.length === 0) {
      renamesSkipped++;
      continue;
    }

    for (const loc of locations) {
      const target = path.resolve(loc.fileName);
      if (!engine.texts.has(target)) continue;
      let arr = editsByFile.get(target);
      if (!arr) editsByFile.set(target, (arr = []));
      arr.push({
        start: loc.textSpan.start,
        end: loc.textSpan.start + loc.textSpan.length,
        newText: original,
      });
    }
    renamesResolved++;
  }

  return { editsByFile, renamesResolved, renamesSkipped };
}

/**
 * Run findRenameLocations for each (deduped) task and return every rename
 * location in ASSEMBLED-file coordinates. Shared by full + per-file renames so
 * the located positions are identical regardless of how many files we render.
 */
function runRenameQueries(
  engine: RenameEngine,
  renameTasks: Array<{ minified: string; original: string }>,
): { allEdits: Edit[]; renamesResolved: number; renamesSkipped: number } {
  const { service, virtualFileName, assembledPositions } = engine;
  const allEdits: Edit[] = [];
  let renamesResolved = 0;
  let renamesSkipped = 0;
  const processed = new Set<string>();

  for (const { minified, original } of renameTasks) {
    if (processed.has(minified)) continue;
    processed.add(minified);

    const pos = assembledPositions.get(minified);
    if (pos === undefined) {
      if (process.env.RENAME_VERBOSE) console.warn(`    skip (no decl): ${minified} → ${original}`);
      renamesSkipped++;
      continue;
    }

    const locations = service.findRenameLocations(virtualFileName, pos, false, false);
    if (!locations || locations.length === 0) {
      if (process.env.RENAME_VERBOSE) console.warn(`    skip (no locs): ${minified} → ${original} at pos ${pos}`);
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

  return { allEdits, renamesResolved, renamesSkipped };
}

/**
 * Apply a section's assembled-coordinate edits to its ORIGINAL on-disk file
 * (import/export lines intact) and return the rewritten code. Positions are
 * shifted by the import-line offset that was stripped during assembly.
 */
function applyEditsToSectionCode(originalCode: string, sec: RenameSection, localEdits: Edit[]): string {
  const importOffset = findCodeOffset(originalCode, sec.code);
  const sorted = [...localEdits].sort((a, b) => b.start - a.start);
  let result = originalCode;
  for (const edit of sorted) {
    result = result.slice(0, edit.start + importOffset) + edit.newText + result.slice(edit.end + importOffset);
  }
  return result;
}

/**
 * Post-pass: rewrite import/export specifier lines (stripped during assembly,
 * so the TS LS never touched them) to use the renamed identifiers.
 */
function updateImportExportSpecifiers(code: string, renameMap: Map<string, string>): { code: string; changed: boolean } {
  let changed = false;

  // Update export { minified1, minified2 } → export { original1, original2 }
  code = code.replace(
    /^(export\s+\{)([^}]+)(\};?)$/gm,
    (_match, prefix, names, suffix) => {
      const updated = names.replace(
        /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
        (name: string) => {
          if (JS_RESERVED.has(name)) return name;
          const orig = renameMap.get(name);
          if (orig) { changed = true; return orig; }
          return name;
        },
      );
      return prefix + updated + suffix;
    },
  );

  // Update import { minified } from './...' → import { original }
  // AND import { x as minified } from "pkg" → import { x as original }
  code = code.replace(
    /^(import\s+\{)([^}]+)(\}\s+from\s+['"][^'"]+['"];?)$/gm,
    (_match, prefix, names, suffix) => {
      const isRelative = suffix.match(/from\s+['"]\.\.?\//);
      const updated = names.replace(
        isRelative
          ? /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g
          : /\bas\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
        (match: string, name: string) => {
          if (JS_RESERVED.has(name)) return match;
          const orig = renameMap.get(name);
          if (orig) {
            changed = true;
            return isRelative ? orig : `as ${orig}`;
          }
          return match;
        },
      );
      return prefix + updated + suffix;
    },
  );

  return { code, changed };
}

/** Build the rename map (task renames + TS-LS cascading renames) for the
    import/export post-pass, from the resolved edits. */
function buildRenameMap(
  renameTasks: Array<{ minified: string; original: string }>,
  assembled: string,
  allEdits: Edit[],
): Map<string, string> {
  const renameMap = new Map<string, string>();
  for (const task of renameTasks) renameMap.set(task.minified, task.original);
  for (const edit of allEdits) {
    const oldText = assembled.slice(edit.start, edit.end);
    if (oldText !== edit.newText && oldText.match(/^[a-zA-Z_$]/) && !renameMap.has(oldText)) {
      renameMap.set(oldText, edit.newText);
    }
  }
  return renameMap;
}

/** Find which section contains an assembled-file offset (binary search). */
function sectionIndexForOffset(sections: RenameSection[], offset: number): number {
  let lo = 0, hi = sections.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sections[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Drop renames whose target name would collide with a top-level declaration that
 * KEEPS that name. All module sections are flattened into one scope, so a rename
 * X→Y is unsafe when another top-level decl is (or stays) named Y: the duplicate
 * `function Y(){}` makes JS hoisting pick the last one, silently rebinding live
 * references (e.g. a startup `config(en())` ended up calling an unrelated
 * module's `en` that pulls in a native addon). We let the identifier already
 * named Y keep it and revert the colliding rename — reverting also leaves that
 * symbol's own references on their original name, so they stay consistent.
 *
 * `declNames` is the set of every top-level declaration name in the assembled
 * (pre-rename) file. Identical inputs in the full-build and per-file paths ⇒
 * identical drops ⇒ no divergence.
 */
function dropCollidingRenames<T extends { minified: string; original: string }>(
  tasks: T[],
  declNames: Set<string>,
): T[] {
  const renamedFrom = new Map(tasks.map((t) => [t.minified, t.original]));
  const finalName = (d: string) => renamedFrom.get(d) ?? d;

  // Group every top-level decl by the name it will have after renaming.
  const byFinal = new Map<string, string[]>();
  for (const d of declNames) {
    const f = finalName(d);
    let g = byFinal.get(f);
    if (!g) byFinal.set(f, (g = []));
    g.push(d);
  }

  const drop = new Set<string>();
  for (const [name, decls] of byFinal) {
    if (decls.length <= 1) continue; // unique → safe
    // A decl literally named `name` (present in this group ⇒ it stays `name`)
    // owns the name; every other entry got renamed INTO it, so revert those.
    const owner = decls.includes(name) ? name : undefined;
    for (const d of decls) {
      if (d === owner) continue;
      if (renamedFrom.get(d) === name && d !== name) drop.add(d);
    }
    // No original owner: several renames target `name` from different sources —
    // ambiguous, so drop them all (mirrors the cross-file collision policy).
    if (!owner) for (const d of decls) drop.add(d);
  }

  if (drop.size) console.log(`  Dropped ${drop.size} renames colliding with existing top-level names`);
  return tasks.filter((t) => !drop.has(t.minified));
}

/**
 * Per-chunk collision filter, for the chunked format.
 *
 * The flat-scope rule above is far too strict here: chunks do NOT share a scope,
 * so `Y` existing in chunk A says nothing about whether X→Y is safe in chunk B.
 * Applying the flat rule to a chunked tree would drop essentially every rename,
 * because with 10,558 duplicated names almost every target name exists SOMEWHERE.
 *
 * The real hazard is per chunk: renaming X→Y inside a chunk that already has its
 * own top-level `Y` would shadow it there. So a task is dropped only if the chunk
 * being edited would end up with two top-level declarations of the same name.
 *
 * Only chunks that actually get edited are considered — i.e. the chunk each task
 * is applied to. A name clash in some unrelated chunk is not a collision here,
 * because that chunk keeps its own scope and is never touched.
 */
function dropCollidingRenamesPerChunk<T extends { minified: string; original: string; declFile?: string }>(
  tasks: T[],
  perChunkDecls: Map<string, Set<string>>,
): T[] {
  // Which chunk will each task edit? Mirrors the owner resolution in
  // runMultiFileRenameQueries, so the filter and the rename agree on the target.
  const declaringChunks = new Map<string, string[]>();
  for (const [chunk, decls] of perChunkDecls) {
    for (const d of decls) {
      let a = declaringChunks.get(d);
      if (!a) declaringChunks.set(d, (a = []));
      a.push(chunk);
    }
  }
  const targetChunk = (t: T): string | undefined => {
    if (t.declFile && perChunkDecls.get(t.declFile)?.has(t.minified)) return t.declFile;
    const c = declaringChunks.get(t.minified);
    return c && c.length === 1 ? c[0] : undefined;
  };

  // Group tasks by the chunk they edit, then apply the shadowing rule there.
  const byChunk = new Map<string, T[]>();
  for (const t of tasks) {
    const c = targetChunk(t);
    if (!c) continue;
    let a = byChunk.get(c);
    if (!a) byChunk.set(c, (a = []));
    a.push(t);
  }

  const drop = new Set<string>();
  for (const [chunk, chunkTasks] of byChunk) {
    const decls = perChunkDecls.get(chunk)!;
    const renamedHere = new Map(chunkTasks.map((t) => [t.minified, t.original]));
    const byFinal = new Map<string, string[]>();
    for (const d of decls) {
      const f = renamedHere.get(d) ?? d;
      let g = byFinal.get(f);
      if (!g) byFinal.set(f, (g = []));
      g.push(d);
    }
    for (const [name, group] of byFinal) {
      if (group.length <= 1) continue;
      const owner = group.includes(name) ? name : undefined;
      for (const d of group) {
        if (d === owner) continue;
        if (renamedHere.get(d) === name && d !== name) drop.add(d);
      }
      if (!owner) for (const d of group) drop.add(d);
    }
  }

  if (drop.size) {
    console.log(`  Dropped ${drop.size} renames colliding with a chunk's own top-level names`);
  }
  return tasks.filter((t) => !drop.has(t.minified));
}

/**
 * Scope-aware renaming for CHUNKED bundles, over the real per-chunk ESM graph.
 *
 * Same contract as renameWithLanguageService (its single-scope counterpart):
 * rewrite the files on disk and return the tasks actually applied. It differs
 * only in that edits arrive already grouped per file, so there is no assembled
 * coordinate space and no import-offset correction — the LS reports positions in
 * the real on-disk files, imports and all.
 */
function renameWithMultiFileService(
  projectDir: string,
  mapping: any,
  renameTasks: Array<{ minified: string; original: string; declFile: string }>,
  fileTexts: Map<string, string>,
  perChunkDecls: Map<string, Set<string>>,
): { totalRenames: number; fileRenames: Map<string, number>; effectiveTasks: Array<{ minified: string; original: string; declFile: string }> } {
  renameTasks = dropCollidingRenamesPerChunk(renameTasks, perChunkDecls);

  const engine = buildMultiFileEngine(projectDir, mapping, fileTexts);
  const { editsByFile, renamesResolved, renamesSkipped } = runMultiFileRenameQueries(engine, renameTasks);

  let locationCount = 0;
  for (const edits of editsByFile.values()) locationCount += edits.length;
  console.log(
    `  TS LS: ${renamesResolved} renames resolved (${locationCount} locations), ${renamesSkipped} skipped`,
  );

  let totalRenames = 0;
  const fileRenames = new Map<string, number>();
  for (const [absFile, edits] of editsByFile) {
    const outputPath = engine.fileToOutputPath.get(absFile);
    if (!outputPath) continue;
    const original = engine.texts.get(absFile)!;
    // Apply back-to-front so earlier offsets stay valid.
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let result = original;
    for (const e of sorted) {
      result = result.slice(0, e.start) + e.newText + result.slice(e.end);
    }
    fs.writeFileSync(path.join(projectDir, outputPath), result);
    fileRenames.set(outputPath, edits.length);
    totalRenames += edits.length;
  }

  return { totalRenames, fileRenames, effectiveTasks: renameTasks };
}

/**
 * Scope-aware renaming using TS Language Service on a single assembled file.
 * Concatenates all sections into ONE virtual file so TS understands scope/
 * shadowing without cross-file module resolution, renames every task, then maps
 * edits back to the split files. Returns the tasks actually applied (after
 * collision filtering) so callers can record an accurate rename map.
 */
function renameWithLanguageService(
  projectDir: string,
  mapping: any,
  renameTasks: Array<{ minified: string; original: string; declFile: string }>,
): { totalRenames: number; fileRenames: Map<string, number>; effectiveTasks: Array<{ minified: string; original: string; declFile: string }> } {
  const engine = buildRenameEngine(projectDir, mapping);
  const { sections, assembled } = engine;

  // Drop renames that would collide with an existing top-level name post-flatten.
  renameTasks = dropCollidingRenames(renameTasks, new Set(engine.assembledPositions.keys()));

  // Phase 4: resolve every rename's locations (assembled coordinates).
  const { allEdits, renamesResolved, renamesSkipped } = runRenameQueries(engine, renameTasks);
  console.log(
    `  TS LS: ${renamesResolved} renames resolved (${allEdits.length} locations), ${renamesSkipped} skipped`,
  );

  // Phase 5: map assembled positions back to sections and apply to split files.
  const editsBySection = new Map<number, Edit[]>();
  for (const edit of allEdits) {
    const idx = sectionIndexForOffset(sections, edit.start);
    const sec = sections[idx];
    if (!editsBySection.has(idx)) editsBySection.set(idx, []);
    editsBySection.get(idx)!.push({
      start: edit.start - sec.start,
      end: edit.end - sec.start,
      newText: edit.newText,
    });
  }

  let totalRenames = 0;
  const fileRenames = new Map<string, number>();
  for (const [secIdx, edits] of editsBySection) {
    const sec = sections[secIdx];
    const fullPath = path.join(projectDir, sec.outputPath);
    const result = applyEditsToSectionCode(fs.readFileSync(fullPath, "utf-8"), sec, edits);
    fs.writeFileSync(fullPath, result);
    fileRenames.set(sec.outputPath, edits.length);
    totalRenames += edits.length;
  }

  // Post-pass: update import/export specifiers across all sections.
  console.log("  Updating import/export specifiers...");
  const renameMap = buildRenameMap(renameTasks, assembled, allEdits);
  for (const sec of sections) {
    const fullPath = path.join(projectDir, sec.outputPath);
    const { code, changed } = updateImportExportSpecifiers(fs.readFileSync(fullPath, "utf-8"), renameMap);
    if (changed) fs.writeFileSync(fullPath, code);
  }

  return { totalRenames, fileRenames, effectiveTasks: renameTasks };
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
 * Pass 1: discover the rename task set (minified → original) for a project via
 * constraint/export-map/signature matching + anchor rules, then drop cross-file
 * collisions. Extracted so the whole-bundle rename and the per-file on-demand
 * rename use the IDENTICAL task set — a per-file render can never disagree with
 * the full build about what a name resolves to.
 */
function discoverRenameTasks(
  projectDir: string,
  sourceRefDir: string,
  mapping: any,
  db: RenameDB | null,
  noSourceRef: boolean,
): { filteredTasks: Array<{ minified: string; original: string; declFile: string }>; seenSize: number; collisions: number } {
  const renameTasks: Array<{ minified: string; original: string; declFile: string }> = [];
  const seen = new Map<string, string>(); // minified → original (dedup)

  for (const section of mapping.sections) {
    // No-source-ref mode: export maps (M_() helper calls) are self-contained
    // in the bundle, so harvest them from EVERY emitted module regardless of
    // whether it matched a source file. Skip all source-dependent matching.
    if (noSourceRef) {
      if (section.type !== "section") continue;
      const deobPath = path.join(projectDir, section.output_path);
      if (!fs.existsSync(deobPath)) continue;
      const exportMap = extractExportMap(fs.readFileSync(deobPath, "utf-8"));
      for (const [minified, original] of exportMap) {
        if (seen.has(minified) || !isValidBindingName(original)) continue;
        seen.set(minified, original);
        renameTasks.push({ minified, original, declFile: section.output_path });
      }
      continue;
    }

    if (!section.matched_source || section.confidence === "low") continue;

    const deobPath = path.join(projectDir, section.output_path);
    const sourcePath = path.join(sourceRefDir, section.matched_source);

    if (!fs.existsSync(deobPath) || !fs.existsSync(sourcePath)) continue;

    const deobCode = fs.readFileSync(deobPath, "utf-8");
    const sourceCode = fs.readFileSync(sourcePath, "utf-8");

    if (!process.env.ANCHOR_ONLY) {
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
      // Filter out JS reserved words as rename targets
      for (const m of constraintMatches) {
        if (seen.has(m.minified) || !isValidBindingName(m.original)) continue;
        seen.set(m.minified, m.original);
        renameTasks.push({
          minified: m.minified,
          original: m.original,
          declFile: section.output_path,
        });
      }

      for (const [minified, original] of legacyRenames) {
        if (seen.has(minified) || !isValidBindingName(original)) continue;
        seen.set(minified, original);
        renameTasks.push({
          minified,
          original,
          declFile: section.output_path,
        });
      }
    }
  }

  // Layer 0: User-defined anchor rules (highest priority)
  const anchorRulesPath = path.join(import.meta.dir, "../anchor-rules.json");
  const anchorMatches = applyAnchorRules(projectDir, anchorRulesPath);
  for (const m of anchorMatches) {
    if (seen.has(m.minified)) {
      if (process.env.RENAME_VERBOSE) console.warn(`    anchor skip (already seen): ${m.minified} → ${m.original} (existing: ${seen.get(m.minified)})`);
      continue;
    }
    // Anchors were the one admission path with NO validity guard. A typo'd or
    // keyword rule name would have emitted unparseable code with no warning.
    if (!isValidBindingName(m.original)) {
      console.warn(`    anchor skip (invalid identifier): ${m.minified} → ${m.original}`);
      continue;
    }
    seen.set(m.minified, m.original);
    renameTasks.push({ minified: m.minified, original: m.original, declFile: "__anchor__" });
  }

  // Filter cross-file collisions: if two different minified names from different
  // files map to the same original, both are ambiguous — drop them.
  const originalToMinified = new Map<string, { minified: string; declFile: string }[]>();
  for (const task of renameTasks) {
    if (!originalToMinified.has(task.original)) originalToMinified.set(task.original, []);
    originalToMinified.get(task.original)!.push(task);
  }
  const collisions = new Set<string>();
  for (const [original, tasks] of originalToMinified) {
    const uniqueFiles = new Set(tasks.map(t => t.declFile));
    if (uniqueFiles.size > 1) {
      const uniqueMinified = new Set(tasks.map(t => t.minified));
      if (uniqueMinified.size > 1) {
        // If an anchor claims this name, trust the anchor and drop conflicting entries
        const anchorTask = tasks.find(t => t.declFile === "__anchor__");
        if (anchorTask) {
          for (let i = renameTasks.length - 1; i >= 0; i--) {
            if (renameTasks[i].original === original && renameTasks[i].declFile !== "__anchor__") {
              renameTasks.splice(i, 1);
            }
          }
        } else {
          collisions.add(original);
        }
      }
    }
  }
  const filteredTasks = renameTasks.filter(t => !collisions.has(t.original));
  if (collisions.size > 0) {
    console.log(`  Filtered ${collisions.size} cross-file collisions`);
  }
  console.log(`  Discovered ${seen.size} unique renames → ${filteredTasks.length} after collision filter`);

  return { filteredTasks, seenSize: seen.size, collisions: collisions.size };
}

/**
 * Per-file on-demand rename. Builds the SAME assembled program as the full
 * rename (so TS binding/scope is identical), but only runs findRenameLocations
 * for the names that actually appear in the requested file — typically tens of
 * names instead of thousands. Returns the file's renamed source WITHOUT touching
 * any other file on disk.
 *
 * Correctness: every rename location that lands inside the target file has, by
 * definition, the pre-rename minified text at that spot — so that name appears
 * in the file and is therefore queried. Decl positions and the task set come
 * from the whole-bundle helpers, so the rendered bytes are identical to what the
 * full build would write for this file. (Used by the studio's resolved/split
 * source view and walk-jump to avoid the whole-bundle rebuild.)
 */
export function renameSingleFile(
  projectDir: string,
  mappingPath: string,
  targetOutputPath: string,
  opts?: { noSourceRef?: boolean },
): { code: string; renames: number } | null {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
  const noSourceRef = opts?.noSourceRef ?? !!process.env.NO_SOURCE_REF;

  let db: RenameDB | null = null;
  const { filteredTasks } = discoverRenameTasks(projectDir, "", mapping, db, noSourceRef);

  // A chunked tree cannot be assembled (it overflows the stack — see
  // hasSharedTopLevelScope), so render that one file from the per-chunk engine
  // instead. Same task set and same collision policy as the chunked full build,
  // so this file's bytes still match what the full build would write for it.
  const fileTexts = new Map<string, string>();
  const perChunkDecls = new Map<string, Set<string>>();
  for (const section of mapping.sections) {
    const p = path.join(projectDir, section.output_path);
    if (!fs.existsSync(p)) continue;
    const code = fs.readFileSync(p, "utf-8");
    fileTexts.set(section.output_path, code);
    perChunkDecls.set(section.output_path, topLevelDeclNames(code, p));
  }

  if (!hasSharedTopLevelScope(perChunkDecls)) {
    if (!fileTexts.has(targetOutputPath)) return null;
    const safeTasks = dropCollidingRenamesPerChunk(filteredTasks, perChunkDecls);
    const mfEngine = buildMultiFileEngine(projectDir, mapping, fileTexts);
    const targetAbs = mfEngine.outputPathToFile.get(targetOutputPath);
    if (!targetAbs) return null;

    // Only names that textually appear in this file can produce a location in it.
    const originalCode = fileTexts.get(targetOutputPath)!;
    const present = new Set<string>();
    for (const m of originalCode.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) present.add(m[0]);
    const tasksForFile = safeTasks.filter((t) => present.has(t.minified));

    const { editsByFile } = runMultiFileRenameQueries(mfEngine, tasksForFile);
    const edits = editsByFile.get(targetAbs) ?? [];
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let out = originalCode;
    for (const e of sorted) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
    return { code: out, renames: edits.length };
  }

  const engine = buildRenameEngine(projectDir, mapping);
  const { sections, sectionByPath, assembled } = engine;

  // Apply the SAME collision filter the full build does (on the full task set,
  // before restricting to this file) so per-file output can't diverge.
  const safeTasks = dropCollidingRenames(filteredTasks, new Set(engine.assembledPositions.keys()));

  const secIdx = sectionByPath.get(targetOutputPath);
  if (secIdx === undefined) return null;
  const target = sections[secIdx];
  const rangeStart = target.start;
  const rangeEnd = target.start + target.length;

  const fullPath = path.join(projectDir, targetOutputPath);
  const originalCode = fs.readFileSync(fullPath, "utf-8");

  // Names that textually appear in the target file — only these can produce a
  // rename location inside it (body edits) or need rewriting in its import/
  // export lines. Scan the FULL original file so import-only names are covered.
  const present = new Set<string>();
  for (const m of originalCode.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) present.add(m[0]);
  const tasksForFile = safeTasks.filter((t) => present.has(t.minified));

  const { allEdits } = runRenameQueries(engine, tasksForFile);

  // Keep only locations inside the target section; convert to local offsets.
  const localEdits: Edit[] = [];
  for (const edit of allEdits) {
    if (edit.start >= rangeStart && edit.start < rangeEnd) {
      localEdits.push({ start: edit.start - rangeStart, end: edit.end - rangeStart, newText: edit.newText });
    }
  }

  let code = applyEditsToSectionCode(originalCode, target, localEdits);

  // Import/export specifier post-pass for this one file (same map source as full).
  const renameMap = buildRenameMap(tasksForFile, assembled, allEdits);
  code = updateImportExportSpecifiers(code, renameMap).code;

  return { code, renames: localEdits.length };
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
  opts?: { noSourceRef?: boolean },
): { totalRenames: number; fileRenames: Map<string, number> } {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
  const noSourceRef = opts?.noSourceRef ?? !!process.env.NO_SOURCE_REF;

  // Load rename DB if provided
  let db: RenameDB | null = null;
  if (dbPath && fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  }

  // Pass 1: Discover the rename task set (shared with the per-file path).
  const { filteredTasks } = discoverRenameTasks(projectDir, sourceRefDir, mapping, db, noSourceRef);

  // Which scope model does this tree have? Read every file once and measure it,
  // rather than trusting a version number — the studio calls this with no
  // version context at all. See hasSharedTopLevelScope for the measurements.
  const fileTexts = new Map<string, string>();
  const perChunkDecls = new Map<string, Set<string>>();
  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;
    const code = fs.readFileSync(fullPath, "utf-8");
    fileTexts.set(section.output_path, code);
    perChunkDecls.set(section.output_path, topLevelDeclNames(code, fullPath));
  }
  const sharedScope = hasSharedTopLevelScope(perChunkDecls);
  console.log(
    `  Scope model: ${sharedScope ? "single shared top-level scope (monolithic) — assembling" : "per-chunk scopes (chunked ESM) — multi-file program"}`,
  );

  // Pass 2: Scope-aware renaming via TS Language Service (also drops collisions).
  //
  // Monolithic bundles keep the original single-file engine unchanged: it is what
  // the live fleet binary is built from, and its output is the regression gate.
  // Chunked bundles get the per-chunk module-graph engine, because concatenating
  // them overflows the stack (see hasSharedTopLevelScope).
  const result = sharedScope
    ? renameWithLanguageService(projectDir, mapping, filteredTasks)
    : renameWithMultiFileService(projectDir, mapping, filteredTasks, fileTexts, perChunkDecls);

  // Write _renames.json from the tasks ACTUALLY applied (collision-safe), so the
  // patch-authoring map matches the emitted output.
  const renamesByFile: Record<string, Record<string, string>> = {};
  for (const task of result.effectiveTasks) {
    const f = task.declFile === "__anchor__" ? "__anchor__" : task.declFile;
    if (!renamesByFile[f]) renamesByFile[f] = {};
    renamesByFile[f][task.minified] = task.original;
  }
  fs.writeFileSync(
    path.join(projectDir, "_renames.json"),
    JSON.stringify({ version: mapping.version ?? "unknown", files: renamesByFile }, null, 2),
  );

  return { totalRenames: result.totalRenames, fileRenames: result.fileRenames };
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
  const noSourceRefIdx = args.indexOf("--no-source-ref");
  const noSourceRef = noSourceRefIdx !== -1;
  if (noSourceRef) args.splice(noSourceRefIdx, 1);

  if (args.length < 3) {
    console.log("Usage: bun run src/renamer.ts <project_dir> <source_ref_dir> <mapping.json> [rename-db.json] [--no-source-ref]");
    process.exit(1);
  }

  const [projectDir, sourceRefDir, mappingPath, dbPath] = args;
  console.log(`Renaming identifiers${noSourceRef ? " (no-source-ref: export maps + anchors only)" : ""}...`);
  const { totalRenames, fileRenames } = renameProject(projectDir, sourceRefDir, mappingPath, dbPath, { noSourceRef });

  console.log(`\nRenamed ${totalRenames} identifiers across ${fileRenames.size} files`);
  const sorted = [...fileRenames.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\nTop 20 files by rename count:");
  for (const [file, count] of sorted.slice(0, 20)) {
    console.log(`  ${String(count).padStart(4)} renames  ${file}`);
  }
}
