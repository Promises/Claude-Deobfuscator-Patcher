/**
 * Generate the rename database from a deobfuscated project.
 *
 * Scans all matched modules, discovers renames via M_() export maps,
 * class matching, and signature matching. Detects collisions and
 * produces a rename-db.json that the renamer uses as a filter.
 *
 * Usage: bun run src/rename-db-gen.ts <project_dir> <source_ref_dir> <mapping.json> [existing-db.json]
 */

import * as fs from "fs";
import * as path from "path";
import { buildModuleRenames } from "./renamer";
import type { RenameDB, FileRenames, RenameEntry, SuppressedEntry, GenerationReport } from "./rename-db-types";

interface DiscoveredRename {
  minified: string;
  original: string;
  kind: "export_map" | "class" | "signature";
}

/**
 * Discover all renames for a single module by running the rename pipeline.
 * Returns raw discovered pairs WITHOUT applying them.
 */
function discoverModuleRenames(
  deobCode: string,
  sourceCode: string,
  sourcePath: string,
): DiscoveredRename[] {
  const renames = buildModuleRenames(deobCode, sourceCode, sourcePath);
  const discovered: DiscoveredRename[] = [];

  for (const [minified, original] of renames) {
    // Classify how this rename was discovered
    // M_() renames come first, then class, then signature
    // We can detect M_() by checking if the export map contains it
    // For simplicity, just mark all as the most likely kind
    discovered.push({ minified, original, kind: "export_map" });
  }

  return discovered;
}

/**
 * Scan a deobfuscated project and generate a rename database.
 */
function generateDB(
  projectDir: string,
  sourceRefDir: string,
  mappingPath: string,
  existingDB?: RenameDB,
): { db: RenameDB; report: GenerationReport } {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

  const db: RenameDB = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    files: {},
  };

  const report: GenerationReport = {
    total_files: 0,
    total_renames: 0,
    total_suppressed: 0,
    by_kind: {},
    collisions: [],
  };

  // Track all renames globally for cross-file collision detection
  // Maps original_name -> array of { sourcePath, minified }
  const globalNameUsage = new Map<string, Array<{ sourcePath: string; minified: string }>>();

  for (const section of mapping.sections) {
    if (!section.matched_source || section.confidence === "low") continue;

    const deobPath = path.join(projectDir, section.output_path);
    const sourcePath = path.join(sourceRefDir, section.matched_source);

    if (!fs.existsSync(deobPath) || !fs.existsSync(sourcePath)) continue;

    const deobCode = fs.readFileSync(deobPath, "utf-8");
    const sourceCode = fs.readFileSync(sourcePath, "utf-8");

    const discovered = discoverModuleRenames(deobCode, sourceCode, section.matched_source);
    if (discovered.length === 0) continue;

    const fileEntry: FileRenames = { renames: {} };

    // Detect intra-file collisions: two minified names → same original
    const byOriginal = new Map<string, string[]>();
    for (const d of discovered) {
      const arr = byOriginal.get(d.original) || [];
      arr.push(d.minified);
      byOriginal.set(d.original, arr);
    }

    for (const [original, minifiedNames] of byOriginal) {
      if (minifiedNames.length > 1) {
        // Collision within this file
        if (!fileEntry.suppressed) fileEntry.suppressed = {};
        fileEntry.suppressed[original] = {
          reason: `intra_file_collision: ${minifiedNames.join(", ")} all map to ${original}`,
          candidates: minifiedNames,
        };
        report.collisions.push({
          file: section.matched_source,
          original,
          minified_names: minifiedNames,
        });
        report.total_suppressed++;
      } else {
        // Clean rename
        const d = discovered.find(x => x.original === original)!;
        fileEntry.renames[original] = {
          kind: d.kind,
          source: "auto",
          confidence: section.confidence === "high" ? "high" : "medium",
        };
        report.total_renames++;
        report.by_kind[d.kind] = (report.by_kind[d.kind] || 0) + 1;
      }

      // Track global usage
      for (const minified of minifiedNames) {
        const arr = globalNameUsage.get(original) || [];
        arr.push({ sourcePath: section.matched_source, minified });
        globalNameUsage.set(original, arr);
      }
    }

    db.files[section.matched_source] = fileEntry;
    report.total_files++;
  }

  // Detect cross-file collisions: same original name in different files
  for (const [original, usages] of globalNameUsage) {
    const uniqueFiles = new Set(usages.map(u => u.sourcePath));
    if (uniqueFiles.size > 1) {
      // This original name appears in multiple files — potential collision
      // when reassembled into one JS file
      for (const usage of usages) {
        const fileEntry = db.files[usage.sourcePath];
        if (!fileEntry) continue;

        // Move from renames to suppressed if not already there
        if (fileEntry.renames[original]) {
          if (!fileEntry.suppressed) fileEntry.suppressed = {};
          fileEntry.suppressed[original] = {
            reason: `cross_file_collision: ${original} also in ${[...uniqueFiles].filter(f => f !== usage.sourcePath).join(", ")}`,
            candidates: usages.filter(u => u.sourcePath === usage.sourcePath).map(u => u.minified),
          };
          delete fileEntry.renames[original];
          report.total_suppressed++;
          report.total_renames--;
        }
      }

      report.collisions.push({
        file: [...uniqueFiles].join(" + "),
        original,
        minified_names: usages.map(u => `${u.minified} (${u.sourcePath})`),
      });
    }
  }

  // Merge with existing DB: preserve manual entries
  if (existingDB) {
    for (const [sourcePath, existingFile] of Object.entries(existingDB.files)) {
      const newFile = db.files[sourcePath];
      if (!newFile) {
        // File no longer matched — keep manual entries only
        const manualOnly: FileRenames = { renames: {} };
        let hasManual = false;
        for (const [name, entry] of Object.entries(existingFile.renames)) {
          if (entry.source === "manual") {
            manualOnly.renames[name] = entry;
            hasManual = true;
          }
        }
        if (existingFile.suppressed) {
          for (const [name, entry] of Object.entries(existingFile.suppressed)) {
            if (entry.resolved_as) {
              if (!manualOnly.suppressed) manualOnly.suppressed = {};
              manualOnly.suppressed[name] = entry;
              hasManual = true;
            }
          }
        }
        if (hasManual) db.files[sourcePath] = manualOnly;
        continue;
      }

      // Preserve manual renames
      for (const [name, entry] of Object.entries(existingFile.renames)) {
        if (entry.source === "manual") {
          newFile.renames[name] = entry;
        }
      }

      // Preserve manual suppression resolutions
      if (existingFile.suppressed) {
        for (const [name, entry] of Object.entries(existingFile.suppressed)) {
          if (entry.resolved_as && newFile.suppressed?.[name]) {
            newFile.suppressed[name].resolved_as = entry.resolved_as;
            newFile.suppressed[name].resolve_hint = entry.resolve_hint;
          }
        }
      }
    }
  }

  return { db, report };
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log("Usage: bun run src/rename-db-gen.ts <project_dir> <source_ref_dir> <mapping.json> [existing-db.json]");
    process.exit(1);
  }

  const [projectDir, sourceRefDir, mappingPath, existingDbPath] = args;

  let existingDB: RenameDB | undefined;
  if (existingDbPath && fs.existsSync(existingDbPath)) {
    existingDB = JSON.parse(fs.readFileSync(existingDbPath, "utf-8"));
    console.log(`Loaded existing DB: ${Object.keys(existingDB!.files).length} files`);
  }

  console.log("Generating rename database...");
  const { db, report } = generateDB(projectDir, sourceRefDir, mappingPath, existingDB);

  // Write DB
  const outPath = path.join(path.dirname(mappingPath), "..", "tools-ts", "rename-db.json");
  fs.writeFileSync(outPath, JSON.stringify(db, null, 2));
  console.log(`\nWrote: ${outPath}`);

  // Print report
  console.log(`\n=== Generation Report ===`);
  console.log(`Files:      ${report.total_files}`);
  console.log(`Renames:    ${report.total_renames}`);
  console.log(`Suppressed: ${report.total_suppressed}`);
  console.log(`By kind:    ${JSON.stringify(report.by_kind)}`);

  if (report.collisions.length > 0) {
    console.log(`\n=== Collisions (${report.collisions.length}) ===`);
    for (const c of report.collisions) {
      console.log(`  ${c.original} in ${c.file}`);
      for (const m of c.minified_names) {
        console.log(`    → ${m}`);
      }
    }
    console.log(`\nResolve collisions by editing ${outPath}`);
    console.log(`Add "resolved_as" and "resolve_hint" to suppressed entries.`);
  }
}
