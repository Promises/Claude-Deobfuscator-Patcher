/**
 * Split an esbuild bundle into individual module files.
 *
 * Uses the TypeScript parser to properly handle string literals,
 * template literals, regex, and nested scopes — no fragile regex.
 *
 * Detects CJS (d) and ESM (G) module wrapper patterns from the preamble,
 * then extracts each `var NAME = WRAPPER((...) => {...})` declaration.
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";

export interface Section {
  index: number;
  filename: string;
  type: "preamble" | "section" | "tail";
  size: number;
  start: number;
  end: number;
  moduleName?: string;
  moduleKind?: string;
  hasGlue?: boolean;
  glueSize?: number;
}

export interface Manifest {
  sourceFile: string;
  sourceSize: number;
  sectionCount: number;
  wrapperNames: { cjs: string | null; esm: string | null };
  sections: Section[];
}

/**
 * Auto-detect CJS and ESM wrapper function names from the preamble.
 *
 * CJS pattern: var d=(H,_)=>()=>(_||H((_={exports:{}}).exports,_),_.exports)
 * ESM pattern: var G=(H,_)=>()=>(H&&(_=H(H=0)),_)
 */
function detectWrapperNames(source: string): { cjs: string | null; esm: string | null } {
  const preamble = source.slice(0, 5000);

  // CJS: contains {exports:{}} pattern — may start with var or ,
  const cjsMatch = preamble.match(
    /(?:var|,)\s*(\w{1,3})\s*=\s*\(\w,\w\)\s*=>\s*\(\)\s*=>\s*\(\w\|\|\w\(\(\w=\{exports:\{/
  );

  // ESM: the &&/=0 pattern — may start with var or ,
  const esmMatch = preamble.match(
    /(?:var|,)\s*(\w{1,3})\s*=\s*\(\w,\w\)\s*=>\s*\(\)\s*=>\s*\(\w&&\(\w=\w\(\w=0\)\)/
  );

  return {
    cjs: cjsMatch?.[1] ?? null,
    esm: esmMatch?.[1] ?? null,
  };
}

/**
 * Find the matching closing paren/brace using the TS scanner.
 * More reliable than manual parsing since it handles all JS syntax.
 */
function findMatchingParen(source: string, openPos: number): number {
  let depth = 0;
  const openChar = source[openPos];
  const closeChar = openChar === "(" ? ")" : openChar === "{" ? "}" : "]";

  // Use a simple stack-based approach with string awareness
  let i = openPos;
  let inString: string | null = null;

  while (i < source.length) {
    const c = source[i];

    if (inString) {
      if (c === "\\" ) { i += 2; continue; }
      if (c === inString) inString = null;
      i++;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      i++;
      continue;
    }

    // Skip comments
    if (c === "/" && i + 1 < source.length) {
      if (source[i + 1] === "/") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl + 1;
        continue;
      }
      if (source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
        continue;
      }
    }

    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
    }

    i++;
  }

  return -1;
}

/**
 * Extract string hints from module body for the manifest.
 */
function extractHints(body: string): {
  requires?: string[];
  strings?: string[];
  errors?: string[];
} {
  const hints: Record<string, string[]> = {};

  // require() calls
  const requires = [...body.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  if (requires.length) hints.requires = [...new Set(requires)].slice(0, 10);

  // Significant strings
  const strings = [...body.matchAll(/"([A-Za-z][\w\-\./ ]{5,80})"/g)]
    .map((m) => m[1])
    .filter((s) => !["object", "function", "string", "number", "create"].includes(s));
  const uniqueStrings = [...new Set(strings)].slice(0, 10);
  if (uniqueStrings.length) hints.strings = uniqueStrings;

  // Error messages
  const errors = [
    ...body.matchAll(/(?:Error|throw|error)\s*\(\s*["`]([^"`]{10,100})/g),
  ].map((m) => m[1]);
  if (errors.length) hints.errors = [...new Set(errors)].slice(0, 5);

  return hints;
}

export function splitSource(sourcePath: string, outputDir: string): Manifest {
  const source = fs.readFileSync(sourcePath, "utf-8");
  console.log(`Reading ${sourcePath}...`);
  console.log(`  ${source.length.toLocaleString()} chars`);

  const wrappers = detectWrapperNames(source);

  // Fallback: detect by frequency analysis if auto-detection fails
  if (!wrappers.cjs || !wrappers.esm) {
    // Only consider names that are defined as thunk factories: var X=(a,b)=>()=>
    const thunkDefs = new Set<string>();
    for (const m of source.slice(0, 5000).matchAll(/var (\w{1,3})=\(\w,\w\)=>\(\)=>/g)) {
      thunkDefs.add(m[1]);
    }
    // Count how often each thunk is used as a module wrapper: var NAME=WRAPPER((
    const freq = new Map<string, number>();
    for (const m of source.matchAll(/var \w+=(\w{1,3})\(\(/g)) {
      if (thunkDefs.has(m[1])) freq.set(m[1], (freq.get(m[1]) || 0) + 1);
    }
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 1 && !wrappers.esm) wrappers.esm = sorted[0][0];
    if (sorted.length >= 2 && !wrappers.cjs) wrappers.cjs = sorted[1][0];
  }

  console.log(`  Wrapper functions: CJS=${wrappers.cjs}, ESM=${wrappers.esm}`);

  const wrapperNames = [wrappers.cjs, wrappers.esm].filter(Boolean);
  if (!wrapperNames.length) {
    throw new Error("No wrapper functions detected");
  }

  // Find all module declarations: var NAME = WRAPPER((
  const wrapperPattern = new RegExp(
    `var (\\w+)=(${wrapperNames.map((n) => n!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\(\\(`,
    "g"
  );

  const modules: Array<{
    name: string;
    kind: string;
    start: number;
    end: number;
  }> = [];

  let match: RegExpExecArray | null;
  let lastModuleEnd = 0;
  while ((match = wrapperPattern.exec(source)) !== null) {
    // Skip if this match starts inside a previous module (overlap)
    if (match.index < lastModuleEnd) continue;

    // Pattern matched: var NAME=WRAPPER((
    // match[0] ends at the second (, so the first ( is at length-2, second at length-1
    const outerParen = match.index + match[0].length - 2; // WRAPPER( ← this one
    const closeParen = findMatchingParen(source, outerParen);
    if (closeParen === -1) continue;

    const moduleSize = closeParen - outerParen;

    // Validation: inner content should start with a function factory pattern
    // Real: WRAPPER((params) => {...})  or WRAPPER(() => {...})
    // False: WRAPPER((someValue))
    const innerParen = outerParen + 1; // The second ( — start of the factory function params
    const innerSample = source.slice(innerParen, Math.min(innerParen + 200, closeParen));
    const looksLikeModule = /^\([^)]*\)\s*=>/.test(innerSample) ||
                            /^\(\s*function/.test(innerSample) ||
                            innerSample.includes("function");
    if (!looksLikeModule) continue;

    // Sanity: skip impossibly large modules (>500KB)
    if (moduleSize > 500_000) continue;

    let moduleEnd = closeParen + 1;
    if (moduleEnd < source.length && source[moduleEnd] === ";") moduleEnd++;

    // Must not overlap with previous module
    if (match.index < lastModuleEnd) continue;

    modules.push({
      name: match[1],
      kind: match[2],
      start: match.index,
      end: moduleEnd,
    });
    lastModuleEnd = moduleEnd;
  }

  console.log(`  ${modules.length} modules found`);

  // Build sections: preamble (before first module), then glue+module pairs, then tail
  const sections: Section[] = [];
  let pos = 0;
  let idx = 0;

  // Preamble: everything before the first module
  if (modules.length > 0 && modules[0].start > 0) {
    sections.push({
      index: idx,
      filename: `${String(idx).padStart(4, "0")}_preamble.js`,
      type: "preamble",
      size: modules[0].start,
      start: 0,
      end: modules[0].start,
    });
    idx++;
    pos = modules[0].start;
  }

  for (const mod of modules) {
    // Include any glue code between previous module end and this module start
    const hasGlue = mod.start > pos;
    const sectionStart = hasGlue ? pos : mod.start;

    sections.push({
      index: idx,
      filename: `${String(idx).padStart(4, "0")}_${mod.name}.js`,
      type: "section",
      size: mod.end - sectionStart,
      start: sectionStart,
      end: mod.end,
      moduleName: mod.name,
      moduleKind: mod.kind,
      hasGlue,
      glueSize: hasGlue ? mod.start - pos : undefined,
    });
    idx++;
    pos = mod.end;
  }

  // Tail
  if (pos < source.length) {
    sections.push({
      index: idx,
      filename: `${String(idx).padStart(4, "0")}_tail.js`,
      type: "tail",
      size: source.length - pos,
      start: pos,
      end: source.length,
    });
  }

  // Verify coverage
  const totalSize = sections.reduce((sum, s) => sum + s.size, 0);
  if (totalSize !== source.length) {
    throw new Error(`Coverage mismatch: ${totalSize} vs ${source.length}`);
  }

  // Write files
  fs.mkdirSync(outputDir, { recursive: true });

  for (const section of sections) {
    const body = source.slice(section.start, section.end);
    fs.writeFileSync(path.join(outputDir, section.filename), body);

    // Add hints for sections
    if (section.type === "section") {
      const hints = extractHints(body);
      (section as any).hints = hints;
    }
  }

  // Write manifest
  const manifest: Manifest = {
    sourceFile: path.basename(sourcePath),
    sourceSize: source.length,
    sectionCount: sections.length,
    wrapperNames: wrappers,
    sections,
  };

  fs.writeFileSync(
    path.join(outputDir, "_manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`\nWrote ${sections.length} sections to ${outputDir}/`);
  console.log(`  Preamble: ${sections.filter((s) => s.type === "preamble").length}`);
  console.log(`  Modules: ${sections.filter((s) => s.type === "section").length}`);
  console.log(`  Tail: ${sections.filter((s) => s.type === "tail").length}`);

  return manifest;
}

// CLI entry
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/splitter.ts <source.js> [output_dir]");
    process.exit(1);
  }
  splitSource(args[0], args[1] || "modules");
}
