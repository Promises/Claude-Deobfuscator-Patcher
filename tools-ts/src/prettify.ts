/**
 * Prettify all deobfuscated files using prettier.
 * Runs after renaming, before patching — gives patches stable, readable context lines.
 *
 * Two passes:
 *   1. prettier  — consistent formatting, indentation, quotes
 *   2. spacer    — blank lines between top-level function/class declarations
 */

import * as fs from 'fs';
import * as path from 'path';
import prettier from 'prettier';

const FORMATTER_SPECS = JSON.parse(
    fs.readFileSync(path.join(import.meta.dir, '../formatterSpecs.json'), 'utf-8'),
);

/**
 * Insert a blank line between adjacent top-level declarations.
 * Matches a lone `}` at column 0 immediately followed by a function/class keyword.
 */
function spaceFunctions(code: string): string {
    return code.replace(/^(})\n(?!\n)((?:async\s+)?function[\s(*]|class[\s{])/gm, '$1\n\n$2');
}

export async function prettifyProject(projectDir: string): Promise<void> {
    const mappingPath = path.join(projectDir, '_mapping.json');
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

    let formatted = 0;
    let failed = 0;

    for (const section of mapping.sections) {
        const fullPath = path.join(projectDir, section.output_path);
        if (!fs.existsSync(fullPath)) continue;

        const code = fs.readFileSync(fullPath, 'utf-8');
        if (!code.trim()) continue;

        try {
            const prettied = await prettier.format(code, FORMATTER_SPECS);
            const spaced = spaceFunctions(prettied);
            fs.writeFileSync(fullPath, spaced);
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
        console.log('Usage: bun run src/prettify.ts <project_dir>');
        process.exit(1);
    }
    prettifyProject(args[0]);
}
