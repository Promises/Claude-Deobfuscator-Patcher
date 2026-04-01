/**
 * Extract identification signatures from TypeScript/JavaScript source files
 * using the TypeScript compiler API for proper AST parsing.
 *
 * Extracts per-file: string literals, method names, property names, exports,
 * class names, error strings — all the things that survive minification.
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";

export interface FileSignature {
  path: string;
  size: number;
  strings: string[];
  uniqueStrings: string[];
  rareStrings: string[];
  errorStrings: string[];
  methods: string[];
  properties: string[];
  exports: string[];
  classNames: string[];
  imports: string[];
  numericConstants: number[];
}

export interface SignatureDB {
  sourceDir: string;
  fileCount: number;
  totalUniqueStrings: number;
  signatures: Record<string, FileSignature>;
}

function extractFromAST(sourceFile: ts.SourceFile): {
  strings: Set<string>;
  errorStrings: Set<string>;
  methods: Set<string>;
  properties: Set<string>;
  exports: Set<string>;
  classNames: Set<string>;
  imports: Set<string>;
  numericConstants: Set<number>;
} {
  const strings = new Set<string>();
  const errorStrings = new Set<string>();
  const methods = new Set<string>();
  const properties = new Set<string>();
  const exports = new Set<string>();
  const classNames = new Set<string>();
  const imports = new Set<string>();
  const numericConstants = new Set<number>();

  function visit(node: ts.Node) {
    // String literals
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (text.length >= 4 && !text.startsWith("use ")) {
        strings.add(text);
      }
    }

    // Template literal heads
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      const text = node.text.trim();
      if (text.length >= 4) strings.add(text);
    }

    // Error strings: new Error("..."), throw new XError("...")
    if (ts.isNewExpression(node) && node.arguments?.length) {
      const expr = node.expression;
      const name = ts.isIdentifier(expr) ? expr.text :
                   ts.isPropertyAccessExpression(expr) ? expr.name.text : "";
      if (name.includes("Error") || name === "Error") {
        const firstArg = node.arguments[0];
        if (ts.isStringLiteral(firstArg) && firstArg.text.length >= 8) {
          errorStrings.add(firstArg.text);
        }
      }
    }

    // Method declarations (class methods)
    if (ts.isMethodDeclaration(node) && node.name) {
      const name = ts.isIdentifier(node.name) ? node.name.text :
                   ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name && name.length >= 2) methods.add(name);
    }

    // Property declarations with this.xxx
    if (ts.isPropertyAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const name = node.name.text;
      if (name.length >= 2) properties.add(name);
    }

    // Property declarations in classes
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      properties.add(node.name.text);
    }

    // Export declarations
    if (ts.isFunctionDeclaration(node) && node.name &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.add(node.name.text);
      classNames.add(node.name.text);
    }
    if (ts.isVariableStatement(node) &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) exports.add(decl.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        exports.add(spec.name.text);
      }
    }
    if (ts.isTypeAliasDeclaration(node) && node.name &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.add(node.name.text);
    }
    if (ts.isInterfaceDeclaration(node) && node.name &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.add(node.name.text);
    }

    // Class names (exported or not)
    if (ts.isClassDeclaration(node) && node.name) {
      classNames.add(node.name.text);
    }

    // Import sources
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    }
    // Dynamic imports
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) imports.add(arg.text);
    }

    // Numeric constants: const XX = number
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.initializer && ts.isNumericLiteral(node.initializer)) {
      const name = node.name.text;
      const val = parseInt(node.initializer.text, 10);
      if (/^[A-Z_]+$/.test(name) && val > 10) {
        numericConstants.add(val);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { strings, errorStrings, methods, properties, exports, classNames, imports, numericConstants };
}

export function extractSignatures(sourceDir: string, outputPath?: string): SignatureDB {
  const signatures: Record<string, FileSignature> = {};
  const allStrings = new Map<string, Set<string>>(); // string → set of file paths

  // Find all source files
  function walkDir(dir: string): string[] {
    const results: string[] = [];
    const skipDirs = new Set([".git", "node_modules", "dist", "_build", ".deob_cache"]);

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !skipDirs.has(entry.name)) {
        results.push(...walkDir(path.join(dir, entry.name)));
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
    return results;
  }

  const files = walkDir(sourceDir);
  console.log(`Scanning ${files.length} source files...`);

  for (const filePath of files) {
    const relPath = path.relative(sourceDir, filePath);
    let code: string;
    try {
      code = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      code,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const extracted = extractFromAST(sourceFile);

    // Track string uniqueness
    for (const s of extracted.strings) {
      if (!allStrings.has(s)) allStrings.set(s, new Set());
      allStrings.get(s)!.add(relPath);
    }

    signatures[relPath] = {
      path: relPath,
      size: code.length,
      strings: [...extracted.strings].sort(),
      uniqueStrings: [], // filled in second pass
      rareStrings: [],
      errorStrings: [...extracted.errorStrings].sort(),
      methods: [...extracted.methods].sort(),
      properties: [...extracted.properties].sort(),
      exports: [...extracted.exports].sort(),
      classNames: [...extracted.classNames].sort(),
      imports: [...extracted.imports].sort(),
      numericConstants: [...extracted.numericConstants].sort(),
    };
  }

  // Second pass: compute uniqueness
  for (const [relPath, sig] of Object.entries(signatures)) {
    sig.uniqueStrings = sig.strings.filter((s) => allStrings.get(s)?.size === 1).sort();
    sig.rareStrings = sig.strings.filter((s) => {
      const count = allStrings.get(s)?.size ?? 0;
      return count > 1 && count <= 3;
    }).sort();
  }

  const totalUnique = [...allStrings.entries()].filter(([, files]) => files.size === 1).length;

  const db: SignatureDB = {
    sourceDir: path.basename(sourceDir),
    fileCount: Object.keys(signatures).length,
    totalUniqueStrings: totalUnique,
    signatures,
  };

  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(db, null, 2));
    console.log(`Wrote ${db.fileCount} signatures to ${outputPath}`);
    console.log(`  Total unique strings: ${totalUnique}`);
  }

  return db;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/signatures.ts <source_dir> [output.json]");
    process.exit(1);
  }
  extractSignatures(args[0], args[1]);
}
