/* Resolved paths for the studio backend. */
import * as path from "path";
import * as fs from "fs";

export const SERVER_DIR = import.meta.dir;
export const STUDIO_DIR = path.resolve(SERVER_DIR, "..");
export const PATCH_REF = path.resolve(STUDIO_DIR, "..");

export const TOOLS_TS = path.join(PATCH_REF, "tools-ts");
export const SIGNATURES = path.join(TOOLS_TS, "signatures.json");
export const ANCHOR_RULES = path.join(TOOLS_TS, "anchor-rules.json");
export const SPLITTER = path.join(PATCH_REF, "tools", "splitter.py");
export const VERSIONREF = path.join(PATCH_REF, "versionref");
export const COVERAGE_RESULTS = path.join(VERSIONREF, "_version_test_results.json");
export const PATCHES_DIR = path.join(PATCH_REF, "patches.d");

// Backend working cache (per-version deob output). Gitignored.
export const CACHE_DIR = path.join(STUDIO_DIR, ".cache");

export const PORT = Number(process.env.PORT || process.env.STUDIO_PORT || 4101);

export function versionCliPath(version: string): string {
  return path.join(VERSIONREF, `${version}-cli.js`);
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
