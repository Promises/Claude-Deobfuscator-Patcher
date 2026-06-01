/* Backend data layer — reads the REAL repo files and transforms them into the
   shapes the studio frontend expects. The frontend merges this snapshot over
   its mock defaults, so any field we can't derive falls back gracefully. */
import * as fs from "fs";
import * as path from "path";
import { ANCHOR_RULES, COVERAGE_RESULTS, PATCHES_DIR, versionCliPath } from "./config";

// ── Raw readers ──────────────────────────────────────────────────────────────

export function readAnchorRules(): any[] {
  try { return JSON.parse(fs.readFileSync(ANCHOR_RULES, "utf-8")); } catch { return []; }
}

export function readCoverage(): { results: any[]; diffs: any[] } {
  try { return JSON.parse(fs.readFileSync(COVERAGE_RESULTS, "utf-8")); } catch { return { results: [], diffs: [] }; }
}

// ── Versions (from coverage results; only real, splittable versions) ──────────

export interface SnapVersion {
  id: string; renames: number; locations: number; stateNamed: number;
  totalFns: number; namedFns: number; format: string; wrappers: string;
  runtime: string; date: string; current: boolean;
  exportMap: number; anchor: number; modulesTotal: number; modulesMatched: number;
}

export function buildVersions(): SnapVersion[] {
  const { results } = readCoverage();
  const usable = results.filter((r) => (r.errors?.length ?? 0) === 0 && fs.existsSync(versionCliPath(r.version)));
  return usable.map((r, i) => {
    const total = r.modules?.total ?? 0;
    const matched = r.modules?.matched ?? 0;
    return {
      id: r.version,
      renames: r.renames?.totalUnique ?? 0,
      locations: total,
      stateNamed: total ? Math.round((matched / total) * 100) : 0,
      totalFns: total,
      namedFns: matched,
      format: total > 4900 ? "IIFE" : "Hashbang",
      wrappers: "R() / d()",
      runtime: "working",
      date: (r.timestamp || "").slice(0, 10),
      current: i === usable.length - 1,
      exportMap: r.renames?.fromExportMaps ?? 0,
      anchor: r.renames?.fromAnchorRules ?? 0,
      modulesTotal: total,
      modulesMatched: matched,
    };
  });
}

// ── Anchors (real anchor-rules.json → grouped root + walk shape) ──────────────

function isPin(r: any) { return r?.type === "pin"; }
function isWalk(r: any) { return typeof r?.from === "string"; }
function rootId(r: any) { return r.id ?? r.rename ?? r.file; }

export function buildAnchors(): any[] {
  const rules = readAnchorRules();
  const { results } = readCoverage();
  const realResults = results.filter((r) => (r.errors?.length ?? 0) === 0);

  // id → { version → status } from coverage's per-rule anchorRuleDetails
  const perVersion = new Map<string, Record<string, string>>();
  for (const r of realResults) {
    for (const d of r.renames?.anchorRuleDetails ?? []) {
      if (!perVersion.has(d.id)) perVersion.set(d.id, {});
      perVersion.get(d.id)![r.version] = d.status === "ok" ? "ok"
        : d.status === "pattern_not_found" || d.status === "scope_not_found" ? "warn" : "fail";
    }
  }

  const roots = rules.filter((r) => !isWalk(r) && !isPin(r));
  // Map any walk's ultimate root by following `from` through chains.
  const byId = new Map<string, any>();
  for (const r of rules) { const id = r.id ?? r.rename; if (id) byId.set(id, r); }
  const ultimateRoot = (id: string, guard = 0): string | null => {
    if (guard > 20) return null;
    const r = byId.get(id);
    if (!r) return id; // unknown parent id — treat as its own anchor bucket
    if (isWalk(r)) return ultimateRoot(r.from, guard + 1);
    return r.id ?? r.rename ?? null;
  };

  const walksByRoot = new Map<string, any[]>();
  for (const r of rules.filter(isWalk)) {
    const root = ultimateRoot(r.from) || r.from;
    if (!walksByRoot.has(root)) walksByRoot.set(root, []);
    const kind: string =
      r.rename === "__export_map" ? "bulk"
      : !r.rename || r.rename === "(intermediate)" ? "anchor"
      : /^(param:|local:)/.test(r.walk || "") ? "scoped" : "global";
    walksByRoot.get(root)!.push({ walk: r.walk, rename: r.rename ?? "(intermediate)", kind, id: r.id });
  }

  return roots.map((r) => {
    const id = rootId(r);
    const vers = perVersion.get(id) || {};
    const statuses = Object.values(vers);
    const status = statuses.length === 0 ? "ok"
      : statuses.every((s) => s === "ok") ? "ok"
      : statuses.every((s) => s !== "ok") ? "fail" : "warn";
    return {
      id,
      file: r.file ?? "—",
      scope: r.scope ?? (isPin(r) ? "pin" : "—"),
      find: r.find ?? {},
      rename: r.anchor_only ? "(anchor_only)" : (r.rename ?? id),
      confidence: 100,
      status,
      desc: r.description ?? "",
      walks: walksByRoot.get(id) || [],
      versions: vers,
    };
  });
}

// ── Patches (parse patches.d/*.patch) ─────────────────────────────────────────

export function buildPatches(): any[] {
  let files: string[] = [];
  try { files = fs.readdirSync(PATCHES_DIR).filter((f) => f.endsWith(".patch")).sort(); } catch { return []; }

  return files.map((f) => {
    const text = fs.readFileSync(path.join(PATCHES_DIR, f), "utf-8");
    const id = (f.match(/^(\d+)/) || [])[1] || f.replace(".patch", "");
    const name = f.replace(/^\d+-/, "").replace(".patch", "");
    const headerVal = (key: string) => {
      const m = text.match(new RegExp(`^#\\s*${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : "";
    };
    const targets = [...text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
    const hunks = (text.match(/^@@ /gm) || []).length;
    const dependsRaw = headerVal("depends");
    const dependsOn = dependsRaw && dependsRaw !== "none"
      ? dependsRaw.split(/[,\s]+/).filter(Boolean) : [];
    return {
      id,
      name,
      fileName: f,
      file: targets[0] || "—",
      targets,
      target: targets[0] || "—",
      hunks,
      status: "applied",
      dependsOn,
      anchorDeps: [],
      desc: headerVal("description"),
      versions: {},
      raw: text,
    };
  });
}

// ── Full snapshot ─────────────────────────────────────────────────────────────

export function readAnchorRulesRaw(): string {
  try { return fs.readFileSync(ANCHOR_RULES, "utf-8"); } catch { return ""; }
}

export function buildSnapshot() {
  return {
    versions: buildVersions(),
    anchors: buildAnchors(),
    anchorsRaw: readAnchorRulesRaw(),
    patches: buildPatches(),
    coverage: readCoverage(),
    generatedAt: new Date().toISOString(),
  };
}
