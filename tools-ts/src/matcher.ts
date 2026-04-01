/**
 * AST-powered module matcher — matches minified bundle modules to source files.
 *
 * Uses the TypeScript compiler API to parse each module and extract:
 * - All string literals (not just regex-guessed ones)
 * - Property/method access chains
 * - Class definitions with their method lists
 * - Function signatures (param counts)
 * - Call graph (what functions each module calls)
 * - require() targets
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { SignatureDB, FileSignature } from "./signatures";

export interface ModuleFingerprint {
  moduleName: string;
  index: number;
  kind: string;
  size: number;
  strings: Set<string>;
  propertyAccesses: Set<string>;
  methodCalls: Set<string>;
  requires: Set<string>;
  classMethodSets: Array<Set<string>>; // methods per class found in module
  functionCount: number;
  paramCounts: number[]; // param counts of top-level functions
}

export interface MatchResult {
  module: string;
  sourceFile: string;
  score: number;
  secondBestScore: number;
  margin: number;
  confidence: "high" | "medium" | "low" | "noise";
  details: Record<string, number>;
  moduleKind: string;
  moduleSize: number;
  moduleIndex: number;
}

export interface MatchOutput {
  totalModules: number;
  matched: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  unmatched: number;
  matches: MatchResult[];
  unmatchedModules: MatchResult[];
}

function extractModuleFingerprint(
  code: string,
  moduleName: string,
  index: number,
  kind: string
): ModuleFingerprint {
  const strings = new Set<string>();
  const propertyAccesses = new Set<string>();
  const methodCalls = new Set<string>();
  const requires = new Set<string>();
  const classMethodSets: Array<Set<string>> = [];
  const paramCounts: number[] = [];
  let functionCount = 0;

  // Common built-in properties to exclude
  const builtins = new Set([
    "prototype", "length", "name", "constructor", "call", "apply", "bind",
    "toString", "valueOf", "hasOwnProperty", "push", "pop", "shift",
    "unshift", "slice", "splice", "map", "filter", "reduce", "forEach",
    "find", "findIndex", "indexOf", "includes", "join", "split", "replace",
    "match", "test", "trim", "toLowerCase", "toUpperCase", "startsWith",
    "endsWith", "keys", "values", "entries", "from", "assign", "create",
    "defineProperty", "freeze", "parse", "stringify", "resolve", "reject",
    "then", "catch", "finally", "next", "done", "value", "default",
    "exports", "module", "require", "delete", "set", "get", "has",
    "clear", "size", "add", "emit", "once", "write", "read", "end",
    "close", "error", "data", "type", "message", "status", "code",
    "log", "warn", "info", "debug", "trace",
  ]);

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      `${moduleName}.js`,
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
  } catch {
    return {
      moduleName, index, kind, size: code.length,
      strings, propertyAccesses, methodCalls, requires,
      classMethodSets, functionCount, paramCounts,
    };
  }

  function visit(node: ts.Node) {
    // String literals
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.length >= 4) strings.add(node.text);
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      if (node.text.trim().length >= 4) strings.add(node.text.trim());
    }

    // Property access: x.foo
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name.length >= 2 && !builtins.has(name)) {
        propertyAccesses.add(name);
      }
      // Method calls: x.foo(...)
      if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        methodCalls.add(name);
      }
    }

    // require() calls
    if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])) {
      requires.add(node.arguments[0].text);
    }

    // Class declarations — extract method names
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const methods = new Set<string>();
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methods.add(member.name.text);
        }
        if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methods.add(member.name.text);
        }
      }
      if (methods.size >= 2) classMethodSets.push(methods);
    }

    // Function declarations — count params
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      functionCount++;
      paramCounts.push(node.parameters.length);
    }
    if (ts.isArrowFunction(node)) {
      functionCount++;
      paramCounts.push(node.parameters.length);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    moduleName, index, kind, size: code.length,
    strings, propertyAccesses, methodCalls, requires,
    classMethodSets, functionCount, paramCounts,
  };
}

function scoreMatch(fp: ModuleFingerprint, sig: FileSignature): { score: number; details: Record<string, number> } {
  const details: Record<string, number> = {};
  let score = 0;

  const srcUnique = new Set(sig.uniqueStrings);
  const srcRare = new Set(sig.rareStrings);
  const srcErrors = new Set(sig.errorStrings);
  const srcAll = new Set(sig.strings);
  const srcMethods = new Set(sig.methods);
  const srcProps = new Set(sig.properties);
  const srcExports = new Set(sig.exports);
  const srcClasses = new Set(sig.classNames);

  // String matches
  let uniqueHits = 0, rareHits = 0, errorHits = 0, generalHits = 0;
  for (const s of fp.strings) {
    if (srcUnique.has(s)) uniqueHits++;
    if (srcRare.has(s)) rareHits++;
    if (srcErrors.has(s)) errorHits++;
    if (srcAll.has(s)) generalHits++;
  }

  score += uniqueHits * 10;
  score += rareHits * 5;
  score += errorHits * 20;
  score += generalHits * 1;
  details.uniqueStringHits = uniqueHits;
  details.rareStringHits = rareHits;
  details.errorStringHits = errorHits;
  details.generalStringHits = generalHits;

  // Method/property matches (from property access in minified code)
  let methodHits = 0, propHits = 0, exportHits = 0;
  for (const p of fp.propertyAccesses) {
    if (srcMethods.has(p)) methodHits++;
    if (srcProps.has(p)) propHits++;
    if (srcExports.has(p)) exportHits++;
  }
  for (const p of fp.methodCalls) {
    if (srcMethods.has(p)) methodHits++;
  }

  score += methodHits * 3;
  score += propHits * 2;
  score += exportHits * 4;
  details.methodHits = methodHits;
  details.propertyHits = propHits;
  details.exportHits = exportHits;

  // Class method set matching — if a module has a class with methods A,B,C
  // and the source file has those same methods, strong signal
  for (const classMethodSet of fp.classMethodSets) {
    let classMatches = 0;
    for (const m of classMethodSet) {
      if (srcMethods.has(m) || srcProps.has(m)) classMatches++;
    }
    if (classMatches >= 3) {
      score += classMatches * 8;
      details.classMethodHits = (details.classMethodHits || 0) + classMatches;
    }
  }

  // Require matches
  let reqHits = 0;
  for (const r of fp.requires) {
    if (sig.imports.includes(r)) reqHits++;
  }
  score += reqHits * 8;
  details.requireHits = reqHits;

  return { score, details };
}

export function matchModules(
  signaturesPath: string,
  modulesDir: string,
  outputPath?: string
): MatchOutput {
  console.log(`Loading signatures from ${signaturesPath}...`);
  const sigDB: SignatureDB = JSON.parse(fs.readFileSync(signaturesPath, "utf-8"));
  console.log(`  ${Object.keys(sigDB.signatures).length} source file signatures`);

  console.log(`Building module fingerprints from ${modulesDir}...`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(modulesDir, "_manifest.json"), "utf-8")
  );

  const fingerprints: ModuleFingerprint[] = [];
  for (const section of manifest.sections) {
    if (section.type !== "section") continue;
    const code = fs.readFileSync(path.join(modulesDir, section.filename), "utf-8");
    fingerprints.push(
      extractModuleFingerprint(code, section.moduleName || section.module_name, section.index, section.moduleKind || section.module_kind)
    );
  }
  console.log(`  ${fingerprints.length} module fingerprints`);

  console.log("Scoring matches...");
  const allScores: MatchResult[] = [];

  for (const fp of fingerprints) {
    let bestScore = 0, bestSource = "", bestDetails: Record<string, number> = {};
    let secondBest = 0;

    for (const [srcPath, sig] of Object.entries(sigDB.signatures)) {
      const { score, details } = scoreMatch(fp, sig);
      if (score > bestScore) {
        secondBest = bestScore;
        bestScore = score;
        bestSource = srcPath;
        bestDetails = details;
      } else if (score > secondBest) {
        secondBest = score;
      }
    }

    if (bestScore > 0) {
      const margin = bestScore - secondBest;
      let confidence: "high" | "medium" | "low" | "noise";
      if (bestScore >= 50 && margin >= bestScore * 0.4) confidence = "high";
      else if (bestScore >= 20 && margin >= 5) confidence = "medium";
      else if (bestScore >= 5) confidence = "low";
      else confidence = "noise";

      allScores.push({
        module: fp.moduleName,
        sourceFile: bestSource,
        score: bestScore,
        secondBestScore: secondBest,
        margin,
        confidence,
        details: bestDetails,
        moduleKind: fp.kind,
        moduleSize: fp.size,
        moduleIndex: fp.index,
      });
    }
  }

  allScores.sort((a, b) => b.score - a.score);

  // Greedy assignment
  const assignedModules = new Set<string>();
  const assignedSources = new Set<string>();
  const matches: MatchResult[] = [];
  const unmatched: MatchResult[] = [];

  for (const entry of allScores) {
    if (assignedModules.has(entry.module)) continue;
    if (assignedSources.has(entry.sourceFile)) {
      unmatched.push({ ...entry, confidence: "noise" });
      continue;
    }

    if (entry.confidence !== "noise") {
      assignedModules.add(entry.module);
      assignedSources.add(entry.sourceFile);
      matches.push(entry);
    } else {
      unmatched.push(entry);
    }
  }

  // Add fully unmatched
  for (const fp of fingerprints) {
    if (!assignedModules.has(fp.moduleName)) {
      unmatched.push({
        module: fp.moduleName,
        sourceFile: "",
        score: 0,
        secondBestScore: 0,
        margin: 0,
        confidence: "noise",
        details: {},
        moduleKind: fp.kind,
        moduleSize: fp.size,
        moduleIndex: fp.index,
      });
    }
  }

  const high = matches.filter((m) => m.confidence === "high").length;
  const medium = matches.filter((m) => m.confidence === "medium").length;
  const low = matches.filter((m) => m.confidence === "low").length;

  console.log(`\nResults:`);
  console.log(`  Total modules: ${fingerprints.length}`);
  console.log(`  Matched: ${matches.length} (${Math.round(matches.length / fingerprints.length * 100)}%)`);
  console.log(`    High confidence: ${high}`);
  console.log(`    Medium confidence: ${medium}`);
  console.log(`    Low confidence: ${low}`);
  console.log(`  Unmatched: ${unmatched.length}`);
  console.log(`\nTop 20:`);
  for (const m of matches.slice(0, 20)) {
    console.log(`  ${m.module.padEnd(12)} → ${m.sourceFile.padEnd(50)} score=${String(m.score).padStart(5)} (${m.confidence})`);
  }

  const output: MatchOutput = {
    totalModules: fingerprints.length,
    matched: matches.length,
    highConfidence: high,
    mediumConfidence: medium,
    lowConfidence: low,
    unmatched: unmatched.length,
    matches,
    unmatchedModules: unmatched,
  };

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\nWrote results to ${outputPath}`);
  }

  return output;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: bun run src/matcher.ts <signatures.json> <modules_dir> [output.json]");
    process.exit(1);
  }
  matchModules(args[0], args[1], args[2]);
}
