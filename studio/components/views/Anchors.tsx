"use client";
/* Anchors — builder (module browser + landmark finder + source + walk-chain builder) + inspector REPL. */
import React, { useState, useRef, useEffect } from "react";
import { useStudio } from "@/lib/StudioContext";
import { Icon, Chip, CodeBlock, Bar, fileTint } from "../ui";
import { DATA, type Anchor, type AnchorWalk, type Landmark, type FileEntry } from "@/lib/data";

function walkKindChip(kind: string) {
  const m: Record<string, [string, string]> = { global: ["accent", "global"], scoped: ["info", "scoped"], anchor: ["plain", "anchor"], bulk: ["warn", "bulk"] };
  const [k, l] = m[kind] || ["plain", kind];
  return <Chip kind={k}>{l}</Chip>;
}

// Convert a display anchor back into the backend's anchor-rules.json rule shape
// so the live pipeline can resolve it.
function anchorToRules(a: Anchor): any[] {
  const anchorOnly = a.rename === "(anchor_only)";
  const root: any = { id: a.id, file: a.file, find: a.find, scope: a.scope };
  if (anchorOnly) root.anchor_only = true; else root.rename = a.rename;
  const walks = a.walks
    .filter((w) => w.rename && !w.rename.startsWith("("))
    .map((w) => ({
      from: a.id,
      walk: w.walk,
      rename: w.rename.startsWith("__export_map") ? "__export_map" : w.rename,
    }));
  return [root, ...walks];
}

// Bounded sample of versions for live re-validation (cold deob is ~20s/version,
// so we sample ~6 across the range rather than all of them). Current included.
function sampleVersions(ids: string[], n = 6): string[] {
  if (ids.length <= n) return ids;
  const step = Math.ceil(ids.length / (n - 1));
  const out = ids.filter((_, i) => i % step === 0);
  const last = ids[ids.length - 1];
  if (!out.includes(last)) out.push(last);
  return out;
}

function findSummary(find: Record<string, unknown> | undefined) {
  if (!find) return "—";
  const k = Object.keys(find)[0];
  const val = find[k] as any;
  if (k === "property_assignment") return `${k} { ${val.key}: "${val.value}" }`;
  if (k === "chained_from") return `chained from ${val}`;
  if (typeof val === "object") return k;
  return `${k}: "${val}"`;
}

export default function AnchorsView({ version }: { version: string }) {
  const [tab, setTab] = useState("builder");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", borderBottom: "1px solid var(--line)", flex: "none" }}>
        <div className="seg">
          <button className={tab === "builder" ? "on" : ""} onClick={() => setTab("builder")}>Builder</button>
          <button className={tab === "repl" ? "on" : ""} onClick={() => setTab("repl")}>Inspector · REPL</button>
        </div>
        <span className="tb-sub">{tab === "builder" ? "Author root rules + walk chains with live cross-version validation" : "anchor-dev — navigate resolved anchors, test walks interactively"}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "builder" ? <AnchorBuilder version={version} /> : <AnchorRepl version={version} />}
      </div>
    </div>
  );
}

interface FindInfo { count: number; matches: { line: number; scope: string | null; inRequestedScope: boolean }[]; }

function AnchorBuilder({ version }: { version: string }) {
  const D = DATA;
  const studio = useStudio();
  const [leftTab, setLeftTab] = useState("anchors");
  const [selId, setSelId] = useState("getGlobalConfig");
  const [jsonMode, setJsonMode] = useState(false);
  const [query, setQuery] = useState("");
  const [findInfo, setFindInfo] = useState<FindInfo | null>(null);
  // jump signal from the walk-chain (right pane) to the source viewer (center)
  const [jump, setJump] = useState<{ seq: number; term: string } | null>(null);

  const anchor = D.ANCHORS.find((a) => a.id === selId) || D.ANCHORS[0];
  const file = anchor.file;

  // Analyze landmark match count/positions once per (anchor, version); shared
  // by the source viewer (highlighting) and the rule editor (warning).
  useEffect(() => {
    setFindInfo(null);
    const hasChained = anchor.find && "chained_from" in anchor.find;
    if (!studio.connected || hasChained || !anchor.find || Object.keys(anchor.find || {}).length === 0) return;
    let cancel = false;
    studio.analyzeFind(version, anchor.file, anchor.find, anchor.scope).then((r) => {
      if (cancel) return;
      if (r.ok && typeof r.count === "number") setFindInfo({ count: r.count, matches: r.matches || [] });
    });
    return () => { cancel = true; };
  }, [anchor.id, version, JSON.stringify(anchor.find)]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLandmark = (lm: Landmark) => {
    const a = D.ANCHORS.find((x) => x.file === lm.file);
    if (a) setSelId(a.id);
    setLeftTab("anchors");
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "256px 1fr 392px", height: "100%", minHeight: 0 }}>
      {/* LEFT */}
      <div style={{ borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-2)" }}>
        <div className="seg" style={{ margin: 10, justifyContent: "stretch" }}>
          {["anchors", "files", "landmarks"].map((t) => (
            <button key={t} className={leftTab === t ? "on" : ""} style={{ flex: 1, textTransform: "capitalize" }} onClick={() => setLeftTab(t)}>{t}</button>
          ))}
        </div>
        <div style={{ padding: "0 10px 10px" }}>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 9, top: 8, color: "var(--ink-4)" }}><Icon name="search" size={14} /></span>
            <input className="input" placeholder={leftTab === "landmarks" ? "filter strings…" : "filter…"} value={query} onChange={(e) => setQuery(e.target.value)} style={{ paddingLeft: 30, fontFamily: "var(--font-ui)" }} />
          </div>
        </div>
        <div className="scroll-y" style={{ flex: 1, minHeight: 0, padding: "0 8px 12px" }}>
          {leftTab === "anchors" && <AnchorList sel={selId} setSel={setSelId} query={query} />}
          {leftTab === "files" && <FileTree sel={file} setSel={(f) => { const a = D.ANCHORS.find((x) => x.file === f); if (a) setSelId(a.id); }} query={query} />}
          {leftTab === "landmarks" && <LandmarkList onPick={loadLandmark} query={query} />}
        </div>
      </div>

      {/* CENTER — live source viewer */}
      <SourceViewer version={version} file={file} anchor={anchor} findInfo={findInfo} jump={jump} />

      {/* RIGHT — builder */}
      <div style={{ borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: "1px solid var(--line)", flex: "none" }}>
          <Icon name="anchor" size={15} /><span style={{ fontWeight: 600 }}>Rule editor</span>
          <div style={{ marginLeft: "auto" }} className="seg">
            <button className={!jsonMode ? "on" : ""} onClick={() => setJsonMode(false)}>Visual</button>
            <button className={jsonMode ? "on" : ""} onClick={() => setJsonMode(true)}>JSON</button>
          </div>
        </div>
        <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
          {jsonMode ? <JsonEditor anchor={anchor} /> : <VisualBuilder anchor={anchor} version={version} findInfo={findInfo} onEditJson={() => setJsonMode(true)} onJumpToTarget={(term) => setJump((j) => ({ seq: (j?.seq || 0) + 1, term }))} />}
        </div>
      </div>
    </div>
  );
}

// Highlight term = the anchor's find string (string literals aren't renamed,
// so it appears in both pre-rename and resolved source).
function landmarkTerm(find: Record<string, unknown> | undefined): string | null {
  if (!find) return null;
  const v = Object.values(find)[0] as any;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.value === "string") return v.value;
  return null;
}

function SrcLoading({ loading }: { loading: boolean }) {
  return <div className="empty"><span className="sdot running pulse" /><div>{loading ? "building source…" : "—"}</div></div>;
}

function SourceViewer({ version, file, anchor, findInfo, jump }: { version: string; file: string; anchor: Anchor; findInfo: FindInfo | null; jump?: { seq: number; term: string } | null }) {
  const studio = useStudio();
  const [mode, setMode] = useState<"minified" | "resolved" | "split">("minified");
  const [src, setSrc] = useState<{ minified: string | null; resolved: string | null }>({ minified: null, resolved: null });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  const [resInfo, setResInfo] = useState<FindInfo | null>(null);
  const [walkPre, setWalkPre] = useState<number | null>(null);
  const [walkRes, setWalkRes] = useState<number | null>(null);
  const [pendingRes, setPendingRes] = useState<number | null>(null);
  const [resKey, setResKey] = useState<string | null>(null);
  const findKey = JSON.stringify(anchor.find);
  const preRef = useRef<HTMLDivElement | null>(null);
  const resRef = useRef<HTMLDivElement | null>(null);
  const scrollLn = (ref: React.RefObject<HTMLDivElement | null>, idx: number) => {
    requestAnimationFrame(() => {
      const el = ref.current?.querySelectorAll(".codeblock .ln")[idx] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  // pre-rename source on file/version change
  useEffect(() => {
    let cancel = false;
    setSrc({ minified: null, resolved: null }); setErr(null); setMode("minified"); setFlashIdx(null); setResInfo(null); setResKey(null); setWalkPre(null); setWalkRes(null); setPendingRes(null); setLoading(true);
    studio.getSource(version, file, false).then((r) => {
      if (cancel) return;
      setLoading(false);
      if (r.ok) setSrc((s) => ({ ...s, minified: r.minified ?? null }));
      else setErr(r.error || "failed");
    });
    return () => { cancel = true; };
  }, [version, file]); // eslint-disable-line react-hooks/exhaustive-deps

  // resolved source + resolved-coordinate match analysis. Re-runs when entering
  // a resolved/split view OR when the find changes (so the resolved highlight
  // tracks filter edits). Skips refetch when already current for this find.
  useEffect(() => {
    if (!(mode === "resolved" || mode === "split") || !studio.connected) return;
    if (src.resolved !== null && resKey === findKey) return; // already current
    let cancel = false; setLoading(true); setErr(null);
    studio.getSource(version, file, true).then((r) => {
      if (cancel) return;
      setLoading(false);
      if (r.ok) setSrc((s) => ({ minified: s.minified ?? r.minified ?? null, resolved: r.resolved ?? "" }));
      else setErr(r.error || "failed");
    });
    if (anchor.find && Object.keys(anchor.find).length && !("chained_from" in anchor.find)) {
      studio.analyzeFind(version, file, anchor.find, anchor.scope, true).then((r) => {
        if (cancel) return;
        if (r.ok && r.resolvedMatches) setResInfo({ count: r.resolvedMatches.length, matches: r.resolvedMatches });
      });
    }
    setResKey(findKey);
    return () => { cancel = true; };
  }, [mode, findKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Walk-chain target jump — jump in the CURRENT view (pre-rename/resolved/split),
  // using backend-located lines (resolved by name, pre-rename by minified name).
  useEffect(() => {
    if (!jump || !jump.term) return;
    let cancel = false;
    (async () => {
      const r = await studio.locateWalk(version, jump.term, anchorToRules(anchor));
      if (cancel || !r.ok) return;
      if ((mode === "minified" || mode === "split") && r.preLine && r.preLine > 0) {
        const idx = r.preLine - 1;
        setWalkPre(idx); scrollLn(preRef, idx);
        setTimeout(() => setWalkPre((w) => (w === idx ? null : w)), 1800);
      }
      if ((mode === "resolved" || mode === "split") && r.resolvedLine && r.resolvedLine > 0) {
        const idx = r.resolvedLine - 1;
        if (src.resolved) { setWalkRes(idx); scrollLn(resRef, idx); setTimeout(() => setWalkRes((w) => (w === idx ? null : w)), 1800); }
        else setPendingRes(idx); // resolved still loading — scroll once it arrives
      }
    })();
    return () => { cancel = true; };
  }, [jump?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // deferred resolved walk-scroll once the resolved source finishes loading
  useEffect(() => {
    if (pendingRes == null || !src.resolved) return;
    const idx = pendingRes; setPendingRes(null);
    setWalkRes(idx); scrollLn(resRef, idx);
    setTimeout(() => setWalkRes((w) => (w === idx ? null : w)), 1800);
  }, [pendingRes, src.resolved]); // eslint-disable-line react-hooks/exhaustive-deps

  const term = landmarkTerm(anchor.find);
  const hitsFor = (text: string | null) => {
    if (!term || !text) return undefined;
    const idx: number[] = [];
    text.split("\n").forEach((l, i) => { if (l.includes(term)) idx.push(i); });
    return idx.length ? { [term]: idx } : undefined;
  };

  // bound match = accent, extras = warning. `info` matches are 1-based line
  // numbers in the coordinate system of `text` (pre-rename vs resolved).
  const markHits = (info: FindInfo | null, text: string | null): { hits?: Record<string, number[]>; warn?: Record<string, number[]> } => {
    if (!term || !info || !info.matches.length) return { hits: hitsFor(text) };
    const bound = info.matches[0].line - 1;
    const extras = info.matches.slice(1).map((m) => m.line - 1);
    return { hits: { [term]: [bound] }, warn: extras.length ? { [term]: extras } : undefined };
  };
  const pre = markHits(findInfo, src.minified);
  const res = markHits(resInfo, src.resolved);
  const preHits = pre.hits, preWarn = pre.warn;

  // hop to match #i — scroll EVERY visible pane to that match in its own
  // coordinate system (so split panes stay in sync) and flash it.
  const scrollPane = (ref: React.RefObject<HTMLDivElement | null>, info: FindInfo | null, i: number) => {
    const m = info?.matches[i];
    if (!ref.current || !m) return;
    const el = ref.current.querySelectorAll(".codeblock .ln")[m.line - 1] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const hop = (i: number) => {
    setFlashIdx(i);
    requestAnimationFrame(() => { scrollPane(preRef, findInfo, i); scrollPane(resRef, resInfo, i); });
    setTimeout(() => setFlashIdx((f) => (f === i ? null : f)), 1600);
  };
  const preHLArr = [...(flashIdx != null && findInfo?.matches[flashIdx] ? [findInfo.matches[flashIdx].line - 1] : []), ...(walkPre != null ? [walkPre] : [])];
  const preFlash = preHLArr.length ? preHLArr : undefined;
  const resHLArr = [...(flashIdx != null && resInfo?.matches[flashIdx] ? [resInfo.matches[flashIdx].line - 1] : []), ...(walkRes != null ? [walkRes] : [])];
  const resFlash = resHLArr.length ? resHLArr : undefined;

  const offline = !studio.connected;
  let body: React.ReactNode;
  if (offline) body = <div className="empty"><Icon name="code" /><div>Backend offline — source preview unavailable.</div></div>;
  else if (err) body = <div className="empty"><Icon name="warn" /><div>{err}</div></div>;
  else if (mode === "split") {
    body = (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="kicker" style={{ marginBottom: 6, flex: "none" }}>pre-rename</div>
          <div ref={preRef} className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
            {src.minified != null ? <CodeBlock src={src.minified} hits={preHits} warnHits={preWarn} highlightLines={preFlash} /> : <SrcLoading loading={loading} />}
          </div>
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="kicker" style={{ marginBottom: 6, flex: "none" }}>resolved</div>
          <div ref={resRef} className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
            {src.resolved != null ? (src.resolved ? <CodeBlock src={src.resolved} hits={res.hits} warnHits={res.warn} highlightLines={resFlash} /> : <div className="empty"><Icon name="warn" /><div>no resolved file</div></div>) : <SrcLoading loading={loading} />}
          </div>
        </div>
      </div>
    );
  } else if (mode === "resolved") {
    body = (
      <div ref={resRef} className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {src.resolved == null ? <SrcLoading loading={loading} />
          : !src.resolved ? <div className="empty"><Icon name="warn" /><div>No resolved file for {file} on {version}.</div></div>
          : <CodeBlock src={src.resolved} hits={res.hits} warnHits={res.warn} highlightLines={resFlash} />}
      </div>
    );
  } else {
    body = (
      <div ref={preRef} className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {src.minified == null ? <SrcLoading loading={loading} /> : <CodeBlock src={src.minified} hits={preHits} warnHits={preWarn} highlightLines={preFlash} />}
      </div>
    );
  }

  // jump chips use the active view's coordinate matches (resolved mode → resInfo,
  // else findInfo); hop(i) syncs every visible pane to match #i.
  const hopInfo = mode === "resolved" ? resInfo : findInfo;
  const showHops = !offline && hopInfo && hopInfo.count > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: "1px solid var(--line)", flex: "none" }}>
        <Icon name="file" size={15} />
        <span className="mono" style={{ fontWeight: 600 }}>{file}</span>
        <Chip kind="plain">{anchor.scope}</Chip>
        {loading && <span className="sdot running pulse" title="loading source" />}
        <div style={{ marginLeft: "auto" }} className="seg">
          <button className={mode === "minified" ? "on" : ""} onClick={() => setMode("minified")}>pre-rename</button>
          <button className={mode === "resolved" ? "on" : ""} onClick={() => setMode("resolved")}>resolved</button>
          <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")}>split</button>
        </div>
      </div>
      {term && (
        <div style={{ padding: "8px 16px 0", fontSize: 11.5, color: "var(--ink-3)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Icon name="target" size={13} />
          landmark <code className="mono mark" style={{ padding: "0 4px" }}>{term}</code> → <code className="mono" style={{ color: "var(--accent)" }}>{anchor.rename}</code>
          {showHops && (
            <span style={{ display: "flex", gap: 5, alignItems: "center", marginLeft: 6, flexWrap: "wrap" }}>
              <span className="muted">jump{mode === "split" ? " (synced)" : ""}:</span>
              {hopInfo!.matches.map((m, i) => (
                <button key={i} className="mono" onClick={() => hop(i)} title={i === 0 ? "the match the anchor binds to" : "extra match (ambiguity)"}
                  style={{ cursor: "pointer", fontSize: 10.5, padding: "1px 7px", borderRadius: 20, border: "1px solid " + (i === 0 ? "color-mix(in oklch,var(--accent) 45%,transparent)" : "color-mix(in oklch,var(--warn) 50%,transparent)"),
                    background: i === 0 ? "color-mix(in oklch,var(--accent) 16%,var(--panel))" : "color-mix(in oklch,var(--warn) 14%,var(--panel))",
                    color: i === 0 ? "var(--accent)" : "var(--warn)" }}>
                  {i === 0 ? "binds " : ""}L{m.line}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, padding: 16, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {body}
      </div>
    </div>
  );
}

function AnchorList({ sel, setSel, query }: { sel: string; setSel: (id: string) => void; query: string }) {
  const D = DATA;
  const list = D.ANCHORS.filter((a) => !query || a.id.toLowerCase().includes(query.toLowerCase()) || a.file.includes(query));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {list.map((a) => (
        <div key={a.id} onClick={() => setSel(a.id)}
          style={{ padding: "8px 10px", borderRadius: "var(--r)", cursor: "pointer", border: "1px solid", borderColor: sel === a.id ? "var(--line)" : "transparent", background: sel === a.id ? "var(--panel-2)" : "transparent" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span className={"sdot " + a.status} />
            <span className="mono" style={{ fontWeight: 600, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.id}</span>
            {a.walks.length > 0 && <span className="nav-badge" style={{ marginLeft: "auto" }}>{a.walks.length}</span>}
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.file}</div>
        </div>
      ))}
      <button className="btn ghost sm" style={{ justifyContent: "flex-start", marginTop: 6, color: "var(--accent)" }}><Icon name="plus" size={13} /> New root rule</button>
    </div>
  );
}

function FileTree({ sel, setSel, query }: { sel: string; setSel: (f: string) => void; query: string }) {
  const D = DATA;
  const files = D.FILES.filter((f) => !query || f.path.includes(query));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {files.map((f) => {
        const pct = Math.round((f.named / f.fns) * 100);
        return (
          <div key={f.path} onClick={() => setSel(f.path)}
            style={{ padding: "7px 9px", borderRadius: "var(--r)", cursor: "pointer", background: sel === f.path ? "var(--panel-2)" : "transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ color: fileTint(f.kind) }}><Icon name="file" size={13} /></span>
              <span className="mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{f.path}</span>
              <span className="mono" style={{ fontSize: 10.5, color: pct < 80 ? "var(--warn)" : "var(--ink-4)" }}>{pct}%</span>
            </div>
            <div style={{ marginTop: 5 }}><Bar pct={pct} kind={pct < 80 ? "warn" : pct >= 97 ? "ok" : ""} /></div>
          </div>
        );
      })}
    </div>
  );
}

function LandmarkList({ onPick, query }: { onPick: (l: Landmark) => void; query: string }) {
  const D = DATA;
  const rk: Record<string, [string, string]> = { unique: ["ok", "unique"], rare: ["info", "rare"], common: ["warn", "common"] };
  const list = D.LANDMARKS.filter((l) => !query || l.str.includes(query) || l.file.includes(query))
    .sort((a, b) => a.count - b.count);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ fontSize: 10.5, color: "var(--ink-4)", padding: "2px 4px 6px" }}>String literals ranked by rarity. Rare = stable anchor.</div>
      {list.map((l, i) => (
        <div key={i} onClick={() => onPick(l)} className="card" style={{ padding: "8px 10px", cursor: "pointer", background: "var(--panel)" }}>
          <div className="mono tok-str" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>"{l.str}"</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
            <Chip kind={rk[l.rarity][0]}>{rk[l.rarity][1]} ·{l.count}×</Chip>
            <span className="mono" style={{ fontSize: 10, color: "var(--ink-4)", marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.file.split("/").pop()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CrossVersionRow({ anchor, live, validating, sample }: {
  anchor: Anchor; live?: Record<string, string>; validating?: boolean; sample?: string[];
}) {
  const D = DATA;
  const ic: Record<string, string> = { ok: "check", warn: "warn", fail: "x" };
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {D.VERSIONS.map((v) => {
        const liveSt = live?.[v.id];
        const pending = validating && sample?.includes(v.id) && !liveSt;
        const st = liveSt ?? anchor.versions[v.id];
        if (pending) {
          return (
            <div key={v.id} title={v.id + ": validating…"} className="mono"
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 6, fontSize: 11,
                border: "1px solid color-mix(in oklch,var(--warn) 40%,transparent)", background: "color-mix(in oklch,var(--warn) 12%,var(--panel))", color: "var(--warn)" }}>
              <span className="sdot validating pulse" />{v.id}
            </div>
          );
        }
        return (
          <div key={v.id} title={v.id + ": " + st + (liveSt ? " (live)" : "")}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)",
              outline: liveSt ? "1px solid color-mix(in oklch,var(--accent) 50%,transparent)" : "none", outlineOffset: 1,
              border: "1px solid " + (st === "fail" ? "color-mix(in oklch,var(--bad) 40%,transparent)" : st === "warn" ? "color-mix(in oklch,var(--warn) 40%,transparent)" : "var(--line)"),
              background: st === "fail" ? "color-mix(in oklch,var(--bad) 12%,var(--panel))" : st === "warn" ? "color-mix(in oklch,var(--warn) 12%,var(--panel))" : "var(--panel)",
              color: st === "fail" ? "var(--bad)" : st === "warn" ? "var(--warn)" : "var(--ok)" }}>
            <Icon name={ic[st] || "dot"} size={12} />{v.id}
          </div>
        );
      })}
    </div>
  );
}

// ── Visual filter composer (add/remove not|include entries, no JSON typing) ───
interface FilterRow { mode: "not" | "include"; type: string; value?: string; key?: string }
const FILTER_TYPES = ["string_literal", "string_contains", "string_startswith", "string_endswith", "property_assignment", "case", "default_case", "function_name", "number"];

function entryToRow(e: any): FilterRow {
  const mode: "not" | "include" = "not" in e ? "not" : "include";
  const crit = e.not || e.include || {};
  const type = Object.keys(crit)[0] || "string_literal";
  const v = (crit as any)[type];
  if (type === "property_assignment") return { mode, type, key: v?.key || "", value: v?.value || "" };
  if (type === "default_case") return { mode, type };
  return { mode, type, value: v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v) };
}
function rowToEntry(row: FilterRow): any {
  let crit: any;
  if (row.type === "property_assignment") {
    const pa: any = {};
    if (row.key) pa.key = row.key;
    if (row.value) pa.value = row.value;
    crit = { property_assignment: pa };
  } else if (row.type === "default_case") crit = { default_case: true };
  else if (row.type === "number") crit = { number: Number(row.value) };
  else crit = { [row.type]: row.value ?? "" };
  return row.mode === "not" ? { not: crit } : { include: crit };
}

function FilterEditor({ anchor }: { anchor: Anchor }) {
  const studio = useStudio();
  const [rows, setRows] = useState<FilterRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows((((anchor.find as any) || {}).filter || []).map(entryToRow));
    setDirty(false); setMsg(null);
  }, [anchor.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (i: number, patch: Partial<FilterRow>) => { setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); setDirty(true); setMsg(null); };
  const add = () => { setRows((rs) => [...rs, { mode: "not", type: "string_literal", value: "" }]); setDirty(true); setMsg(null); };
  const remove = (i: number) => { setRows((rs) => rs.filter((_, j) => j !== i)); setDirty(true); setMsg(null); };

  const doSave = async (commit: boolean) => {
    const raw = (DATA as any).ANCHORS_RAW as string | undefined;
    if (!raw) { setMsg("error: rules not loaded"); return; }
    let rules: any[];
    try { rules = JSON.parse(raw); } catch { setMsg("error: rules parse failed"); return; }
    const idx = rules.findIndex((r) => (r.id ?? r.rename) === anchor.id && !r.from && r.type !== "pin");
    if (idx < 0) { setMsg("error: rule not found in file"); return; }
    const base = { ...(rules[idx].find || {}) }; delete (base as any).filter;
    const filter = rows.map(rowToEntry);
    rules[idx].find = filter.length ? { ...base, filter } : base;
    setSaving(true); setMsg(null);
    const r = await studio.save(rules, commit, `studio: edit ${anchor.id} filter`);
    setSaving(false);
    if (r.ok) { setDirty(false); setMsg(commit ? `saved + committed ${r.sha ?? ""}` : "saved — latest re-warming"); }
    else setMsg("error: " + (r.error || "failed"));
  };

  const offline = !studio.connected;
  const seg = (active: boolean) => ({ padding: "2px 8px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600, border: "1px solid var(--line)", background: active ? "var(--raised)" : "transparent" });

  return (
    <div className="field">
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>filter {rows.length > 0 && <span className="mono" style={{ color: "var(--ink-4)" }}>· {rows.length}</span>}{dirty && <Chip kind="warn">unsaved</Chip>}</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-2)", minWidth: 0 }}>
            <div className="seg" style={{ flex: "none" }}>
              <button className={row.mode === "not" ? "on" : ""} onClick={() => update(i, { mode: "not" })}>not</button>
              <button className={row.mode === "include" ? "on" : ""} onClick={() => update(i, { mode: "include" })}>incl</button>
            </div>
            <select className="input mono" style={{ flex: "none", width: 132, height: 26, fontSize: 11 }} value={row.type} onChange={(e) => update(i, { type: e.target.value })}>
              {FILTER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {row.type === "property_assignment" ? (
              <>
                <input className="input mono" style={{ height: 26, fontSize: 11 }} placeholder="key" value={row.key || ""} onChange={(e) => update(i, { key: e.target.value })} />
                <input className="input mono" style={{ height: 26, fontSize: 11 }} placeholder="value (opt)" value={row.value || ""} onChange={(e) => update(i, { value: e.target.value })} />
              </>
            ) : row.type === "default_case" ? (
              <span className="muted" style={{ flex: 1, fontSize: 11 }}>(no value)</span>
            ) : (
              <input className="input mono" style={{ height: 26, fontSize: 11 }} placeholder="value" value={row.value || ""} onChange={(e) => update(i, { value: e.target.value })} />
            )}
            <button className="btn icon ghost sm" style={{ flex: "none" }} title="remove" onClick={() => remove(i)}><Icon name="x" size={13} /></button>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn sm ghost" onClick={add}><Icon name="plus" size={12} /> add filter</button>
          {dirty && (
            <>
              <button className="btn sm" style={{ marginLeft: "auto" }} disabled={offline || saving} onClick={() => doSave(false)}><Icon name="check" size={12} /> {saving ? "Saving…" : "Save"}</button>
              <button className="btn sm pri" disabled={offline || saving} onClick={() => doSave(true)}><Icon name="git" size={12} /> Save &amp; commit</button>
            </>
          )}
          {msg && <span className="mono" style={{ fontSize: 10.5, marginLeft: dirty ? 0 : "auto", color: msg.startsWith("error") ? "var(--bad)" : "var(--ok)" }}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}

function VisualBuilder({ anchor, version, onEditJson, findInfo, onJumpToTarget }: { anchor: Anchor; version: string; onEditJson?: () => void; findInfo: FindInfo | null; onJumpToTarget?: (term: string) => void }) {
  const D = DATA;
  const studio = useStudio();
  const findKey = Object.keys(anchor.find)[0];
  const findVal = anchor.find[findKey] as any;
  // collision detection across other anchors' renames
  const allRenames = D.ANCHORS.flatMap((a) => [a.rename, ...a.walks.map((w) => w.rename)]).filter((r) => r && !r.startsWith("(") && !r.startsWith("__"));
  const collisions = anchor.walks.map((w) => w.rename).filter((r) => r && !r.startsWith("(") && !r.startsWith("__") && allRenames.filter((x) => x === r).length > 1);
  const failVersions = D.VERSIONS.filter((v) => anchor.versions[v.id] === "fail");

  // ── Live backend wiring ────────────────────────────────────────────────────
  const [live, setLive] = useState<Record<string, string>>({});
  const [validating, setValidating] = useState(false);
  const [resolveMsg, setResolveMsg] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const sample = sampleVersions(D.VERSIONS.map((v) => v.id));
  const landmark = landmarkTerm(anchor.find);

  // Reset live results when the selected anchor changes.
  useEffect(() => { setLive({}); setResolveMsg(null); }, [anchor.id]);

  const doResolve = async () => {
    setResolving(true); setResolveMsg(null);
    const r = await studio.preview(version, anchorToRules(anchor));
    setResolving(false);
    setResolveMsg(r.ok ? `resolved ${r.count} rename${r.count === 1 ? "" : "s"} on ${version}` : `error: ${r.error || "failed"}`);
  };
  const doValidate = async () => {
    setValidating(true); setLive({});
    await studio.validate(sample, anchorToRules(anchor), (res) => {
      setLive((prev) => ({ ...prev, [res.version]: res.resolved ? "ok" : "fail" }));
    });
    setValidating(false);
  };
  const offline = !studio.connected;

  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* root rule */}
      <div className="card">
        <div className="card-h" style={{ padding: "10px 13px" }}>
          <Chip kind="accent" dot>root rule</Chip>
          <span className="mono" style={{ fontWeight: 600, marginLeft: 2 }}>{anchor.id}</span>
        </div>
        <div className="card-b" style={{ padding: 13, display: "flex", flexDirection: "column", gap: 11 }}>
          <div className="field">
            <label>file</label>
            <input className="input" value={anchor.file} readOnly />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="field">
              <label>find type</label>
              <select className="input" value={findKey} {...{ readOnly: true } as any}>
                {D.FIND_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label>scope</label>
              <select className="input" value={anchor.scope} {...{ readOnly: true } as any}>
                {D.SCOPE_TYPES.concat(["—(chained)"]).map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>find value</label>
            <input className="input tok-str" value={typeof findVal === "object" ? JSON.stringify(findVal) : findVal}
              style={{ borderColor: findInfo && findInfo.count > 1 ? "var(--warn)" : undefined }} readOnly />
          </div>
          <FilterEditor anchor={anchor} />
          {findInfo && (
            findInfo.count > 1 ? (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, color: "var(--warn)", background: "color-mix(in oklch,var(--warn) 10%,transparent)", padding: "8px 10px", borderRadius: 6 }}>
                <Icon name="warn" size={14} style={{ flex: "none", marginTop: 1 }} />
                <span>
                  <b>Ambiguous landmark</b> — {landmark ? <code className="mono">&quot;{landmark}&quot;</code> : "this pattern"} matches <b>{findInfo.count}×</b> in {anchor.file}.
                  The anchor binds to the <b>first</b> (line {findInfo.matches[0]?.line}
                  {findInfo.matches[0] && (findInfo.matches[0].inRequestedScope
                    ? <> · in <code className="mono">{findInfo.matches[0].scope}</code></>
                    : <> · <span style={{ color: "var(--bad)" }}>NOT inside a {anchor.scope}</span></>)}).
                  {findInfo.matches.length > 1 && <> Other matches: lines {findInfo.matches.slice(1).map((m) => m.line).join(", ")}.</>}
                  {" "}Use a more unique string, or narrow with <code className="mono">property_assignment</code> / a tighter scope.
                </span>
              </div>
            ) : findInfo.count === 1 ? (
              <div style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11.5, color: "var(--ok)" }}>
                <Icon name="check" size={13} /> Unique landmark — single match on {version}
                {findInfo.matches[0] && !findInfo.matches[0].inRequestedScope && (
                  <span style={{ color: "var(--bad)" }}>(but not inside a {anchor.scope})</span>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11.5, color: "var(--bad)" }}>
                <Icon name="x" size={13} /> No match for this pattern on {version}
              </div>
            )
          )}
          <div className="field">
            <label>rename →</label>
            <input className="input" style={{ color: "var(--accent)", fontWeight: 600 }} value={anchor.rename} readOnly />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--ink-3)" }}>
            <span className={"sdot " + anchor.status} />
            resolves on {version} · confidence
            <b className="mono" style={{ color: anchor.confidence >= 90 ? "var(--ok)" : "var(--warn)" }}>{anchor.confidence}%</b>
          </div>
        </div>
      </div>

      {/* walk chain */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span className="kicker">Walk chain</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{anchor.walks.length} rules</span>
        </div>
        {anchor.walks.length === 0 && <div className="empty" style={{ padding: 22 }}><Icon name="branch" /><div style={{ fontSize: 12 }}>No walks. Add one from the palette below.</div></div>}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {anchor.walks.map((w, i) => (
            <div key={i} style={{ display: "flex", gap: 9 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 16, flex: "none" }}>
                <div style={{ width: 1.5, flex: 1, background: "var(--line)", minHeight: 8 }} />
                <div style={{ width: 7, height: 7, borderRadius: 2, background: "var(--accent)", transform: "rotate(45deg)" }} />
                <div style={{ width: 1.5, flex: 1, background: i === anchor.walks.length - 1 ? "transparent" : "var(--line)" }} />
              </div>
              {(() => {
                const jumpable = !!onJumpToTarget && !!w.rename && !w.rename.startsWith("(") && !w.rename.startsWith("__");
                return (
                  <div className="card" style={{ flex: 1, padding: "9px 11px", marginBottom: 7, cursor: jumpable ? "pointer" : "default" }}
                    title={jumpable ? `jump to ${w.rename} in resolved source` : undefined}
                    onClick={jumpable ? () => onJumpToTarget!(w.rename) : undefined}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <code className="mono" style={{ fontSize: 11.5, color: "var(--ink)" }}>{w.walk}</code>
                      {walkKindChip(w.kind)}
                      {jumpable && <Icon name="arrowR" size={12} style={{ marginLeft: "auto", color: "var(--ink-4)" }} />}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11.5 }}>
                      <Icon name="arrowR" size={12} style={{ color: "var(--ink-4)" }} />
                      <code className="mono" style={{ color: w.rename.startsWith("(") ? "var(--ink-4)" : "var(--accent)", fontWeight: 600 }}>{w.rename}</code>
                      {collisions.includes(w.rename) && <span title="name collision" style={{ marginLeft: "auto" }}><Chip kind="bad"><Icon name="warn" size={11} /> collision</Chip></span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      </div>

      {/* add walk palette */}
      <details className="card">
        <summary style={{ padding: "10px 13px", cursor: "pointer", fontWeight: 600, fontSize: 12.5, listStyle: "none", display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="plus" size={14} /> Add walk from vocabulary
        </summary>
        <div className="card-b" style={{ padding: 12, paddingTop: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {D.WALK_VOCAB.map((g) => (
            <div key={g.group}>
              <div className="kicker" style={{ marginBottom: 5 }}>{g.group}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {g.items.map((it) => (
                  <button key={it} className="chip mono" style={{ cursor: "pointer", fontSize: 10.5 }}>{it}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>

      {/* validation */}
      <div className="card">
        <div className="card-h" style={{ padding: "10px 13px" }}>
          <Icon name="target" size={15} /><span className="ttl">Cross-version validation</span>
          {Object.keys(live).length > 0 && <Chip kind="accent" dot>live · {Object.keys(live).length}/{sample.length}</Chip>}
          <span className="sub" style={{ marginLeft: "auto" }}>{validating ? "validating sample…" : "coverage run · re-validate for live"}</span>
        </div>
        <div className="card-b" style={{ padding: 13, display: "flex", flexDirection: "column", gap: 11 }}>
          <CrossVersionRow anchor={anchor} live={live} validating={validating} sample={sample} />
          {failVersions.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, color: "var(--bad)", background: "color-mix(in oklch,var(--bad) 10%,transparent)", padding: "8px 10px", borderRadius: 6 }}>
              <Icon name="warn" size={14} />
              <span>Drift: fails on {failVersions.map((v) => v.id).join(", ")}. The <span className="mono">{findKey}</span> pattern isn't present pre-rename in those bundles. Chain from a more stable string.</span>
            </div>
          )}
          {collisions.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, color: "var(--warn)", background: "color-mix(in oklch,var(--warn) 10%,transparent)", padding: "8px 10px", borderRadius: 6 }}>
              <Icon name="warn" size={14} /><span>{collisions.length} rename target(s) collide with another anchor. Anchor match wins; the conflict is logged.</span>
            </div>
          )}
        </div>
      </div>

      {/* actions */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn" onClick={doResolve} disabled={offline || resolving}
          title={offline ? "backend offline — start patcher-studio-api" : `resolve on ${version}`}>
          <Icon name="play" size={13} /> {resolving ? "Resolving…" : "Resolve"}
        </button>
        <button className="btn" onClick={doValidate} disabled={offline || validating}
          title={offline ? "backend offline — start patcher-studio-api" : "re-validate across sampled versions"}>
          <Icon name="refresh" size={13} /> {validating ? "Validating…" : "Re-validate"}
        </button>
        {resolveMsg && <span className="mono" style={{ fontSize: 11.5, color: resolveMsg.startsWith("error") ? "var(--bad)" : "var(--ok)" }}>{resolveMsg}</span>}
        {offline && <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>backend offline</span>}
        <button className="btn pri" style={{ marginLeft: "auto" }} onClick={onEditJson}><Icon name="code" size={13} /> Edit rules JSON</button>
      </div>
    </div>
  );
}

function JsonEditor({ anchor }: { anchor: Anchor }) {
  const studio = useStudio();
  // Edit the RAW anchor-rules.json (full file) — round-tripping the grouped
  // view would be lossy, so we edit/save the real file verbatim.
  const raw = (DATA as any).ANCHORS_RAW as string | undefined;
  const fallback = JSON.stringify(anchorToRules(anchor), null, 4);
  const [text, setText] = useState(raw ?? fallback);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Re-sync to the latest file when it changes externally — but only if the
  // user hasn't started editing (don't clobber in-progress edits).
  useEffect(() => {
    if (!dirty && typeof raw === "string") setText(raw);
  }, [raw, dirty]);

  const onChange = (v: string) => {
    setText(v); setDirty(true); setMsg(null);
    try { const a = JSON.parse(v); setErr(Array.isArray(a) ? null : "top level must be an array of rules"); }
    catch (e: any) { setErr(e.message); }
  };

  const doSave = async (commit: boolean) => {
    let arr: unknown;
    try { arr = JSON.parse(text); } catch (e: any) { setErr(e.message); return; }
    if (!Array.isArray(arr)) { setErr("top level must be an array of rules"); return; }
    setSaving(true); setMsg(null);
    const r = await studio.save(arr as unknown[], commit, "studio: edit anchor rules");
    setSaving(false);
    if (r.ok) { setDirty(false); setMsg(commit ? `saved + committed ${r.sha ?? ""}` : "saved — latest re-warming"); }
    else setMsg("error: " + (r.error || "failed"));
  };

  const offline = !studio.connected;
  const ruleCount = (() => { try { const a = JSON.parse(text); return Array.isArray(a) ? a.length : null; } catch { return null; } })();

  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 7 }}>
        <Icon name="code" size={14} /> Editing <span className="mono">tools-ts/anchor-rules.json</span>
        {ruleCount != null && <span className="mono" style={{ color: "var(--ink-4)" }}>· {ruleCount} rules</span>}
        {dirty && <Chip kind="warn">unsaved</Chip>}
      </div>
      <textarea className="input code" spellCheck={false} value={text} onChange={(e) => onChange(e.target.value)}
        style={{ flex: 1, minHeight: 320, fontSize: 11.5, lineHeight: 1.55, borderColor: err ? "var(--bad)" : undefined }} />
      {err && <div className="mono" style={{ fontSize: 11, color: "var(--bad)" }}><Icon name="warn" size={12} /> {err}</div>}
      {msg && <div className="mono" style={{ fontSize: 11, color: msg.startsWith("error") ? "var(--bad)" : "var(--ok)" }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn sm" disabled={offline || saving || !!err} onClick={() => doSave(false)}
          title={offline ? "backend offline" : "write anchor-rules.json (re-warms latest)"}>
          <Icon name="check" size={13} /> {saving ? "Saving…" : "Save"}
        </button>
        <button className="btn sm pri" style={{ marginLeft: "auto" }} disabled={offline || saving || !!err} onClick={() => doSave(true)}
          title={offline ? "backend offline" : "write + git commit"}>
          <Icon name="git" size={13} /> Save &amp; commit
        </button>
      </div>
    </div>
  );
}

interface ReplLine {
  t: string;
  v: string;
}

function AnchorRepl({ version }: { version: string }) {
  const D = DATA;
  const [ctx, setCtx] = useState("getGlobalConfig");
  const [history, setHistory] = useState<ReplLine[]>([
    { t: "sys", v: `anchor-dev · deobfuscated/ · ${version} · ${D.ANCHORS.length} root rules loaded` },
    { t: "sys", v: 'type "help" for commands · CLI mode: bun run tools-ts/src/anchor-dev.ts deobfuscated -- "…"' },
    { t: "cmd", v: "resolve" },
    { t: "ok", v: "✓ 11 root rules → 47 renames + 2 anchor-only (3 export_map → 321 bulk renames)" },
  ]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (endRef.current) (endRef.current.parentNode as HTMLElement).scrollTop = (endRef.current.parentNode as HTMLElement).scrollHeight; }, [history]);

  const anchorById = (id: string) => D.ANCHORS.find((a) => a.id === id || a.rename === id);

  const run = (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    const out: ReplLine[] = [{ t: "cmd", v: cmd }];
    const [verb, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(" ");
    const a = anchorById(ctx)!;

    const push = (t: string, v: string) => out.push({ t, v });

    switch (verb) {
      case "help":
        push("out", "from <id>   inspect   params   locals   strings   calls   members");
        push("out", "returns   callers [name]   walk <expr>   source [N]   anchors [f]   resolve");
        break;
      case "from": {
        const t = anchorById(arg);
        if (t) { setCtx(t.id); push("ok", `→ context: ${t.id}  (${t.file}, ${t.scope})`); }
        else push("err", `no resolved anchor "${arg}"`);
        break;
      }
      case "anchors": {
        const list = D.ANCHORS.filter((x) => !arg || x.id.includes(arg));
        list.forEach((x) => push("out", `  ${x.status === "ok" ? "✓" : "⚠"} ${x.id.padEnd(30)} ${x.file}`));
        if (arg.includes("_fun_")) push("dim", "  …212 export_map anchors (bootstrap/state.js_fun_*)");
        break;
      }
      case "inspect":
        push("dim", `── ${a.id}  ${a.file}  [${a.scope}] ──`);
        push("out", `params:  ${a.walks.filter((w) => w.walk.startsWith("param")).map((w) => w.rename).join(", ") || "—"}`);
        push("out", `locals:  ${a.walks.filter((w) => w.walk.startsWith("local")).map((w) => w.rename).join(", ") || "—"}`);
        push("out", `calls:   ${a.walks.filter((w) => w.kind === "global").length} resolved callees`);
        push("out", `find:    ${findSummary(a.find)}`);
        break;
      case "params": {
        const ps = a.walks.filter((w) => w.walk.startsWith("param"));
        if (!ps.length) push("dim", "  (no params)");
        ps.forEach((w, i) => push("out", `  [${w.walk.split(":")[1] || i}] ${w.rename}`));
        break;
      }
      case "locals": {
        const ls = a.walks.filter((w) => w.walk.startsWith("local"));
        if (!ls.length) push("dim", "  (no locals)");
        ls.forEach((w) => push("out", `  ${w.rename.padEnd(22)} ← ${w.walk}`));
        break;
      }
      case "strings":
        D.LANDMARKS.filter((l) => l.file === a.file).forEach((l) => push("out", `  "${l.str}"  (${l.count}× in file)`));
        break;
      case "returns":
        push("out", "  [0] [comma:2]");
        push("out", "  [1] [comma:4]   ← target for intermediate anchor");
        break;
      case "calls": case "members":
        a.walks.filter((w) => w.kind === "global").forEach((w) => push("out", `  ${w.walk}  →  ${w.rename}`));
        break;
      case "callers": {
        const n = arg || a.rename;
        push("ok", `${n} referenced in 1${n === "STATE" ? "47" : "2"} file(s):`);
        push("out", "  bootstrap/state.js, query.js, utils/config.js, services/api/withRetry.js …");
        break;
      }
      case "walk": {
        const w = a.walks.find((x) => x.walk === arg || x.walk.split(":")[0] === arg.split(":")[0]);
        if (w) push("ok", `walk ${arg}  →  ${w.rename}  [${w.kind}]`);
        else push("err", `walk ${arg} failed — pattern not found in scope`);
        break;
      }
      case "source": {
        const s = D.SOURCE[a.file];
        if (s) s.minified.split("\n").slice(0, +arg || 8).forEach((l, i) => push("src", `  ${String(i + 1).padStart(2)}  ${l}`));
        else push("dim", "  (no source snippet)");
        break;
      }
      case "resolve":
        push("ok", "✓ 11 root rules → 47 renames + 2 anchor-only");
        break;
      default:
        push("err", `unknown command "${verb}" — try "help"`);
    }
    setHistory((h) => [...h, ...out]);
    setInput("");
  };

  const QUICK = ["inspect", "params", "locals", "returns", "walk return:comma:4", "callers", "source"];
  const color: Record<string, string> = { cmd: "var(--accent)", ok: "var(--ok)", err: "var(--bad)", out: "var(--ink-2)", dim: "var(--ink-4)", sys: "var(--ink-4)", src: "var(--info)" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "248px 1fr", height: "100%", minHeight: 0 }}>
      {/* left: resolved anchors + quick commands */}
      <div style={{ borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-2)" }}>
        <div style={{ padding: "11px 12px 8px", fontSize: 11, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="terminal" size={14} /> context <code className="mono" style={{ color: "var(--accent)", fontWeight: 600 }}>{ctx}</code>
        </div>
        <div className="scroll-y" style={{ flex: 1, minHeight: 0, padding: "0 8px 10px" }}>
          {D.ANCHORS.map((a) => (
            <div key={a.id} onClick={() => run("from " + a.id)}
              style={{ padding: "6px 9px", borderRadius: "var(--r)", cursor: "pointer", background: ctx === a.id ? "var(--panel-2)" : "transparent", display: "flex", alignItems: "center", gap: 7 }}>
              <span className={"sdot " + a.status} />
              <span className="mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.id}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: 10, borderTop: "1px solid var(--line)", display: "flex", flexWrap: "wrap", gap: 5 }}>
          {QUICK.map((q) => (
            <button key={q} className="chip mono" style={{ cursor: "pointer", fontSize: 10.5 }} onClick={() => run(q)}>{q}</button>
          ))}
        </div>
      </div>
      {/* terminal */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg)" }}>
        <div className="scroll-y code" style={{ flex: 1, minHeight: 0, padding: "14px 18px", fontSize: 12, lineHeight: 1.7 }}>
          {history.map((h, i) => (
            <div key={i} style={{ color: color[h.t], whiteSpace: "pre-wrap" }}>
              {h.t === "cmd" ? <span><span style={{ color: "var(--ink-4)" }}>anchor-dev&gt; </span>{h.v}</span> : h.v}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <form style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 16px", borderTop: "1px solid var(--line)" }}
          onSubmit={(e) => { e.preventDefault(); run(input); }}>
          <span className="mono" style={{ color: "var(--accent)", fontWeight: 600 }}>anchor-dev&gt;</span>
          <input className="input code" autoFocus value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="from STATE · inspect · walk param:0 …" style={{ flex: 1, border: "none", background: "transparent", paddingLeft: 0 }} />
          <button className="btn sm pri" type="submit">Run <span className="kbd" style={{ background: "transparent", border: "none" }}>↵</span></button>
        </form>
      </div>
    </div>
  );
}
