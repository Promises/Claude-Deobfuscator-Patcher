import { applyAnchorScopedRenamesInDir } from "./anchor-rules";
import * as path from "path";

const deobDir = process.argv[2];
const rulesPath = process.argv[3];

if (!deobDir || !rulesPath) {
    console.error("Usage: apply-scoped-renames <deob-dir> <rules.json>");
    process.exit(1);
}

applyAnchorScopedRenamesInDir(path.resolve(deobDir), path.resolve(rulesPath));
