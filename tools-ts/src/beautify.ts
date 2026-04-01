/**
 * Beautify minified JS files using the TypeScript compiler API.
 *
 * Parses each file as JS, then re-emits it with the TS printer
 * which adds proper indentation and line breaks.
 *
 * For reassembly, the reverse operation strips all non-essential whitespace.
 */

import ts from "typescript";

/**
 * Beautify a JS code string using the TS printer.
 */
export function beautify(code: string, filename = "module.js"): string {
  const sourceFile = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
    omitTrailingSemicolon: false,
  });

  return printer.printFile(sourceFile);
}

/**
 * Minify beautified JS back — strip formatting whitespace so it
 * matches the original minified form for byte-exact reassembly.
 *
 * This is NOT a general-purpose minifier. It only reverses what
 * the TS printer added: indentation, line breaks between statements,
 * spaces around operators that the printer inserts.
 *
 * Preserves strings, template literals, and regex exactly.
 */
export function minify(code: string): string {
  // Use the TS scanner to tokenize, then reconstruct without whitespace
  // This is safer than regex since it handles strings/templates correctly
  const sourceFile = ts.createSourceFile(
    "module.js",
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );

  // Walk all tokens and reconstruct
  const result: string[] = [];
  let lastEnd = 0;

  function visit(node: ts.Node) {
    // For leaf tokens, grab the text
    if (node.getChildCount(sourceFile) === 0) {
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      const text = code.slice(start, end);

      // Check if we need a separator between this token and the last
      if (result.length > 0 && start > lastEnd) {
        const gap = code.slice(lastEnd, start);
        // Keep exactly one space if the gap contains only whitespace
        // and the tokens need separation (identifiers, keywords)
        if (/\S/.test(gap)) {
          // There's non-whitespace in the gap (comments?) — keep it
          result.push(gap);
        } else if (needsSeparator(result[result.length - 1], text)) {
          result.push(" ");
        }
      }

      result.push(text);
      lastEnd = end;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return result.join("");
}

function needsSeparator(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  const lastChar = prev[prev.length - 1];
  const firstChar = next[0];

  // Two identifiers/keywords need a space
  const isIdChar = (c: string) => /[\w$]/.test(c);
  if (isIdChar(lastChar) && isIdChar(firstChar)) return true;

  // Operators that could merge: ++ becomes + +, etc
  if (lastChar === "+" && firstChar === "+") return true;
  if (lastChar === "-" && firstChar === "-") return true;
  if (lastChar === "/" && firstChar === "/") return true;
  if (lastChar === "/" && firstChar === "*") return true;

  return false;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/beautify.ts <file.js> [--minify]");
    process.exit(1);
  }

  const fs = await import("fs");
  const code = fs.readFileSync(args[0], "utf-8");

  if (args.includes("--minify")) {
    process.stdout.write(minify(code));
  } else {
    process.stdout.write(beautify(code));
  }
}
