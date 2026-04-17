import ts from "typescript";
import * as fs from "fs";

let code = fs.readFileSync("deobfuscated/utils/env.js", "utf-8");
code = code.replace(/^import\s+\{[^}]*\}\s+from\s+['"]\.\.?\/?[^'"]+['"];?\s*\n?/gm, "");
code = code.replace(/^export\s+\{[^}]*\};?\s*\n?/gm, "");

const sf = ts.createSourceFile("test.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const positions = new Map<string, number>();

function extractBindingPositions(name: ts.BindingName) {
    if (ts.isIdentifier(name) && !positions.has(name.text)) {
        positions.set(name.text, name.getStart(sf));
    }
}
function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && !positions.has(node.name.text)) {
        positions.set(node.name.text, node.name.getStart(sf));
    } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) extractBindingPositions(decl.name);
    }
    ts.forEachChild(node, visit);
}
visit(sf);

console.log("sP found:", positions.has("sP"), "at pos:", positions.get("sP"));

// Now test findRenameLocations
const snapshot = ts.ScriptSnapshot.fromString(code);
const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => ["test.js"],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fn) => fn === "test.js" ? snapshot : undefined,
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => ({ allowJs: true, checkJs: false, target: ts.ScriptTarget.Latest, noEmit: true, strict: false }),
    getDefaultLibFileName: () => ts.getDefaultLibFilePath({}),
    fileExists: (fn) => fn === "test.js" || ts.sys.fileExists(fn),
    readFile: (fn) => fn === "test.js" ? code : ts.sys.readFile(fn),
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const pos = positions.get("sP");
if (pos !== undefined) {
    const locs = service.findRenameLocations("test.js", pos, false, false);
    console.log("findRenameLocations for sP:", locs?.length ?? "null", "locations");
    if (locs) {
        for (const loc of locs.slice(0, 5)) {
            const text = code.substring(loc.textSpan.start, loc.textSpan.start + loc.textSpan.length);
            console.log("  ", text, "at", loc.textSpan.start);
        }
    }
}
