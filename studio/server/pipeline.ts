/* Pipeline adapter — runs the real tools-ts deobfuscation in-process and
   resolves anchor rules against a version's emitted output.

   prepareVersion(v)  → split + match + emit + reconstruct into a cached
                        deob dir (lazy, disk-cached, in-flight de-duped).
   resolveAnchors()   → run anchor rules (in-memory) against a deob dir. */
import { execSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { matchModules } from "../../tools-ts/src/matcher";
import { emitProject } from "../../tools-ts/src/emitter";
import { reconstructModules } from "../../tools-ts/src/module-reconstruct";
import { applyAnchorRulesFromRules, applyAnchorScopedRenamesInDir, analyzeFind } from "../../tools-ts/src/anchor-rules";
import { renameProject, renameSingleFile } from "../../tools-ts/src/renamer";
import { prettifyProject, prettifyCode } from "../../tools-ts/src/prettify";
import {
  SIGNATURES, SPLITTER, CACHE_DIR, ANCHOR_RULES, PATCHES_DIR, versionCliPath, ensureDir,
} from "./config";

export interface PrepareResult {
  version: string;
  deobDir: string;
  modules: number;
  matched: number;
  cached: boolean;
  ms: number;
}

const inflight = new Map<string, Promise<PrepareResult>>();

/** Silence the pipeline's heavy console output during a call. */
function quiet<T>(fn: () => T): T {
  const log = console.log, warn = console.warn, err = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; console.error = err; }
}

export function availableVersionWorkdir(version: string): string {
  return path.join(CACHE_DIR, "versions", version);
}

export function isPrepared(version: string): boolean {
  return fs.existsSync(path.join(availableVersionWorkdir(version), "deob", "_mapping.json"));
}

function loadCached(version: string): PrepareResult | null {
  const deobDir = path.join(availableVersionWorkdir(version), "deob");
  const mappingPath = path.join(deobDir, "_mapping.json");
  if (!fs.existsSync(mappingPath)) return null;
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
  return {
    version, deobDir,
    modules: mapping.section_count ?? 0,
    matched: mapping.matched_count ?? 0,
    cached: true, ms: 0,
  };
}

/**
 * The heavy work (split + match + emit + reconstruct). This BLOCKS the event
 * loop (execSync + synchronous TS), so it must run in a child process (see
 * prepare-worker.ts), never inline on the socket server's loop.
 */
export async function runPrepareInline(version: string): Promise<PrepareResult> {
  const start = Date.now();
  const sourceJs = versionCliPath(version);
  if (!fs.existsSync(sourceJs)) throw new Error(`No cli.js for version ${version} at ${sourceJs}`);

  const cached = loadCached(version);
  if (cached) return cached;

  const workDir = availableVersionWorkdir(version);
  const cacheDir = path.join(workDir, ".cache");
  const modulesDir = path.join(cacheDir, "modules");
  const matchesPath = path.join(cacheDir, "matches.json");
  const deobDir = path.join(workDir, "deob");
  ensureDir(cacheDir);

  // 1. Split (python) — skip if module manifest already cached.
  if (!fs.existsSync(path.join(modulesDir, "_manifest.json"))) {
    execSync(`python3 "${SPLITTER}" "${sourceJs}" "${modulesDir}"`, { stdio: ["pipe", "pipe", "pipe"] });
  }
  // 2. Match against committed signatures.
  quiet(() => matchModules(SIGNATURES, modulesDir, matchesPath));
  const matches = JSON.parse(fs.readFileSync(matchesPath, "utf-8"));
  // 3. Emit deobfuscated project.
  quiet(() => emitProject(matchesPath, modulesDir, deobDir));
  // 4. Module reconstruction (imports/exports) so anchors resolve on real files.
  quiet(() => reconstructModules(deobDir));

  return {
    version, deobDir,
    modules: matches.totalModules ?? 0,
    matched: matches.matched ?? 0,
    cached: false, ms: Date.now() - start,
  };
}

/**
 * Prepare a version's deob output. Cache hits return immediately on the main
 * loop; cache misses are offloaded to a child process so the heavy, blocking
 * pipeline work never freezes the Socket.IO server.
 */
export async function prepareVersion(version: string): Promise<PrepareResult> {
  const cached = loadCached(version);
  if (cached) return cached;

  const existing = inflight.get(version);
  if (existing) return existing;

  const job = (async () => {
    const start = Date.now();
    if (!fs.existsSync(versionCliPath(version))) {
      throw new Error(`No cli.js for version ${version}`);
    }
    const workerPath = path.join(import.meta.dir, "prepare-worker.ts");
    const proc = Bun.spawn({ cmd: ["bun", workerPath, version], stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`prepare ${version} failed: ${err.trim().slice(0, 500)}`);
    }
    const result = loadCached(version);
    if (!result) throw new Error(`prepare ${version}: worker produced no output`);
    result.cached = false;
    result.ms = Date.now() - start;
    return result;
  })().finally(() => inflight.delete(version));

  inflight.set(version, job);
  return job;
}

export interface ResolvedRename {
  minified: string;
  original: string;
  confidence: number;
  reason: string;
}

/** Resolve a set of (draft) anchor rules against a prepared version. */
export function resolveAnchors(deobDir: string, rules: unknown[]): ResolvedRename[] {
  return quiet(() => applyAnchorRulesFromRules(deobDir, rules as any)) as ResolvedRename[];
}

/** Analyze a find pattern's matches (ambiguity warning) against a version's
    PRE-RENAME (deob) file. */
export async function analyzeLandmark(version: string, file: string, find: unknown, scope?: string) {
  const { deobDir } = await prepareVersion(version);
  const p = path.join(deobDir, file);
  if (!fs.existsSync(p)) return { count: 0, usedIndex: 0, matches: [], missing: true };
  return analyzeFind(fs.readFileSync(p, "utf-8"), find as any, (scope as any) || "function");
}

/** Same, but against the RESOLVED (renamed) file — line numbers in resolved
    coordinates, for highlighting the resolved/split source panes. */
export async function analyzeLandmarkResolved(version: string, file: string, find: unknown, scope?: string) {
  const { renamedDir } = await prepareRenamed(version);
  const p = path.join(renamedDir, file);
  if (!fs.existsSync(p)) return { count: 0, usedIndex: 0, matches: [], missing: true };
  return analyzeFind(fs.readFileSync(p, "utf-8"), find as any, (scope as any) || "function");
}

/** Locate a walk target by running the SAME anchor resolution the renamer uses,
    against both the deob (pre-rename) and renamed dirs. The resolver attaches
    each result's exact node line, so the jump is guaranteed to land where the
    anchor actually binds — never a heuristic that could diverge.
    `rules` is the anchor's rule subset (root + walks); `target` is the walk's
    rename (MatchResult.original). 1-based lines; 0 = not resolved. */
export async function locateWalkTarget(version: string, target: string, rules: unknown[]) {
  const { deobDir } = await prepareVersion(version);
  const { renamedDir } = await prepareRenamed(version);
  const lineIn = (dir: string): number => {
    const results = quiet(() => applyAnchorRulesFromRules(dir, rules as any));
    const m = results.find((r) => r.original === target && typeof (r as any).line === "number");
    return (m as any)?.line ?? 0;
  };
  return { preLine: lineIn(deobDir), resolvedLine: lineIn(renamedDir) };
}

// ── Renamed output (for patch test-apply) ─────────────────────────────────────
// Reproduces build.sh steps rename → prettify → scoped renames (no-source-ref)
// on top of a prepared deob dir, so patches can be applied against output whose
// identifiers match what the patches reference.

export interface RenamedResult {
  version: string;
  renamedDir: string;
  renames: number;
  cached: boolean;
  ms: number;
}

const renameInflight = new Map<string, Promise<RenamedResult>>();

export function renamedWorkdir(version: string): string {
  return path.join(availableVersionWorkdir(version), "renamed");
}
function renamedMarker(version: string): string {
  return path.join(renamedWorkdir(version), ".studio-renamed-ready");
}

/** Cheap check: renamed output present (regardless of currency). For status hints. */
export function isRenamedFresh(version: string): boolean {
  return fs.existsSync(renamedMarker(version)) && fs.existsSync(path.join(renamedWorkdir(version), "_mapping.json"));
}

/** Hash of the actual anchor resolution against this version's deob. The renamed
    output is fully determined by (deob + export maps + this resolution); export
    maps are version-fixed, so this hash is the cache key. A rule edit that
    doesn't change what the anchors resolve to (e.g. flipping a filter that still
    binds the same scope) yields the SAME hash → the expensive rebuild is skipped. */
async function anchorResolutionHash(version: string): Promise<string> {
  const { deobDir } = await prepareVersion(version);
  let rules: unknown[] = [];
  try { rules = JSON.parse(fs.readFileSync(ANCHOR_RULES, "utf-8")); } catch {}
  const res = quiet(() => applyAnchorRulesFromRules(deobDir, rules as any));
  const pairs = res.map((r) => `${r.minified}=${r.original}`).sort().join("\n");
  return createHash("sha1").update(pairs).digest("hex");
}

/** True if the cached renamed output matches the current anchor resolution. */
async function renamedHashMatches(version: string): Promise<boolean> {
  if (!isRenamedFresh(version)) return false;
  try {
    const stored = fs.readFileSync(renamedMarker(version), "utf-8").trim();
    return stored === (await anchorResolutionHash(version));
  } catch { return false; }
}

/** Heavy: copy deob → renamed, then rename + prettify + scoped renames + git baseline.
    BLOCKS the event loop — run via rename-worker.ts child, never inline on the server. */
export async function runRenameInline(version: string): Promise<RenamedResult> {
  const start = Date.now();
  const prep = await runPrepareInline(version); // ensure deob exists
  const renamedDir = renamedWorkdir(version);
  const curHash = await anchorResolutionHash(version);
  const marker = renamedMarker(version);

  // Reuse if the cached output was built for the same anchor resolution.
  if (isRenamedFresh(version)) {
    try {
      if (fs.readFileSync(marker, "utf-8").trim() === curHash) {
        const r = JSON.parse(fs.readFileSync(path.join(renamedDir, "_renames.json"), "utf-8"));
        const renames = Object.values(r.files || {}).reduce((a: number, f: any) => a + Object.keys(f).length, 0);
        return { version, renamedDir, renames, cached: true, ms: Date.now() - start };
      }
    } catch {}
  }

  // Fresh copy of the deob output.
  fs.rmSync(renamedDir, { recursive: true, force: true });
  fs.cpSync(prep.deobDir, renamedDir, { recursive: true });

  const mappingPath = path.join(renamedDir, "_mapping.json");
  let renames = 0;
  quiet(() => {
    const r = renameProject(renamedDir, "", mappingPath, undefined, { noSourceRef: true });
    renames = r.totalRenames;
  });
  await prettifyProject(renamedDir).catch(() => {});
  quiet(() => applyAnchorScopedRenamesInDir(renamedDir, ANCHOR_RULES));

  // Git baseline so patches can be applied/checked.
  const git = `git -c user.email=studio@local -c user.name=studio`;
  execSync(`cd "${renamedDir}" && git init -q && ${git} add -A && ${git} commit -q -m baseline`, { stdio: ["pipe", "pipe", "pipe"] });
  fs.writeFileSync(marker, curHash);

  return { version, renamedDir, renames, cached: false, ms: Date.now() - start };
}

/** Ensure renamed output exists; offload the heavy build to a child process. */
export async function prepareRenamed(version: string): Promise<RenamedResult> {
  if (await renamedHashMatches(version)) {
    return runRenameInline(version); // hash matches → returns the cached branch immediately
  }
  const existing = renameInflight.get(version);
  if (existing) return existing;

  const job = (async () => {
    const start = Date.now();
    const workerPath = path.join(import.meta.dir, "rename-worker.ts");
    const proc = Bun.spawn({ cmd: ["bun", workerPath, version], stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`rename ${version} failed: ${err.trim().slice(0, 800)}`);
    }
    const result = await runRenameInline(version); // now the cached branch
    result.cached = false;
    result.ms = Date.now() - start;
    return result;
  })().finally(() => renameInflight.delete(version));

  renameInflight.set(version, job);
  return job;
}

// ── Per-file on-demand resolved render ────────────────────────────────────────
// The studio's source view / walk-jump only need ONE file rendered, not the whole
// bundle. renameSingleFile builds the same assembled TS program but queries only
// the names that appear in the requested file (tens, not thousands), so its output
// is byte-identical to the full build (verified) at a fraction of the cost (~4s vs
// ~24s host / ~49s docker). Results are cached on disk keyed by the anchor-
// resolution hash + file, and the heavy assemble/binder work is offloaded to a
// child process so it never blocks the Socket.IO loop.

function renderedFileCacheRoot(version: string): string {
  return path.join(availableVersionWorkdir(version), "renamed-files");
}
function renderedFileCachePath(version: string, hash: string, file: string): string {
  return path.join(renderedFileCacheRoot(version), hash, file);
}

const renderInflight = new Map<string, Promise<string | null>>();

/** Render ONE file's resolved source (rename → prettify → scoped renames),
    byte-identical to the whole-bundle output for that file. Heavy (assembles the
    full program) — call from a worker, never on the main loop. Writes the result
    into the per-file cache (keyed by `hash`) and returns it. */
export async function runRenderResolvedFileInline(version: string, file: string, hash?: string): Promise<string | null> {
  const { deobDir } = await runPrepareInline(version);
  const mappingPath = path.join(deobDir, "_mapping.json");
  if (!fs.existsSync(path.join(deobDir, file))) return null;

  // 1. Rename just this file (export maps + anchors) — same task set as full build.
  const r = quiet(() => renameSingleFile(deobDir, mappingPath, file, { noSourceRef: true }));
  if (!r) return null;
  // 2. Prettify (per-file, same formatter specs as the full build).
  let code = r.code;
  try { code = await prettifyCode(code); } catch {}
  // 3. Scoped anchor renames: resolve against a temp dir holding just this file
  //    and let the existing scoped-rename pass edit it (mirrors the whole-build
  //    applyAnchorScopedRenamesInDir, which only ever edits a rule's own file).
  const tmp = fs.mkdtempSync(path.join(availableVersionWorkdir(version), "pf-"));
  try {
    const dst = path.join(tmp, file);
    ensureDir(path.dirname(dst));
    fs.writeFileSync(dst, code);
    fs.copyFileSync(mappingPath, path.join(tmp, "_mapping.json"));
    quiet(() => applyAnchorScopedRenamesInDir(tmp, ANCHOR_RULES));
    code = fs.readFileSync(dst, "utf-8");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const h = hash ?? (await anchorResolutionHash(version));
  // Drop stale-hash renders so the per-file cache doesn't grow unbounded.
  try {
    const root = renderedFileCacheRoot(version);
    if (fs.existsSync(root)) for (const d of fs.readdirSync(root)) if (d !== h) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  } catch {}
  const out = renderedFileCachePath(version, h, file);
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, code);
  return code;
}

/** Get ONE file's resolved source. Fast paths: the warm whole-bundle (if its hash
    matches) or the per-file disk cache. Otherwise offloads a single-file render to
    a child process. Avoids the whole-bundle rebuild for the common view/jump. */
export async function prepareRenamedFile(version: string, file: string): Promise<{ content: string | null; cached: boolean; ms: number }> {
  const start = Date.now();
  // Fastest: the whole renamed bundle is already fresh for this resolution.
  if (await renamedHashMatches(version)) {
    const p = path.join(renamedWorkdir(version), file);
    return { content: fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null, cached: true, ms: 0 };
  }
  const hash = await anchorResolutionHash(version);
  const cachePath = renderedFileCachePath(version, hash, file);
  if (fs.existsSync(cachePath)) {
    console.log(`[studio] per-file cache hit ${version} ${file}`);
    return { content: fs.readFileSync(cachePath, "utf-8"), cached: true, ms: 0 };
  }

  const key = `${version}::${hash}::${file}`;
  let job = renderInflight.get(key);
  if (!job) {
    job = (async () => {
      console.log(`[studio] per-file render ${version} ${file} (offload)`);
      const workerPath = path.join(import.meta.dir, "rename-file-worker.ts");
      const proc = Bun.spawn({ cmd: ["bun", workerPath, version, file, hash], stdout: "pipe", stderr: "pipe" });
      const exit = await proc.exited;
      if (exit !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`render ${version}:${file} failed: ${err.trim().slice(0, 500)}`);
      }
      return fs.existsSync(cachePath) ? fs.readFileSync(cachePath, "utf-8") : null;
    })().finally(() => renderInflight.delete(key));
    renderInflight.set(key, job);
  }
  const content = await job;
  const ms = Date.now() - start;
  console.log(`[studio] per-file render done ${version} ${file} ${(ms / 1000).toFixed(1)}s (${content?.length ?? 0}b)`);
  return { content, cached: false, ms };
}

export interface PatchTestResult {
  version: string;
  patch: string;
  status: "applied" | "fuzz" | "reject" | "error";
  failedFiles: string[];
  message: string;
}

/** Test-apply a patch against a version's renamed output (mirrors build.sh:
    exact `git apply`, then `-C0` fuzz fallback, else reject). */
export async function testApplyPatch(version: string, patchFile: string): Promise<PatchTestResult> {
  const patchPath = path.join(PATCHES_DIR, patchFile);
  if (!fs.existsSync(patchPath)) {
    return { version, patch: patchFile, status: "error", failedFiles: [], message: `patch not found: ${patchFile}` };
  }
  const { renamedDir } = await prepareRenamed(version);

  const tryApply = (extra: string): { ok: boolean; out: string } => {
    try {
      execSync(`cd "${renamedDir}" && git apply --check ${extra} "${patchPath}"`, { stdio: ["pipe", "pipe", "pipe"] });
      return { ok: true, out: "" };
    } catch (e: any) {
      return { ok: false, out: String(e?.stderr || e?.stdout || e?.message || "") };
    }
  };

  const clean = tryApply("");
  if (clean.ok) return { version, patch: patchFile, status: "applied", failedFiles: [], message: "applies cleanly" };

  const fuzz = tryApply("-C0");
  if (fuzz.ok) return { version, patch: patchFile, status: "fuzz", failedFiles: [], message: "applies with reduced context (fuzz)" };

  const failedFiles = [...new Set([...fuzz.out.matchAll(/patch failed: (.+?):\d+/g)].map((m) => m[1]))];
  return {
    version, patch: patchFile, status: "reject", failedFiles,
    message: fuzz.out.split("\n").filter((l) => l.includes("error:")).slice(0, 4).join("; ") || "does not apply",
  };
}
