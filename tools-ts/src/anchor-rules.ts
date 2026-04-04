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
    | { number: number; op?: string }
    | { property_assignment: { key: string; value: string } }
    | { function_name: string };

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
    rename?: string;
    anchor_only?: boolean; // resolve anchor but emit no rename
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
    // For intermediate anchors that resolve to an AST region rather than a named node
    nodeStart?: number;
    nodeEnd?: number;
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

    if ("property_assignment" in find) {
        const { key, value } = (find as { property_assignment: { key: string; value: string } }).property_assignment;
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (
                ts.isPropertyAssignment(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === key &&
                ts.isStringLiteral(node.initializer) &&
                node.initializer.text === value
            ) {
                pos = node.getStart(sf);
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
        return pos;
    }

    if ("function_name" in find) {
        const name = (find as { function_name: string }).function_name;
        let pos = -1;
        function visit(node: ts.Node) {
            if (pos !== -1) return;
            if (getNodeName(node) === name) {
                pos = node.getStart(sf);
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

function findNodeAtPosition(sf: ts.SourceFile, start: number, end: number): ts.Node | null {
    let best: ts.Node | null = null;
    function visit(node: ts.Node) {
        const ns = node.getStart(sf);
        const ne = node.end;
        if (ns === start && ne === end) {
            best = node;
            return;
        }
        if (ns <= start && end <= ne) {
            ts.forEachChild(node, visit);
        }
    }
    visit(sf);
    return best;
}

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

interface WalkResult {
    name: string | null;
    // For intermediate walks that resolve to an AST region
    nodeStart?: number;
    nodeEnd?: number;
}

function walkFromNode(
    node: ts.Node,
    walkExpr: string,
    sf: ts.SourceFile,
    resolvedById?: Map<string, Resolved>,
): WalkResult {
    const parts = walkExpr.split(":");
    const op = parts[0];

    const fn = node as ts.FunctionLikeDeclaration;

    switch (op) {
        case "param": {
            const idx = parseInt(parts[1] ?? "0");
            const param = fn.parameters?.[idx];
            return { name: param && ts.isIdentifier(param.name) ? param.name.text : null };
        }

        case "local": {
            return { name: walkLocal(fn, parts.slice(1).join(":")) };
        }

        case "yield_star_callee": {
            if (!fn.body) return { name: null };
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
            return { name: result };
        }

        case "call_string_arg": {
            // call_string_arg:VALUE:callee
            const value = parts[1];
            if (!fn.body || !value) return { name: null };
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
            return { name: result };
        }

        case "enclosing_class": {
            const cls = node.parent;
            if (cls && (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name)
                return { name: cls.name.text };
            return { name: null };
        }

        case "method": {
            // method:find:TEXT — find a method whose body contains TEXT
            if (parts[1] === "find" && parts[2]) {
                const needle = parts[2];
                const cls = node as ts.ClassDeclaration;
                for (const member of cls.members ?? []) {
                    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
                        const bodyText = member.body.getText(sf);
                        if (bodyText.includes(needle)) return { name: member.name.text };
                    }
                }
            }
            return { name: null };
        }

        // return:comma:N — find a return statement with an N-part comma expression.
        // Resolves to the comma expression node (positional anchor, no name).
        case "return": {
            if (parts[1] === "comma" && parts[2]) {
                const expectedLength = parseInt(parts[2]);
                const body = fn.body ?? node;
                const found = findReturnComma(body, expectedLength, sf);
                if (found) return { name: `__pos_${found.getStart(sf)}`, nodeStart: found.getStart(sf), nodeEnd: found.end };
            }
            if (parts[1] === "postfix_increment_operand") {
                return walkReturnPostfixIncrementOperand(node, sf);
            }
            return { name: null };
        }

        // contains:TEXT:assign_target[:N] — within a node region, find the sub-expression
        // containing TEXT, then return the assignment target identifier.
        // contains:TEXT:member_access_target — find the identifier accessed with .TEXT
        // contains:TEXT:assign_target_at:N — Nth (0-indexed) assign target in the comma expr
        case "contains": {
            const text = parts[1];
            const what = parts[2];
            if (!text) return { name: null };
            if (what === "assign_target") {
                const idx = parts[3] !== undefined ? parseInt(parts[3]) : undefined;
                return { name: findAssignTargetContaining(node, text, sf, idx) };
            }
            if (what === "member_access_target") {
                return { name: findMemberAccessTarget(node, text, sf) };
            }
            return { name: null };
        }

        // if:condition_refs:ANCHOR_ID — find an if statement whose condition references
        // the minified name of a previously resolved anchor. Resolves to the if body.
        case "if": {
            if (parts[1] === "condition_refs" && parts[2] && resolvedById) {
                const anchorId = parts[2];
                const resolved = resolvedById.get(anchorId);
                if (!resolved) return { name: null };
                const body = fn.body ?? node;
                const found = findIfConditionRefs(body, resolved.minifiedName, sf);
                if (found) return { name: `__pos_${found.getStart(sf)}`, nodeStart: found.getStart(sf), nodeEnd: found.end };
            }
            return { name: null };
        }

        // postfix_increment_operand — find the first postfix ++ operand in the node region
        case "postfix_increment_operand": {
            return walkReturnPostfixIncrementOperand(node, sf);
        }

        // method_arg_callee:METHOD — find a call to .METHOD(X()), return the callee X
        case "method_arg_callee": {
            const method = parts[1];
            if (!method) return { name: null };
            const body = fn.body ?? node;
            return { name: findMethodArgCallee(body, method, sf) };
        }

        // standalone_increment — find a free-standing expression statement that is X++
        case "standalone_increment": {
            const body = fn.body ?? node;
            return { name: findStandaloneIncrement(body, sf) };
        }

        default:
            return { name: null };
    }
}

// ── New Walk Helpers ────────────────────────────────────────────────────────

/** Find a return statement containing a comma expression with exactly N parts */
function findReturnComma(body: ts.Node, n: number, sf: ts.SourceFile): ts.Node | null {
    let found: ts.Node | null = null;
    function visit(node: ts.Node) {
        if (found) return;
        if (ts.isReturnStatement(node) && node.expression) {
            const parts = collectCommaOperands(node.expression);
            if (parts.length === n) {
                found = node.expression;
                return;
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    return found;
}

/** Flatten a comma expression (BinaryExpression with CommaToken) into its operands */
function collectCommaOperands(expr: ts.Expression): ts.Expression[] {
    // Unwrap parentheses
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return [...collectCommaOperands(expr.left), ...collectCommaOperands(expr.right)];
    }
    return [expr];
}

/** Within a node, find a sub-expression containing `text` that is an assignment, return LHS name.
 *  If `idx` is provided, return the Nth (0-indexed) assignment target in the comma expression. */
function findAssignTargetContaining(node: ts.Node, text: string, sf: ts.SourceFile, idx?: number): string | null {
    // If this is a positional node (comma expr), iterate its operands
    const operands = ts.isBinaryExpression(node) ? collectCommaOperands(node as ts.Expression) : null;
    const candidates = operands ?? [node];

    let matchCount = 0;
    for (const candidate of candidates) {
        const candidateText = candidate.getText(sf);
        if (!candidateText.includes(text)) continue;

        // Look for assignment expression
        let result: string | null = null;
        function findAssign(n: ts.Node) {
            if (result) return;
            if (
                ts.isBinaryExpression(n) &&
                n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(n.left) &&
                n.getText(sf).includes(text)
            ) {
                result = n.left.text;
                return;
            }
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

/** Within a node, find an identifier that has `.propertyName` accessed on it */
function findMemberAccessTarget(node: ts.Node, propertyName: string, sf: ts.SourceFile): string | null {
    // Search across comma operands if applicable
    const operands = ts.isBinaryExpression(node) ? collectCommaOperands(node as ts.Expression) : null;
    const roots = operands ?? [node];

    for (const root of roots) {
        let result: string | null = null;
        function find(n: ts.Node) {
            if (result) return;
            if (
                ts.isPropertyAccessExpression(n) &&
                n.name.text === propertyName &&
                ts.isIdentifier(n.expression)
            ) {
                result = n.expression.text;
                return;
            }
            ts.forEachChild(n, find);
        }
        find(root);
        if (result) return result;
    }
    return null;
}

/** Find an if statement whose condition references `name`, return its then-body */
function findIfConditionRefs(body: ts.Node, name: string, sf: ts.SourceFile): ts.Node | null {
    let found: ts.Node | null = null;
    function visit(node: ts.Node) {
        if (found) return;
        if (ts.isIfStatement(node)) {
            const condText = node.expression.getText(sf);
            if (refsIdentifier(node.expression, name)) {
                found = node.thenStatement;
                return;
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    return found;
}

/** Check if an expression tree references a specific identifier */
function refsIdentifier(node: ts.Node, name: string): boolean {
    if (ts.isIdentifier(node) && node.text === name) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
        if (!found) found = refsIdentifier(child, name);
    });
    return found;
}

/** Find a postfix increment operand within a node (searches return statements first) */
function walkReturnPostfixIncrementOperand(node: ts.Node, sf: ts.SourceFile): WalkResult {
    let result: string | null = null;
    function find(n: ts.Node) {
        if (result) return;
        if (
            ts.isPostfixUnaryExpression(n) &&
            n.operator === ts.SyntaxKind.PlusPlusToken &&
            ts.isIdentifier(n.operand)
        ) {
            result = n.operand.text;
            return;
        }
        if (
            ts.isPrefixUnaryExpression(n) &&
            n.operator === ts.SyntaxKind.PlusPlusToken &&
            ts.isIdentifier(n.operand)
        ) {
            result = n.operand.text;
            return;
        }
        ts.forEachChild(n, find);
    }
    find(node);
    return { name: result };
}

/** Find a call to .method(X()), return the callee X of the first arg */
function findMethodArgCallee(body: ts.Node, method: string, sf: ts.SourceFile): string | null {
    let result: string | null = null;
    function visit(node: ts.Node) {
        if (result) return;
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === method &&
            node.arguments.length >= 1
        ) {
            const arg = node.arguments[0];
            if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
                result = arg.expression.text;
                return;
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    return result;
}

/** Find a standalone expression statement that is X++ or ++X */
function findStandaloneIncrement(body: ts.Node, sf: ts.SourceFile): string | null {
    let result: string | null = null;
    function visit(node: ts.Node) {
        if (result) return;
        if (ts.isExpressionStatement(node)) {
            const expr = node.expression;
            if (
                ts.isPostfixUnaryExpression(expr) &&
                expr.operator === ts.SyntaxKind.PlusPlusToken &&
                ts.isIdentifier(expr.operand)
            ) {
                result = expr.operand.text;
                return;
            }
            if (
                ts.isPrefixUnaryExpression(expr) &&
                expr.operator === ts.SyntaxKind.PlusPlusToken &&
                ts.isIdentifier(expr.operand)
            ) {
                result = expr.operand.text;
                return;
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    return result;
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
            // not our target — recurse into its body to find nested for-ofs
            ts.forEachChild(node, visit);
            return;
        }

        if (localType === "call_result" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    ts.isCallExpression(decl.initializer)
                ) {
                    result = decl.name.text;
                    return;
                }
            }
        }

        if (localType === "call_result_callee" && ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    ts.isCallExpression(decl.initializer) &&
                    ts.isIdentifier(decl.initializer.expression)
                ) {
                    result = decl.initializer.expression.text;
                    return;
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    let forOfCount = 0;
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

        const id = rule.id ?? rule.rename ?? minifiedName;
        resolvedById.set(id, { id, file: rule.file, minifiedName });

        if (!rule.anchor_only && rule.rename) {
            results.push({
                minified: minifiedName,
                original: rule.rename,
                confidence: 100,
                reason: `anchor: ${rule.description ?? rule.rename}`,
            });
        }

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

            // Find the parent node — either by name or by position for intermediate anchors
            let node: ts.Node | null;
            if (parent.nodeStart !== undefined && parent.nodeEnd !== undefined) {
                node = findNodeAtPosition(sf, parent.nodeStart, parent.nodeEnd);
            } else {
                node = findNodeByName(sf, parent.minifiedName);
            }
            if (!node) {
                if (verbose) console.warn(`  anchor walk skip: node "${parent.minifiedName}" not found — ${rule.description ?? rule.rename}`);
                continue;
            }

            const walkResult = walkFromNode(node, rule.walk, sf, resolvedById);
            if (!walkResult.name) {
                if (verbose) console.warn(`  anchor walk skip: walk "${rule.walk}" failed — ${rule.description ?? rule.rename}`);
                continue;
            }

            const id = rule.id ?? rule.rename;
            const resolved: Resolved = {
                id,
                file: parent.file,
                minifiedName: walkResult.name,
                nodeStart: walkResult.nodeStart,
                nodeEnd: walkResult.nodeEnd,
            };
            resolvedById.set(id, resolved);

            // Only emit a rename if this walk has a rename target (not an intermediate anchor)
            if (rule.rename && !walkResult.name.startsWith("__pos_")) {
                results.push({
                    minified: walkResult.name,
                    original: rule.rename,
                    confidence: 95,
                    reason: `anchor walk (${rule.from} → ${rule.walk})`,
                });
            }
        }

        if (unresolved.length === pending.length) break;
        pending.splice(0, pending.length, ...unresolved);
    }

    if (results.length > 0)
        console.log(`  Anchor rules: ${results.length} renames from ${rules.length} rules`);

    return results;
}

// ── Scoped Param/Local Rename ─────────────────────────────────────────────────
// Runs AFTER prettify against the already-renamed deobfuscated files.
// For param:N and local:* walk rules, finds the (renamed) function and
// replaces all references to the current param/local name within its body,
// stopping at nested functions that re-declare the same name.

function collectIdentifierRefs(
    node: ts.Node,
    name: string,
    sf: ts.SourceFile,
    out: Array<{ start: number; end: number }>,
): void {
    // Stop descending into nested function-likes that shadow this name in their params
    if (ts.isFunctionLike(node)) {
        const fn = node as ts.FunctionLikeDeclaration;
        const shadows = fn.parameters?.some(
            (p) => ts.isIdentifier(p.name) && p.name.text === name,
        );
        if (shadows) return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
        out.push({ start: node.getStart(sf), end: node.end });
    }
    ts.forEachChild(node, (child) => collectIdentifierRefs(child, name, sf, out));
}

function applyScopedRenameToFn(
    code: string,
    sf: ts.SourceFile,
    fn: ts.FunctionLikeDeclaration,
    oldName: string,
    newName: string,
): string {
    const positions: Array<{ start: number; end: number }> = [];

    // Rename the param declaration itself
    for (const param of fn.parameters ?? []) {
        if (ts.isIdentifier(param.name) && param.name.text === oldName) {
            positions.push({ start: param.name.getStart(sf), end: param.name.end });
        }
    }

    // All references within the body
    if (fn.body) collectIdentifierRefs(fn.body, oldName, sf, positions);

    if (positions.length === 0) return code;

    positions.sort((a, b) => b.start - a.start);
    let result = code;
    for (const { start, end } of positions) {
        result = result.slice(0, start) + newName + result.slice(end);
    }
    return result;
}

const SCOPED_WALK_PREFIXES = ["param:", "local:", "contains:"];

function isScopedWalk(walk: string): boolean {
    return SCOPED_WALK_PREFIXES.some((p) => walk.startsWith(p));
}

export function applyAnchorScopedRenamesInDir(deobDir: string, rulesPath: string): number {
    if (!fs.existsSync(rulesPath)) return 0;

    const rules: AnchorRule[] = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    const walkRules = (rules.filter(isWalkRule) as WalkRule[]).filter((r) => isScopedWalk(r.walk));
    if (walkRules.length === 0) return 0;

    // Run full anchor resolution to build the complete anchors map
    // (including walk-derived anchors like getGlobalConfig from getCustomApiKeyStatus)
    const allResults = applyAnchorRules(deobDir, rulesPath);

    // Build anchors from all resolved rules — root AND walk-derived.
    // Use the renamed name (original) as the function name since renames have been applied.
    const anchors = new Map<string, { file: string; renamedName: string }>();

    // Root rules
    for (const rule of rules.filter((r) => !isWalkRule(r)) as RootRule[]) {
        if (rule.rename) anchors.set(rule.id ?? rule.rename, { file: rule.file, renamedName: rule.rename });
    }

    // Walk rules that resolved (they produce anchors too)
    for (const rule of rules.filter(isWalkRule) as WalkRule[]) {
        const ruleId = rule.id ?? rule.rename;
        // Find the matching result to get the file
        const match = allResults.find(r => r.original === rule.rename);
        if (match && rule.rename) {
            // Walk-derived anchors inherit the file from their parent
            const parent = anchors.get(rule.from);
            if (parent) {
                anchors.set(ruleId, { file: parent.file, renamedName: rule.rename });
            }
        }
    }

    // Group scoped renames by file
    const byFile = new Map<string, Array<{ fnName: string; walk: string; rename: string }>>();
    for (const rule of walkRules) {
        const parent = anchors.get(rule.from);
        if (!parent) continue;
        if (!byFile.has(parent.file)) byFile.set(parent.file, []);
        byFile.get(parent.file)!.push({ fnName: parent.renamedName, walk: rule.walk, rename: rule.rename });
    }

    const verbose = !!process.env.ANCHOR_VERBOSE;
    let totalRenames = 0;

    for (const [file, scopedRules] of byFile) {
        const filePath = path.join(deobDir, file);
        if (!fs.existsSync(filePath)) continue;

        let code = fs.readFileSync(filePath, "utf-8");
        const original = code;

        for (const { fnName, walk, rename } of scopedRules) {
            let sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const fnNode = findNodeByName(sf, fnName) as ts.FunctionLikeDeclaration | null;
            if (!fnNode) {
                if (verbose) console.warn(`  scoped rename skip: function "${fnName}" not found`);
                continue;
            }

            const walkResult = walkFromNode(fnNode, walk, sf);
            if (!walkResult.name) {
                if (verbose) console.warn(`  scoped rename skip: walk "${walk}" failed in ${fnName}`);
                continue;
            }
            if (walkResult.name === rename) continue; // already correct

            const newCode = applyScopedRenameToFn(code, sf, fnNode, walkResult.name, rename);
            if (newCode !== code) {
                if (verbose) console.log(`  scoped rename: ${fnName} — ${walkResult.name} → ${rename}`);
                code = newCode;
                totalRenames++;
            }
        }

        if (code !== original) fs.writeFileSync(filePath, code, "utf-8");
    }

    if (totalRenames > 0) console.log(`  Scoped renames: ${totalRenames} applied`);
    return totalRenames;
}
