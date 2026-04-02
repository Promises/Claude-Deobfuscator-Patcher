/**
 * Anchor-rule system for user-defined structural rename patterns.
 *
 * Rules are defined in anchor-rules.json. Two kinds:
 *
 *   Root rule — finds a pattern in a file, walks up the AST to a scope,
 *               produces a minified → original rename.
 *
 *   Walk rule — starts from a previously resolved anchor, traverses the AST
 *               to find a related identifier (param, local, callee, etc.)
 *               and produces another rename.
 *
 * Walk rules can chain: A → B → C, resolving an entire function's locals
 * from a single root anchor.
 */

import ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { MatchResult } from "./constraint-renamer";

// ── Rule Types ───────────────────────────────────────────────────────────────

type FindCriteria =
    | { text: string }
    | { regex: string }
    | { string_literal: string }
    | { number: number; op?: string };

type Scope =
    | "function"
    | "async_generator"
    | "generator"
    | "async_function"
    | "method"
    | "class"
    | "arrow";

interface RootRule {
    id?: string;
    description?: string;
    file: string;
    find: FindCriteria | string;
    scope: Scope;
    rename: string;
    class?: string; // also rename enclosing class (scope=method)
}

interface WalkRule {
    id?: string;
    description?: string;
    from: string; // references another rule's id or rename
    walk: string; // walk expression
    rename: string;
}

type AnchorRule = RootRule | WalkRule;

function isWalkRule(rule: AnchorRule): rule is WalkRule {
    return "from" in rule;
}

// Resolved anchor for use by dependent rules
interface Resolved {
    id: string;
    file: string;
    minifiedName: string;
}

// ── Pattern Search ───────────────────────────────────────────────────────────

function findPatternPos(code: string, find: FindCriteria | string, sf: ts.SourceFile): number {
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
            if (ts.isStringLiteral(node) && node.text === (find as { string_literal: string }).string_literal)
                pos = node.getStart(sf);
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }

    if ("number" in find) {
        const target = find as { number: number; op?: string };
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (ts.isNumericLiteral(node) && Number(node.text) === target.number) {
                if (target.op) {
                    const p = node.parent;
                    if (ts.isBinaryExpression(p) && ts.tokenToString(p.operatorToken.kind) === target.op)
                        pos = node.getStart(sf);
                } else {
                    pos = node.getStart(sf);
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }

    return -1;
}

// ── Scope Detection ──────────────────────────────────────────────────────────

function scopeMatches(node: ts.Node, scope: Scope): boolean {
    const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node);
    const isAsync = isFn && !!(node as ts.FunctionDeclaration).modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
    );
    const isGen = isFn && !!(node as ts.FunctionDeclaration).asteriskToken;

    switch (scope) {
        case "function":
            return isFn;
        case "async_generator":
            return isFn && isAsync && isGen;
        case "generator":
            return isFn && isGen;
        case "async_function":
            return isFn && isAsync;
        case "method":
            return ts.isMethodDeclaration(node);
        case "class":
            return ts.isClassDeclaration(node) || ts.isClassExpression(node);
        case "arrow":
            return ts.isArrowFunction(node);
    }
}

function getNodeName(node: ts.Node): string | null {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text ?? null;
    if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
        if (node.name) return node.name.text;
        if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
            return node.parent.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    return null;
}

function findContainingScope(sf: ts.SourceFile, pos: number, scope: Scope): ts.Node | null {
    // Find deepest node containing pos
    let deepest: ts.Node = sf;
    function descend(node: ts.Node) {
        if (node.getStart(sf) <= pos && pos <= node.end) {
            deepest = node;
            ts.forEachChild(node, descend);
        }
    }
    descend(sf);

    // Walk up to matching scope
    let cur: ts.Node | undefined = deepest;
    while (cur) {
        if (scopeMatches(cur, scope)) return cur;
        cur = cur.parent;
    }
    return null;
}

// ── Walk Execution ───────────────────────────────────────────────────────────

function findNodeByName(sf: ts.SourceFile, name: string): ts.Node | null {
    let found: ts.Node | null = null;
    function visit(node: ts.Node) {
        if (found) return;
        if (getNodeName(node) === name) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return found;
}

function walkFromNode(node: ts.Node, walkExpr: string, sf: ts.SourceFile): string | null {
    const parts = walkExpr.split(":");
    const op = parts[0];

    const fn = node as ts.FunctionLikeDeclaration;

    switch (op) {
        case "param": {
            const idx = parseInt(parts[1] ?? "0");
            const param = fn.parameters?.[idx];
            return param && ts.isIdentifier(param.name) ? param.name.text : null;
        }

        case "local": {
            return walkLocal(fn, parts[1] ?? "");
        }

        case "yield_star_callee": {
            if (!fn.body) return null;
            let result: string | null = null;
            function find(n: ts.Node) {
                if (result) return;
                if (
                    ts.isYieldExpression(n) &&
                    n.asteriskToken &&
                    n.expression &&
                    ts.isCallExpression(n.expression) &&
                    ts.isIdentifier(n.expression.expression)
                )
                    result = n.expression.expression.text;
                ts.forEachChild(n, find);
            }
            find(fn.body);
            return result;
        }

        case "call_string_arg": {
            // call_string_arg:VALUE:callee
            const value = parts[1];
            if (!fn.body || !value) return null;
            let result: string | null = null;
            function find(n: ts.Node) {
                if (result) return;
                if (ts.isCallExpression(n)) {
                    const hasArg = n.arguments.some((a) => ts.isStringLiteral(a) && a.text === value);
                    if (hasArg && ts.isIdentifier(n.expression)) result = n.expression.text;
                }
                ts.forEachChild(n, find);
            }
            find(fn.body);
            return result;
        }

        case "enclosing_class": {
            const cls = node.parent;
            if (cls && (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name)
                return cls.name.text;
            return null;
        }

        case "method": {
            // method:find:TEXT — find a method whose body contains TEXT
            if (parts[1] === "find" && parts[2]) {
                const needle = parts[2];
                const cls = node as ts.ClassDeclaration;
                for (const member of cls.members ?? []) {
                    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
                        const bodyText = member.body.getText(sf);
                        if (bodyText.includes(needle)) return member.name.text;
                    }
                }
            }
            return null;
        }

        default:
            return null;
    }
}

function walkLocal(fn: ts.FunctionLikeDeclaration, localType: string): string | null {
    if (!fn.body) return null;
    let result: string | null = null;

    function visit(node: ts.Node) {
        if (result) return;

        if (localType === "array_init" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    ts.isArrayLiteralExpression(decl.initializer) &&
                    decl.initializer.elements.length === 0
                ) {
                    result = decl.name.text;
                    return;
                }
            }
        }

        if (localType === "yield_star_result" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    ts.isYieldExpression(decl.initializer) &&
                    decl.initializer.asteriskToken
                ) {
                    result = decl.name.text;
                    return;
                }
            }
        }

        if (localType === "for_of_binding" && ts.isForOfStatement(node)) {
            const init = node.initializer;
            if (ts.isVariableDeclarationList(init) && init.declarations[0]) {
                const decl = init.declarations[0];
                if (ts.isIdentifier(decl.name)) result = decl.name.text;
            }
            return;
        }

        ts.forEachChild(node, visit);
    }

    visit(fn.body);
    return result;
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export function applyAnchorRules(deobDir: string, rulesPath: string): MatchResult[] {
    if (!fs.existsSync(rulesPath)) return [];

    const rules: AnchorRule[] = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    if (rules.length === 0) return [];

    const results: MatchResult[] = [];
    const resolvedById = new Map<string, Resolved>();

    const verbose = !!process.env.ANCHOR_VERBOSE;

    // ── Phase 1: Root rules ──────────────────────────────────────────────────

    for (const rule of rules.filter((r) => !isWalkRule(r)) as RootRule[]) {
        const filePath = path.join(deobDir, rule.file);
        if (!fs.existsSync(filePath)) {
            if (verbose) console.warn(`  anchor skip: file not found — ${rule.file}`);
            continue;
        }

        const code = fs.readFileSync(filePath, "utf-8");
        const sf = ts.createSourceFile(rule.file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

        const pos = findPatternPos(code, rule.find, sf);
        if (pos === -1) {
            if (verbose) console.warn(`  anchor skip: pattern not found — ${rule.description ?? rule.rename}`);
            continue;
        }

        const node = findContainingScope(sf, pos, rule.scope);
        if (!node) {
            if (verbose) console.warn(`  anchor skip: scope not found — ${rule.description ?? rule.rename}`);
            continue;
        }

        const minifiedName = getNodeName(node);
        if (!minifiedName) continue;

        const id = rule.id ?? rule.rename;
        resolvedById.set(id, { id, file: rule.file, minifiedName });

        results.push({
            minified: minifiedName,
            original: rule.rename,
            confidence: 100,
            reason: `anchor: ${rule.description ?? rule.rename}`,
        });

        // Optionally rename the enclosing class (scope=method)
        if (rule.class && ts.isMethodDeclaration(node)) {
            const cls = node.parent;
            if ((ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name) {
                results.push({
                    minified: cls.name.text,
                    original: rule.class,
                    confidence: 100,
                    reason: `anchor (class): ${rule.description ?? rule.rename}`,
                });
            }
        }
    }

    // ── Phase 2: Walk rules (iterate to resolve dependency chains) ───────────

    const pending = rules.filter(isWalkRule) as WalkRule[];

    for (let round = 0; round < 10 && pending.length > 0; round++) {
        const unresolved: WalkRule[] = [];

        for (const rule of pending) {
            const parent = resolvedById.get(rule.from);
            if (!parent) {
                unresolved.push(rule);
                continue;
            }

            const filePath = path.join(deobDir, parent.file);
            if (!fs.existsSync(filePath)) continue;

            const code = fs.readFileSync(filePath, "utf-8");
            const sf = ts.createSourceFile(parent.file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

            const node = findNodeByName(sf, parent.minifiedName);
            if (!node) {
                if (verbose) console.warn(`  anchor walk skip: node "${parent.minifiedName}" not found — ${rule.description ?? rule.rename}`);
                continue;
            }

            const minifiedName = walkFromNode(node, rule.walk, sf);
            if (!minifiedName) {
                if (verbose) console.warn(`  anchor walk skip: walk "${rule.walk}" failed — ${rule.description ?? rule.rename}`);
                continue;
            }

            const id = rule.id ?? rule.rename;
            resolvedById.set(id, { id, file: parent.file, minifiedName });

            results.push({
                minified: minifiedName,
                original: rule.rename,
                confidence: 95,
                reason: `anchor walk (${rule.from} → ${rule.walk})`,
            });
        }

        if (unresolved.length === pending.length) break;
        pending.splice(0, pending.length, ...unresolved);
    }

    if (results.length > 0)
        console.log(`  Anchor rules: ${results.length} renames from ${rules.length} rules`);

    return results;
}
