/**
 * Version test harness — runs the deob + rename pipeline against multiple
 * Claude Code versions and produces a structured comparison report.
 *
 * Usage:
 *   bun run src/version-test.ts <versionref-dir> [version-glob]
 *
 * Examples:
 *   bun run src/version-test.ts ../versionref                    # all versions
 *   bun run src/version-test.ts ../versionref "2.1.15*"          # only 2.1.15x
 *   bun run src/version-test.ts ../versionref "2.1.90"           # single version
 *
 * Output: versionref/_version_test_results.json
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { matchModules } from "./matcher";
import { emitProject } from "./emitter";
import { applyAnchorRules } from "./anchor-rules";
import { extractExportMap } from "./renamer";

const COMMITTED_SIGS = path.resolve(__dirname, "../signatures.json");
const ANCHOR_RULES = path.resolve(__dirname, "../anchor-rules.json");

interface AnchorRuleResult {
  id: string;
  rename?: string;
  description?: string;
  status: "ok" | "missing_file" | "pattern_not_found" | "scope_not_found" | "walk_failed";
  minified?: string;
}

interface VersionResult {
  version: string;
  timestamp: string;
  bundleSize: number;
  modules: {
    total: number;
    matched: number;
    high: number;
    medium: number;
    low: number;
    unmatched: number;
    vendor: number;
  };
  renames: {
    fromExportMaps: number;
    fromAnchorRules: number;
    totalUnique: number;
    anchorRuleDetails: AnchorRuleResult[];
  };
  errors: string[];
  durationMs: number;
}

interface DiffEntry {
  field: string;
  prev: string | number;
  curr: string | number;
  delta?: number;
}

interface VersionDiff {
  from: string;
  to: string;
  changes: DiffEntry[];
  newModules: string[];
  lostModules: string[];
  anchorBreaks: string[];
  anchorFixes: string[];
}

function testVersion(sourceJs: string, workDir: string): VersionResult {
  const start = Date.now();
  const errors: string[] = [];
  const bundleSize = fs.statSync(sourceJs).size;

  const cacheDir = path.join(workDir, ".cache");
  const modulesDir = path.join(cacheDir, "modules");
  const matchesPath = path.join(cacheDir, "matches.json");
  const outDir = path.join(workDir, "deobfuscated");

  // Clean previous run
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // Step 1: Split
  const pySplitter = path.resolve(__dirname, "../../tools/splitter.py");
  try {
    execSync(`python3 "${pySplitter}" "${sourceJs}" "${modulesDir}"`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    errors.push(`split failed: ${e.stderr?.toString().trim() || e.message}`);
    return makeErrorResult(sourceJs, bundleSize, errors, start);
  }

  // Step 2: Match
  try {
    matchModules(COMMITTED_SIGS, modulesDir, matchesPath);
  } catch (e: any) {
    errors.push(`match failed: ${e.message}`);
    return makeErrorResult(sourceJs, bundleSize, errors, start);
  }

  const matches = JSON.parse(fs.readFileSync(matchesPath, "utf-8"));

  // Step 3: Emit
  try {
    // Suppress console output during emit
    const origLog = console.log;
    const origWarn = console.warn;
    const logs: string[] = [];
    console.log = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => logs.push("WARN: " + args.join(" "));
    emitProject(matchesPath, modulesDir, outDir);
    console.log = origLog;
    console.warn = origWarn;
  } catch (e: any) {
    errors.push(`emit failed: ${e.message}`);
    return makeErrorResult(sourceJs, bundleSize, errors, start);
  }

  // Step 4: Module reconstruction
  try {
    const { reconstructModules } = require("./module-reconstruct");
    const origLog = console.log;
    console.log = () => {};
    reconstructModules(outDir);
    console.log = origLog;
  } catch (e: any) {
    errors.push(`reconstruct failed: ${e.message}`);
  }

  // Step 5: Anchor rules (verbose — we capture individual results)
  let anchorRuleDetails: AnchorRuleResult[] = [];
  let anchorRenameCount = 0;
  let anchorPairs: Array<{ minified: string; original: string }> = [];
  try {
    const anchorResults = testAnchorRulesDetailed(outDir, ANCHOR_RULES);
    anchorRuleDetails = anchorResults.details;
    anchorRenameCount = anchorResults.renames;
    anchorPairs = anchorResults.pairs;
  } catch (e: any) {
    errors.push(`anchor rules failed: ${e.message}`);
  }

  // Step 6: Rename coverage (no-source-ref). Export maps (M_() helper calls)
  // are self-contained in the bundle, so export maps + anchors define what we
  // can rename WITHOUT the source reference. Count unique minified→original
  // across every emitted module, mirroring the renamer's first-wins dedup.
  const seen = new Map<string, string>();
  let exportMapRenames = 0;
  const mappingPath = path.join(outDir, "_mapping.json");
  if (fs.existsSync(mappingPath)) {
    const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
    for (const section of mapping.sections) {
      if (section.type !== "section" || !section.output_path) continue;
      const p = path.join(outDir, section.output_path);
      if (!fs.existsSync(p)) continue;
      let em: Map<string, string>;
      try {
        em = extractExportMap(fs.readFileSync(p, "utf-8"));
      } catch {
        continue;
      }
      for (const [minified, original] of em) {
        if (seen.has(minified)) continue;
        seen.set(minified, original);
        exportMapRenames++;
      }
    }
  }
  // Union with anchors: an anchor only adds coverage when its minified name
  // wasn't already resolved by an export map.
  for (const { minified, original } of anchorPairs) {
    if (!seen.has(minified)) seen.set(minified, original);
  }
  const totalUniqueRenames = seen.size;

  // Parse match stats
  const vendorCount = countVendorModules(outDir);

  return {
    version: path.basename(sourceJs).replace("-cli.js", ""),
    timestamp: new Date().toISOString(),
    bundleSize,
    modules: {
      total: matches.totalModules ?? 0,
      matched: matches.matched ?? 0,
      high: matches.highConfidence ?? 0,
      medium: matches.mediumConfidence ?? 0,
      low: matches.lowConfidence ?? 0,
      unmatched: matches.unmatched ?? 0,
      vendor: vendorCount,
    },
    renames: {
      fromExportMaps: exportMapRenames,
      fromAnchorRules: anchorRenameCount,
      totalUnique: totalUniqueRenames,
      anchorRuleDetails,
    },
    errors,
    durationMs: Date.now() - start,
  };
}

function countVendorModules(outDir: string): number {
  const vendorDir = path.join(outDir, "_vendor");
  if (!fs.existsSync(vendorDir)) return 0;
  return fs.readdirSync(vendorDir).filter((f) => f.endsWith(".js")).length;
}

/**
 * Run anchor rules and capture per-rule pass/fail status.
 */
import ts from "typescript";

function testAnchorRulesDetailed(
  deobDir: string,
  rulesPath: string,
): { renames: number; details: AnchorRuleResult[]; pairs: Array<{ minified: string; original: string }> } {
  if (!fs.existsSync(rulesPath)) return { renames: 0, details: [], pairs: [] };

  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
  const details: AnchorRuleResult[] = [];

  // Test root rules individually for reporting
  for (const rule of rules) {
    if (rule.from || rule.type === "pin") continue; // skip walk/pin rules

    // Documentation-only entries (a bare `__note` object) carry no `file`, and
    // path.join(dir, undefined) THROWS. That aborted the whole per-version run,
    // which the caller records as one error and zero anchor renames — a result
    // indistinguishable from "this version resolves nothing". A single note
    // object silently voided 60 of 64 versions in the 2026-08-21 sweep.
    //
    // The engine has the same guard, but this file keeps its OWN copy of the
    // rule loop, so fixing it there did not fix it here. If you change one,
    // check the other.
    if (!rule.file) continue;

    const id = rule.id ?? rule.rename ?? "unknown";
    const filePath = path.join(deobDir, rule.file);

    if (!fs.existsSync(filePath)) {
      details.push({ id, rename: rule.rename, description: rule.description, status: "missing_file" });
      continue;
    }

    const code = fs.readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(rule.file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    // Test find pattern
    const pos = findPatternPos(code, rule.find, sf);
    if (pos === -1) {
      details.push({ id, rename: rule.rename, description: rule.description, status: "pattern_not_found" });
      continue;
    }

    // Test scope
    const node = findContainingScope(sf, pos, rule.scope);
    if (!node) {
      details.push({ id, rename: rule.rename, description: rule.description, status: "scope_not_found" });
      continue;
    }

    const minified = getNodeName(node);
    details.push({
      id,
      rename: rule.rename,
      description: rule.description,
      status: "ok",
      minified: minified ?? undefined,
    });
  }

  // Run the full anchor rules to get actual rename count
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  let results: any[];
  try {
    results = applyAnchorRules(deobDir, rulesPath);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  const pairs = results.map((r) => ({ minified: r.minified, original: r.original }));
  return { renames: results.length, details, pairs };
}

// ── Borrowed helpers from anchor-rules.ts (simplified for testing) ──────────

type FindCriteria =
  | { text: string }
  | { regex: string }
  | { string_literal: string }
  | { string_startswith: string }
  | { string_endswith: string }
  | { string_contains: string }
  | { number: number; op?: string }
  | { property_assignment: { key: string; value: string } }
  | { function_name: string };

function findPatternPos(code: string, find: FindCriteria | string, sf: ts.SourceFile): number {
  if (typeof find === "string") find = { text: find };

  if ("text" in find) return code.indexOf(find.text);
  if ("regex" in find) {
    const m = code.match(new RegExp(find.regex));
    return m ? m.index! : -1;
  }
  if ("string_literal" in find) {
    // Find a string literal node with this value
    let found = -1;
    function visit(n: ts.Node) {
      if (found !== -1) return;
      if (ts.isStringLiteral(n) && n.text === find.string_literal) {
        found = n.getStart(sf);
        return;
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return found;
  }
  if ("string_startswith" in find) {
    let found = -1;
    function visit(n: ts.Node) {
      if (found !== -1) return;
      if (ts.isStringLiteral(n) && n.text.startsWith((find as any).string_startswith)) {
        found = n.getStart(sf);
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return found;
  }
  if ("string_endswith" in find) {
    let found = -1;
    function visit(n: ts.Node) {
      if (found !== -1) return;
      if (ts.isStringLiteral(n) && n.text.endsWith((find as any).string_endswith)) {
        found = n.getStart(sf);
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return found;
  }
  if ("string_contains" in find) {
    let found = -1;
    function visit(n: ts.Node) {
      if (found !== -1) return;
      if (ts.isStringLiteral(n) && n.text.includes((find as any).string_contains)) {
        found = n.getStart(sf);
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return found;
  }
  if ("property_assignment" in find) {
    const { key, value } = find.property_assignment;
    let found = -1;
    function visit(n: ts.Node) {
      if (found !== -1) return;
      if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === key &&
        ts.isStringLiteral(n.initializer) &&
        n.initializer.text === value
      ) {
        found = n.getStart(sf);
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return found;
  }
  if ("number" in find) {
    let found = -1;
    function visit(n: ts.Node) {
      if (found !== -1) return;
      if (ts.isNumericLiteral(n) && parseFloat(n.text) === (find as any).number) {
        found = n.getStart(sf);
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return found;
  }
  if ("function_name" in find) {
    return code.indexOf(find.function_name);
  }
  return -1;
}

type Scope = "function" | "async_generator" | "generator" | "async_function" | "method" | "class" | "arrow";

function findContainingScope(sf: ts.SourceFile, pos: number, scope: Scope): ts.Node | null {
  let target: ts.Node | null = null;

  function visit(node: ts.Node) {
    if (pos < node.getStart(sf) || pos >= node.end) return;
    ts.forEachChild(node, visit);

    if (target) return;

    switch (scope) {
      case "function":
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) target = node;
        break;
      case "async_generator":
        if (
          (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
          node.asteriskToken &&
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        )
          target = node;
        break;
      case "generator":
        if (
          (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
          node.asteriskToken
        )
          target = node;
        break;
      case "async_function":
        if (
          (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        )
          target = node;
        break;
      case "method":
        if (ts.isMethodDeclaration(node)) target = node;
        break;
      case "class":
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) target = node;
        break;
      case "arrow":
        if (ts.isArrowFunction(node)) target = node;
        break;
    }
  }

  visit(sf);
  return target;
}

function getNodeName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
    return node.name?.text ?? null;
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return node.name?.text ?? null;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  // For anonymous functions assigned to variables, walk up
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return null;
}

function makeErrorResult(sourceJs: string, bundleSize: number, errors: string[], start: number): VersionResult {
  return {
    version: path.basename(sourceJs).replace("-cli.js", ""),
    timestamp: new Date().toISOString(),
    bundleSize,
    modules: { total: 0, matched: 0, high: 0, medium: 0, low: 0, unmatched: 0, vendor: 0 },
    renames: { fromExportMaps: 0, fromAnchorRules: 0, totalUnique: 0, anchorRuleDetails: [] },
    errors,
    durationMs: Date.now() - start,
  };
}

// ── Diff two consecutive version results ────────────────────────────────────

function diffVersions(prev: VersionResult, curr: VersionResult): VersionDiff {
  const changes: DiffEntry[] = [];

  const compare = (field: string, p: number, c: number) => {
    if (p !== c) changes.push({ field, prev: p, curr: c, delta: c - p });
  };

  compare("bundleSize", prev.bundleSize, curr.bundleSize);
  compare("modules.total", prev.modules.total, curr.modules.total);
  compare("modules.matched", prev.modules.matched, curr.modules.matched);
  compare("modules.high", prev.modules.high, curr.modules.high);
  compare("modules.medium", prev.modules.medium, curr.modules.medium);
  compare("modules.low", prev.modules.low, curr.modules.low);
  compare("modules.unmatched", prev.modules.unmatched, curr.modules.unmatched);
  compare("renames.fromExportMaps", prev.renames.fromExportMaps, curr.renames.fromExportMaps);
  compare("renames.fromAnchorRules", prev.renames.fromAnchorRules, curr.renames.fromAnchorRules);
  compare("renames.totalUnique", prev.renames.totalUnique, curr.renames.totalUnique);

  // Anchor rule breakages
  const prevAnchors = new Map(prev.renames.anchorRuleDetails.map((a) => [a.id, a]));
  const currAnchors = new Map(curr.renames.anchorRuleDetails.map((a) => [a.id, a]));

  const anchorBreaks: string[] = [];
  const anchorFixes: string[] = [];

  for (const [id, pa] of prevAnchors) {
    const ca = currAnchors.get(id);
    if (pa.status === "ok" && ca && ca.status !== "ok") {
      anchorBreaks.push(`${id}: ${pa.status} → ${ca.status}`);
    }
    if (pa.status !== "ok" && ca && ca.status === "ok") {
      anchorFixes.push(`${id}: ${pa.status} → ok`);
    }
    if (pa.status === "ok" && ca?.status === "ok" && pa.minified !== ca.minified) {
      changes.push({ field: `anchor.${id}.minified`, prev: pa.minified!, curr: ca.minified! });
    }
  }

  return {
    from: prev.version,
    to: curr.version,
    changes,
    newModules: [], // could compare module lists if needed
    lostModules: [],
    anchorBreaks,
    anchorFixes,
  };
}

// ── Print summary table ─────────────────────────────────────────────────────

function printSummary(results: VersionResult[], diffs: VersionDiff[]) {
  console.log("\n" + "=".repeat(100));
  console.log("VERSION TEST SUMMARY");
  console.log("=".repeat(100));

  // Header. "ExpMap" = renames from self-contained export maps (no source ref),
  // "Anchor" = renames from anchor rules, "Total" = unique union of the two
  // (the no-source-ref rename coverage we grow each wave).
  console.log(
    pad("Version", 12) +
      pad("Size", 8) +
      pad("Mods", 7) +
      pad("Match", 7) +
      pad("ExpMap", 8) +
      pad("Anchor", 8) +
      pad("Total", 8) +
      pad("Err", 5) +
      pad("Time", 8),
  );
  console.log("-".repeat(100));

  for (const r of results) {
    const matchPct = r.modules.total > 0 ? ((r.modules.matched / r.modules.total) * 100).toFixed(0) + "%" : "N/A";
    console.log(
      pad(r.version, 12) +
        pad(fmtBytes(r.bundleSize), 8) +
        pad(String(r.modules.total), 7) +
        pad(matchPct, 7) +
        pad(String(r.renames.fromExportMaps), 8) +
        pad(String(r.renames.fromAnchorRules), 8) +
        pad(String(r.renames.totalUnique), 8) +
        pad(String(r.errors.length), 5) +
        pad(fmtMs(r.durationMs), 8),
    );
  }

  // Diffs
  if (diffs.length > 0) {
    console.log("\n" + "=".repeat(100));
    console.log("CHANGES BETWEEN VERSIONS");
    console.log("=".repeat(100));

    for (const d of diffs) {
      const significant = d.changes.filter(
        (c) => c.field !== "bundleSize" || (typeof c.delta === "number" && Math.abs(c.delta) > 10000),
      );
      if (significant.length === 0 && d.anchorBreaks.length === 0 && d.anchorFixes.length === 0) continue;

      console.log(`\n${d.from} → ${d.to}:`);
      for (const c of significant) {
        const arrow = typeof c.delta === "number" ? (c.delta > 0 ? "+" : "") + c.delta : "";
        const val =
          c.field === "bundleSize"
            ? `${fmtBytes(c.prev as number)} → ${fmtBytes(c.curr as number)}`
            : `${c.prev} → ${c.curr}`;
        console.log(`  ${c.field}: ${val} ${arrow ? `(${arrow})` : ""}`);
      }
      for (const b of d.anchorBreaks) console.log(`  BREAK: ${b}`);
      for (const f of d.anchorFixes) console.log(`  FIXED: ${f}`);
    }
  }

  // Anchor rule status across all versions
  console.log("\n" + "=".repeat(100));
  console.log("ANCHOR RULE STATUS ACROSS VERSIONS");
  console.log("=".repeat(100));

  const allIds = new Set<string>();
  for (const r of results) {
    for (const a of r.renames.anchorRuleDetails) allIds.add(a.id);
  }

  for (const id of allIds) {
    const statuses = results.map((r) => {
      const a = r.renames.anchorRuleDetails.find((d) => d.id === id);
      return a ? a.status : "?";
    });
    const allOk = statuses.every((s) => s === "ok");
    const allFail = statuses.every((s) => s !== "ok" && s !== "?");
    const marker = allOk ? "✓" : allFail ? "✗" : "~";
    const compressed = compressStatuses(statuses, results.map((r) => r.version));
    console.log(`  ${marker} ${pad(id, 40)} ${compressed}`);
  }
}

function compressStatuses(statuses: string[], versions: string[]): string {
  // Show ranges of same status
  const ranges: string[] = [];
  let i = 0;
  while (i < statuses.length) {
    const s = statuses[i];
    let j = i;
    while (j < statuses.length && statuses[j] === s) j++;
    const tag = s === "ok" ? "ok" : s === "?" ? "?" : s.replace(/_/g, " ");
    if (j - i === 1) {
      ranges.push(`${versions[i]}:${tag}`);
    } else {
      ranges.push(`${versions[i]}..${versions[j - 1]}:${tag}`);
    }
    i = j;
  }
  return ranges.join(" | ");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + " ".repeat(n - s.length);
}

function fmtBytes(n: number): string {
  if (n > 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n > 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}

function fmtMs(ms: number): string {
  if (ms > 60000) return (ms / 60000).toFixed(1) + "m";
  if (ms > 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

// ── Main ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/version-test.ts <versionref-dir> [version-glob]");
    process.exit(1);
  }

  const versionDir = path.resolve(args[0]);
  const glob = args[1] || "*";

  // Find all cli.js files
  const allFiles = fs.readdirSync(versionDir).filter((f) => f.endsWith("-cli.js")).sort((a, b) => {
    const va = a.replace("-cli.js", "").split(".").map(Number);
    const vb = b.replace("-cli.js", "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((va[i] || 0) !== (vb[i] || 0)) return (va[i] || 0) - (vb[i] || 0);
    }
    return 0;
  });

  // Filter by glob
  const matchGlob = (name: string, pattern: string): boolean => {
    const ver = name.replace("-cli.js", "");
    if (pattern === "*") return true;
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return re.test(ver);
  };

  const files = allFiles.filter((f) => matchGlob(f, glob));
  if (files.length === 0) {
    console.error(`No versions matched "${glob}" in ${versionDir}`);
    process.exit(1);
  }

  console.log(`Testing ${files.length} versions: ${files[0].replace("-cli.js", "")} .. ${files[files.length - 1].replace("-cli.js", "")}`);

  const workBase = path.join(versionDir, ".version_test_work");
  fs.mkdirSync(workBase, { recursive: true });

  const results: VersionResult[] = [];
  const outputPath = path.join(versionDir, "_version_test_results.json");

  // Load previous results if they exist (for incremental runs)
  const prevResults = new Map<string, VersionResult>();
  if (fs.existsSync(outputPath)) {
    const prev: { results: VersionResult[] } = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    for (const r of prev.results) prevResults.set(r.version, r);
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const version = file.replace("-cli.js", "");
    const sourceJs = path.join(versionDir, file);
    const workDir = path.join(workBase, version);

    // Check cache (skip entries from an older result schema)
    const cached = prevResults.get(version);
    if (
      cached &&
      cached.bundleSize === fs.statSync(sourceJs).size &&
      cached.errors.length === 0 &&
      cached.renames.totalUnique !== undefined
    ) {
      console.log(`[${i + 1}/${files.length}] ${version} — cached`);
      results.push(cached);
      continue;
    }

    console.log(`[${i + 1}/${files.length}] ${version} ...`);

    try {
      const result = testVersion(sourceJs, workDir);
      results.push(result);

      const matchPct = result.modules.total > 0
        ? ((result.modules.matched / result.modules.total) * 100).toFixed(0) + "%"
        : "N/A";
      const errStr = result.errors.length > 0 ? ` (${result.errors.length} errors)` : "";
      console.log(
        `  → ${result.modules.total} modules, ${matchPct} matched, ${result.renames.fromAnchorRules} anchor renames, ${fmtMs(result.durationMs)}${errStr}`,
      );
    } catch (e: any) {
      console.error(`  FATAL: ${e.message}`);
      results.push(makeErrorResult(sourceJs, fs.statSync(sourceJs).size, [`fatal: ${e.message}`], Date.now()));
    }

    // Clean work dir to save space
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // Compute diffs
  const diffs: VersionDiff[] = [];
  for (let i = 1; i < results.length; i++) {
    diffs.push(diffVersions(results[i - 1], results[i]));
  }

  // Save results
  fs.writeFileSync(outputPath, JSON.stringify({ results, diffs }, null, 2));
  console.log(`\nResults saved to ${outputPath}`);

  // Print summary
  printSummary(results, diffs);

  // Cleanup work dir
  fs.rmSync(workBase, { recursive: true, force: true });
}
