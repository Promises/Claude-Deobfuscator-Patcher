/**
 * Emit deobfuscated project layout from matched modules.
 */

import * as fs from "fs";
import * as path from "path";
import type { MatchOutput } from "./matcher";

export interface MappingSection {
  index: number;
  original_filename: string;
  output_path: string;
  type: string;
  module_name?: string;
  module_kind?: string;
  matched_source?: string;
  confidence?: string;
  score?: number;
}

export interface Mapping {
  version: string;
  section_count: number;
  matched_count: number;
  sections: MappingSection[];
}

export function emitProject(
  matchesPath: string,
  modulesDir: string,
  outputDir: string
): Mapping {
  const matchesData: MatchOutput = JSON.parse(fs.readFileSync(matchesPath, "utf-8"));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(modulesDir, "_manifest.json"), "utf-8")
  );

  // Build match lookup
  const matchLookup = new Map<string, (typeof matchesData.matches)[0]>();
  for (const m of matchesData.matches) {
    matchLookup.set(m.module, m);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const mapping: Mapping = {
    version: manifest.sourceFile || manifest.source_file || "unknown",
    section_count: manifest.sections.length,
    matched_count: matchesData.matched,
    sections: [],
  };

  let matched = 0, vendor = 0, unmatched = 0;

  for (const section of manifest.sections) {
    const secType = section.type;
    const filename = section.filename;
    const srcPath = path.join(modulesDir, filename);

    let code: string;
    try {
      code = fs.readFileSync(srcPath, "utf-8");
    } catch {
      continue;
    }

    let outPath: string;

    if (secType === "preamble") {
      outPath = "_preamble.js";
    } else if (secType === "tail") {
      outPath = "_tail.js";
    } else if (secType === "section") {
      const modName = section.module_name || section.module_name;
      const match = matchLookup.get(modName);

      if (match && (match.confidence === "high" || match.confidence === "medium")) {
        outPath = match.sourceFile.replace(/\.tsx?$/, ".js");
        matched++;
      } else if (match && match.confidence === "low") {
        const base = path.basename(match.sourceFile).replace(/\.tsx?$/, ".js");
        outPath = `_tentative/${String(section.index).padStart(4, "0")}_${base}`;
        matched++;
      } else {
        // Check vendor by requires
        const hints = section.hints || {};
        const reqs: string[] = hints.requires || [];
        const isVendor = reqs.some(
          (r: string) => (r.startsWith("@") || !r.includes("/")) && !r.startsWith(".") && !r.startsWith("/$bunfs")
        );
        const idx = String(section.index).padStart(4, "0");
        if (isVendor) {
          outPath = `_vendor/${idx}_${modName}.js`;
          vendor++;
        } else {
          outPath = `_unmatched/${idx}_${modName}.js`;
          unmatched++;
        }
      }
    } else {
      continue;
    }

    const fullOut = path.join(outputDir, outPath);
    fs.mkdirSync(path.dirname(fullOut), { recursive: true });
    fs.writeFileSync(fullOut, code);

    const entry: MappingSection = {
      index: section.index,
      original_filename: filename,
      output_path: outPath,
      type: secType,
    };

    if (secType === "section") {
      entry.module_name = section.module_name || section.module_name;
      entry.module_kind = section.module_kind || section.module_kind;
      const match = matchLookup.get(entry.module_name!);
      if (match) {
        entry.matched_source = match.sourceFile;
        entry.confidence = match.confidence;
        entry.score = match.score;
      }
    }

    mapping.sections.push(entry);
  }

  fs.writeFileSync(
    path.join(outputDir, "_mapping.json"),
    JSON.stringify(mapping, null, 2)
  );

  // Inject custom modules from patches.d/modules/ if present
  const customModulesDir = path.join(path.dirname(outputDir), "patches.d", "modules");
  if (fs.existsSync(customModulesDir)) {
    const customFiles = fs.readdirSync(customModulesDir).filter((f) => f.endsWith(".js")).sort();
    for (const file of customFiles) {
      const src = path.join(customModulesDir, file);
      const dest = path.join(outputDir, "_custom", file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);

      // Add to mapping — insert right after preamble so custom code
      // is available to all other modules at runtime
      const entry: MappingSection = {
        index: -1,
        original_filename: `_custom/${file}`,
        output_path: `_custom/${file}`,
        type: "section",
        module_name: `_custom_${file.replace(".js", "")}`,
      };
      const firstSectionIdx = mapping.sections.findIndex((s) => s.type === "section");
      if (firstSectionIdx >= 0) {
        mapping.sections.splice(firstSectionIdx, 0, entry);
      } else {
        mapping.sections.splice(1, 0, entry);
      }
    }
    console.log(`  Custom modules: ${customFiles.length} (from patches.d/modules/)`);
  }

  fs.writeFileSync(
    path.join(outputDir, "_mapping.json"),
    JSON.stringify(mapping, null, 2)
  );

  console.log(`Emitted to ${outputDir}/`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Vendor: ${vendor}`);
  console.log(`  Unmatched: ${unmatched}`);

  return mapping;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log("Usage: bun run src/emitter.ts <matches.json> <modules_dir> <output_dir>");
    process.exit(1);
  }
  emitProject(args[0], args[1], args[2]);
}
