/**
 * Apply global anchor-rule renames across all deobfuscated files.
 *
 * Uses the TS AST to rename only identifiers, never string contents.
 * This prevents false positives like renaming "bg" inside chalk's
 * string concatenation `"bg" + name[0].toUpperCase()`.
 */

import ts from "typescript";
import { applyAnchorRules } from "./anchor-rules";
import type { MatchResult } from "./constraint-renamer";
import * as fs from "fs";
import * as path from "path";

// Walk expressions that target function-scoped identifiers (params, locals).
// These must NOT be applied globally — they share minified names across files.
const SCOPED_WALK_PATTERNS = /\bparam:|local:/;

function applyGlobalRenames(deobDir: string, rulesPath: string): number {
    const matches = applyAnchorRules(deobDir, rulesPath);
    if (matches.length === 0) return 0;

    // Filter out scoped renames — only keep globals
    const globalMatches = matches.filter(m => !SCOPED_WALK_PATTERNS.test(m.reason));
    console.log(`  Global: ${globalMatches.length}/${matches.length} renames (${matches.length - globalMatches.length} scoped, skipped)`);

    // Build rename map: minified → original
    const renames = new Map<string, string>();
    for (const m of globalMatches) {
        if (renames.has(m.minified)) {
            if (renames.get(m.minified) !== m.original) {
                console.warn(`  dup anchor: ${m.minified} → ${m.original} (already mapped to ${renames.get(m.minified)})`);
            }
            continue;
        }
        renames.set(m.minified, m.original);
    }

    // Walk all .js files and rename identifiers via AST
    let totalReplacements = 0;
    let filesModified = 0;

    function walkDir(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDir(full);
            } else if (entry.name.endsWith(".js")) {
                const code = fs.readFileSync(full, "utf-8");
                const result = renameIdentifiers(code, entry.name, renames);
                if (result.count > 0) {
                    fs.writeFileSync(full, result.code);
                    totalReplacements += result.count;
                    filesModified++;
                }
            }
        }
    }

    walkDir(deobDir);
    return totalReplacements;
}

/**
 * Rename identifiers in source code using the TS AST.
 * Only touches Identifier nodes — strings, comments, etc. are untouched.
 */
function renameIdentifiers(code: string, filename: string, renames: Map<string, string>): { code: string; count: number } {
    const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    // Collect all identifier positions that need renaming (reverse order for safe splicing)
    const edits: Array<{ start: number; end: number; newName: string }> = [];

    function visit(node: ts.Node) {
        if (ts.isIdentifier(node)) {
            const newName = renames.get(node.text);
            if (newName) {
                const parent = node.parent;
                // Skip property names — these aren't variable references:
                //   x.bg      → PropertyAccessExpression.name
                //   { bg: v } → PropertyAssignment.name
                //   { bg }    → ShorthandPropertyAssignment.name
                const isPropName =
                    (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
                    (parent && ts.isPropertyAssignment(parent) && parent.name === node) ||
                    (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node);
                if (!isPropName) {
                    edits.push({
                        start: node.getStart(sf),
                        end: node.getEnd(),
                        newName,
                    });
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);

    if (edits.length === 0) return { code, count: 0 };

    // Apply edits in reverse order to preserve positions
    edits.sort((a, b) => b.start - a.start);
    let result = code;
    for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.newName + result.slice(edit.end);
    }

    return { code: result, count: edits.length };
}

// CLI
if (import.meta.main) {
    const deobDir = process.argv[2];
    const rulesPath = process.argv[3];

    if (!deobDir || !rulesPath) {
        console.error("Usage: apply-global-renames <deob-dir> <rules.json>");
        process.exit(1);
    }

    const count = applyGlobalRenames(path.resolve(deobDir), path.resolve(rulesPath));
    console.log(`  Anchor rules (global): ${count} replacements`);
}
