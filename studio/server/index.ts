/* Patcher Studio backend — HTTP health + Socket.IO real-time API.

   Imports the real tools-ts pipeline in-process (run with Bun). Serves a
   snapshot of real repo data and resolves anchor rules live against any
   prepared version. */
import { createServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Server } from "socket.io";
import { PORT, ANCHOR_RULES, PATCH_REF } from "./config";
import { buildSnapshot, buildVersions } from "./data";
import { prepareVersion, resolveAnchors, isPrepared, testApplyPatch, isRenamedFresh, prepareRenamed, prepareRenamedFile, analyzeLandmark, analyzeLandmarkResolved, locateWalkTarget } from "./pipeline";

const httpServer = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "patcher-studio-server" }));
    return;
  }
  res.writeHead(404); res.end();
});

const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e6,
  // prepareVersion() runs the splitter + TS pipeline synchronously (~20s cold),
  // which blocks the event loop and starves heartbeats. Generous ping timeouts
  // keep the socket alive across that blocking work instead of disconnecting.
  pingInterval: 25000,
  pingTimeout: 300000,
});

function log(...a: unknown[]) { console.log("[studio]", ...a); }

io.on("connection", (socket) => {
  log("client connected", socket.id);

  // Initial real-data snapshot.
  try {
    socket.emit("snapshot", buildSnapshot());
  } catch (e: any) {
    socket.emit("server:error", { where: "snapshot", message: String(e?.message || e) });
  }

  // Per-socket token so a newer validate run cancels an older one.
  let validateToken = 0;

  // Warm a version's deob cache; report stage status.
  socket.on("version:prepare", async ({ version }: { version: string }, ack?: (r: unknown) => void) => {
    socket.emit("stage:status", { version, stage: "deob", status: isPrepared(version) ? "fresh" : "computing" });
    try {
      const r = await prepareVersion(version);
      socket.emit("stage:status", { version, stage: "deob", status: "fresh" });
      ack?.({ ok: true, ...r });
    } catch (e: any) {
      socket.emit("stage:status", { version, stage: "deob", status: "error" });
      ack?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Resolve draft rules against ONE version (live preview).
  socket.on("anchor:preview", async ({ version, rules }: { version: string; rules: unknown[] }, ack?: (r: unknown) => void) => {
    try {
      const { deobDir } = await prepareVersion(version);
      const renames = resolveAnchors(deobDir, rules);
      ack?.({ ok: true, count: renames.length, renames: renames.slice(0, 200) });
    } catch (e: any) {
      ack?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Validate draft rules across MANY versions — streams one result per version.
  socket.on("anchor:validate", async ({ versions, rules }: { versions: string[]; rules: unknown[] }, ack?: (r: unknown) => void) => {
    const token = ++validateToken;
    let done = 0;
    for (const version of versions) {
      if (token !== validateToken) return; // superseded by a newer run
      try {
        const { deobDir } = await prepareVersion(version);
        if (token !== validateToken) return;
        const renames = resolveAnchors(deobDir, rules);
        socket.emit("validation:result", {
          token, version, resolved: renames.length > 0, count: renames.length,
          renames: renames.slice(0, 50),
        });
      } catch (e: any) {
        socket.emit("validation:result", { token, version, resolved: false, error: String(e?.message || e) });
      }
      done++;
    }
    ack?.({ ok: true, validated: done });
  });

  // Persist rules to anchor-rules.json; optionally git-commit.
  socket.on("anchor:save", ({ rules, commit, message }: { rules: unknown[]; commit?: boolean; message?: string }, ack?: (r: unknown) => void) => {
    try {
      fs.writeFileSync(ANCHOR_RULES, JSON.stringify(rules, null, 4) + "\n");
      let sha: string | null = null;
      if (commit) {
        execSync(`git add "${ANCHOR_RULES}"`, { cwd: PATCH_REF });
        const msg = (message || "studio: update anchor rules").replace(/"/g, '\\"');
        execSync(`git commit -m "${msg}" -- "${ANCHOR_RULES}"`, { cwd: PATCH_REF });
        sha = execSync("git rev-parse --short HEAD", { cwd: PATCH_REF }).toString().trim();
      }
      socket.emit("snapshot", buildSnapshot()); // refresh everyone's view
      ack?.({ ok: true, committed: !!commit, sha });
    } catch (e: any) {
      ack?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Test-apply a patch against a version's renamed output.
  socket.on("patch:test", async ({ version, patchFile }: { version: string; patchFile: string }, ack?: (r: unknown) => void) => {
    socket.emit("stage:status", { version, stage: "renamed", status: isRenamedFresh(version) ? "fresh" : "computing" });
    try {
      const r = await testApplyPatch(version, patchFile);
      socket.emit("stage:status", { version, stage: "renamed", status: "fresh" });
      ack?.({ ok: true, ...r });
    } catch (e: any) {
      socket.emit("stage:status", { version, stage: "renamed", status: "error" });
      ack?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Fetch a file's source: pre-rename (deob dir) and, on request, resolved
  // (renamed dir — heavy unless that version is already warmed).
  socket.on("source:get", async ({ version, file, wantResolved }: { version: string; file: string; wantResolved?: boolean }, ack?: (r: unknown) => void) => {
    const readCapped = (p: string): string => {
      const MAX = 400_000;
      let t = fs.readFileSync(p, "utf-8");
      if (t.length > MAX) t = t.slice(0, MAX) + "\n/* … truncated … */";
      return t;
    };
    const cap = (t: string | null): string | null => {
      const MAX = 400_000;
      if (t == null) return null;
      return t.length > MAX ? t.slice(0, MAX) + "\n/* … truncated … */" : t;
    };
    try {
      const { deobDir } = await prepareVersion(version);
      const minPath = path.join(deobDir, file);
      const minified = fs.existsSync(minPath) ? readCapped(minPath) : null;
      let resolved: string | null = null;
      if (wantResolved) {
        // Per-file on-demand render — byte-identical to the whole-bundle output
        // for this file, but avoids rebuilding the entire bundle just to view one.
        const r = await prepareRenamedFile(version, file);
        resolved = cap(r.content);
      }
      ack?.({ ok: true, minified, resolved });
    } catch (e: any) {
      ack?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Landmark ambiguity: how many places does this find pattern match?
  socket.on("find:analyze", async ({ version, file, find, scope, wantResolved }: { version: string; file: string; find: unknown; scope?: string; wantResolved?: boolean }, ack?: (r: unknown) => void) => {
    try {
      const r = await analyzeLandmark(version, file, find, scope);
      let resolved: any = undefined;
      if (wantResolved) resolved = await analyzeLandmarkResolved(version, file, find, scope);
      ack?.({ ok: true, ...r, resolvedCount: resolved?.count, resolvedMatches: resolved?.matches });
    } catch (e: any) {
      ack?.({ ok: false, error: String(e?.message || e) });
    }
  });

  // Locate a walk target via the real anchor resolution (pre-rename + resolved).
  socket.on("walk:locate", async ({ version, target, rules }: { version: string; target: string; rules: unknown[] }, ack?: (r: unknown) => void) => {
    try {
      const r = await locateWalkTarget(version, target, rules);
      ack?.({ ok: true, ...r });
    } catch (e: any) {
      ack?.({ ok: false, error: String(e?.message || e) });
    }
  });

  socket.on("disconnect", () => log("client disconnected", socket.id));
});

// ── Keep the latest version warm ──────────────────────────────────────────────
// We expect work to happen on the latest version, so warm its full renamed
// output once on startup and rebuild only when anchor-rules.json changes
// (the deob stage stays cached; only rename + downstream are recomputed).

function latestVersion(): string | null {
  const vs = buildVersions();
  if (!vs.length) return null;
  return (vs.find((v) => v.current) || vs[vs.length - 1]).id;
}

let warming = false;
let warmQueued = false;
async function warmLatest(reason: string) {
  if (warming) { warmQueued = true; return; }
  warming = true;
  try {
    do {
      warmQueued = false;
      const v = latestVersion();
      if (!v) { log("warm: no versions available"); break; }
      const fresh = isRenamedFresh(v);
      log(`warming latest ${v} (${reason})${fresh ? " — already fresh" : ""}`);
      io.emit("stage:status", { version: v, stage: "renamed", status: fresh ? "fresh" : "computing", warm: true });
      const r = await prepareRenamed(v);
      log(`warm ${v}: ${r.renames} renames, cached=${r.cached}, ${(r.ms / 1000).toFixed(0)}s`);
      io.emit("stage:status", { version: v, stage: "renamed", status: "fresh", warm: true });
    } while (warmQueued);
  } catch (e: any) {
    log(`warm failed: ${e?.message || e}`);
  } finally {
    warming = false;
  }
}

// Rebuild the warm cache when anchors change (writeFileSync keeps the inode, so
// the watch survives the studio's own anchor:save).
let warmDebounce: ReturnType<typeof setTimeout> | null = null;
try {
  fs.watch(ANCHOR_RULES, () => {
    if (warmDebounce) clearTimeout(warmDebounce);
    warmDebounce = setTimeout(() => warmLatest("anchor-rules changed"), 1500);
  });
} catch (e: any) {
  log(`anchor-rules watch unavailable: ${e?.message || e}`);
}

httpServer.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}`);
  warmLatest("startup"); // fire-and-forget
});
