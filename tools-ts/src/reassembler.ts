/**
 * Reassemble a deobfuscated project back into a single JS file.
 */

import * as fs from "fs";
import * as path from "path";
import type { Mapping } from "./emitter";

export function reassemble(projectDir: string, outputPath: string): void {
  const mappingPath = path.join(projectDir, "_mapping.json");
  const mapping: Mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

  const parts: string[] = [];
  let missing = 0;

  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) {
      console.log(`  WARNING: Missing file: ${section.output_path}`);
      missing++;
      continue;
    }
    parts.push(fs.readFileSync(fullPath, "utf-8"));
  }

  const result = parts.join("");
  fs.writeFileSync(outputPath, result);

  console.log(`Reassembled ${mapping.sections.length} sections (${missing} missing)`);
  console.log(`  Output: ${outputPath} (${result.length.toLocaleString()} bytes)`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: bun run src/reassembler.ts <project_dir> <output.js>");
    process.exit(1);
  }
  reassemble(args[0], args[1]);
}
