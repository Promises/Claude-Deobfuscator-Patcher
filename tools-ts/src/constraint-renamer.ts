/**
 * Inside-out constraint propagation renamer.
 *
 * Instead of relying on export maps and top-level declaration scanning,
 * this renamer identifies functions/classes by their structural patterns:
 * - Unique string literals
 * - Property access patterns (`.sessionId`, `.clientType`)
 * - Numeric constants in specific contexts (128, -1)
 * - Class structure (method names, property combos)
 * - Call graph relationships
 *
 * Works across versions because these patterns survive minification.
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";

// ── Fingerprint Types ────────────────────────────────────────────────────────

export interface FunctionFingerprint {
  name: string;
  node: ts.Node; // AST node for position tracking
  paramCount: number;
  isAsync: boolean;
  isGenerator: boolean;
  strings: string[];
  numbers: number[];
  propertyAccesses: PropertyAccess[];
  calledFunctions: string[];
  bodyText: string; // raw body for fallback matching
}

export interface PropertyAccess {
  object: string; // variable being accessed
  property: string; // property name
}

export interface ClassFingerprint {
  name: string;
  node: ts.Node;
  methods: string[];
  properties: string[];
  methodFingerprints: Map<string, FunctionFingerprint>;
}

export interface MatchResult {
  minified: string;
  original: string;
  confidence: number;
  reason: string;
}

// ── Fingerprint Extraction ───────────────────────────────────────────────────

function extractFunctionFingerprints(
  code: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.JS,
): FunctionFingerprint[] {
  const sf = ts.createSourceFile("mod.js", code, ts.ScriptTarget.Latest, true, scriptKind);
  const fps: FunctionFingerprint[] = [];

  function extractBody(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): FunctionFingerprint | null {
    const name =
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
        ? node.name?.text
        : undefined;
    if (!name) return null;

    const strings: string[] = [];
    const numbers: number[] = [];
    const propertyAccesses: PropertyAccess[] = [];
    const calledFunctions: string[] = [];

    function walk(n: ts.Node) {
      if (ts.isStringLiteral(n)) {
        strings.push(n.text);
      }
      if (ts.isNumericLiteral(n)) {
        const val = Number(n.text);
        if (!isNaN(val)) numbers.push(val);
      }
      if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) {
        numbers.push(-Number(n.operand.text));
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        propertyAccesses.push({
          object: n.expression.text,
          property: n.name.text,
        });
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        calledFunctions.push(n.expression.text);
      }
      // yield* f() — treat as a call for propagation purposes
      if (ts.isYieldExpression(n) && n.asteriskToken && n.expression && ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
        calledFunctions.push(n.expression.expression.text);
      }
      ts.forEachChild(n, walk);
    }

    if (node.body) walk(node.body);

    const bodyText = node.body ? code.slice(node.body.pos, node.body.end) : "";

    return {
      name,
      node,
      paramCount: node.parameters.length,
      isAsync: !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      isGenerator: !!node.asteriskToken,
      strings,
      numbers,
      propertyAccesses,
      calledFunctions,
      bodyText,
    };
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const fp = extractBody(node);
      if (fp) fps.push(fp);
    }
    // Also handle var x = function() {} patterns
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer))
        ) {
          const init = decl.initializer;
          const strings: string[] = [];
          const numbers: number[] = [];
          const propertyAccesses: PropertyAccess[] = [];
          const calledFunctions: string[] = [];

          function walk(n: ts.Node) {
            if (ts.isStringLiteral(n)) strings.push(n.text);
            if (ts.isNumericLiteral(n)) numbers.push(Number(n.text));
            if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
              propertyAccesses.push({ object: n.expression.text, property: n.name.text });
            }
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
              calledFunctions.push(n.expression.text);
            }
            ts.forEachChild(n, walk);
          }
          if (init.body) walk(init.body);

          fps.push({
            name: decl.name.text,
            node: decl,
            paramCount: init.parameters.length,
            isAsync: !!init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
            isGenerator: ts.isFunctionExpression(init) ? !!init.asteriskToken : false,
            strings,
            numbers,
            propertyAccesses,
            calledFunctions,
            bodyText: init.body ? code.slice(init.body.pos, init.body.end) : "",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return fps;
}

function extractClassFingerprints(
  code: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.JS,
): ClassFingerprint[] {
  const sf = ts.createSourceFile("mod.js", code, ts.ScriptTarget.Latest, true, scriptKind);
  const classes: ClassFingerprint[] = [];

  function visit(node: ts.Node) {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      const methods: string[] = [];
      const properties: string[] = [];
      const methodFps = new Map<string, FunctionFingerprint>();

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const mname = member.name.text;
          methods.push(mname);

          // Extract method fingerprint
          const strings: string[] = [];
          const numbers: number[] = [];
          const propertyAccesses: PropertyAccess[] = [];
          const calledFunctions: string[] = [];

          function walk(n: ts.Node) {
            if (ts.isStringLiteral(n)) strings.push(n.text);
            if (ts.isNumericLiteral(n)) numbers.push(Number(n.text));
            if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
              propertyAccesses.push({ object: n.expression.text, property: n.name.text });
            }
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
              calledFunctions.push(n.expression.text);
            }
            ts.forEachChild(n, walk);
          }
          if (member.body) walk(member.body);

          methodFps.set(mname, {
            name: mname,
            node: member,
            paramCount: member.parameters.length,
            isAsync: !!member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
            isGenerator: !!member.asteriskToken,
            strings,
            numbers,
            propertyAccesses,
            calledFunctions,
            bodyText: member.body ? code.slice(member.body.pos, member.body.end) : "",
          });
        }
        if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          properties.push(member.name.text);
        }
        if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methods.push(member.name.text);
        }
      }

      classes.push({
        name: node.name.text,
        node,
        methods,
        properties,
        methodFingerprints: methodFps,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return classes;
}

/**
 * Extract M_() / c1() / any export map helper entries.
 */
function extractExportMap(code: string): Map<string, string> {
  const sf = ts.createSourceFile("mod.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const map = new Map<string, string>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.arguments.length === 2 &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      const obj = node.arguments[1] as ts.ObjectLiteralExpression;
      for (const prop of obj.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          ts.isArrowFunction(prop.initializer) &&
          ts.isIdentifier(prop.initializer.body)
        ) {
          map.set((prop.initializer.body as ts.Identifier).text, prop.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return map;
}

// ── Anchor Matching ──────────────────────────────────────────────────────────

/**
 * Find functions matched by unique string literals.
 * A string is "unique" if it appears in exactly 1 deob function AND 1 source function.
 */
function matchByUniqueStrings(
  deobFps: FunctionFingerprint[],
  sourceFps: FunctionFingerprint[],
): MatchResult[] {
  // Build string → functions maps
  const deobStringMap = new Map<string, string[]>();
  for (const fp of deobFps) {
    for (const s of fp.strings) {
      if (s.length < 3) continue; // skip short strings
      if (!deobStringMap.has(s)) deobStringMap.set(s, []);
      deobStringMap.get(s)!.push(fp.name);
    }
  }

  const sourceStringMap = new Map<string, string[]>();
  for (const fp of sourceFps) {
    for (const s of fp.strings) {
      if (s.length < 3) continue;
      if (!sourceStringMap.has(s)) sourceStringMap.set(s, []);
      sourceStringMap.get(s)!.push(fp.name);
    }
  }

  const results: MatchResult[] = [];
  for (const [str, deobNames] of deobStringMap) {
    if (deobNames.length !== 1) continue;
    const sourceNames = sourceStringMap.get(str);
    if (!sourceNames || sourceNames.length !== 1) continue;

    results.push({
      minified: deobNames[0],
      original: sourceNames[0],
      confidence: 100,
      reason: `unique string: "${str.slice(0, 40)}"`,
    });
  }

  return results;
}

/**
 * Identify the STATE variable by finding the object with the most
 * property accesses from simple getter/setter functions.
 * Then match getters/setters by the property they access.
 */
function matchStateGettersSetters(
  deobFps: FunctionFingerprint[],
  sourceFps: FunctionFingerprint[],
): { stateVar: string | null; matches: MatchResult[] } {
  // Find the most-accessed object variable (likely STATE)
  const objectAccessCounts = new Map<string, number>();
  for (const fp of deobFps) {
    for (const pa of fp.propertyAccesses) {
      objectAccessCounts.set(pa.object, (objectAccessCounts.get(pa.object) || 0) + 1);
    }
  }

  // The STATE object is accessed by 100+ functions
  let stateVar: string | null = null;
  let maxCount = 0;
  for (const [obj, count] of objectAccessCounts) {
    if (count > maxCount) {
      maxCount = count;
      stateVar = obj;
    }
  }

  if (!stateVar || maxCount < 20) {
    return { stateVar: null, matches: [] };
  }

  // Find the STATE variable name in source (typically "STATE")
  const sourceObjectCounts = new Map<string, number>();
  for (const fp of sourceFps) {
    for (const pa of fp.propertyAccesses) {
      sourceObjectCounts.set(pa.object, (sourceObjectCounts.get(pa.object) || 0) + 1);
    }
  }

  let sourceStateVar: string | null = null;
  let sourceMaxCount = 0;
  for (const [obj, count] of sourceObjectCounts) {
    if (count > sourceMaxCount) {
      sourceMaxCount = count;
      sourceStateVar = obj;
    }
  }

  if (!sourceStateVar) return { stateVar, matches: [] };

  // Build property → function maps for simple getters/setters
  // A getter: function f() { return STATE.propName; }
  // A setter: function f(A) { STATE.propName = A; }
  const deobGetters = new Map<string, string>(); // property → function name
  const deobSetters = new Map<string, string>();

  for (const fp of deobFps) {
    const stateAccesses = fp.propertyAccesses.filter((pa) => pa.object === stateVar);
    if (stateAccesses.length === 1 && fp.propertyAccesses.length <= 2) {
      const prop = stateAccesses[0].property;
      if (fp.paramCount === 0 && fp.calledFunctions.length === 0) {
        deobGetters.set(prop, fp.name);
      } else if (fp.paramCount === 1 && fp.calledFunctions.length === 0) {
        deobSetters.set(prop, fp.name);
      }
    }
  }

  const sourceGetters = new Map<string, string>();
  const sourceSetters = new Map<string, string>();

  for (const fp of sourceFps) {
    const stateAccesses = fp.propertyAccesses.filter((pa) => pa.object === sourceStateVar);
    if (stateAccesses.length === 1 && fp.propertyAccesses.length <= 2) {
      const prop = stateAccesses[0].property;
      if (fp.paramCount === 0 && fp.calledFunctions.length === 0) {
        sourceGetters.set(prop, fp.name);
      } else if (fp.paramCount === 1 && fp.calledFunctions.length === 0) {
        sourceSetters.set(prop, fp.name);
      }
    }
  }

  // Match getters by property name
  const matches: MatchResult[] = [];
  for (const [prop, deobName] of deobGetters) {
    const sourceName = sourceGetters.get(prop);
    if (sourceName) {
      matches.push({
        minified: deobName,
        original: sourceName,
        confidence: 95,
        reason: `getter: ${sourceStateVar}.${prop}`,
      });
    }
  }

  for (const [prop, deobName] of deobSetters) {
    const sourceName = sourceSetters.get(prop);
    if (sourceName) {
      matches.push({
        minified: deobName,
        original: sourceName,
        confidence: 95,
        reason: `setter: ${sourceStateVar}.${prop}`,
      });
    }
  }

  return { stateVar, matches };
}

/**
 * Match classes by method name overlap + property combos.
 */
function matchClasses(
  deobClasses: ClassFingerprint[],
  sourceClasses: ClassFingerprint[],
): MatchResult[] {
  // Score all pairs, then do greedy 1:1 assignment
  const candidates: Array<{ deob: string; source: string; score: number }> = [];

  for (const dc of deobClasses) {
    const deobMethods = new Set(dc.methods);
    const deobProps = new Set(dc.properties);

    for (const sc of sourceClasses) {
      const methodOverlap = sc.methods.filter((m) => deobMethods.has(m)).length;
      const propOverlap = sc.properties.filter((p) => deobProps.has(p)).length;

      // Bonus: check method fingerprints for distinctive patterns
      let patternBonus = 0;
      for (const [mname, mfp] of dc.methodFingerprints) {
        const srcMfp = sc.methods.includes(mname) ? true : false;
        if (srcMfp) {
          // Method exists in both — check for distinctive numbers/patterns
          if (mfp.numbers.includes(128)) patternBonus += 5;
          if (mfp.strings.some((s) => s.length > 5)) patternBonus += 2;
        }
      }

      const score = methodOverlap * 3 + propOverlap * 2 + patternBonus;
      if (score >= 4) {
        candidates.push({ deob: dc.name, source: sc.name, score });
      }
    }
  }

  // Greedy 1:1 assignment — highest score wins
  candidates.sort((a, b) => b.score - a.score);
  const usedDeob = new Set<string>();
  const usedSource = new Set<string>();
  const results: MatchResult[] = [];

  for (const c of candidates) {
    if (usedDeob.has(c.deob) || usedSource.has(c.source)) continue;
    usedDeob.add(c.deob);
    usedSource.add(c.source);
    results.push({
      minified: c.deob,
      original: c.source,
      confidence: Math.min(90, 70 + c.score),
      reason: `class structure match (score: ${c.score})`,
    });
  }

  return results;
}

/**
 * Propagation: use resolved names to find callees.
 * If a resolved function calls an unresolved function,
 * and the source function calls a known function, match them.
 */
function propagateFromCalls(
  resolved: Map<string, string>,
  deobFps: FunctionFingerprint[],
  sourceFps: FunctionFingerprint[],
): MatchResult[] {
  const results: MatchResult[] = [];
  const deobByName = new Map(deobFps.map((fp) => [fp.name, fp]));
  const sourceByName = new Map(sourceFps.map((fp) => [fp.name, fp]));

  // Reverse map: original → minified
  const reverseResolved = new Map<string, string>();
  for (const [min, orig] of resolved) reverseResolved.set(orig, min);

  for (const [minified, original] of resolved) {
    const deobFp = deobByName.get(minified);
    const sourceFp = sourceByName.get(original);
    if (!deobFp || !sourceFp) continue;

    // For each call in the source function
    for (let i = 0; i < sourceFp.calledFunctions.length; i++) {
      const sourceCallee = sourceFp.calledFunctions[i];
      if (reverseResolved.has(sourceCallee)) continue; // already resolved

      // Find the corresponding call in the deob function
      // Simple approach: if the source calls exactly N unresolved functions
      // and the deob calls exactly N unresolved functions, match by position
      const unresolvedSourceCalls = sourceFp.calledFunctions.filter(
        (c) => !reverseResolved.has(c),
      );
      const unresolvedDeobCalls = deobFp.calledFunctions.filter(
        (c) => !resolved.has(c),
      );

      if (unresolvedSourceCalls.length === 1 && unresolvedDeobCalls.length === 1) {
        results.push({
          minified: unresolvedDeobCalls[0],
          original: unresolvedSourceCalls[0],
          confidence: 80,
          reason: `sole unresolved callee in ${original}`,
        });
      }
    }
  }

  return results;
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export function constraintMatch(
  deobCode: string,
  sourceCode: string,
  sourcePath: string,
): { matches: MatchResult[]; exportMap: Map<string, string> } {
  const scriptKind = sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

  // Extract fingerprints
  const deobFuncs = extractFunctionFingerprints(deobCode);
  const sourceFuncs = extractFunctionFingerprints(sourceCode, scriptKind);
  const deobClasses = extractClassFingerprints(deobCode);
  const sourceClasses = extractClassFingerprints(sourceCode, scriptKind);
  const exportMap = extractExportMap(deobCode);

  const allMatches: MatchResult[] = [];
  const resolved = new Map<string, string>();

  // Layer 1: Unique string anchors
  const stringMatches = matchByUniqueStrings(deobFuncs, sourceFuncs);
  for (const m of stringMatches) {
    if (!resolved.has(m.minified)) {
      resolved.set(m.minified, m.original);
      allMatches.push(m);
    }
  }

  // Layer 2: State getters/setters by property name
  const { stateVar, matches: stateMatches } = matchStateGettersSetters(deobFuncs, sourceFuncs);
  for (const m of stateMatches) {
    if (!resolved.has(m.minified)) {
      resolved.set(m.minified, m.original);
      allMatches.push(m);
    }
  }

  // Layer 3: Class matching
  const classMatches = matchClasses(deobClasses, sourceClasses);
  for (const m of classMatches) {
    if (!resolved.has(m.minified)) {
      resolved.set(m.minified, m.original);
      allMatches.push(m);
    }
  }

  // Layer 4: Propagation (iterate until stable)
  for (let round = 0; round < 5; round++) {
    const newMatches = propagateFromCalls(resolved, deobFuncs, sourceFuncs);
    let added = 0;
    for (const m of newMatches) {
      if (!resolved.has(m.minified)) {
        resolved.set(m.minified, m.original);
        allMatches.push(m);
        added++;
      }
    }
    if (added === 0) break;
  }

  // Layer 5: Export map validation + gap filling
  let confirmed = 0;
  let conflicts = 0;
  let gapFilled = 0;
  for (const [minified, original] of exportMap) {
    const existing = resolved.get(minified);
    if (existing === original) {
      confirmed++;
    } else if (existing && existing !== original) {
      conflicts++;
      if (process.env.CONSTRAINT_VERBOSE)
        console.warn(`  CONFLICT: ${minified} → constraint says "${existing}" but export map says "${original}"`);
    } else {
      // Not yet resolved — use export map as fallback
      resolved.set(minified, original);
      allMatches.push({
        minified,
        original,
        confidence: 75,
        reason: "export map (fallback)",
      });
      gapFilled++;
    }
  }

  if (process.env.CONSTRAINT_VERBOSE) {
    console.log(`  Constraint matching: ${allMatches.length} total`);
    console.log(`    Unique strings: ${stringMatches.length}`);
    console.log(`    State getters/setters: ${stateMatches.length}${stateVar ? ` (var: ${stateVar})` : ""}`);
    console.log(`    Classes: ${classMatches.length}`);
    console.log(`    Propagated: ${allMatches.length - stringMatches.length - stateMatches.length - classMatches.length - gapFilled}`);
    console.log(`    Export map fallback: ${gapFilled}`);
    console.log(`    Export map confirmed: ${confirmed}, conflicts: ${conflicts}`);
  }

  return { matches: allMatches, exportMap };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: bun run src/constraint-renamer.ts <deob_file.js> <source_file.ts>");
    process.exit(1);
  }

  const [deobPath, sourcePath] = args;
  const deobCode = fs.readFileSync(deobPath, "utf-8");
  const sourceCode = fs.readFileSync(sourcePath, "utf-8");

  console.log(`Constraint matching: ${path.basename(deobPath)} ↔ ${path.basename(sourcePath)}`);
  const { matches, exportMap } = constraintMatch(deobCode, sourceCode, sourcePath);

  console.log(`\nResolved ${matches.length} identifiers:`);

  // Group by confidence
  const byConfidence = new Map<number, MatchResult[]>();
  for (const m of matches) {
    const tier = m.confidence >= 95 ? 95 : m.confidence >= 80 ? 80 : 75;
    if (!byConfidence.has(tier)) byConfidence.set(tier, []);
    byConfidence.get(tier)!.push(m);
  }

  for (const [conf, ms] of [...byConfidence.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`\n  Confidence ${conf}%+ (${ms.length}):`);
    for (const m of ms.slice(0, 15)) {
      console.log(`    ${m.minified.padEnd(8)} → ${m.original.padEnd(40)} [${m.reason}]`);
    }
    if (ms.length > 15) console.log(`    ... and ${ms.length - 15} more`);
  }

  // Report coverage vs export map
  const exportNames = new Set(exportMap.values());
  const resolvedNames = new Set(matches.map((m) => m.original));
  const covered = [...exportNames].filter((n) => resolvedNames.has(n));
  console.log(`\nExport map coverage: ${covered.length}/${exportNames.size} (${((covered.length / exportNames.size) * 100).toFixed(0)}%)`);
}
