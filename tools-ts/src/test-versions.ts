/**
 * Automated accuracy tests across all Claude Code versions.
 *
 * Usage: bun run src/test-versions.ts <versionref_dir> <source_ref_dir>
 */

import * as fs from "fs";
import * as path from "path";
import { splitSource } from "./splitter";
import { extractSignatures } from "./signatures";
import { matchModules } from "./matcher";
import { findPatterns } from "./patterns";

const KEY_MODULES = [
  "cli/structuredIO.ts",
  "bridge/replBridge.ts",
  "bridge/bridgeMessaging.ts",
  "bridge/initReplBridge.ts",
  "main.tsx",
  "QueryEngine.ts",
  "bootstrap/state.ts",
  "commands.ts",
  "utils/messages.ts",
  "services/api/claude.ts",
];

interface VersionResult {
  version: string;
  patterns: {
    sessionId: boolean;
    sessionIdName: string | null;
    structuredIO: boolean;
    structuredIOName: string | null;
    queryFunction: boolean;
    queryFunctionName: string | null;
    queryLoops: number;
  };
  matching: {
    totalModules: number;
    matched: number;
    high: number;
    medium: number;
    low: number;
    matchRate: number;
    highRate: number;
    keyModulesFound: number;
    keyModulesTotal: number;
    keyDetails: Record<string, boolean>;
  };
  elapsedMs: number;
}

async function testVersion(
  jsPath: string,
  sigsPath: string,
  workDir: string,
  usePySplit: boolean = false
): Promise<VersionResult> {
  const version = path.basename(jsPath).replace("-cli.js", "").replace(".js", "");
  const start = Date.now();

  // Pattern tests
  const code = fs.readFileSync(jsPath, "utf-8");
  const patResults = findPatterns(code);

  // Split + match
  const modulesDir = path.join(workDir, "modules");
  fs.mkdirSync(modulesDir, { recursive: true });

  if (usePySplit) {
    // Use the proven Python splitter for splitting
    const { execSync } = await import("child_process");
    const pyScript = path.resolve(__dirname, "../../tools/splitter.py");
    execSync(`python3 ${pyScript} ${jsPath} ${modulesDir}`, { stdio: "pipe" });
  } else {
    splitSource(jsPath, modulesDir);
  }

  const matchesPath = path.join(workDir, "matches.json");
  const matchResult = matchModules(sigsPath, modulesDir, matchesPath);

  // Check key modules
  const matchedSources = new Set(matchResult.matches.map((m) => m.sourceFile));
  const keyDetails: Record<string, boolean> = {};
  for (const k of KEY_MODULES) {
    keyDetails[k] = matchedSources.has(k);
  }

  const elapsed = Date.now() - start;

  return {
    version,
    patterns: {
      sessionId: !!patResults.sessionIdFunc,
      sessionIdName: patResults.sessionIdFunc?.name ?? null,
      structuredIO: !!patResults.structuredIO,
      structuredIOName: patResults.structuredIO?.className ?? null,
      queryFunction: !!patResults.queryFunction,
      queryFunctionName: patResults.queryFunction?.name ?? null,
      queryLoops: patResults.queryFunction?.loops.length ?? 0,
    },
    matching: {
      totalModules: matchResult.totalModules,
      matched: matchResult.matched,
      high: matchResult.highConfidence,
      medium: matchResult.mediumConfidence,
      low: matchResult.lowConfidence,
      matchRate: Math.round((matchResult.matched / matchResult.totalModules) * 1000) / 10,
      highRate: Math.round((matchResult.highConfidence / matchResult.totalModules) * 1000) / 10,
      keyModulesFound: Object.values(keyDetails).filter(Boolean).length,
      keyModulesTotal: KEY_MODULES.length,
      keyDetails,
    },
    elapsedMs: elapsed,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: bun run src/test-versions.ts <versionref_dir> <source_ref_dir>");
    process.exit(1);
  }

  const versionDir = args[0];
  const sourceRefDir = args[1];

  // Generate signatures (cached)
  const sigsPath = path.join(versionDir, "_ts_signatures.json");
  if (!fs.existsSync(sigsPath)) {
    console.log("Generating signatures from source reference...");
    extractSignatures(sourceRefDir, sigsPath);
  } else {
    console.log(`Using cached signatures: ${sigsPath}`);
  }

  const jsFiles = fs.readdirSync(versionDir)
    .filter((f) => f.endsWith("-cli.js"))
    .sort();

  console.log(`\nTesting ${jsFiles.length} versions...\n`);

  const results: VersionResult[] = [];

  for (const jsFile of jsFiles) {
    const version = jsFile.replace("-cli.js", "");
    const jsPath = path.join(versionDir, jsFile);

    console.log(`--- ${version} ---`);

    const workDir = `/tmp/claudiverse_ts_test_${version}`;
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    let result: VersionResult;
    try {
      result = await testVersion(jsPath, sigsPath, workDir, args.includes("--py-split"));
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`);
      result = {
        version,
        patterns: { sessionId: false, sessionIdName: null, structuredIO: false, structuredIOName: null, queryFunction: false, queryFunctionName: null, queryLoops: 0 },
        matching: { totalModules: 0, matched: 0, high: 0, medium: 0, low: 0, matchRate: 0, highRate: 0, keyModulesFound: 0, keyModulesTotal: KEY_MODULES.length, keyDetails: {} },
        elapsedMs: Date.now() - Date.now(),
      };
    }
    results.push(result);

    // Clean up
    fs.rmSync(workDir, { recursive: true, force: true });

    const p = result.patterns;
    const m = result.matching;
    const status = p.sessionId && p.structuredIO && p.queryFunction ? "PASS" : "FAIL";
    console.log(`  Patterns: SID=${p.sessionId}, SIO=${p.structuredIO}, QF=${p.queryFunction} [${status}]`);
    console.log(`  Matching: ${m.matched}/${m.totalModules} (${m.matchRate}%), high=${m.high}, key=${m.keyModulesFound}/${m.keyModulesTotal}`);
    console.log(`  Time: ${(result.elapsedMs / 1000).toFixed(1)}s\n`);
  }

  // Summary table
  console.log("=".repeat(110));
  console.log("SUMMARY (TypeScript AST)");
  console.log("=".repeat(110));
  console.log(
    "Version    SID  SIO   QF Loops  Total  Match  High   Med   Low   Rate  HiRate   Key  Time"
  );
  console.log("-".repeat(110));

  let allPass = true;
  for (const r of results) {
    const p = r.patterns;
    const m = r.matching;
    const passed = p.sessionId && p.structuredIO && p.queryFunction;
    if (!passed) allPass = false;

    const line = [
      r.version.padEnd(10),
      (p.sessionId ? "Y" : "N").padStart(4),
      (p.structuredIO ? "Y" : "N").padStart(4),
      (p.queryFunction ? "Y" : "N").padStart(5),
      String(p.queryLoops).padStart(5),
      String(m.totalModules).padStart(6),
      String(m.matched).padStart(6),
      String(m.high).padStart(5),
      String(m.medium).padStart(5),
      String(m.low).padStart(5),
      `${m.matchRate}%`.padStart(6),
      `${m.highRate}%`.padStart(6),
      `${m.keyModulesFound}/${m.keyModulesTotal}`.padStart(5),
      `${(r.elapsedMs / 1000).toFixed(0)}s`.padStart(5),
      passed ? " " : "!",
    ].join(" ");
    console.log(line);
  }

  console.log("-".repeat(110));

  // Key module stability
  console.log("\nKey Module Stability:");
  for (const key of KEY_MODULES) {
    const found = results.filter((r) => r.matching.keyDetails[key]).length;
    const status = found === results.length ? "OK" : `MISSING in ${results.length - found}`;
    console.log(`  ${key.padEnd(45)} ${found}/${results.length} ${status}`);
  }

  console.log();
  console.log(allPass ? "ALL VERSIONS PASSED" : "SOME VERSIONS FAILED");

  // Compare with Python baseline if available
  const pyResultsPath = path.join(versionDir, "_test_results.json");
  if (fs.existsSync(pyResultsPath)) {
    const pyResults = JSON.parse(fs.readFileSync(pyResultsPath, "utf-8"));
    console.log("\n--- Comparison with Python regex baseline ---");
    console.log("Version    Py-High  TS-High  Improvement");
    console.log("-".repeat(45));
    for (const r of results) {
      const pyR = pyResults[r.version];
      if (pyR) {
        const pyHigh = pyR.matching?.high || 0;
        const tsHigh = r.matching.high;
        const diff = tsHigh - pyHigh;
        console.log(
          `${r.version.padEnd(10)} ${String(pyHigh).padStart(7)}  ${String(tsHigh).padStart(7)}  ${diff >= 0 ? "+" : ""}${diff}`
        );
      }
    }
  }

  // Write results
  const outputPath = path.join(versionDir, "_ts_test_results.json");
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);
}

main().catch(console.error);
