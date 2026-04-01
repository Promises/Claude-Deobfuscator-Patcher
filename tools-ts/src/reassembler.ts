/**
 * Reassemble a deobfuscated project back into a single JS file.
 *
 * If files have import/export from module-reconstruct.ts, these are stripped
 * before concatenation (the original bundle has everything at global scope).
 */

import * as fs from "fs";
import * as path from "path";
import type { Mapping } from "./emitter";

/**
 * Strip import/export statements added by module-reconstruct.ts.
 * - Remove `import { ... } from '...';` lines
 * - Remove `export { ... };` lines
 * - Restore IIFE wrapper for preamble/tail if needed
 */
function stripModuleSyntax(code: string): string {
  // Only remove imports from relative paths (added by module-reconstruct).
  // Keep original code imports from bare specifiers ("crypto", "fs", "process", etc.)
  code = code.replace(/^import\s+\{[^}]*\}\s+from\s+['"]\.\.?\/[^'"]+['"];?\s*\n?/gm, "");

  // Remove export lines: `export { name1, name2, ... };`
  code = code.replace(/^export\s+\{[^}]*\};?\s*\n?/gm, "");

  return code;
}

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

    let code = fs.readFileSync(fullPath, "utf-8");
    code = stripModuleSyntax(code);

    // Restore IIFE wrapper (only if original had one — v2.1.70+ uses hashbang instead)
    if (section.type === "preamble" && !code.startsWith("#!")) {
      code = "(function(exports, require, module, __filename, __dirname) {" + code;
    } else if (section.type === "tail" && !code.includes("})({},")) {
      // Only add IIFE closing if preamble had IIFE opening
      // Check: does the assembled output start with IIFE?
      if (parts.length > 0 && parts[0].startsWith("(function(")) {
        code = code + "})({}, require, module, __filename, __dirname)";
      }
    }

    parts.push(code);
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
