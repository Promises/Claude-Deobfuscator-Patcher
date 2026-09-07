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

// A single node-matchable criterion (no text/regex — those are string-offset based).
type NodeCriterion =
    | { string_literal: string }
    | { string_startswith: string }
    | { string_endswith: string }
    | { string_contains: string }
    | { number: number; op?: string }
    | { property_assignment: { key?: string; value?: string } }
    | { function_name: string }
    | { case: string | number }
    | { default_case: true };

// A single ancestor-context filter entry. Every find criterion can be reused as a
// filter (since all are NodeCriterion-based). Filters are an ordered list and ALL
// entries must pass for a candidate to be kept.
//   { include: C } → keep candidate only if some ancestor (inclusive) matches C.
//   { not: C }     → drop candidate if any ancestor matches C.
type FilterEntry = { not: NodeCriterion } | { include: NodeCriterion };

// Optional ancestor-context filters applicable to any find criterion.
interface ContextFilters {
    filter?: FilterEntry[];
}

type FindCriteria =
    | ({ text: string } & ContextFilters)
    | ({ regex: string } & ContextFilters)
    | (NodeCriterion & ContextFilters);

export type Scope =
    | "function"
    | "async_generator"
    | "generator"
    | "async_function"
    | "method"
    | "class"
    | "arrow"
    // The bundler's module-init arrow: `var sT = L(() => { ...module body... })`
    // at the top level of a file. It has no derivable name of its own (its
    // parent is the CallExpression, not the declarator), which is exactly why
    // it needs its own scope kind — see POSITIONAL ANCHORS below.
    | "module_init";

interface RootRule {
    id?: string;
    description?: string;
    file: string;
    find: FindCriteria | string;
    scope: Scope;
    rename?: string;
    anchor_only?: boolean; // resolve anchor but emit no rename
    class?: string; // also rename enclosing class (scope=method)
    /**
     * POSITIONAL ANCHOR (requires anchor_only).
     *
     * Normally a root rule registers its anchor under the minified NAME of the
     * scope node, and a scope with no derivable name (`getNodeName` → null) is
     * dead: the rule warns UNNAMED SCOPE and emits nothing. That skip made every
     * symbol living inside the bundler's anonymous module-init arrow
     * (`var sT = L(() => { ... })`) unreachable, because the arrow's parent is a
     * CallExpression rather than a VariableDeclaration.
     *
     * With `anchor_positional: true` the rule instead registers the resolved
     * scope by its AST SPAN (nodeStart/nodeEnd) — the same addressing walk rules
     * already use for intermediate anchors — so walks can chain from an unnamed
     * scope. The span is recomputed from the rule's own `find` on every run
     * against whichever tree is being processed; it is never persisted, so this
     * is NOT a line-number or offset key baked into the ruleset. The stable key
     * remains the rule's `find` criterion plus `file` + `scope`.
     *
     * Positional anchors emit no rename themselves (there is no name to rename),
     * hence the anchor_only requirement.
     */
    anchor_positional?: boolean;
    /**
     * Opt OUT of the missing-file whole-tree fallback (see resolveByUniqueScan).
     *
     * Set this on a rule that is deliberately redundant with another rule — a
     * `_split` / `_legacy` / `_v168` variant that is EXPECTED to miss on the tree
     * it does not describe. Without it such a rule can win the unique-scan and
     * bind a name its sibling rule already binds correctly.
     */
    no_tree_scan?: boolean;
}

interface WalkRule {
    id?: string;
    description?: string;
    from: string; // references another rule's id or rename
    walk: string; // walk expression
    rename: string;
    find?: FindCriteria | string; // optional: locate position within parent before walking
}

interface PinRule {
    type: "pin";
    description?: string;
    source: string; // target source path (e.g. "components/PromptInput/useSwarmBanner.ts")
    find: FindCriteria | string; // content anchor — must match inside the module
}

type AnchorRule = RootRule | WalkRule | PinRule;

function isWalkRule(rule: AnchorRule): rule is WalkRule {
    return "from" in rule;
}

function isPinRule(rule: AnchorRule): rule is PinRule {
    return "type" in rule && (rule as any).type === "pin";
}

/**
 * Resolve pin rules by scanning raw split modules for find patterns.
 * Returns a map: module_name → source file path for modules that matched a pin.
 */
export function resolvePinRules(rulesPath: string, modulesDir: string): Map<string, string> {
    const result = new Map<string, string>();
    if (!fs.existsSync(rulesPath)) return result;

    const rules: AnchorRule[] = (JSON.parse(fs.readFileSync(rulesPath, "utf-8")) as AnchorRule[])
        // `disabled: true` retires a rule WITHOUT deleting it, so the REASON it was
        // retired stays beside it — delete the rule and the next person to meet the
        // same symptom re-derives the whole diagnosis.
        // ⚠️ Added because the flag was ALREADY BEING USED and silently IGNORED: a
        // rule marked disabled still fired, so a "retirement" was a no-op that read
        // as done. Anything shaped like an off-switch must switch something off.
        // Filtered at LOAD, not in isPinRule() — a disabled pin dropped there would
        // fall through to the root-rule path at :1463 and be misrouted, not disabled.
        .filter((r) => (r as any).disabled !== true);
    const pins = rules.filter(isPinRule) as PinRule[];
    if (pins.length === 0) return result;

    const manifestPath = path.join(modulesDir, "_manifest.json");
    if (!fs.existsSync(manifestPath)) return result;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    for (const pin of pins) {
        let found = false;
        for (const section of manifest.sections) {
            if (section.type !== "section") continue;
            const modPath = path.join(modulesDir, section.filename);
            if (!fs.existsSync(modPath)) continue;

            const code = fs.readFileSync(modPath, "utf-8");
            const sf = ts.createSourceFile(section.filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const pos = findPatternPos(code, pin.find, sf);
            if (pos !== -1) {
                // 🔴 A DUPLICATE BINDING USED TO BE SILENT, AND IT DELETES A MODULE.
                // This is a plain Map keyed on the minified module name: a second
                // pin matching the same module simply overwrote the first, and
                // BOTH printed a cheerful "Pin:" success line. MEASURED on
                // 2.1.263: two shipped pins both bind module `b2`
                // (commands/remoteCommands.ts and services/compact/
                // precomputedCompact.ts), the second wins, and
                // commands/remoteCommands.js is ABSENT from the built tree while
                // the log shows two successes. Confirmed independently by two
                // agents, and present with the shipped ruleset alone.
                // Related, same class: a pin aimed at an already-occupied path
                // deletes whatever legitimately owned it — that cost two modules
                // (5439 -> 5437 files) earlier in this project, with the build
                // reporting success throughout.
                // A pin is a rename of a FILE; two rules claiming one file is a
                // rule bug, not a tie to be broken silently.
                const prior = result.get(section.module_name);
                if (prior && prior !== pin.source) {
                    // VERSION-SPECIFIC MERGES ARE EXPECTED, so a pin may declare
                    // `yields_to`: the paths it will stand down for when upstream
                    // merges its module into another. This is NOT a tie-break
                    // convenience — it is how one ruleset stays correct across
                    // versions where module IDENTITY differs.
                    //
                    // MEASURED: commands/remoteCommands is a separate module on
                    // 2.1.238 (where patch 005 depends on its pin) and is MERGED
                    // into the precomputed-compact chunk on 2.1.263 (one 5.6 MB
                    // chunk holding both pin keys). A global `disabled` flag
                    // cannot express that: disabling it fixed 263 and dropped 238
                    // to 9/10 patches; restoring it fixed 238 and made 263 throw.
                    // I broke each version once by fixing the other.
                    //
                    // A pin that yields keeps its rules pointed at the winner's
                    // path, which is correct: the module is genuinely there now.
                    const yieldsTo = ((pin as any).yields_to ?? []) as string[];
                    if (yieldsTo.includes(prior)) {
                        console.log(
                            `  Pin: ${pin.source} YIELDS to ${prior} for module ` +
                            `"${section.module_name}" (declared yields_to; upstream merged them)`,
                        );
                        found = true;
                        break;
                    }
                    if (((result.get(section.module_name) && (pins.find(x => x.source === prior) as any)?.yields_to) ?? []).includes(pin.source)) {
                        // The incumbent declared that IT yields to us — take over.
                        console.log(
                            `  Pin: ${prior} YIELDS to ${pin.source} for module "${section.module_name}"`,
                        );
                        result.set(section.module_name, pin.source);
                        found = true;
                        break;
                    }
                    throw new Error(
                        `pin collision: module "${section.module_name}" is claimed by BOTH ` +
                        `"${prior}" and "${pin.source}". Either one find key is not unique to ` +
                        `its module (tighten it), or upstream MERGED the two modules in this ` +
                        `version — in which case add "yields_to": ["${prior}"] to the pin that ` +
                        `should stand down. Silently keeping the last writer makes the other ` +
                        `module vanish from the tree.`,
                    );
                }
                result.set(section.module_name, pin.source);
                console.log(`  Pin: ${section.module_name} → ${pin.source} (${pin.description ?? ""})`);
                found = true;
                break;
            }
        }
        if (!found) {
            console.warn(`  Pin miss: no module matched find for ${pin.source} (${pin.description ?? ""})`);
        }
    }
    return result;
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

/**
 * Shared per-node predicate covering every AST-node-based criterion type.
 * `text`/`regex` are string-offset based and are NOT handled here (they have no
 * single node) — callers special-case them. Returns false for those keys.
 */
function matchesNode(node: ts.Node, criterion: NodeCriterion, sf: ts.SourceFile): boolean {
    const c = criterion as any;
    if ("string_literal" in c) return ts.isStringLiteral(node) && node.text === c.string_literal;
    if ("string_startswith" in c) return ts.isStringLiteral(node) && node.text.startsWith(c.string_startswith);
    if ("string_endswith" in c) return ts.isStringLiteral(node) && node.text.endsWith(c.string_endswith);
    if ("string_contains" in c) return ts.isStringLiteral(node) && node.text.includes(c.string_contains);
    if ("number" in c) {
        if (!(ts.isNumericLiteral(node) && Number(node.text) === c.number)) return false;
        if (c.op) {
            const p = node.parent;
            return !!(p && ts.isBinaryExpression(p) && ts.tokenToString(p.operatorToken.kind) === c.op);
        }
        return true;
    }
    if ("property_assignment" in c) {
        const { key, value } = c.property_assignment as { key?: string; value?: string };
        if (!(ts.isPropertyAssignment(node) && ts.isIdentifier(node.name))) return false;
        const km = !key || node.name.text === key;
        const vm = !value || (ts.isStringLiteral(node.initializer) && node.initializer.text === value);
        return km && vm;
    }
    if ("function_name" in c) return getNodeName(node) === c.function_name;
    if ("case" in c) {
        if (!ts.isCaseClause(node)) return false;
        const expr = node.expression;
        if (!(ts.isStringLiteral(expr) || ts.isNumericLiteral(expr))) return false;
        return expr.text === String(c.case);
    }
    if ("default_case" in c) return ts.isDefaultClause(node);
    return false;
}

/** Does any ancestor of `node` (inclusive of node itself) satisfy `criterion`? */
function anyAncestorMatches(node: ts.Node, criterion: NodeCriterion, sf: ts.SourceFile): boolean {
    let cur: ts.Node | undefined = node;
    while (cur) {
        if (matchesNode(cur, criterion, sf)) return true;
        cur = cur.parent;
    }
    return false;
}

/**
 * Apply the optional `filter` list of ancestor-context filters to a candidate node.
 * Filters are an ordered list; ALL entries must pass.
 * - `{ not: C }`:     drop candidate if C matches any ancestor.
 * - `{ include: C }`: keep candidate only if C matches some ancestor.
 * For text/regex finds there is no single AST node, so `node` is the deepest
 * node resolved at the match offset (or null). When null, context filters pass.
 */
function passesContextFilters(node: ts.Node | null, filters: ContextFilters, sf: ts.SourceFile): boolean {
    const entries = filters.filter ?? [];
    if (entries.length === 0) return true;
    if (!node) return true; // text/regex offset with no resolvable node — skip filtering
    for (const entry of entries) {
        if ("not" in entry) {
            if (anyAncestorMatches(node, entry.not, sf)) return false;
        } else {
            if (!anyAncestorMatches(node, entry.include, sf)) return false;
        }
    }
    return true;
}

/** Resolve the deepest AST node whose span contains `pos`. */
function deepestNodeAt(sf: ts.SourceFile, pos: number): ts.Node | null {
    let deepest: ts.Node | null = null;
    function descend(n: ts.Node) {
        if (n.getStart(sf) <= pos && pos < n.end) {
            deepest = n;
            ts.forEachChild(n, descend);
        }
    }
    ts.forEachChild(sf, descend);
    return deepest;
}

/**
 * Collect all candidate match positions for a find, in depth-first traversal
 * order, after applying any `filter` ancestor-context filters.
 * Shared by findPatternPos (takes [0]) and analyzeFind (takes all).
 */
function collectFindPositions(code: string, find: FindCriteria | string, sf: ts.SourceFile): number[] {
    const f: any = typeof find === "string" ? { text: find } : find;
    const filters: ContextFilters = { filter: f.filter };
    const positions: number[] = [];

    if ("text" in f) {
        let i = code.indexOf(f.text);
        while (i !== -1) {
            if (passesContextFilters(deepestNodeAt(sf, i), filters, sf)) positions.push(i);
            i = code.indexOf(f.text, i + Math.max(1, f.text.length));
        }
        return positions;
    }

    if ("regex" in f) {
        const re = new RegExp(f.regex, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(code))) {
            if (passesContextFilters(deepestNodeAt(sf, m.index), filters, sf)) positions.push(m.index);
            if (m.index === re.lastIndex) re.lastIndex++;
        }
        return positions;
    }

    // property_assignment with neither key nor value matches nothing (legacy behavior)
    if ("property_assignment" in f) {
        const { key, value } = f.property_assignment ?? {};
        if (!key && !value) return positions;
    }

    const criterion = f as NodeCriterion;
    function visit(node: ts.Node) {
        if (matchesNode(node, criterion, sf) && passesContextFilters(node, filters, sf)) {
            positions.push(node.getStart(sf));
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return positions;
}

export function findPatternPos(code: string, find: FindCriteria | string, sf: ts.SourceFile): number {
    const positions = collectFindPositions(code, find, sf);
    return positions.length > 0 ? positions[0] : -1;
}

// ── Scope Detection ──────────────────────────────────────────────────────────

/**
 * SINGLE SOURCE OF TRUTH for scope matching — anchor-dev.ts imports this rather
 * than keeping its own copy. It previously had a forked `Scope` union and a
 * forked `scopeMatches`, the same drift that once made `scope: "arrow"` resolve
 * in the dev tool and rename nothing in the real build. Do not fork it.
 */
export function scopeMatches(node: ts.Node, scope: Scope): boolean {
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
        case "module_init":
            return isModuleInitArrow(node);
    }
}

/**
 * True for the bundler's module-init arrow: the block-bodied arrow that is the
 * SOLE argument of a call initializing a TOP-LEVEL variable declarator —
 *
 *     var sT = L(() => { ...entire module body... });
 *
 * Measured on commands.js: exactly ONE such arrow in 2.1.168 (`L`, decl `sT`,
 * 131 statements) and exactly one in 2.1.238 (`E`, decl `pg`, 147 statements),
 * so within a file the shape is unambiguous. Neither the wrapper callee (`L` /
 * `E`) nor the declarator (`sT` / `pg`) is used as a key — both are minified and
 * both drift between versions. The shape alone identifies it.
 *
 * Deliberately excludes non-top-level arrows and expression-bodied arrows, so a
 * nested `h6(() => [...])` memo callback does NOT match; reach those with
 * `scope: "arrow"` + `anchor_positional` instead.
 */
function isModuleInitArrow(node: ts.Node): boolean {
    if (!ts.isArrowFunction(node)) return false;
    if (!ts.isBlock(node.body)) return false;
    const call = node.parent;
    if (!call || !ts.isCallExpression(call)) return false;
    if (call.arguments.length !== 1 || call.arguments[0] !== node) return false;
    const decl = call.parent;
    if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer !== call) return false;
    // Top level: VariableDeclaration < VariableDeclarationList < VariableStatement < SourceFile
    const list = decl.parent;
    const stmt = list?.parent;
    return !!stmt && !!stmt.parent && ts.isSourceFile(stmt.parent);
}

/**
 * Resolve the minified name a scope node should be renamed under.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH. anchor-dev.ts imports it rather than
 * keeping its own copy: a second implementation previously drifted (it had an
 * ArrowFunction case this one lacked), so `scope: "arrow"` rules RESOLVED in
 * the dev tool and silently renamed NOTHING in the real build. Do not fork it.
 */
export function getNodeName(node: ts.Node): string | null {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text ?? null;
    if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
        if (node.name) return node.name.text;
        if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
            return node.parent.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    // An arrow function has no name of its own; it is named by the declarator
    // it initializes (`let Foo = () => {...}`). Required for scope: "arrow".
    if (ts.isArrowFunction(node) && node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
        return node.parent.name.text;
    return null;
}

export function findContainingScope(sf: ts.SourceFile, pos: number, scope: Scope): ts.Node | null {
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

// ── Find ambiguity analysis ──────────────────────────────────────────────────
// findPatternPos binds to the FIRST match. This reports ALL matches (with line
// + enclosing scope) so callers can warn when a landmark is ambiguous. Mirrors
// findPatternPos's matching semantics exactly; matches[0] is the one used.

export interface FindMatch { line: number; column: number; scope: string | null; inRequestedScope: boolean; }
export interface FindAnalysis { count: number; usedIndex: number; matches: FindMatch[]; }

export function analyzeFind(code: string, find: FindCriteria | string, scope: Scope = "function"): FindAnalysis {
    const sf = ts.createSourceFile("f.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const positions = collectFindPositions(code, find, sf);

    const matches: FindMatch[] = positions.map((pos) => {
        const lc = sf.getLineAndCharacterOfPosition(pos);
        const scopeNode = findContainingScope(sf, pos, scope);
        let name = scopeNode ? getNodeName(scopeNode) : null;
        if (!name) { const fn = findContainingScope(sf, pos, "function"); name = fn ? getNodeName(fn) : null; }
        return { line: lc.line + 1, column: lc.character + 1, scope: name, inRequestedScope: !!scopeNode };
    });

    return { count: matches.length, usedIndex: 0, matches };
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
            // Function declaration/expression: return parameter name
            const param = fn.parameters?.[idx];
            if (param && ts.isIdentifier(param.name)) return { name: param.name.text };
            // Call expression: return argument identifier
            if (ts.isCallExpression(node) && idx < node.arguments.length) {
                const arg = node.arguments[idx];
                if (ts.isIdentifier(arg)) return { name: arg.text };
            }
            return { name: null };
        }

        case "local": {
            return { name: walkLocal(fn, parts.slice(1).join(":"), sf) };
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

        // only_bare_call — returns the callee name only if there's exactly one call in the body,
        // it has zero arguments, and the callee is a plain identifier.
        // Matches patterns like: function f() { if (cond) g(); }
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
            // call_string_arg:VALUE:callee — VALUE is rejoined to handle colons
            const value = parts.slice(1, -1).join(":");
            const action = parts[parts.length - 1];
            if (!fn.body || !value || action !== "callee") return { name: null };
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

        // call_string_contains:SUBSTR:callee — like call_string_arg but partial match
        case "call_string_contains": {
            const substr = parts.slice(1, -1).join(":");
            const action = parts[parts.length - 1];
            if (!fn.body || !substr || action !== "callee") return { name: null };
            let result: string | null = null;
            function find(n: ts.Node) {
                if (result) return;
                if (ts.isCallExpression(n)) {
                    const hasArg = n.arguments.some((a) => ts.isStringLiteral(a) && a.text.includes(substr));
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

        // export_map — search the entire file for an object literal containing
        // `someKey: () => MINIFIED_NAME` where MINIFIED_NAME is the anchor's minified name.
        // Returns the object literal as a positional anchor.
        case "export_map": {
            const anchorName = getNodeName(node);
            if (!anchorName) return { name: null };
            const obj = findExportMapObject(sf, anchorName);
            if (obj) return { name: `__pos_${obj.getStart(sf)}`, nodeStart: obj.getStart(sf), nodeEnd: obj.end };
            return { name: null };
        }

        // closest_parent:if|while|for|call — from a positional anchor, walk up the AST
        // to the nearest matching parent node. Returns it as a positional anchor.
        case "closest_parent": {
            const target = parts[1];
            if (!target) return { name: null };
            // node is already positioned (from find or previous walk)
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

        // condition_callee — from an if/while node, return the callee of the condition.
        // Matches: if (fn(x)) or while (fn(x))
        // When used with an id (no rename), also stores the call node position for further walks (e.g. param:0)
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

        // callee — from a call expression node, return the callee identifier
        case "callee": {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
                return { name: node.expression.text };
            // If node is an expression statement wrapping a call
            if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression))
                return { name: node.expression.expression.text };
            return { name: null };
        }

        // declarator_name — from a node positioned anywhere inside a variable
        // declarator's INITIALIZER (typically via `find`), walk up to the
        // enclosing VariableDeclaration and return the declared name.
        //
        // Closes the gap where a readiness flag is a plain declarator in a long
        // `let a = ..., b = ..., c = ...;` list:
        //     let Dk = mz || KH || OH,
        //         gY = a1?.isLocalJSXCommand === !0 && a1?.jsx != null;
        // Neither `contains:*:assign_target` (needs a BinaryExpression `=`) nor
        // `binary_other_operand` (returns the other operand, e.g. `!0`) can name
        // `gY`; the declarator name lives on an ancestor, not a sibling.
        case "declarator_name": {
            let cur: ts.Node | undefined = node;
            // Stop at a function boundary so we cannot escape into an outer
            // declarator (e.g. `let Foo = () => { ...find lands here... }`)
            // and mistakenly return the enclosing function's own name.
            while (cur && !ts.isVariableDeclaration(cur)) {
                if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur))
                    return { name: null };
                cur = cur.parent;
            }
            if (cur && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name))
                return { name: cur.name.text, nodeStart: cur.name.getStart(sf), nodeEnd: cur.name.end };
            return { name: null };
        }

        // call_arg:N — from a node positioned at/inside a call expression, return
        // the Nth argument when it is a bare identifier.
        //
        // Closes the gap where a value is distributed via a call argument rather
        // than bound to a name, e.g. a React context read: `useContext(VVi)`.
        // `param:N` already reads call arguments, but only when the walk landed
        // exactly ON the CallExpression; a `find` on the callee text lands on an
        // inner Identifier, so this walks UP to the nearest enclosing call first.
        case "call_arg": {
            const idx = parseInt(parts[1] ?? "0");
            let cur: ts.Node | undefined = node;
            while (cur && !ts.isCallExpression(cur)) cur = cur.parent;
            if (!cur || !ts.isCallExpression(cur)) return { name: null };
            const arg = cur.arguments[idx];
            if (arg && ts.isIdentifier(arg))
                return { name: arg.text, nodeStart: arg.getStart(sf), nodeEnd: arg.end };
            return { name: null };
        }

        // catch_binding — from a try statement (or any node containing one),
        // return the identifier bound by the first `catch (e)` clause.
        case "catch_binding": {
            const body = fn.body ?? node;
            return { name: findCatchBinding(body, sf) };
        }

        // binary_other_operand — from a node positioned inside a binary expression
        // (typically via find), walk up to the containing BinaryExpression and return
        // the identifier on the other side. Works for ===, !==, ==, !=, <, >, etc.
        case "binary_other_operand": {
            let cur: ts.Node | undefined = node;
            while (cur && !ts.isBinaryExpression(cur)) cur = cur.parent;
            if (!cur || !ts.isBinaryExpression(cur)) return { name: null };
            const bin = cur;
            // Determine which side the find landed on, return the other
            const nodeStart = node.getStart(sf);
            const nodeEnd = node.end;
            const leftStart = bin.left.getStart(sf);
            const leftEnd = bin.left.end;
            const other = (nodeStart >= leftStart && nodeEnd <= leftEnd) ? bin.right : bin.left;
            if (ts.isIdentifier(other)) return { name: other.text };
            return { name: null };
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

        // Look for an assignment expression OR a variable declarator.
        //
        // Both bind a name to a value; only the spelling differs, and which
        // spelling a given release uses is a refactor away. Handling only
        // `X = expr` meant a rule resolved on a build where the declaration had
        // been split (`X = await fn()`) and silently failed on one where it had
        // not (`let X = await fn()`) — same code, same intent, different node.
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
            if (
                ts.isVariableDeclaration(n) &&
                ts.isIdentifier(n.name) &&
                n.initializer &&
                n.initializer.getText(sf).includes(text)
            ) {
                result = n.name.text;
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

/** Find the identifier bound by the first `catch (e)` clause within a node.
 *  The catch parameter is a declaration all of its own (CatchClause.variableDeclaration),
 *  reachable by no other walk: it is not a declarator in a VariableDeclarationList,
 *  not an assignment, and not a function parameter. */
function findCatchBinding(body: ts.Node, sf: ts.SourceFile): string | null {
    let result: string | null = null;
    function visit(node: ts.Node) {
        if (result) return;
        if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
            result = node.variableDeclaration.name.text;
            return;
        }
        ts.forEachChild(node, visit);
    }
    visit(body);
    return result;
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

function walkLocal(fn: ts.FunctionLikeDeclaration, localType: string, sf?: ts.SourceFile): string | null {
    // Search the function body when we have one; otherwise search the node
    // itself. A POSITIONAL anchor (from `return:comma`, `if:condition_refs`,
    // `closest_parent`, …) is a plain expression/statement with no `.body`, and
    // the old unconditional `if (!fn.body) return null` made every local:* walk
    // unusable from one — a whole class of rules that could never fire.
    const root: ts.Node | undefined = fn.body ?? (fn as unknown as ts.Node);
    if (!root) return null;
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

        // call_result_named:FN — name the local whose INITIALIZER calls FN.
        //   let X = await refreshOAuthToken(...)  →  X
        // Unlike `call_result` (which takes the first call-initialized local it
        // meets, wherever it is), this is selective: it identifies the local by
        // WHICH function produced it, which is what makes it stable across
        // releases that reorder or insert declarations. Matches both `fn()` and
        // `obj.fn()`, and looks through `await`.
        if (localType.startsWith("call_result_named:") && ts.isVariableDeclaration(node)) {
            const target = localType.slice("call_result_named:".length);
            if (target && ts.isIdentifier(node.name) && node.initializer) {
                let init: ts.Expression = node.initializer;
                if (ts.isAwaitExpression(init)) init = init.expression;
                if (ts.isCallExpression(init)) {
                    const callee = init.expression;
                    const calleeName = ts.isIdentifier(callee)
                        ? callee.text
                        : ts.isPropertyAccessExpression(callee)
                          ? callee.name.text
                          : null;
                    if (calleeName === target) {
                        result = node.name.text;
                        return;
                    }
                }
            }
        }

        // declarator_named_init:TEXT — name the local whose initializer text
        // contains TEXT. The general form behind the readiness-flag case, where
        // the value is an expression rather than a call:
        //   let gY = a1?.isLocalJSXCommand === !0 && a1?.jsx != null  →  gY
        if (localType.startsWith("declarator_named_init:") && ts.isVariableDeclaration(node)) {
            const needle = localType.slice("declarator_named_init:".length);
            if (needle && ts.isIdentifier(node.name) && node.initializer && sf) {
                if (node.initializer.getText(sf).includes(needle)) {
                    result = node.name.text;
                    return;
                }
            }
        }

        // catch_binding — the identifier bound by the first catch clause.
        if (localType === "catch_binding" && ts.isCatchClause(node)) {
            if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
                result = node.variableDeclaration.name.text;
                return;
            }
        }

        // binding_element:PROP — name the local bound by an object-destructuring
        // property whose SOURCE KEY is PROP:
        //   let { status: xD, waitingFor: eGe, working: tGe } = IOo  →  (…:waitingFor) eGe
        //
        // This is the only walk that can reach a destructured local. Every other
        // `local:*` variant tests `ts.isIdentifier(decl.name)`, which an
        // ObjectBindingPattern fails by construction, so before this handler a
        // destructured binding was unnameable no matter which find/walk pair was
        // tried. React-Compiler output destructures heavily out of anonymous memo
        // slots, so this reaches a whole class of symbols, not one.
        //
        // Keyed on the PROPERTY NAME, which is upstream source text: a minifier
        // may rewrite the bound local (`eGe`) freely but must preserve the key
        // (`waitingFor:`) or the object lookup breaks. That is what makes it
        // version-stable.
        //
        // Shorthand (`let { waitingFor } = x`) is deliberately EXCLUDED: there
        // the local IS the property name, so it is already unminified and needs
        // no anchor — and binding it would emit a self-rename.
        if (localType.startsWith("binding_element:") && ts.isObjectBindingPattern(node)) {
            const wantKey = localType.slice("binding_element:".length);
            if (wantKey) {
                for (const el of node.elements) {
                    if (
                        el.propertyName &&
                        ts.isIdentifier(el.propertyName) &&
                        el.propertyName.text === wantKey &&
                        ts.isIdentifier(el.name)
                    ) {
                        result = el.name.text;
                        return;
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    let forOfCount = 0;
    visit(root);
    return result;
}

/** Find an object literal that has a property `key: () => name` where name matches */
function findExportMapObject(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | null {
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

/** Extract all `key: () => identifier` pairs from an object literal */
function extractExportMapRenames(node: ts.Node, sf: ts.SourceFile): MatchResult[] {
    if (!ts.isObjectLiteralExpression(node)) return [];
    const results: MatchResult[] = [];
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
                results.push({
                    minified,
                    original,
                    confidence: 90,
                    reason: `anchor export_map`,
                });
            }
        }
    }
    return results;
}

// First occurrence of identifier `name` WITHIN `scope` (the node the walk
// resolved against). The anchor renames this name across that scope, so this
// is a position the anchor genuinely binds — derived from the resolver itself,
// never a heuristic that could point elsewhere.
function firstIdentStart(scope: ts.Node, name: string, sf: ts.SourceFile): number | undefined {
    let found: number | undefined;
    function visit(n: ts.Node) {
        if (found !== undefined) return;
        if (ts.isIdentifier(n) && n.text === name) { found = n.getStart(sf); return; }
        ts.forEachChild(n, visit);
    }
    visit(scope);
    return found;
}

// ── Missing-file fallback: whole-tree scan under a UNIQUENESS invariant ──────
//
// WHY THIS EXISTS
// A rule's `file` is how it says WHERE to look. On the monolithic tree that path
// is a real module and the rule resolves there. On a CHUNKED tree bun's bundler
// has hoisted and merged modules, so most of those paths do not exist at all:
// measured on 2.1.259, 22 of 43 root rules name a file that is absent, and the
// content they describe is sitting inside a mega-chunk named after ONE of its
// many constituents (services/compact/precomputedCompact.js is 9.1 MB and holds
// query.js's and withRetry.js's content). The module boundaries are erased, so
// re-splitting is not available. The pattern is still there; only the address is
// wrong.
//
// WHY `file` CANNOT SIMPLY BE DROPPED
// `file` is not only a lookup, it is the SAFETY property: it stops a pattern
// binding a same-looking node in an unrelated module. Deleting it and taking the
// first whole-tree hit would bind confidently and wrongly. That is measured, not
// feared — on 2.1.259 `formatErrorMessage`'s pattern resolves to a named scope in
// 48 DIFFERENT files, `LogoV2`'s in 12, `getCustomApiKeyStatus`'s in 10, and in
// every one of those cases the candidate names are all DISTINCT. "First match"
// would have silently mis-bound all of them.
//
// THE REPLACEMENT INVARIANT
// Uniqueness, not position. The fallback runs only when the declared `file` is
// absent, and it BINDS ONLY IF the whole tree yields exactly ONE candidate — one
// distinct minified name from a scope of the requested kind. Zero candidates or
// two-or-more candidates DECLINE, and decline LOUDLY: an ambiguous rule reports
// its candidates so it can be given a tighter key, rather than silently guessing.
//
// Candidates are deduplicated by resolved NAME, not by file, so a pattern that
// legitimately appears several times in one mega-chunk but always resolves to the
// same scope still counts as unique. This is what makes the fallback usable at
// all on a tree whose files are megabytes wide.
//
// The fallback is INERT on monolithic trees: every `file` exists there, so the
// missing-file branch is never taken and the resolved set is unchanged (verified
// — 2.1.238 stays at 725 renames, same members).

interface ScanCandidate {
    name: string;
    file: string;
    pos: number;
    nodeStart: number;
    nodeEnd: number;
}

/** Lazily-parsed, cached view of every .js file in the tree. */
class TreeIndex {
    private files: string[] | null = null;
    private cache = new Map<string, { code: string; sf: ts.SourceFile }>();
    constructor(private deobDir: string) {}

    list(): string[] {
        if (this.files) return this.files;
        const acc: string[] = [];
        const rec = (d: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) rec(p);
                else if (e.name.endsWith(".js")) acc.push(p);
            }
        };
        rec(this.deobDir);
        acc.sort();
        this.files = acc;
        return acc;
    }

    get(fp: string): { code: string; sf: ts.SourceFile } | null {
        let c = this.cache.get(fp);
        if (c) return c;
        let code: string;
        try { code = fs.readFileSync(fp, "utf-8"); } catch { return null; }
        const rel = path.relative(this.deobDir, fp);
        c = { code, sf: ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) };
        this.cache.set(fp, c);
        return c;
    }
}

/**
 * Search the whole tree for `rule.find` and return the candidates whose
 * enclosing scope is of the requested kind AND has a derivable name.
 * Deduplicated by resolved name (see the uniqueness note above).
 */
function scanTreeForRule(rule: RootRule, index: TreeIndex): ScanCandidate[] {
    const byName = new Map<string, ScanCandidate>();
    for (const fp of index.list()) {
        const entry = index.get(fp);
        if (!entry) continue;
        const { code, sf } = entry;
        let pos: number;
        try { pos = findPatternPos(code, rule.find, sf); } catch { continue; }
        if (pos === -1) continue;
        const node = findContainingScope(sf, pos, rule.scope);
        if (!node) continue;
        const name = getNodeName(node);
        if (!name) continue;
        if (!byName.has(name))
            byName.set(name, {
                name,
                file: sf.fileName,
                pos,
                nodeStart: node.getStart(sf),
                nodeEnd: node.end,
            });
    }
    return [...byName.values()];
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export function applyAnchorRules(deobDir: string, rulesPath: string): MatchResult[] {
    if (!fs.existsSync(rulesPath)) return [];

    const rules: AnchorRule[] = (JSON.parse(fs.readFileSync(rulesPath, "utf-8")) as AnchorRule[])
        // `disabled: true` retires a rule WITHOUT deleting it, so the REASON it was
        // retired stays beside it — delete the rule and the next person to meet the
        // same symptom re-derives the whole diagnosis.
        // ⚠️ Added because the flag was ALREADY BEING USED and silently IGNORED: a
        // rule marked disabled still fired, so a "retirement" was a no-op that read
        // as done. Anything shaped like an off-switch must switch something off.
        // Filtered at LOAD, not in isPinRule() — a disabled pin dropped there would
        // fall through to the root-rule path at :1463 and be misrouted, not disabled.
        .filter((r) => (r as any).disabled !== true);
    return applyAnchorRulesFromRules(deobDir, rules);
}

/**
 * Same as applyAnchorRules but takes already-parsed rules in memory.
 * Used by the studio backend to resolve DRAFT rules without writing to disk.
 */
export function applyAnchorRulesFromRules(deobDir: string, rules: AnchorRule[]): MatchResult[] {
    if (!rules || rules.length === 0) return [];

    const results: MatchResult[] = [];
    const resolvedById = new Map<string, Resolved>();

    const verbose = !!process.env.ANCHOR_VERBOSE;

    // Built lazily — a monolithic tree never takes the missing-file branch, so
    // it must not pay to walk and parse 5,439 files.
    const treeIndex = new TreeIndex(deobDir);
    const scanStats = { attempted: 0, bound: 0, ambiguous: 0, absent: 0 };

    // ── Phase 1: Root rules ──────────────────────────────────────────────────

    for (const rule of rules.filter((r) => !isWalkRule(r) && !isPinRule(r)) as RootRule[]) {
        // A comment-only entry (an object carrying just `__note`/`__note_*` keys,
        // used to document a group of rules) is not a rule. Without this guard it
        // fell through to path.join(deobDir, undefined), which THROWS and aborts
        // the entire run — every rule in the file silently produces nothing.
        if (!rule.file || !rule.find) {
            if (verbose && (rule.id || rule.rename))
                console.warn(`  anchor skip: entry has no file/find — ${rule.id ?? rule.rename}`);
            continue;
        }

        // `resolvedFile` is what the rule ACTUALLY bound against. It equals
        // rule.file on the normal path, and the mega-chunk that really contains
        // the pattern when the fallback fires. Walk rules chain off
        // Resolved.file, so recording the declared-but-wrong path here would
        // strand every walk that depends on this anchor.
        let resolvedFile = rule.file;
        let code: string;
        let sf: ts.SourceFile;
        let node: ts.Node | null = null;

        // Try the declared location first. It stays authoritative whenever it
        // works, so a rule that resolves in its own file NEVER consults the tree
        // and cannot be re-bound by a coincidental match elsewhere.
        //
        // The trigger is "the declared location did not yield a node", NOT merely
        // "the file is missing". A path can SURVIVE into the chunked tree while
        // holding entirely different content — measured on 2.1.259, utils/auth.js
        // exists at the same path but is 17,949 bytes against 301,579 on 2.1.238,
        // and its landmark string is absent from it while being present elsewhere
        // in the tree. Gating on existence alone left exactly those rules — the
        // parents of the export_map bulk renames, which are 673 of the monolithic
        // tree's 725 — falling into the silent pattern-not-found skip.
        const filePath = path.join(deobDir, rule.file);
        const declaredExists = fs.existsSync(filePath);
        if (declaredExists) {
            code = fs.readFileSync(filePath, "utf-8");
            sf = ts.createSourceFile(rule.file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const pos = findPatternPos(code, rule.find, sf);
            if (pos !== -1) node = findContainingScope(sf, pos, rule.scope);
        }

        if (!node) {
            // FALLBACK — see the block comment above scanTreeForRule.
            // Binds only on a UNIQUE whole-tree candidate; declines loudly otherwise.
            const ruleId = rule.id ?? rule.rename ?? rule.description ?? "(unnamed rule)";
            const why = declaredExists ? "pattern absent from declared file" : "declared file does not exist";
            if (rule.no_tree_scan) {
                if (verbose) console.warn(`  anchor skip: ${why}, tree-scan opted out — ${rule.file} (${ruleId})`);
                continue;
            }
            scanStats.attempted++;
            const candidates = scanTreeForRule(rule, treeIndex);

            if (candidates.length === 0) {
                scanStats.absent++;
                console.warn(
                    `  anchor DECLINE (absent): rule "${ruleId}" — ${why} ("${rule.file}") ` +
                    `and its find pattern matches no ${rule.scope} scope with a derivable name anywhere in the tree. ` +
                    `Either the symbol is gone in this version, or the rule needs a different landmark.`,
                );
                continue;
            }
            if (candidates.length > 1) {
                scanStats.ambiguous++;
                const shown = candidates.slice(0, 5).map((c) => `${c.name} (${c.file})`).join(", ");
                console.warn(
                    `  anchor DECLINE (ambiguous): rule "${ruleId}" — ${why} ("${rule.file}") ` +
                    `and its find pattern resolves to ${candidates.length} distinct ${rule.scope} scopes across the tree, ` +
                    `so there is no unique node to bind. Give it a tighter \`find\`. Candidates: ${shown}` +
                    `${candidates.length > 5 ? ", …" : ""}`,
                );
                continue;
            }

            const only = candidates[0];
            const entry = treeIndex.get(path.join(deobDir, only.file));
            if (!entry) continue;
            code = entry.code;
            sf = entry.sf;
            resolvedFile = only.file;
            node = findNodeAtPosition(sf, only.nodeStart, only.nodeEnd);
            if (!node) continue;
            scanStats.bound++;
            if (verbose)
                console.log(`  anchor tree-scan: "${ruleId}" ${rule.file} → ${only.file} (unique: ${only.name})`);
        }

        const minifiedName = getNodeName(node);
        if (!minifiedName) {
            const ruleId = rule.id ?? rule.rename ?? rule.description ?? "(unnamed rule)";
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

            // POSITIONAL ANCHOR — an anchor_only rule may opt in to being
            // registered by AST SPAN instead of by name, which is the only way
            // to chain out of an unnamed scope (the bundler's module-init arrow,
            // a memo callback, any anonymous function). The span is derived from
            // this rule's own `find` against the tree currently being processed,
            // so nothing position-shaped is persisted in the ruleset.
            if (rule.anchor_positional && rule.anchor_only) {
                const posId = rule.id ?? rule.rename;
                if (!posId) {
                    console.warn(
                        `  anchor POSITIONAL: rule "${ruleId}" needs an explicit \`id\` — an unnamed ` +
                        `scope has no name to fall back to as its anchor key.`,
                    );
                    continue;
                }
                resolvedById.set(posId, {
                    id: posId,
                    file: resolvedFile,
                    // No name exists. Keep a diagnostic-only placeholder; lookup
                    // goes through nodeStart/nodeEnd, never through this string.
                    minifiedName: `__unnamed_${ts.SyntaxKind[node.kind]}`,
                    nodeStart: node.getStart(sf),
                    nodeEnd: node.end,
                });
                if (verbose)
                    console.log(
                        `  anchor positional: "${posId}" → ${ts.SyntaxKind[node.kind]} at ` +
                        `${resolvedFile}:${line} (span ${node.getStart(sf)}..${node.end})`,
                    );
                continue;
            }

            // A scope node with no derivable name renames NOTHING. This used to
            // `continue` silently — not even under ANCHOR_VERBOSE — so a dead
            // rule was indistinguishable from a working one. Warn unconditionally
            // and name the rule, the node kind, and why it has no name.
            console.warn(
                `  anchor UNNAMED SCOPE: rule "${ruleId}" matched a ${ts.SyntaxKind[node.kind]} ` +
                `at ${resolvedFile}:${line} (scope: "${rule.scope}") that has no derivable name — ` +
                `rule resolves to nothing and emits no rename. ` +
                `Anonymous functions/classes are only nameable when directly assigned to a variable declarator. ` +
                `Set "anchor_positional": true (with "anchor_only": true and an explicit "id") to register ` +
                `it by AST span so walk rules can chain from it.`,
            );
            continue;
        }

        const id = rule.id ?? rule.rename ?? minifiedName;
        resolvedById.set(id, { id, file: resolvedFile, minifiedName });

        if (!rule.anchor_only && rule.rename) {
            const start = node.getStart(sf);
            results.push({
                minified: minifiedName,
                original: rule.rename,
                confidence: 100,
                reason: `anchor: ${rule.description ?? rule.rename}`,
                file: resolvedFile,
                start,
                line: sf.getLineAndCharacterOfPosition(start).line + 1,
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

            // If the walk rule has a `find`, narrow to the deepest node at the found position
            if (rule.find) {
                const nodeCode = node.getText(sf);
                const nodeSf = ts.createSourceFile("__walk_find.js", nodeCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                const localPos = findPatternPos(nodeCode, rule.find, nodeSf);
                if (localPos === -1) {
                    if (verbose) console.warn(`  anchor walk skip: find in walk failed — ${rule.description ?? rule.rename}`);
                    continue;
                }
                // Map local position back to the real source file position
                const realPos = node.getStart(sf) + localPos;
                // Find deepest node at that position in the real source file
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

            // __export_map: bulk-rename all `key: () => identifier` entries from the object
            if (rule.rename === "__export_map" && walkResult.nodeStart !== undefined && walkResult.nodeEnd !== undefined) {
                const mapNode = findNodeAtPosition(sf, walkResult.nodeStart, walkResult.nodeEnd);
                if (mapNode) {
                    const mapRenames = extractExportMapRenames(mapNode, sf);
                    for (const r of mapRenames) {
                        results.push(r);
                        // Register each as a chainable anchor: <file>_fun_<originalName>
                        const anchorId = `${parent.file}_fun_${r.original}`;
                        resolvedById.set(anchorId, { id: anchorId, file: parent.file, minifiedName: r.minified });
                    }
                    if (verbose) console.log(`  export_map: ${mapRenames.length} renames from ${parent.file}`);
                }
                continue;
            }

            // Only emit a rename if this walk has a rename target (not an intermediate anchor)
            if (rule.rename && !walkResult.name.startsWith("__pos_")) {
                // Prefer the precise node the walk found; otherwise the first
                // occurrence of the resolved name within the scope it resolved
                // against (the node the anchor renames over).
                const start = walkResult.nodeStart ?? firstIdentStart(node, walkResult.name, sf);
                results.push({
                    minified: walkResult.name,
                    original: rule.rename,
                    confidence: 95,
                    reason: `anchor walk (${rule.from} → ${rule.walk})`,
                    file: parent.file,
                    start,
                    line: start !== undefined ? sf.getLineAndCharacterOfPosition(start).line + 1 : undefined,
                });
            }
        }

        if (unresolved.length === pending.length) break;
        pending.splice(0, pending.length, ...unresolved);
    }

    if (results.length > 0)
        console.log(`  Anchor rules: ${results.length} renames from ${rules.length} rules`);

    // Only printed when the fallback actually engaged, so a monolithic build's
    // log is byte-identical to what it was before this mechanism existed.
    if (scanStats.attempted > 0)
        console.log(
            `  Anchor tree-scan (declared location did not resolve): ${scanStats.attempted} attempted — ` +
            `${scanStats.bound} bound uniquely, ${scanStats.ambiguous} declined ambiguous, ` +
            `${scanStats.absent} declined absent`,
        );

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

    const rules: AnchorRule[] = (JSON.parse(fs.readFileSync(rulesPath, "utf-8")) as AnchorRule[])
        // `disabled: true` retires a rule WITHOUT deleting it, so the REASON it was
        // retired stays beside it — delete the rule and the next person to meet the
        // same symptom re-derives the whole diagnosis.
        // ⚠️ Added because the flag was ALREADY BEING USED and silently IGNORED: a
        // rule marked disabled still fired, so a "retirement" was a no-op that read
        // as done. Anything shaped like an off-switch must switch something off.
        // Filtered at LOAD, not in isPinRule() — a disabled pin dropped there would
        // fall through to the root-rule path at :1463 and be misrouted, not disabled.
        .filter((r) => (r as any).disabled !== true);
    const walkRules = (rules.filter(isWalkRule) as WalkRule[]).filter((r) => isScopedWalk(r.walk));
    if (walkRules.length === 0) return 0;

    // Run full anchor resolution to build the complete anchors map
    // (including walk-derived anchors like getGlobalConfig from getCustomApiKeyStatus)
    const allResults = applyAnchorRules(deobDir, rulesPath);

    // Build anchors from all resolved rules — root AND walk-derived.
    // Use the renamed name (original) as the function name since renames have been applied.
    const anchors = new Map<string, { file: string; renamedName: string }>();

    // Root rules
    for (const rule of rules.filter((r) => !isWalkRule(r) && !isPinRule(r)) as RootRule[]) {
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
