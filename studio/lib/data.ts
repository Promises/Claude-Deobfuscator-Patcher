/* ============================================================
   Deobfuscator Patcher Studio — data layer
   Initial content ported from the design prototype's mock data,
   itself drawn from the real repo (anchor-rules.json,
   MULTI-ACCOUNT-PATCHES.md, claude-renamer.md).

   Phase 2 will replace these constants with live reads of
   anchor-rules.json, _version_test_results.json, and patches.d/.
   ============================================================ */

export type VerStatus = "ok" | "warn" | "fail";

export interface Version {
  id: string;
  renames: number;
  locations: number;
  stateNamed: number;
  totalFns: number;
  namedFns: number;
  format: string;
  wrappers: string;
  runtime: string;
  date: string;
  current: boolean;
}

export const VERSIONS: Version[] = [
  { id: "2.1.70", renames: 3750, locations: 21544, stateNamed: 97, totalFns: 4710, namedFns: 4310, format: "Hashbang", wrappers: "E() / S()", runtime: "working", date: "2026-03-02", current: false },
  { id: "2.1.77", renames: 4118, locations: 22810, stateNamed: 97, totalFns: 4802, namedFns: 4456, format: "Hashbang", wrappers: "E() / S()", runtime: "working", date: "2026-04-01", current: false },
  { id: "2.1.80", renames: 4604, locations: 24102, stateNamed: 98, totalFns: 4901, namedFns: 4622, format: "IIFE", wrappers: "R() / d()", runtime: "working", date: "2026-04-19", current: false },
  { id: "2.1.87", renames: 4992, locations: 25493, stateNamed: 97, totalFns: 5044, namedFns: 4801, format: "IIFE", wrappers: "R() / d()", runtime: "working", date: "2026-05-11", current: false },
  { id: "2.1.89", renames: 5002, locations: 28225, stateNamed: 99, totalFns: 5081, namedFns: 4980, format: "IIFE", wrappers: "R() / d()", runtime: "working", date: "2026-05-26", current: true },
];

export interface PipelineStep {
  id: string;
  cmd: string;
  label: string;
  desc: string;
  out: string;
  size: string;
  secs: number;
  status: "done" | "running" | "pending";
}

export const PIPELINE: PipelineStep[] = [
  { id: "extract", cmd: "entrypoint.sh extract", label: "Extract", desc: "Claude binary → source.js (~12 MB)", out: "source.js", size: "11.8 MB", secs: 4, status: "done" },
  { id: "deob", cmd: "entrypoint.sh deob", label: "Deobfuscate", desc: "Split + match + emit → 4,600+ files", out: "deobfuscated/", size: "12.1 MB", secs: 38, status: "done" },
  { id: "modrecon", cmd: "entrypoint.sh modrecon", label: "Module Reconstruct", desc: "Add import / export for TS LS scope analysis", out: "+imports", size: "—", secs: 6, status: "done" },
  { id: "rename", cmd: "entrypoint.sh rename", label: "Rename", desc: "Anchors + constraint renamer via TS Language Service", out: "_renames.json", size: "5,002 renames", secs: 94, status: "done" },
  { id: "prettify", cmd: "entrypoint.sh prettify", label: "Prettify", desc: "prettier printWidth 100 — stable patch context", out: "deobfuscated/", size: "12.4 MB", secs: 22, status: "done" },
  { id: "patch", cmd: "entrypoint.sh patch", label: "Patch", desc: "Apply patches.d/ + inject modules, tag git baseline", out: "patched", size: "9 patches", secs: 3, status: "running" },
  { id: "reassemble", cmd: "entrypoint.sh reassemble", label: "Reassemble", desc: "Strip module syntax, restore IIFE → single file", out: "cli-runnable.js", size: "14 MB", secs: 9, status: "pending" },
  { id: "compile", cmd: "entrypoint.sh compile", label: "Compile", desc: "Bundle → standalone claude binary", out: "claude", size: "80 MB", secs: 31, status: "pending" },
];

export interface FileEntry {
  path: string;
  fns: number;
  named: number;
  anchors: number;
  exportMap: number;
  kind: "core" | "api" | "cli" | "ui" | "utils";
  patchCritical: boolean;
}

export const FILES: FileEntry[] = [
  { path: "bootstrap/state.js", fns: 218, named: 216, anchors: 5, exportMap: 212, kind: "core", patchCritical: true },
  { path: "query.js", fns: 47, named: 46, anchors: 6, exportMap: 0, kind: "core", patchCritical: true },
  { path: "utils/config.js", fns: 64, named: 63, anchors: 11, exportMap: 58, kind: "core", patchCritical: true },
  { path: "utils/auth.js", fns: 58, named: 55, anchors: 2, exportMap: 51, kind: "core", patchCritical: true },
  { path: "cli/structuredIO.js", fns: 22, named: 21, anchors: 4, exportMap: 0, kind: "cli", patchCritical: true },
  { path: "services/api/withRetry.js", fns: 18, named: 14, anchors: 0, exportMap: 0, kind: "api", patchCritical: true },
  { path: "services/api/client.js", fns: 31, named: 27, anchors: 0, exportMap: 0, kind: "api", patchCritical: true },
  { path: "utils/secureStorage/index.js", fns: 14, named: 9, anchors: 0, exportMap: 0, kind: "utils", patchCritical: true },
  { path: "components/LogoV2/LogoV2.js", fns: 12, named: 11, anchors: 2, exportMap: 0, kind: "ui", patchCritical: false },
  { path: "utils/logoV2Utils.js", fns: 9, named: 9, anchors: 2, exportMap: 0, kind: "utils", patchCritical: false },
  { path: "ink/screen.js", fns: 41, named: 38, anchors: 1, exportMap: 0, kind: "ui", patchCritical: false },
  { path: "components/PromptInput/useSwarmBanner.ts", fns: 6, named: 5, anchors: 1, exportMap: 0, kind: "ui", patchCritical: false },
  { path: "services/mcp/transport.js", fns: 27, named: 12, anchors: 0, exportMap: 0, kind: "api", patchCritical: false },
  { path: "utils/telemetry.js", fns: 44, named: 19, anchors: 1, exportMap: 0, kind: "utils", patchCritical: false },
];

export type WalkKind = "scoped" | "global" | "anchor" | "bulk";

export interface AnchorWalk {
  walk: string;
  rename: string;
  kind: WalkKind;
  id?: string;
}

export interface Anchor {
  id: string;
  file: string;
  scope: string;
  find: Record<string, unknown>;
  rename: string;
  confidence: number;
  status: VerStatus;
  desc: string;
  walks: AnchorWalk[];
  versions: Record<string, VerStatus>;
}

function vmap(spec: Record<string, VerStatus>): Record<string, VerStatus> {
  const out: Record<string, VerStatus> = {};
  VERSIONS.forEach((v) => (out[v.id] = spec[v.id] || "ok"));
  return out;
}

export const ANCHORS: Anchor[] = [
  {
    id: "query", file: "query.js", scope: "async_generator",
    find: { string_literal: "completed" }, rename: "query", confidence: 100, status: "ok",
    desc: "query wrapper — calls queryLoop via yield* and notifies 'completed'",
    walks: [
      { walk: "param:0", rename: "params", kind: "scoped" },
      { walk: "local:array_init", rename: "consumedCommandUuids", kind: "scoped" },
      { walk: "local:for_of_binding", rename: "uuid", kind: "scoped" },
      { walk: "yield_star_callee", rename: "queryLoop", kind: "global", id: "queryLoop" },
      { walk: "local:yield_star_result", rename: "terminal", kind: "scoped" },
      { walk: "call_string_arg:completed:callee", rename: "notifyCommandLifecycle", kind: "global" },
    ],
    versions: vmap({}),
  },
  {
    id: "yieldMissingToolResultBlocks", file: "query.js", scope: "generator",
    find: { property_assignment: { key: "type", value: "tool_result" } },
    rename: "yieldMissingToolResultBlocks", confidence: 95, status: "ok",
    desc: "generator that yields tool_result error messages for unmatched tool uses",
    walks: [
      { walk: "param:0", rename: "assistantMessages", kind: "scoped" },
      { walk: "param:1", rename: "errorMessage", kind: "scoped" },
      { walk: "local:for_of_binding", rename: "assistantMessage", kind: "scoped" },
      { walk: "local:call_result", rename: "toolUseBlocks", kind: "scoped" },
      { walk: "local:for_of_binding:1", rename: "toolUse", kind: "scoped" },
    ],
    versions: vmap({}),
  },
  {
    id: "getCustomApiKeyStatus", file: "utils/config.js", scope: "function",
    find: { string_literal: "approved" }, rename: "getCustomApiKeyStatus", confidence: 100, status: "ok",
    desc: "getCustomApiKeyStatus — returns 'approved', 'rejected', or 'new'",
    walks: [
      { walk: "param:0", rename: "truncatedApiKey", kind: "scoped" },
      { walk: "local:call_result", rename: "config", kind: "scoped" },
      { walk: "local:call_result_callee", rename: "getGlobalConfig", kind: "global", id: "getGlobalConfig" },
    ],
    versions: vmap({}),
  },
  {
    id: "getGlobalConfig", file: "utils/config.js", scope: "—(chained)",
    find: { chained_from: "getCustomApiKeyStatus" }, rename: "getGlobalConfig", confidence: 90, status: "ok",
    desc: "getGlobalConfig — config reader, drives 10+ chained renames",
    walks: [
      { walk: "return:comma:4", rename: "(intermediate)", kind: "anchor" },
      { walk: "contains:Date.now():assign_target", rename: "globalConfigCache", kind: "global" },
      { walk: "contains:mtimeMs:member_access_target", rename: "stats", kind: "scoped" },
      { walk: "contains:size:assign_target", rename: "lastReadFileStats", kind: "global" },
      { walk: "method_arg_callee:statSync", rename: "getGlobalClaudeFile", kind: "global" },
      { walk: "if:condition_refs:globalConfigCache", rename: "(intermediate)", kind: "anchor" },
      { walk: "postfix_increment_operand", rename: "configCacheHits", kind: "global" },
      { walk: "standalone_increment", rename: "configCacheMisses", kind: "global" },
      { walk: "export_map", rename: "__export_map (58)", kind: "bulk" },
    ],
    versions: vmap({ "2.1.70": "warn" }),
  },
  {
    id: "saveGlobalConfig", file: "utils/config.js", scope: "function",
    find: { chained_from: "config_exports" }, rename: "saveGlobalConfig", confidence: 85, status: "ok",
    desc: "auth-loss guard — wires logForDebugging + wouldLoseAuthState",
    walks: [
      { walk: "call_string_arg:tengu_config_auth_loss_prevented:callee", rename: "logEvent", kind: "global" },
      { walk: "closest_parent:call → callee", rename: "logForDebugging", kind: "global" },
      { walk: "closest_parent:if → condition_callee", rename: "wouldLoseAuthState", kind: "global" },
      { walk: "param:0", rename: "currentConfig", kind: "scoped" },
    ],
    versions: vmap({}),
  },
  {
    id: "getTotalCacheReadInputTokens", file: "bootstrap/state.js", scope: "function",
    find: { string_literal: "cacheReadInputTokens" }, rename: "getTotalCacheReadInputTokens", confidence: 100, status: "ok",
    desc: "sumBy on STATE.modelUsage — also bulk-renames 212 exports",
    walks: [
      { walk: "contains:modelUsage:member_access_target", rename: "STATE", kind: "global" },
      { walk: "export_map", rename: "__export_map (212)", kind: "bulk" },
    ],
    versions: vmap({}),
  },
  {
    id: "getInitialState", file: "bootstrap/state.js", scope: "function",
    find: { string_literal: "userSettings" }, rename: "getInitialState", confidence: 95, status: "ok",
    desc: "creates the initial STATE object with defaults",
    walks: [], versions: vmap({}),
  },
  {
    id: "hasAnthropicApiKeyAuth", file: "utils/auth.js", scope: "function",
    find: { text: "skipRetrievingKeyFromApiKeyHelper" }, rename: "(anchor_only)", confidence: 90, status: "ok",
    desc: "anchor_only — stepping stone to bulk-rename utils/auth.js exports",
    walks: [{ walk: "export_map", rename: "__export_map (51)", kind: "bulk" }],
    versions: vmap({}),
  },
  {
    id: "prependUserMessage", file: "cli/structuredIO.js", scope: "method",
    find: { property_assignment: { key: "role", value: "user" } }, rename: "(anchor_only)", confidence: 88, status: "ok",
    desc: "method anchoring the StructuredIO class + jsonStringify callee",
    walks: [
      { walk: "closest_parent:call → callee", rename: "jsonStringify", kind: "global" },
      { walk: "enclosing_class", rename: "StructuredIO", kind: "global" },
    ],
    versions: vmap({}),
  },
  {
    id: "LogoV2", file: "components/LogoV2/LogoV2.js", scope: "function",
    find: { text: "sandboxed" }, rename: "LogoV2", confidence: 80, status: "warn",
    desc: "main logo/header component — text anchor drifts across versions",
    walks: [{ walk: "contains:createElement:member_access_target", rename: "React", kind: "global" }],
    versions: vmap({ "2.1.70": "fail", "2.1.77": "warn", "2.1.80": "ok" }),
  },
  {
    id: "getLayoutMode", file: "utils/logoV2Utils.js", scope: "function",
    find: { string_literal: "compact" }, rename: "getLayoutMode", confidence: 95, status: "ok",
    desc: "returns 'horizontal' or 'compact' based on terminal width",
    walks: [{ walk: "param:0", rename: "columns", kind: "scoped" }],
    versions: vmap({}),
  },
];

export interface Landmark {
  str: string;
  file: string;
  count: number;
  rarity: "unique" | "rare" | "common";
  stability: "high" | "medium" | "low";
}

export const LANDMARKS: Landmark[] = [
  { str: "tengu_config_auth_loss_prevented", file: "utils/config.js", count: 1, rarity: "unique", stability: "high" },
  { str: "skipRetrievingKeyFromApiKeyHelper", file: "utils/auth.js", count: 1, rarity: "unique", stability: "high" },
  { str: "anthropic-ratelimit-unified-reset", file: "services/api/withRetry.js", count: 1, rarity: "unique", stability: "high" },
  { str: "cacheReadInputTokens", file: "bootstrap/state.js", count: 1, rarity: "unique", stability: "high" },
  { str: "claudeAiOauth", file: "utils/auth.js", count: 2, rarity: "rare", stability: "high" },
  { str: "refusing to write", file: "utils/config.js", count: 1, rarity: "unique", stability: "medium" },
  { str: "userSettings", file: "bootstrap/state.js", count: 3, rarity: "rare", stability: "high" },
  { str: "sandboxed", file: "components/LogoV2/LogoV2.js", count: 4, rarity: "common", stability: "low" },
  { str: "approved", file: "utils/config.js", count: 2, rarity: "rare", stability: "high" },
  { str: "compact", file: "utils/logoV2Utils.js", count: 2, rarity: "rare", stability: "medium" },
  { str: "completed", file: "query.js", count: 5, rarity: "common", stability: "medium" },
];

export interface SourceSnippet {
  minified: string;
  resolved: string | null;
  hits: Record<string, number[]>;
}

export const SOURCE: Record<string, SourceSnippet> = {
  "utils/config.js": {
    minified: [
      "function Tp() {",
      "  if (sP.config && b1.mtimeMs === sP.mtime) {",
      "    return Xk2++, sP.config;",
      "  }",
      "  Qd9++;",
      "  let A = u9().statSync(zR4());",
      "  let B = A ? { mtime: A.mtimeMs, size: A.size } : null;",
      "  return (sP = { config: $f(), mtime: Date.now(), ... }, B);",
      "}",
      "function gV2(K) {",
      '  if (K !== "" && fK1(K) === "approved") return uI(K);',
      "  let _ = Tp();",
      '  return _.customApiKeyResponses?.approved?.includes(K) ? "approved" : "new";',
      "}",
    ].join("\n"),
    resolved: [
      "function getGlobalConfig() {",
      "  if (globalConfigCache.config && stats.mtimeMs === globalConfigCache.mtime) {",
      "    return configCacheHits++, globalConfigCache.config;",
      "  }",
      "  configCacheMisses++;",
      "  let stats = getGlobalClaudeFile().statSync(getGlobalClaudeFile());",
      "  let lastReadFileStats = stats ? { mtime: stats.mtimeMs, size: stats.size } : null;",
      "  return (globalConfigCache = { config: $f(), mtime: Date.now(), ... }, lastReadFileStats);",
      "}",
      "function getCustomApiKeyStatus(truncatedApiKey) {",
      '  if (truncatedApiKey !== "" && fK1(truncatedApiKey) === "approved") return uI(truncatedApiKey);',
      "  let config = getGlobalConfig();",
      '  return config.customApiKeyResponses?.approved?.includes(truncatedApiKey) ? "approved" : "new";',
      "}",
    ].join("\n"),
    hits: { approved: [10, 12], "Date.now()": [7], statSync: [5], mtimeMs: [1, 5] },
  },
  "bootstrap/state.js": {
    minified: [
      "function PIH(A) {",
      "  return _8(b1.modelUsage, (Q) => Q.cacheReadInputTokens ?? 0);",
      "}",
      "M_(exports, {",
      "  getTotalCacheReadInputTokens: () => PIH,",
      "  getSessionId: () => l1,",
      "  setMeter: () => Ee_,",
      "  getInitialState: () => z9,",
      "  /* … 208 more entries … */",
      "});",
    ].join("\n"),
    resolved: [
      "function getTotalCacheReadInputTokens(A) {",
      "  return _8(STATE.modelUsage, (Q) => Q.cacheReadInputTokens ?? 0);",
      "}",
      "M_(exports, {",
      "  getTotalCacheReadInputTokens: () => getTotalCacheReadInputTokens,",
      "  getSessionId: () => getSessionId,",
      "  setMeter: () => setMeter,",
      "  getInitialState: () => getInitialState,",
      "  /* … 208 more entries … */",
      "});",
    ].join("\n"),
    hits: { cacheReadInputTokens: [1], modelUsage: [1] },
  },
  "services/api/withRetry.js": {
    minified: [
      "function Zb(Y) {",
      '  let H = Y.headers?.["anthropic-ratelimit-unified-reset"];',
      "  return H ? Math.max(0, +H * 1000 - Date.now()) : 0;",
      "}",
      "// … 429 handler, fast-mode cooldown, retry loop …",
      "// ⚠ no anchor — getRateLimitResetDelayMs still minified as Zb()",
    ].join("\n"),
    resolved: null,
    hits: { "anthropic-ratelimit-unified-reset": [1] },
  },
};

export interface Patch {
  id: string;
  name: string;
  file: string;
  target: string;
  hunks: number;
  status: "applied" | "broken" | "warn";
  dependsOn: string[];
  anchorDeps: string[];
  unguardedDeps?: string[];
  desc: string;
  versions: Record<string, string>;
}

function pvers(spec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  VERSIONS.forEach((v) => (out[v.id] = spec[v.id] || "apply"));
  return out;
}

export const PATCHES: Patch[] = [
  {
    id: "001", name: "sidecar-client", file: "patches.d/modules/SidecarClient.js",
    target: "module inject", hunks: 1, status: "applied", dependsOn: [],
    anchorDeps: ["getSessionId"], desc: "Phoenix V2 WebSocket sidecar client",
    versions: pvers({}),
  },
  {
    id: "003", name: "multi-account-config-bind", file: "bootstrap/state.js",
    target: "getSessionId()", hunks: 1, status: "applied", dependsOn: ["001"],
    anchorDeps: ["getSessionId", "getGlobalConfig", "saveGlobalConfig"], desc: "Bind __multiAccount to config functions during init",
    versions: pvers({}),
  },
  {
    id: "004", name: "multi-account-storage-bind", file: "utils/secureStorage/index.js",
    target: "U4() singleton", hunks: 1, status: "broken", dependsOn: ["003"],
    anchorDeps: ["U4 (secure storage singleton)"], unguardedDeps: ["U4"],
    desc: "Bind secure storage read/update — references U4() which NO anchor guarantees",
    versions: pvers({ "2.1.70": "fuzz", "2.1.77": "reject", "2.1.80": "reject", "2.1.87": "reject", "2.1.89": "reject" }),
  },
  {
    id: "005", name: "multi-account-auth-override", file: "utils/auth.js",
    target: "getClaudeAIOAuthTokens / getAnthropicApiKeyWithSource", hunks: 2, status: "applied", dependsOn: ["003", "004"],
    anchorDeps: ["getClaudeAIOAuthTokens", "getAnthropicApiKeyWithSource", "isBareMode"],
    unguardedDeps: ["getClaudeAIOAuthTokens", "getAnthropicApiKeyWithSource"],
    desc: "Override auth getters to return active account credentials",
    versions: pvers({ "2.1.70": "fuzz" }),
  },
  {
    id: "006", name: "multi-account-failover", file: "services/api/withRetry.js",
    target: "429 handler + success path", hunks: 2, status: "warn", dependsOn: ["005"],
    anchorDeps: ["getRateLimitResetDelayMs", "triggerFastModeCooldown", "getClaudeAIOAuthTokens"],
    unguardedDeps: ["getRateLimitResetDelayMs", "triggerFastModeCooldown"],
    desc: "Account failover on 429 + clear cooldown on success",
    versions: pvers({ "2.1.70": "fuzz", "2.1.77": "fuzz", "2.1.89": "fuzz" }),
  },
];

export interface InjectedModule {
  file: string;
  size: string;
  desc: string;
  inject: string;
}

export const MODULES: InjectedModule[] = [
  { file: "patches.d/modules/SidecarClient.js", size: "7.6 KB", desc: "Phoenix V2 WebSocket client, auto-connect, mirror, queue", inject: "preamble" },
  { file: "patches.d/modules/MultiAccountManager.js", size: "29.5 KB", desc: "Account registry, failover, credential management", inject: "module" },
  { file: "patches.d/modules/AAASessionHooks.js", size: "873 B", desc: "Session lifecycle hooks", inject: "module" },
  { file: "patches.d/modules/AABCommandHooks.js", size: "1.1 KB", desc: "Command interception hooks", inject: "module" },
  { file: "patches.d/modules/ClaudiversePanel.js", size: "540 B", desc: "Status panel UI component", inject: "module" },
];

export interface DiffLine {
  t: "ctx" | "add" | "del";
  n: string;
}

export const PATCH_DIFF: DiffLine[] = [
  { t: "ctx", n: "function getSessionId() {" },
  { t: "add", n: "    try {" },
  { t: "add", n: "        if (typeof __multiAccount !== 'undefined') {" },
  { t: "add", n: "            __multiAccount.bindConfig(getGlobalConfig, saveGlobalConfig);" },
  { t: "add", n: "        }" },
  { t: "add", n: "    } catch (e) {}" },
  { t: "ctx", n: "    try {" },
  { t: "ctx", n: "        __claudiverse.connect();" },
  { t: "ctx", n: "    } catch (e) {}" },
  { t: "ctx", n: "    return STATE.sessionId;" },
  { t: "ctx", n: "}" },
];

export interface Wave {
  id: string;
  name: string;
  total: number;
  done: number;
  desc: string;
}

export const WAVES: Wave[] = [
  { id: "wave-1", name: "Patch-critical", total: 8, done: 6, desc: "Files every multi-account patch depends on" },
  { id: "wave-2", name: "High-value", total: 24, done: 9, desc: "Heavily-called modules, >50 references" },
  { id: "wave-3", name: "Long tail", total: 4571, done: 1840, desc: "Everything else, best-effort" },
];

export interface AgentQueueItem {
  id: string;
  file: string;
  state: "proposed" | "review" | "queued" | "validating" | "committed";
  proposals: number;
  agent: string;
  target: string;
  confidence: number;
  note: string;
}

export const AGENT_QUEUE: AgentQueueItem[] = [
  { id: "q1", file: "services/api/withRetry.js", state: "proposed", proposals: 3, agent: "claude-sonnet", target: "getRateLimitResetDelayMs", confidence: 92, note: "string anchor 'anthropic-ratelimit-unified-reset' is unique + stable" },
  { id: "q2", file: "utils/secureStorage/index.js", state: "review", proposals: 2, agent: "claude-sonnet", target: "U4 (secure storage singleton)", confidence: 74, note: "match by .read()/.update()/.readAsync() + claudeAiOauth — patch 004 needs this" },
  { id: "q3", file: "utils/auth.js", state: "review", proposals: 4, agent: "claude-sonnet", target: "getClaudeAIOAuthTokens", confidence: 88, note: "z6() memoization wrapper + claudeAiOauth string anchor" },
  { id: "q4", file: "services/mcp/transport.js", state: "queued", proposals: 0, agent: "—", target: "—", confidence: 0, note: "15 of 27 functions still minified" },
  { id: "q5", file: "utils/telemetry.js", state: "queued", proposals: 0, agent: "—", target: "—", confidence: 0, note: "25 of 44 functions still minified" },
  { id: "q6", file: "services/api/client.js", state: "validating", proposals: 1, agent: "claude-sonnet", target: "isClaudeAISubscriber", confidence: 81, note: "checked before selecting apiKey vs authToken" },
  { id: "q7", file: "bootstrap/state.js", state: "committed", proposals: 1, agent: "claude-sonnet", target: "getSessionId (export_map)", confidence: 99, note: "bulk via export_map — 212 renames landed" },
];

export interface WalkVocabGroup {
  group: string;
  items: string[];
}

export const WALK_VOCAB: WalkVocabGroup[] = [
  { group: "Params & Locals", items: ["param:N", "local:array_init", "local:for_of_binding", "local:call_result", "local:call_result_callee", "local:yield_star_result"] },
  { group: "Callees & Refs", items: ["yield_star_callee", "call_string_arg:VALUE:callee", "call_string_contains:SUBSTR:callee", "method_arg_callee:METHOD", "only_bare_call", "callee"] },
  { group: "Structural", items: ["return:comma:N", "contains:TEXT:assign_target", "contains:TEXT:member_access_target", "if:condition_refs:ANCHOR", "postfix_increment_operand", "standalone_increment", "closest_parent:TYPE", "condition_callee", "binary_other_operand"] },
  { group: "Class", items: ["enclosing_class", "method:find:TEXT"] },
  { group: "Bulk", items: ["export_map"] },
];

export const FIND_TYPES = ["string_literal", "string_startswith", "string_endswith", "string_contains", "property_assignment", "number", "text", "regex", "function_name"];
export const SCOPE_TYPES = ["function", "async_function", "generator", "async_generator", "method", "class", "arrow"];

export const DATA = {
  VERSIONS, PIPELINE, FILES, ANCHORS, LANDMARKS, SOURCE, PATCHES, MODULES,
  PATCH_DIFF, WAVES, AGENT_QUEUE, WALK_VOCAB, FIND_TYPES, SCOPE_TYPES,
};

export type StudioData = typeof DATA;
