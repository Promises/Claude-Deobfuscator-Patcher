/**
 * Deobfuscator orchestrator — full pipeline using Python splitter + TS analysis.
 *
 * 1. Split bundle into modules (Python splitter — proven reliable)
 * 2. Extract signatures from source reference (TS AST)
 * 3. Match modules to source files (TS AST)
 * 4. Emit deobfuscated project layout
 *
 * Usage: bun run src/deob.ts <source.js> <source_ref_dir> <output_dir>
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { extractSignatures } from "./signatures";
import { matchModules } from "./matcher";
import { emitProject } from "./emitter";

export function deobfuscate(sourceJs: string, sourceRefDir: string, outputDir: string) {
  const cacheDir = path.join(path.dirname(sourceJs), ".deob_cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const pySplitter = path.resolve(__dirname, "../../tools/splitter.py");

  // Step 1: Split with Python splitter
  const modulesDir = path.join(cacheDir, "modules");
  console.log("=".repeat(60));
  console.log("STEP 1: Splitting bundle into modules (Python)");
  console.log("=".repeat(60));
  if (fs.existsSync(path.join(modulesDir, "_manifest.json"))) {
    console.log(`  Using cached modules in ${modulesDir}`);
  } else {
    execSync(`python3 ${pySplitter} ${sourceJs} ${modulesDir}`, { stdio: "inherit" });
  }

  // Step 2: Signatures (TS AST, cached)
  const sigsPath = path.join(cacheDir, "signatures.json");
  console.log("\n" + "=".repeat(60));
  console.log("STEP 2: Extracting source signatures (TS AST)");
  console.log("=".repeat(60));
  if (fs.existsSync(sigsPath)) {
    console.log(`  Using cached signatures: ${sigsPath}`);
  } else {
    extractSignatures(sourceRefDir, sigsPath);
  }

  // Step 3: Match (TS AST)
  const matchesPath = path.join(cacheDir, "matches.json");
  console.log("\n" + "=".repeat(60));
  console.log("STEP 3: Matching modules to source files (TS AST)");
  console.log("=".repeat(60));
  matchModules(sigsPath, modulesDir, matchesPath);

  // Step 4: Emit
  console.log("\n" + "=".repeat(60));
  console.log("STEP 4: Emitting deobfuscated project");
  console.log("=".repeat(60));
  emitProject(matchesPath, modulesDir, outputDir);

  console.log("\n" + "=".repeat(60));
  console.log("DONE");
  console.log("=".repeat(60));
  console.log(`  Project: ${outputDir}/`);
  console.log(`  Mapping: ${outputDir}/_mapping.json`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log("Usage: bun run src/deob.ts <source.js> <source_ref_dir> <output_dir>");
    process.exit(1);
  }
  deobfuscate(args[0], args[1], args[2]);
}
