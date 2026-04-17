/**
 * Interactive anchor rule development tool.
 *
 * Usage:
 *   bun run src/anchor-dev.ts <deob-dir> [rules.json]
 *
 * Commands:
 *   build global|scoped|full|rename|clean — run entrypoint.sh to prepare files
 *   resolve [id]           — resolve all rules (or one by id), show results
 *   from <id>              — set context to a resolved anchor
 *   walk <expr>            — try a walk expression from current context
 *   inspect                — show AST info: params, locals, strings, returns
 *   strings                — list all string literals in scope
 *   params                 — list parameters
 *   locals                 — list local variable declarations
 *   returns                — list return statements (summarized)
 *   calls                  — list function calls in scope
 *   members                — list property accesses (X.foo)
 *   source [lines]         — print source of current node (default 30 lines)
 *   find <type> <value>    — test a find criteria (string_literal, text, regex, etc.)
 *   scope <type>           — from last find, walk up to scope
 *   apply [id]             — apply a resolved rename to the file (tracks applied)
 *   applied                — list applied renames this session
 *   mode [global|scoped]   — show or switch mode
 *   rules                  — list all rules from anchor-rules.json
 *   help                   — show commands
 *   quit                   — exit
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import { applyAnchorRules } from "./anchor-rules";
import type { MatchResult } from "./constraint-renamer";

// ── Types ───────────────────────────────────────────────────────────────────

interface Resolved {
    id: string;
    file: string;
    minifiedName: string;
    nodeStart?: number;
    nodeEnd?: number;
}

interface AppliedRename {
    id: string;
    file: string;
    minified: string;
    original: string;
    type: "global" | "scoped";
}

// ── State ───────────────────────────────────────────────────────────────────

// Parse args: <deob-dir> [rules.json] [-- commands...]
// "--" can appear as argv[3] (no rules path) or argv[4] (with rules path)
const dashIdx = process.argv.indexOf("--");
const positionalArgs = dashIdx !== -1 ? process.argv.slice(2, dashIdx) : process.argv.slice(2);

const deobDir = path.resolve(positionalArgs[0] ?? "deobfuscated");
const rulesPath = positionalArgs[1] ? path.resolve(positionalArgs[1]) : path.resolve("tools-ts/anchor-rules.json");
const entrypointDir = path.resolve(path.dirname(deobDir)); // patch-ref/
const entrypoint = path.join(entrypointDir, "entrypoint.sh");

if (!fs.existsSync(deobDir)) {
    console.error(`Error: deob dir not found: ${deobDir}`);
    process.exit(1);
}

let mode: "global" | "scoped" = "global";
const resolvedById = new Map<string, Resolved>();
let resolveResults: MatchResult[] = [];
const appliedRenames: AppliedRename[] = [];

// Current context
let currentAnchor: Resolved | null = null;
let currentNode: ts.Node | null = null;
let currentSf: ts.SourceFile | null = null;
let currentCode: string | null = null;

// Last find result (for scope command)
let lastFindPos: number = -1;
let lastFindFile: string | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadFile(file: string): { code: string; sf: ts.SourceFile } | null {
    const filePath = path.join(deobDir, file);
    if (!fs.existsSync(filePath)) {
        console.log(`  File not found: ${filePath}`);
        return null;
    }
    const code = fs.readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return { code, sf };
}

function getNodeName(node: ts.Node): string | null {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text ?? null;
    if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
        if (node.name) return node.name.text;
        if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
            return node.parent.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isArrowFunction(node) && node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
        return node.parent.name.text;
    return null;
}

function findNodeByName(sf: ts.SourceFile, name: string): ts.Node | null {
    let found: ts.Node | null = null;
    function visit(node: ts.Node) {
        if (found) return;
        if (getNodeName(node) === name) { found = node; return; }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return found;
}

function findNodeAtPosition(sf: ts.SourceFile, start: number, end: number): ts.Node | null {
    let best: ts.Node | null = null;
    function visit(node: ts.Node) {
        const ns = node.getStart(sf);
        const ne = node.end;
        if (ns === start && ne === end) { best = node; return; }
        if (ns <= start && end <= ne) ts.forEachChild(node, visit);
    }
    visit(sf);
    return best;
}

type Scope = "function" | "async_generator" | "generator" | "async_function" | "method" | "class" | "arrow";

function scopeMatches(node: ts.Node, scope: Scope): boolean {
    const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node);
    const isAsync = isFn && !!(node as ts.FunctionDeclaration).modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
    const isGen = isFn && !!(node as ts.FunctionDeclaration).asteriskToken;

    switch (scope) {
        case "function": return isFn;
        case "async_generator": return isFn && isAsync && isGen;
        case "generator": return isFn && isGen;
        case "async_function": return isFn && isAsync;
        case "method": return ts.isMethodDeclaration(node);
        case "class": return ts.isClassDeclaration(node) || ts.isClassExpression(node);
        case "arrow": return ts.isArrowFunction(node);
    }
}

function findContainingScope(sf: ts.SourceFile, pos: number, scope: Scope): ts.Node | null {
    let deepest: ts.Node = sf;
    function descend(node: ts.Node) {
        if (node.getStart(sf) <= pos && pos <= node.end) {
            deepest = node;
            ts.forEachChild(node, descend);
        }
    }
    descend(sf);
    let cur: ts.Node | undefined = deepest;
    while (cur) {
        if (scopeMatches(cur, scope)) return cur;
        cur = cur.parent;
    }
    return null;
}

function setContext(anchor: Resolved) {
    currentAnchor = anchor;
    const loaded = loadFile(anchor.file);
    if (!loaded) return;
    currentCode = loaded.code;
    currentSf = loaded.sf;

    if (anchor.nodeStart !== undefined && anchor.nodeEnd !== undefined) {
        currentNode = findNodeAtPosition(loaded.sf, anchor.nodeStart, anchor.nodeEnd);
    } else {
        currentNode = findNodeByName(loaded.sf, anchor.minifiedName);
    }
    if (!currentNode) {
        console.log(`  Warning: could not find node for anchor "${anchor.id}" (${anchor.minifiedName})`);
    }
}

function nodeKindLabel(node: ts.Node): string {
    const kind = ts.SyntaxKind[node.kind];
    const name = getNodeName(node);
    const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node);
    let extra = "";
    if (isFn) {
        const isAsync = !!(node as ts.FunctionDeclaration).modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
        const isGen = !!(node as ts.FunctionDeclaration).asteriskToken;
        if (isAsync && isGen) extra = " (async generator)";
        else if (isAsync) extra = " (async)";
        else if (isGen) extra = " (generator)";
    }
    return `${kind}${extra}${name ? ` "${name}"` : ""}`;
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdResolve(args: string) {
    process.env.ANCHOR_VERBOSE = "1";
    resolveResults = applyAnchorRules(deobDir, rulesPath);
    delete process.env.ANCHOR_VERBOSE;

    // Rebuild resolvedById by re-running resolution logic
    resolvedById.clear();
    const rules = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    // Re-run resolution to populate resolvedById (simplified — reuse the engine internals)
    resolveInternally(rules);

    if (args) {
        const match = resolveResults.find(r => r.original === args) ?? resolveResults.find(r => r.minified === args);
        if (match) console.log(`  ${match.minified} → ${match.original} (${match.confidence}%) — ${match.reason}`);
        else {
            const anchor = resolvedById.get(args);
            if (anchor) console.log(`  [anchor-only] ${anchor.id}: ${anchor.minifiedName} in ${anchor.file}` +
                (anchor.nodeStart !== undefined ? ` (pos ${anchor.nodeStart}..${anchor.nodeEnd})` : ""));
            else console.log(`  Not found: ${args}`);
        }
    } else {
        console.log(`\n  Resolved ${resolveResults.length} renames, ${resolvedById.size} anchors total:\n`);
        for (const r of resolveResults) {
            console.log(`  ${r.minified.padEnd(30)} → ${r.original.padEnd(35)} (${r.confidence}%)`);
        }
        console.log();
        // Show anchor-only entries
        for (const [id, a] of resolvedById) {
            if (!resolveResults.some(r => r.original === id || r.minified === a.minifiedName)) {
                console.log(`  [anchor-only] ${id.padEnd(30)}   ${a.minifiedName.padEnd(35)} ${a.file}`);
            }
        }
    }
}

function resolveInternally(rules: any[]) {
    // Simplified resolution to populate resolvedById — mirrors applyAnchorRules logic
    type FindCriteria = any;
    type RootRule = any;
    type WalkRule = any;

    const isWalk = (r: any) => "from" in r;

    // Import the walk and find helpers from anchor-rules dynamically
    // Since we can't easily import internals, we do a mini-resolve here
    for (const rule of rules.filter((r: any) => !isWalk(r))) {
        const loaded = loadFile(rule.file);
        if (!loaded) continue;
        const { code, sf } = loaded;

        const pos = findPatternPosLocal(code, rule.find, sf);
        if (pos === -1) continue;

        const node = findContainingScope(sf, pos, rule.scope);
        if (!node) continue;

        const minifiedName = getNodeName(node);
        if (!minifiedName) continue;

        const id = rule.id ?? rule.rename ?? minifiedName;
        resolvedById.set(id, { id, file: rule.file, minifiedName });
    }

    // Walk rules — iterate to resolve chains
    const pending = rules.filter(isWalk);
    for (let round = 0; round < 10 && pending.length > 0; round++) {
        const unresolved: any[] = [];
        for (const rule of pending) {
            const parent = resolvedById.get(rule.from);
            if (!parent) { unresolved.push(rule); continue; }

            const loaded = loadFile(parent.file);
            if (!loaded) continue;
            const { code, sf } = loaded;

            let node: ts.Node | null;
            if (parent.nodeStart !== undefined && parent.nodeEnd !== undefined) {
                node = findNodeAtPosition(sf, parent.nodeStart, parent.nodeEnd);
            } else {
                node = findNodeByName(sf, parent.minifiedName);
            }
            if (!node) continue;

            // If the walk rule has a `find`, narrow to the deepest node at the found position
            if (rule.find) {
                const nodeCode = node.getText(sf);
                const nodeSf = ts.createSourceFile("__walk_find.js", nodeCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                const localPos = findPatternPosLocal(nodeCode, rule.find, nodeSf);
                if (localPos === -1) continue;
                const realPos = node.getStart(sf) + localPos;
                let deepest: ts.Node = node;
                function descend(n: ts.Node) {
                    if (n.getStart(sf) <= realPos && realPos < n.end) {
                        deepest = n;
                        ts.forEachChild(n, descend);
                    }
                }
                descend(node);
                node = deepest;
            }

            const walkResult = walkFromNodeLocal(node, rule.walk, sf);
            if (!walkResult.name) continue;

            const id = rule.id ?? rule.rename;
            resolvedById.set(id, {
                id, file: parent.file, minifiedName: walkResult.name,
                nodeStart: walkResult.nodeStart, nodeEnd: walkResult.nodeEnd,
            });

            // Handle __export_map bulk anchors
            if (rule.rename === "__export_map" && walkResult.nodeStart !== undefined && walkResult.nodeEnd !== undefined) {
                const mapNode = findNodeAtPosition(sf, walkResult.nodeStart, walkResult.nodeEnd);
                if (mapNode) {
                    const entries = extractExportMapRenamesLocal(mapNode, sf, parent.file);
                    for (const e of entries) {
                        resolvedById.set(e.anchorId, { id: e.anchorId, file: parent.file, minifiedName: e.minified });
                    }
                }
            }
        }
        if (unresolved.length === pending.length) break;
        pending.splice(0, pending.length, ...unresolved);
    }
}

// Local copies of find/walk for the dev tool (self-contained)
function findPatternPosLocal(code: string, find: any, sf: ts.SourceFile): number {
    if (typeof find === "string") return code.indexOf(find);
    if ("text" in find) return code.indexOf(find.text);
    if ("regex" in find) {
        const m = code.match(new RegExp(find.regex));
        return m ? code.indexOf(m[0]) : -1;
    }
    if ("string_literal" in find) {
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (ts.isStringLiteral(node) && node.text === find.string_literal) pos = node.getStart(sf);
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }
    if ("string_startswith" in find) {
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (ts.isStringLiteral(node) && node.text.startsWith(find.string_startswith)) pos = node.getStart(sf);
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }
    if ("string_endswith" in find) {
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (ts.isStringLiteral(node) && node.text.endsWith(find.string_endswith)) pos = node.getStart(sf);
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }
    if ("string_contains" in find) {
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (ts.isStringLiteral(node) && node.text.includes(find.string_contains)) pos = node.getStart(sf);
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }
    if ("property_assignment" in find) {
        const { key, value } = find.property_assignment;
        if (!key && !value) return -1;
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
                const keyMatch = !key || node.name.text === key;
                const valueMatch = !value || (ts.isStringLiteral(node.initializer) && node.initializer.text === value);
                if (keyMatch && valueMatch) pos = node.getStart(sf);
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }
    if ("number" in find) {
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (ts.isNumericLiteral(node) && Number(node.text) === find.number) {
                if (find.op) {
                    const p = node.parent;
                    if (ts.isBinaryExpression(p) && ts.tokenToString(p.operatorToken.kind) === find.op) pos = node.getStart(sf);
                } else pos = node.getStart(sf);
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }
    if ("function_name" in find) {
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (getNodeName(node) === find.function_name) pos = node.getStart(sf);
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }
    return -1;
}

// Minimal walk implementation for the dev tool
function walkFromNodeLocal(node: ts.Node, walkExpr: string, sf: ts.SourceFile): { name: string | null; nodeStart?: number; nodeEnd?: number } {
    const parts = walkExpr.split(":");
    const op = parts[0];
    const fn = node as ts.FunctionLikeDeclaration;

    switch (op) {
        case "param": {
            const idx = parseInt(parts[1] ?? "0");
            const param = fn.parameters?.[idx];
            if (param && ts.isIdentifier(param.name)) return { name: param.name.text };
            if (ts.isCallExpression(node) && idx < node.arguments.length) {
                const arg = node.arguments[idx];
                if (ts.isIdentifier(arg)) return { name: arg.text };
            }
            return { name: null };
        }
        case "local": {
            return { name: walkLocalSimple(fn, parts.slice(1).join(":")) };
        }
        case "yield_star_callee": {
            if (!fn.body) return { name: null };
            let result: string | null = null;
            function find(n: ts.Node) {
                if (result) return;
                if (ts.isYieldExpression(n) && n.asteriskToken && n.expression &&
                    ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression))
                    result = n.expression.expression.text;
                ts.forEachChild(n, find);
            }
            find(fn.body);
            return { name: result };
        }
        case "only_bare_call": {
            const body = fn.body ?? node;
            const found: string[] = [];
            function findBareCalls(n: ts.Node) {
                if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments.length === 0) {
                    found.push(n.expression.text);
                }
                ts.forEachChild(n, findBareCalls);
            }
            findBareCalls(body);
            return { name: found.length === 1 ? found[0] : null };
        }
        case "call_string_arg": {
            const value = parts.slice(1, -1).join(":");
            const action = parts[parts.length - 1];
            if (!fn.body || !value || action !== "callee") return { name: null };
            let result: string | null = null;
            function find(n: ts.Node) {
                if (result) return;
                if (ts.isCallExpression(n)) {
                    const hasArg = n.arguments.some(a => ts.isStringLiteral(a) && a.text === value);
                    if (hasArg && ts.isIdentifier(n.expression)) result = n.expression.text;
                }
                ts.forEachChild(n, find);
            }
            find(fn.body);
            return { name: result };
        }
        case "call_string_contains": {
            const substr = parts.slice(1, -1).join(":");
            const action = parts[parts.length - 1];
            if (!fn.body || !substr || action !== "callee") return { name: null };
            let result: string | null = null;
            function find(n: ts.Node) {
                if (result) return;
                if (ts.isCallExpression(n)) {
                    const hasArg = n.arguments.some(a => ts.isStringLiteral(a) && a.text.includes(substr));
                    if (hasArg && ts.isIdentifier(n.expression)) result = n.expression.text;
                }
                ts.forEachChild(n, find);
            }
            find(fn.body);
            return { name: result };
        }
        case "return": {
            if (parts[1] === "comma" && parts[2]) {
                const n = parseInt(parts[2]);
                const body = fn.body ?? node;
                let found: ts.Node | null = null;
                function visit(nd: ts.Node) {
                    if (found) return;
                    if (ts.isReturnStatement(nd) && nd.expression) {
                        const ops = collectCommaOperands(nd.expression);
                        if (ops.length === n) { found = nd.expression; return; }
                    }
                    ts.forEachChild(nd, visit);
                }
                visit(body);
                if (found) return { name: `__pos_${(found as ts.Node).getStart(sf)}`, nodeStart: (found as ts.Node).getStart(sf), nodeEnd: (found as ts.Node).end };
            }
            if (parts[1] === "postfix_increment_operand") {
                return walkPostfixIncrement(node, sf);
            }
            return { name: null };
        }
        case "contains": {
            const text = parts[1];
            const what = parts[2];
            if (!text) return { name: null };
            if (what === "assign_target") {
                const idx = parts[3] !== undefined ? parseInt(parts[3]) : undefined;
                return { name: findAssignTargetContainingLocal(node, text, sf, idx) };
            }
            if (what === "member_access_target") {
                return { name: findMemberAccessTargetLocal(node, text, sf) };
            }
            return { name: null };
        }
        case "if": {
            if (parts[1] === "condition_refs" && parts[2]) {
                const resolved = resolvedById.get(parts[2]);
                if (!resolved) return { name: null };
                const body = fn.body ?? node;
                let found: ts.Node | null = null;
                function visit(nd: ts.Node) {
                    if (found) return;
                    if (ts.isIfStatement(nd) && refsId(nd.expression, resolved!.minifiedName))
                        { found = nd.thenStatement; return; }
                    ts.forEachChild(nd, visit);
                }
                visit(body);
                if (found) return { name: `__pos_${(found as ts.Node).getStart(sf)}`, nodeStart: (found as ts.Node).getStart(sf), nodeEnd: (found as ts.Node).end };
            }
            return { name: null };
        }
        case "postfix_increment_operand": return walkPostfixIncrement(node, sf);
        case "standalone_increment": {
            const body = fn.body ?? node;
            let result: string | null = null;
            function visit(nd: ts.Node) {
                if (result) return;
                if (ts.isExpressionStatement(nd)) {
                    const expr = nd.expression;
                    if ((ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) &&
                        expr.operator === ts.SyntaxKind.PlusPlusToken && ts.isIdentifier(expr.operand))
                        { result = expr.operand.text; return; }
                }
                ts.forEachChild(nd, visit);
            }
            visit(body);
            return { name: result };
        }
        case "method_arg_callee": {
            const method = parts[1];
            if (!method) return { name: null };
            const body = fn.body ?? node;
            let result: string | null = null;
            function visit(nd: ts.Node) {
                if (result) return;
                if (ts.isCallExpression(nd) && ts.isPropertyAccessExpression(nd.expression) &&
                    nd.expression.name.text === method && nd.arguments.length >= 1) {
                    const arg = nd.arguments[0];
                    if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression))
                        { result = arg.expression.text; return; }
                }
                ts.forEachChild(nd, visit);
            }
            visit(body);
            return { name: result };
        }
        case "export_map": {
            const anchorName = getNodeName(node);
            if (!anchorName) return { name: null };
            const obj = findExportMapObjectLocal(sf, anchorName);
            if (obj) return { name: `__pos_${obj.getStart(sf)}`, nodeStart: obj.getStart(sf), nodeEnd: obj.end };
            return { name: null };
        }
        case "closest_parent": {
            const target = parts[1];
            if (!target) return { name: null };
            let cur: ts.Node | undefined = node;
            while (cur) {
                const match =
                    (target === "if" && ts.isIfStatement(cur)) ||
                    (target === "while" && ts.isWhileStatement(cur)) ||
                    (target === "for" && (ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isForInStatement(cur))) ||
                    (target === "call" && ts.isCallExpression(cur)) ||
                    (target === "return" && ts.isReturnStatement(cur)) ||
                    (target === "expression_statement" && ts.isExpressionStatement(cur));
                if (match) return { name: `__pos_${cur.getStart(sf)}`, nodeStart: cur.getStart(sf), nodeEnd: cur.end };
                cur = cur.parent;
            }
            return { name: null };
        }
        case "condition_callee": {
            let cond: ts.Expression | undefined;
            if (ts.isIfStatement(node)) cond = node.expression;
            else if (ts.isWhileStatement(node)) cond = node.expression;
            if (!cond) return { name: null };
            let call: ts.CallExpression | undefined;
            if (ts.isCallExpression(cond)) call = cond;
            if (ts.isPrefixUnaryExpression(cond) && ts.isCallExpression(cond.operand)) call = cond.operand;
            if (call && ts.isIdentifier(call.expression))
                return { name: call.expression.text, nodeStart: call.getStart(sf), nodeEnd: call.end };
            return { name: null };
        }
        case "enclosing_class": {
            const cls = node.parent;
            if (cls && (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name)
                return { name: cls.name.text };
            return { name: null };
        }
        case "callee": {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
                return { name: node.expression.text };
            if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression))
                return { name: node.expression.expression.text };
            return { name: null };
        }
        case "binary_other_operand": {
            let cur: ts.Node | undefined = node;
            while (cur && !ts.isBinaryExpression(cur)) cur = cur.parent;
            if (!cur || !ts.isBinaryExpression(cur)) return { name: null };
            const bin = cur;
            const nodeStart = node.getStart(sf);
            const nodeEnd = node.end;
            const leftStart = bin.left.getStart(sf);
            const leftEnd = bin.left.end;
            const other = (nodeStart >= leftStart && nodeEnd <= leftEnd) ? bin.right : bin.left;
            if (ts.isIdentifier(other)) return { name: other.text };
            return { name: null };
        }
        default: return { name: null };
    }
}

function findExportMapObjectLocal(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | null {
    let found: ts.ObjectLiteralExpression | null = null;
    function visit(node: ts.Node) {
        if (found) return;
        if (ts.isObjectLiteralExpression(node)) {
            for (const prop of node.properties) {
                if (
                    ts.isPropertyAssignment(prop) &&
                    ts.isArrowFunction(prop.initializer) &&
                    ts.isIdentifier(prop.initializer.body as ts.Node) &&
                    (prop.initializer.body as ts.Identifier).text === name
                ) {
                    found = node;
                    return;
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return found;
}

function extractExportMapRenamesLocal(node: ts.Node, sf: ts.SourceFile, file: string): Array<{ minified: string; original: string; anchorId: string }> {
    if (!ts.isObjectLiteralExpression(node)) return [];
    const results: Array<{ minified: string; original: string; anchorId: string }> = [];
    for (const prop of node.properties) {
        if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            ts.isArrowFunction(prop.initializer) &&
            ts.isIdentifier(prop.initializer.body as ts.Node)
        ) {
            const original = prop.name.text;
            const minified = (prop.initializer.body as ts.Identifier).text;
            if (original !== minified) {
                results.push({ minified, original, anchorId: `${file}_fun_${original}` });
            }
        }
    }
    return results;
}

function walkLocalSimple(fn: ts.FunctionLikeDeclaration, localType: string): string | null {
    if (!fn.body) return null;
    let result: string | null = null;
    let forOfCount = 0;
    function visit(node: ts.Node) {
        if (result) return;
        if (localType === "array_init" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer && ts.isArrayLiteralExpression(decl.initializer) && decl.initializer.elements.length === 0)
                    { result = decl.name.text; return; }
            }
        }
        if (localType === "yield_star_result" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer && ts.isYieldExpression(decl.initializer) && decl.initializer.asteriskToken)
                    { result = decl.name.text; return; }
            }
        }
        if (localType.startsWith("for_of_binding") && ts.isForOfStatement(node)) {
            const colonIdx = localType.indexOf(":");
            const targetIdx = colonIdx !== -1 ? parseInt(localType.slice(colonIdx + 1)) : 0;
            const thisIdx = forOfCount++;
            if (thisIdx === targetIdx) {
                const init = node.initializer;
                if (ts.isVariableDeclarationList(init) && init.declarations[0]) {
                    const decl = init.declarations[0];
                    if (ts.isIdentifier(decl.name)) result = decl.name.text;
                }
                return;
            }
            ts.forEachChild(node, visit);
            return;
        }
        if (localType === "call_result" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer && ts.isCallExpression(decl.initializer))
                    { result = decl.name.text; return; }
            }
        }
        if (localType === "call_result_callee" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer && ts.isCallExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression))
                    { result = decl.initializer.expression.text; return; }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(fn.body);
    return result;
}

function collectCommaOperands(expr: ts.Expression): ts.Expression[] {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken)
        return [...collectCommaOperands(expr.left), ...collectCommaOperands(expr.right)];
    return [expr];
}

function walkPostfixIncrement(node: ts.Node, sf: ts.SourceFile): { name: string | null } {
    let result: string | null = null;
    function find(n: ts.Node) {
        if (result) return;
        if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
            n.operator === ts.SyntaxKind.PlusPlusToken && ts.isIdentifier(n.operand))
            { result = n.operand.text; return; }
        ts.forEachChild(n, find);
    }
    find(node);
    return { name: result };
}

function findAssignTargetContainingLocal(node: ts.Node, text: string, sf: ts.SourceFile, idx?: number): string | null {
    const operands = ts.isBinaryExpression(node) ? collectCommaOperands(node as ts.Expression) : null;
    const candidates = operands ?? [node];
    let matchCount = 0;
    for (const candidate of candidates) {
        if (!candidate.getText(sf).includes(text)) continue;
        let result: string | null = null;
        function findAssign(n: ts.Node) {
            if (result) return;
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(n.left) && n.getText(sf).includes(text))
                { result = n.left.text; return; }
            ts.forEachChild(n, findAssign);
        }
        findAssign(candidate);
        if (result) {
            if (idx === undefined || matchCount === idx) return result;
            matchCount++;
        }
    }
    return null;
}

function findMemberAccessTargetLocal(node: ts.Node, propertyName: string, sf: ts.SourceFile): string | null {
    const operands = ts.isBinaryExpression(node) ? collectCommaOperands(node as ts.Expression) : null;
    const roots = operands ?? [node];
    for (const root of roots) {
        let result: string | null = null;
        function find(n: ts.Node) {
            if (result) return;
            if (ts.isPropertyAccessExpression(n) && n.name.text === propertyName && ts.isIdentifier(n.expression))
                { result = n.expression.text; return; }
            ts.forEachChild(n, find);
        }
        find(root);
        if (result) return result;
    }
    return null;
}

function refsId(node: ts.Node, name: string): boolean {
    if (ts.isIdentifier(node) && node.text === name) return true;
    let found = false;
    ts.forEachChild(node, child => { if (!found) found = refsId(child, name); });
    return found;
}

// ── Inspect Commands ────────────────────────────────────────────────────────

function cmdInspect() {
    if (!currentNode || !currentSf) { console.log("  No context. Use 'from <id>' first."); return; }
    const sf = currentSf;
    const node = currentNode;

    console.log(`  Node: ${nodeKindLabel(node)}`);
    console.log(`  File: ${currentAnchor?.file}`);
    console.log(`  Pos:  ${node.getStart(sf)}..${node.end}`);
    console.log();

    // Params
    const fn = node as ts.FunctionLikeDeclaration;
    if (fn.parameters) {
        console.log("  Parameters:");
        fn.parameters.forEach((p, i) => {
            const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf);
            console.log(`    [${i}] ${name}`);
        });
        console.log();
    }

    // Show summary of body
    cmdLocals();
    console.log();
    cmdStrings();
    console.log();
    cmdCalls();
}

function cmdParams() {
    if (!currentNode || !currentSf) { console.log("  No context."); return; }
    const fn = currentNode as ts.FunctionLikeDeclaration;
    if (!fn.parameters) { console.log("  No parameters."); return; }
    console.log("  Parameters:");
    fn.parameters.forEach((p, i) => {
        const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText(currentSf!);
        const type = p.type ? p.type.getText(currentSf!) : "";
        console.log(`    [${i}] ${name}${type ? ": " + type : ""}`);
    });
}

function cmdLocals() {
    if (!currentNode || !currentSf) { console.log("  No context."); return; }
    const fn = currentNode as ts.FunctionLikeDeclaration;
    const body = fn.body ?? currentNode;
    const sf = currentSf;

    console.log("  Locals:");
    function visit(node: ts.Node, depth: number) {
        // Don't recurse into nested functions
        if (depth > 0 && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;

        if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    const init = decl.initializer;
                    let initSummary = "";
                    if (init) {
                        const text = init.getText(sf);
                        initSummary = text.length > 60 ? text.slice(0, 60) + "..." : text;
                    }
                    console.log(`    ${decl.name.text}${initSummary ? " = " + initSummary : ""}`);
                }
            }
        }
        ts.forEachChild(node, n => visit(n, depth + 1));
    }
    visit(body, 0);
}

function cmdStrings() {
    if (!currentNode || !currentSf) { console.log("  No context."); return; }
    const sf = currentSf;
    const strings: string[] = [];

    function visit(node: ts.Node) {
        if (ts.isStringLiteral(node)) {
            const val = node.text;
            if (val.length > 0 && !strings.includes(val)) strings.push(val);
        }
        ts.forEachChild(node, visit);
    }
    visit(currentNode);

    console.log(`  String literals (${strings.length}):`);
    for (const s of strings) {
        console.log(`    "${s.length > 80 ? s.slice(0, 80) + "..." : s}"`);
    }
}

function cmdReturns() {
    if (!currentNode || !currentSf) { console.log("  No context."); return; }
    const sf = currentSf;
    const fn = currentNode as ts.FunctionLikeDeclaration;
    const body = fn.body ?? currentNode;

    console.log("  Return statements:");
    let idx = 0;
    function visit(node: ts.Node, depth: number) {
        if (depth > 0 && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;
        if (ts.isReturnStatement(node) && node.expression) {
            const text = node.expression.getText(sf);
            const commaOps = collectCommaOperands(node.expression);
            const commaInfo = commaOps.length > 1 ? ` [comma:${commaOps.length}]` : "";
            console.log(`    [${idx}]${commaInfo} ${text.length > 100 ? text.slice(0, 100) + "..." : text}`);
            idx++;
        }
        ts.forEachChild(node, n => visit(n, depth + 1));
    }
    visit(body, 0);
}

function cmdCalls() {
    if (!currentNode || !currentSf) { console.log("  No context."); return; }
    const sf = currentSf;
    const fn = currentNode as ts.FunctionLikeDeclaration;
    const body = fn.body ?? currentNode;

    const calls: string[] = [];
    function visit(node: ts.Node, depth: number) {
        if (depth > 0 && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;
        if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(sf);
            const args = node.arguments.map(a => {
                const t = a.getText(sf);
                return t.length > 30 ? t.slice(0, 30) + "..." : t;
            }).join(", ");
            const summary = `${callee}(${args})`;
            if (!calls.includes(summary)) calls.push(summary);
        }
        ts.forEachChild(node, n => visit(n, depth + 1));
    }
    visit(body, 0);

    console.log(`  Calls (${calls.length}):`);
    for (const c of calls) {
        console.log(`    ${c.length > 100 ? c.slice(0, 100) + "..." : c}`);
    }
}

function cmdMembers() {
    if (!currentNode || !currentSf) { console.log("  No context."); return; }
    const sf = currentSf;

    const members: string[] = [];
    function visit(node: ts.Node) {
        if (ts.isPropertyAccessExpression(node)) {
            const obj = node.expression.getText(sf);
            const prop = node.name.text;
            const key = `${obj}.${prop}`;
            if (!members.includes(key)) members.push(key);
        }
        ts.forEachChild(node, visit);
    }
    visit(currentNode);

    console.log(`  Member accesses (${members.length}):`);
    for (const m of members) {
        console.log(`    ${m}`);
    }
}

function cmdCallers(args: string) {
    if (!currentAnchor) { console.log("  No context. Use 'from <id>' first."); return; }
    const name = args || currentAnchor.minifiedName;
    console.log(`  Searching for references to "${name}" across deobfuscated/...\n`);

    // Scan all .js files for references
    const results: Array<{ file: string; line: number; text: string }> = [];
    function scanDir(dir: string, rel: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                scanDir(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
            } else if (entry.name.endsWith(".js")) {
                const filePath = path.join(dir, entry.name);
                const filRel = rel ? `${rel}/${entry.name}` : entry.name;
                const code = fs.readFileSync(filePath, "utf-8");
                const lines = code.split("\n");
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(name)) {
                        // Skip the definition itself
                        const trimmed = lines[i].trim();
                        if (trimmed.startsWith(`function ${name}`) || trimmed.startsWith(`var ${name}`) || trimmed.startsWith(`let ${name}`) || trimmed.startsWith(`const ${name}`)) continue;
                        // Skip export maps
                        if (trimmed.includes("() =>") && trimmed.includes(name)) continue;
                        results.push({ file: filRel, line: i + 1, text: trimmed });
                    }
                }
            }
        }
    }
    scanDir(deobDir, "");

    if (results.length === 0) {
        console.log("  No callers found.");
        return;
    }

    console.log(`  References (${results.length}):`);
    for (const r of results) {
        const text = r.text.length > 100 ? r.text.slice(0, 100) + "..." : r.text;
        console.log(`    ${r.file}:${r.line}  ${text}`);
    }
}

function cmdSource(args: string) {
    if (!currentNode || !currentSf || !currentCode) { console.log("  No context."); return; }
    const maxLines = parseInt(args) || 30;
    const text = currentNode.getText(currentSf);
    const lines = text.split("\n");
    const startLine = currentCode.slice(0, currentNode.getStart(currentSf)).split("\n").length;

    console.log(`  Source (${currentAnchor?.file}:${startLine}):\n`);
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
        console.log(`  ${(startLine + i).toString().padStart(4)} | ${lines[i]}`);
    }
    if (lines.length > maxLines) console.log(`  ... (${lines.length - maxLines} more lines)`);
}

function cmdWalk(args: string) {
    if (!currentNode || !currentSf) { console.log("  No context."); return; }
    const result = walkFromNodeLocal(currentNode, args, currentSf);
    if (result.name) {
        console.log(`  Walk "${args}" → ${result.name}`);
        if (result.nodeStart !== undefined) {
            console.log(`  (positional anchor: ${result.nodeStart}..${result.nodeEnd})`);
        }
    } else {
        console.log(`  Walk "${args}" → (no match)`);
    }
}

function cmdFrom(args: string) {
    if (!args) { console.log("  Usage: from <id>"); return; }
    const anchor = resolvedById.get(args);
    if (!anchor) {
        console.log(`  Anchor "${args}" not found. Run 'resolve' first.`);
        return;
    }
    setContext(anchor);
    if (currentNode) {
        console.log(`  Context: ${nodeKindLabel(currentNode)} in ${anchor.file}`);
        if (anchor.nodeStart !== undefined) console.log(`  (positional: ${anchor.nodeStart}..${anchor.nodeEnd})`);
    }
}

function cmdFind(args: string) {
    // find string_literal approved [file]
    // find text someText [file]
    // find regex pattern [file]
    const parts = args.split(/\s+/);
    if (parts.length < 2) { console.log("  Usage: find <type> <value> [file]"); return; }
    const type = parts[0];
    const value = parts[1];
    const file = parts[2] ?? currentAnchor?.file;
    if (!file) { console.log("  No file specified and no context."); return; }

    const loaded = loadFile(file);
    if (!loaded) return;
    const { code, sf } = loaded;

    let criteria: any;
    switch (type) {
        case "string_literal": criteria = { string_literal: value }; break;
        case "text": criteria = { text: value }; break;
        case "regex": criteria = { regex: value }; break;
        case "property_assignment": {
            const [key, val] = value.split("=");
            criteria = { property_assignment: { key, value: val } };
            break;
        }
        default: console.log(`  Unknown find type: ${type}`); return;
    }

    const pos = findPatternPosLocal(code, criteria, sf);
    if (pos === -1) { console.log(`  Not found.`); return; }

    lastFindPos = pos;
    lastFindFile = file;

    const lineNum = code.slice(0, pos).split("\n").length;
    const context = code.slice(pos, pos + 80).replace(/\n/g, "\\n");
    console.log(`  Found at pos ${pos} (line ${lineNum}): ${context}...`);
}

function cmdScope(args: string) {
    if (lastFindPos === -1 || !lastFindFile) { console.log("  No find result. Use 'find' first."); return; }
    if (!args) { console.log("  Usage: scope <function|async_function|generator|async_generator|method|class|arrow>"); return; }

    const loaded = loadFile(lastFindFile);
    if (!loaded) return;
    const { code, sf } = loaded;

    const node = findContainingScope(sf, lastFindPos, args as Scope);
    if (!node) { console.log(`  No ${args} scope found containing pos ${lastFindPos}.`); return; }

    const name = getNodeName(node);
    console.log(`  Scope: ${nodeKindLabel(node)} at pos ${node.getStart(sf)}..${node.end}`);

    // Set as temp context for further inspection
    currentSf = sf;
    currentCode = code;
    currentNode = node;
    currentAnchor = { id: name ?? "__temp", file: lastFindFile, minifiedName: name ?? "__unknown" };
}

function cmdMode(args: string) {
    if (args === "global" || args === "scoped") {
        mode = args;
        console.log(`  Mode: ${mode}`);
    } else {
        console.log(`  Mode: ${mode}`);
    }
}

function cmdRules() {
    if (!fs.existsSync(rulesPath)) { console.log("  No rules file."); return; }
    const rules = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    console.log(`  ${rules.length} rules:\n`);
    for (const rule of rules) {
        if ("from" in rule) {
            console.log(`    walk: ${rule.from} → ${rule.walk} → ${rule.rename}${rule.id ? ` (id: ${rule.id})` : ""}`);
        } else {
            console.log(`    root: ${rule.file} find:${JSON.stringify(rule.find)} scope:${rule.scope} → ${rule.rename ?? "(anchor-only)"}${rule.id ? ` (id: ${rule.id})` : ""}`);
        }
    }
}

function cmdAnchors(args: string) {
    if (resolvedById.size === 0) { console.log("  No anchors resolved. Run 'resolve' first."); return; }

    const filter = args.trim();
    const entries = [...resolvedById.entries()]
        .filter(([id]) => !filter || id.includes(filter))
        .sort(([a], [b]) => a.localeCompare(b));

    if (entries.length === 0) {
        console.log(`  No anchors matching "${filter}".`);
        return;
    }

    console.log(`  Anchors (${entries.length}):`);
    for (const [id, a] of entries) {
        const pos = a.nodeStart !== undefined ? ` (pos ${a.nodeStart}..${a.nodeEnd})` : "";
        console.log(`    ${id.padEnd(50)} ${a.minifiedName.padEnd(15)} ${a.file}${pos}`);
    }
}

function cmdApplied() {
    if (appliedRenames.length === 0) { console.log("  No renames applied this session."); return; }
    console.log(`  Applied renames (${appliedRenames.length}):`);
    for (const a of appliedRenames) {
        console.log(`    ${a.minified} → ${a.original} (${a.type}) in ${a.file}`);
    }
}

function runEntrypoint(steps: string[], env?: Record<string, string>) {
    const envStr = env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ") + " " : "";
    const cmd = `${envStr}${entrypoint} ${steps.join(" ")}`;
    console.log(`  Running: ${cmd}`);
    try {
        execSync(cmd, { cwd: entrypointDir, stdio: "inherit", env: { ...process.env, ...env } });
        console.log(`  Done.`);
    } catch (e: any) {
        console.error(`  Build failed (exit ${e.status}).`);
    }
}

function cmdBuild(args: string) {
    const parts = args.split(/\s+/).filter(Boolean);
    const sub = parts[0];

    switch (sub) {
        case "global":
            // Clean build to modrecon — files ready for global anchor resolution
            console.log("  Building to modrecon (global anchor state)...");
            runEntrypoint(["clean"]);
            runEntrypoint(["extract", "deob", "modrecon"]);
            mode = "global";
            console.log(`  Mode: global — files are pre-rename, ready for anchor resolution.`);
            break;

        case "scoped":
            // Build through prettify with anchor-only — files ready for scoped renames
            console.log("  Building to prettify with ANCHOR_ONLY (scoped state)...");
            runEntrypoint(["clean"]);
            runEntrypoint(["extract", "deob", "modrecon", "rename", "prettify"], { ANCHOR_ONLY: "1" });
            mode = "scoped";
            console.log(`  Mode: scoped — files are post-rename+prettify, ready for scoped inspection.`);
            break;

        case "full":
            // Full clean build with anchor-only
            console.log("  Full clean build with ANCHOR_ONLY...");
            runEntrypoint(["clean"]);
            runEntrypoint(["extract", "deob", "modrecon", "rename", "prettify"], { ANCHOR_ONLY: "1" });
            console.log(`  Full build complete.`);
            break;

        case "rename":
            // Just re-run rename + prettify (assumes extract/deob/modrecon already done)
            console.log("  Re-running rename + prettify (ANCHOR_ONLY)...");
            runEntrypoint(["reset", "rename"]);
            runEntrypoint(["rename", "prettify"], { ANCHOR_ONLY: "1" });
            console.log(`  Rename + prettify complete.`);
            break;

        case "clean":
            runEntrypoint(["clean"]);
            break;

        default:
            if (sub) {
                // Pass through arbitrary steps
                runEntrypoint(parts, process.env.ANCHOR_ONLY ? { ANCHOR_ONLY: "1" } : {});
            } else {
                console.log(`  Usage:
    build global     Clean build to modrecon (pre-rename, for global anchors)
    build scoped     Clean build through prettify with ANCHOR_ONLY (for scoped anchors)
    build full       Full clean build with ANCHOR_ONLY
    build rename     Re-run rename + prettify only (fast, assumes modrecon done)
    build clean      Just clean
    build <steps>    Pass arbitrary steps to entrypoint.sh`);
            }
            break;
    }
}

function cmdHelp() {
    console.log(`
  Anchor Dev Tool — Interactive anchor rule development

  Commands:
    build global           Clean build to modrecon (pre-rename, for global anchors)
    build scoped           Clean build through prettify (post-rename, for scoped anchors)
    build full             Full clean build with ANCHOR_ONLY
    build rename           Re-run rename + prettify only (fast iteration)
    build clean            Just clean
    resolve [id]           Resolve all rules (or specific one)
    anchors [filter]       List all resolved anchor IDs (optional substring filter)
    from <id>              Set context to a resolved anchor
    walk <expr>            Try a walk expression from current context
    inspect                Show AST summary: params, locals, strings, calls
    strings                List string literals in scope
    params                 List parameters
    locals                 List local variable declarations
    returns                List return statements
    calls                  List function calls
    members                List property accesses (X.foo)
    callers [name]         Find references/callers across all files
    source [lines]         Print source (default 30 lines)
    find <type> <value> [file]   Test a find criteria
    scope <type>           From last find, walk up to scope type
    mode [global|scoped]   Show or switch mode
    rules                  List rules from anchor-rules.json
    applied                List renames applied this session
    help                   Show this help
    quit                   Exit
`);
}

// ── Command Dispatch ────────────────────────────────────────────────────────

function dispatch(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;

    const [cmd, ...rest] = trimmed.split(/\s+/);
    const args = rest.join(" ");

    try {
        switch (cmd) {
            case "build": cmdBuild(args); break;
            case "resolve": cmdResolve(args); break;
            case "anchors": cmdAnchors(args); break;
            case "from": cmdFrom(args); break;
            case "walk": cmdWalk(args); break;
            case "inspect": cmdInspect(); break;
            case "strings": cmdStrings(); break;
            case "params": cmdParams(); break;
            case "locals": cmdLocals(); break;
            case "returns": cmdReturns(); break;
            case "calls": cmdCalls(); break;
            case "members": cmdMembers(); break;
            case "callers": case "refs": cmdCallers(args); break;
            case "source": case "src": cmdSource(args); break;
            case "find": cmdFind(args); break;
            case "scope": cmdScope(args); break;
            case "mode": cmdMode(args); break;
            case "rules": cmdRules(); break;
            case "applied": cmdApplied(); break;
            case "help": case "?": cmdHelp(); break;
            case "quit": case "exit": case "q": return false;
            default: console.log(`  Unknown command: ${cmd}. Type 'help'.`); break;
        }
    } catch (e: any) {
        console.error(`  Error: ${e.message}`);
    }
    return true;
}

// ── CLI vs REPL ─────────────────────────────────────────────────────────────
//
// CLI mode:  bun run src/anchor-dev.ts <deob-dir> [rules.json] -- cmd1 ; cmd2 ; cmd3
// REPL mode: bun run src/anchor-dev.ts <deob-dir> [rules.json]
//
// CLI mode runs commands sequentially, no prompt, no colors, then exits.
// Commands are separated by ";" in the argument list.
// "resolve" is implicitly run first unless the first command is "build" or "resolve".

if (dashIdx !== -1) {
    // CLI mode — join everything after "--" and split on ";"
    const cliArgs = process.argv.slice(dashIdx + 1).join(" ");
    const commands = cliArgs.split(";").map(s => s.trim()).filter(Boolean);

    if (commands.length === 0) {
        console.error("Usage: anchor-dev <deob-dir> [rules.json] -- cmd1 ; cmd2 ; cmd3");
        process.exit(1);
    }

    // Auto-resolve unless first command handles it
    const first = commands[0].split(/\s+/)[0];
    if (first !== "build" && first !== "resolve" && first !== "help") {
        dispatch("resolve");
    }

    for (const cmd of commands) {
        if (!dispatch(cmd)) break;
    }
    process.exit(0);
} else {
    // REPL mode
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[36manchor>\x1b[0m ",
    });

    console.log("\n  Anchor Dev Tool — type 'help' for commands\n");
    rl.prompt();

    rl.on("line", (line) => {
        if (dispatch(line)) rl.prompt();
        else process.exit(0);
    });

    rl.on("close", () => process.exit(0));
}
