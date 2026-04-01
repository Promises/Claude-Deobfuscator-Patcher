/**
 * Prettify all deobfuscated files using prettier.
 * Runs after renaming, before patching — gives patches stable, readable context lines.
 */

import * as fs from "fs";
import * as path from "path";
import prettier from "prettier";

export async function prettifyProject(projectDir: string): Promise<void> {
  const mappingPath = path.join(projectDir, "_mapping.json");
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));

  let formatted = 0;
  let failed = 0;

  for (const section of mapping.sections) {
    const fullPath = path.join(projectDir, section.output_path);
    if (!fs.existsSync(fullPath)) continue;

    const code = fs.readFileSync(fullPath, "utf-8");
    if (!code.trim()) continue;

    try {
      const result = await prettier.format(code, {
        parser: "babel",
        printWidth: 100,
        semi: true,
        singleQuote: false,
        trailingComma: "all",
        arrowParens: "always",
      });
      fs.writeFileSync(fullPath, result);
      formatted++;
    } catch {
      // Some files may not parse (preamble edge cases) — skip silently
      failed++;
    }
  }

  console.log(`  Prettified ${formatted} files (${failed} skipped)`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/prettify.ts <project_dir>");
    process.exit(1);
  }
  prettifyProject(args[0]);
}
