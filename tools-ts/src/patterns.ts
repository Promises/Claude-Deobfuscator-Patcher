/**
 * AST-powered pattern finder — locates hookable functions and structures
 * in minified JS using the TypeScript compiler API.
 *
 * Finds: session ID function, StructuredIO class, query function with
 * for-await loops, call graphs from anchors.
 */

import ts from "typescript";
import * as fs from "fs";

export interface PatternResults {
  sessionIdFunc?: { name: string; stateVar: string; offset: number };
  sessionIdSetter?: { name: string; offset: number };
  structuredIO?: { className: string; offset: number; methodsFound: number; methods: string[] };
  queryFunction?: { name: string; offset: number; loops: ForAwaitLoop[] };
  prependUserMessageSites: number;
}

export interface ForAwaitLoop {
  iteratorVar: string;
  iterableFunc: string;
  offset: number;
  bodyOffset: number;
  hasBraces: boolean;
}

export function findPatterns(sourceCode: string): PatternResults {
  const sf = ts.createSourceFile("source.js", sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const results: PatternResults = { prependUserMessageSites: 0 };

  // Track all function declarations for call graph analysis
  const functionBodies = new Map<string, ts.Node>(); // name → node
  const functionOffsets = new Map<string, number>();

  function visit(node: ts.Node) {
    // 1. Session ID function: function XX(){return YY.sessionId}
    if (ts.isFunctionDeclaration(node) && node.name && node.body?.statements.length === 1) {
      const stmt = node.body.statements[0];
      if (ts.isReturnStatement(stmt) && stmt.expression &&
          ts.isPropertyAccessExpression(stmt.expression) &&
          stmt.expression.name.text === "sessionId") {
        const stateVar = ts.isIdentifier(stmt.expression.expression)
          ? stmt.expression.expression.text : "unknown";
        results.sessionIdFunc = {
          name: node.name.text,
          stateVar,
          offset: node.getStart(sf),
        };
      }
    }

    // 2. Session ID setter: function that does XX.sessionId = YY.randomUUID()
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const text = node.body.getText(sf);
      if (text.includes(".sessionId=") && text.includes(".randomUUID()")) {
        results.sessionIdSetter = {
          name: node.name.text,
          offset: node.getStart(sf),
        };
      }
    }

    // 3. StructuredIO class — has prependUserMessage, injectControlResponse
    if (ts.isClassDeclaration(node)) {
      const methodNames: string[] = [];
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methodNames.push(member.name.text);
        }
        if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methodNames.push(member.name.text);
        }
        // Getter
        if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          methodNames.push(member.name.text);
        }
      }

      const target = ["prependUserMessage", "injectControlResponse", "getPendingPermissionRequests"];
      const found = target.filter((t) => methodNames.includes(t));
      if (found.length >= 2) {
        results.structuredIO = {
          className: node.name?.text || "anonymous",
          offset: node.getStart(sf),
          methodsFound: found.length,
          methods: methodNames,
        };
      }
    }

    // Track function declarations for call graph
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionBodies.set(node.name.text, node);
      functionOffsets.set(node.name.text, node.getStart(sf));
    }

    // 4. Count prependUserMessage references
    if (ts.isIdentifier(node) && node.text === "prependUserMessage") {
      results.prependUserMessageSites++;
    }

    // 5. For-await loops
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      const init = node.initializer;
      let iterVar = "unknown";
      if (ts.isVariableDeclarationList(init) && init.declarations.length === 1) {
        const decl = init.declarations[0];
        if (ts.isIdentifier(decl.name)) iterVar = decl.name.text;
      }

      let iterFunc = "unknown";
      const expr = node.expression;
      if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
        iterFunc = expr.expression.text;
      }

      const bodyNode = node.statement;
      const hasBraces = ts.isBlock(bodyNode);

      // Check if this is inside a function that uses session_id
      const bodyText = bodyNode.getText(sf);
      const parentFunc = findEnclosingFunction(node, sf);

      if (parentFunc) {
        // Store for later — we'll check if the parent function references sessionId
        if (!results.queryFunction) {
          // Check if parent function body references session_id or sessionId
          const parentBody = parentFunc.getText(sf);
          if (parentBody.includes("session_id") || parentBody.includes("sessionId")) {
            const funcName = ts.isFunctionDeclaration(parentFunc) && parentFunc.name
              ? parentFunc.name.text : "anonymous";
            results.queryFunction = {
              name: funcName,
              offset: parentFunc.getStart(sf),
              loops: [],
            };
          }
        }

        if (results.queryFunction) {
          results.queryFunction.loops.push({
            iteratorVar: iterVar,
            iterableFunc: iterFunc,
            offset: node.getStart(sf),
            bodyOffset: bodyNode.getStart(sf),
            hasBraces,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // If we found session_id func but no query function yet, use call graph
  if (results.sessionIdFunc && !results.queryFunction) {
    const sidName = results.sessionIdFunc.name;
    // Find functions that call the session ID function
    for (const [funcName, funcNode] of functionBodies) {
      const text = funcNode.getText(sf);
      if (text.includes(`${sidName}(`) && text.includes("for await")) {
        // This function calls session ID and has for-await — likely the query function
        results.queryFunction = {
          name: funcName,
          offset: functionOffsets.get(funcName) || 0,
          loops: [],
        };

        // Re-scan for loops within this function
        function findLoops(node: ts.Node) {
          if (ts.isForOfStatement(node) && node.awaitModifier) {
            const init = node.initializer;
            let iterVar = "unknown";
            if (ts.isVariableDeclarationList(init) && init.declarations.length === 1) {
              const decl = init.declarations[0];
              if (ts.isIdentifier(decl.name)) iterVar = decl.name.text;
            }
            let iterFunc = "unknown";
            if (ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
              iterFunc = node.expression.expression.text;
            }

            results.queryFunction!.loops.push({
              iteratorVar: iterVar,
              iterableFunc: iterFunc,
              offset: node.getStart(sf),
              bodyOffset: node.statement.getStart(sf),
              hasBraces: ts.isBlock(node.statement),
            });
          }
          ts.forEachChild(node, findLoops);
        }
        findLoops(funcNode);
        break;
      }
    }
  }

  return results;
}

function findEnclosingFunction(node: ts.Node, sf: ts.SourceFile): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function findAllPatterns(sourcePath: string): PatternResults {
  const code = fs.readFileSync(sourcePath, "utf-8");
  console.log(`Analyzing ${sourcePath} (${(code.length / 1e6).toFixed(1)}MB)...`);

  const results = findPatterns(code);

  if (results.sessionIdFunc) {
    console.log(`  SessionID: ${results.sessionIdFunc.name}() returns ${results.sessionIdFunc.stateVar}.sessionId`);
  } else {
    console.log(`  SessionID: NOT FOUND`);
  }

  if (results.structuredIO) {
    console.log(`  StructuredIO: class ${results.structuredIO.className} (${results.structuredIO.methodsFound} target methods)`);
  } else {
    console.log(`  StructuredIO: NOT FOUND`);
  }

  if (results.queryFunction) {
    console.log(`  QueryFunc: ${results.queryFunction.name}() with ${results.queryFunction.loops.length} for-await loops`);
    for (const loop of results.queryFunction.loops) {
      console.log(`    Loop: for await(let ${loop.iteratorVar} of ${loop.iterableFunc}(...)) braces=${loop.hasBraces}`);
    }
  } else {
    console.log(`  QueryFunc: NOT FOUND`);
  }

  console.log(`  prependUserMessage sites: ${results.prependUserMessageSites}`);

  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/patterns.ts <source.js> [--all-versions <dir>]");
    process.exit(1);
  }

  if (args[0] === "--all-versions" && args[1]) {
    const dir = args[1];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith("-cli.js")).sort();
    const summary: Array<{ version: string; sid: string; sio: string; qf: string; loops: number }> = [];

    for (const file of files) {
      const version = file.replace("-cli.js", "");
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Version: ${version}`);
      console.log("=".repeat(60));
      const results = findAllPatterns(`${dir}/${file}`);
      summary.push({
        version,
        sid: results.sessionIdFunc?.name || "-",
        sio: results.structuredIO?.className || "-",
        qf: results.queryFunction?.name || "-",
        loops: results.queryFunction?.loops.length || 0,
      });
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log("Version    SID          SIO          QF           Loops");
    console.log("-".repeat(60));
    for (const s of summary) {
      console.log(
        `${s.version.padEnd(10)} ${s.sid.padEnd(12)} ${s.sio.padEnd(12)} ${s.qf.padEnd(12)} ${s.loops}`
      );
    }
  } else {
    findAllPatterns(args[0]);
  }
}
