"use client";
/* Patches — authoring + testing. Master/detail with diff, hunk status, anchor deps. */
import React, { useState, useEffect } from "react";
import { Icon, Chip, StatusChip, hl } from "../ui";
import { DATA } from "@/lib/data";
import { useStudio } from "@/lib/StudioContext";

// backend status → the view's hunk status vocabulary
const STATUS_MAP: Record<string, string> = { applied: "apply", fuzz: "fuzz", reject: "reject" };

export default function PatchesView({ version }: { version: string }) {
  const D = DATA;
  const studio = useStudio();
  const [selId, setSelId] = useState<string>(D.PATCHES[0]?.id ?? "001");
  const [testing, setTesting] = useState<boolean>(false);
  // live test-apply results, keyed `${patchId}@${version}`
  const [results, setResults] = useState<Record<string, { status: string; failedFiles?: string[]; message?: string }>>({});
  const p = D.PATCHES.find((x) => x.id === selId) || D.PATCHES[0];
  const patchFile: string | undefined = (p as any).fileName;
  const liveKey = p.id + "@" + version;
  const live = results[liveKey];

  const runTest = async () => {
    if (!patchFile || !studio.connected) {
      // mock fallback (offline / no backend metadata)
      setTesting(true); setTimeout(() => setTesting(false), 1000); return;
    }
    setTesting(true);
    const r = await studio.testPatch(version, patchFile);
    setTesting(false);
    if (r.ok && r.status) {
      setResults((prev) => ({ ...prev, [liveKey]: { status: r.status!, failedFiles: r.failedFiles, message: r.message } }));
    } else {
      setResults((prev) => ({ ...prev, [liveKey]: { status: "error", message: r.error || "failed" } }));
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "100%", minHeight: 0 }}>
      {/* list */}
      <div style={{ borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-2)" }}>
        <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="patch" size={15} /><span style={{ fontWeight: 600 }}>patches.d/</span>
          <button className="btn sm ghost" style={{ marginLeft: "auto" }}><Icon name="plus" size={13} /> New</button>
        </div>
        <div className="scroll-y" style={{ flex: 1, minHeight: 0, padding: 8 }}>
          {D.PATCHES.map((x) => (
            <div key={x.id} onClick={() => setSelId(x.id)}
              style={{ padding: "10px 11px", borderRadius: "var(--r)", cursor: "pointer", marginBottom: 4, border: "1px solid", borderColor: selId === x.id ? "var(--line)" : "transparent", background: selId === x.id ? "var(--panel-2)" : "transparent" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={"sdot " + x.status} />
                <span className="mono" style={{ fontWeight: 600, fontSize: 12 }}>{x.id}</span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</span>
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.file}</div>
              <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
                <StatusChip s={x.status} />
                {x.unguardedDeps && <Chip kind="bad"><Icon name="warn" size={11} /> {x.unguardedDeps.length} unguarded</Chip>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 8 }}>Injected modules</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {D.MODULES.map((m) => (
              <div key={m.file} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11 }}>
                <Icon name="pkg" size={13} style={{ color: "var(--ink-3)" }} />
                <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.file.split("/").pop()}</span>
                <span className="mono muted" style={{ marginLeft: "auto", fontSize: 10 }}>{m.size}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* detail */}
      <div className="scroll-y" style={{ minHeight: 0 }}>
        <div style={{ padding: "20px 24px 50px", maxWidth: 900 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 4 }}>
            <span className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{p.id}</span>
            <span style={{ fontSize: 18, fontWeight: 600 }}>{p.name}</span>
            <StatusChip s={p.status} />
          </div>
          <div className="muted" style={{ marginBottom: 16 }}>{p.desc}</div>

          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 18, fontSize: 12.5 }}>
            <span><span className="muted">target file </span><b className="mono">{p.file}</b></span>
            <span><span className="muted">hook </span><b className="mono">{p.target}</b></span>
            <span><span className="muted">hunks </span><b className="mono">{p.hunks}</b></span>
            {p.dependsOn.length > 0 && <span><span className="muted">depends on </span><b className="mono">{p.dependsOn.join(", ")}</b></span>}
          </div>

          {/* anchor dependency warning */}
          <div className="card" style={{ marginBottom: 18, borderColor: p.unguardedDeps ? "color-mix(in oklch,var(--bad) 40%,var(--line))" : "var(--line)" }}>
            <div className="card-h" style={{ padding: "11px 14px" }}>
              <Icon name="link" size={15} /><span className="ttl">Anchor dependencies</span>
              {p.unguardedDeps ? <Chip kind="bad" dot>{p.unguardedDeps.length} unguarded</Chip> : <Chip kind="ok" dot>all guaranteed</Chip>}
            </div>
            <div className="card-b" style={{ padding: 13, display: "flex", flexDirection: "column", gap: 7 }}>
              {p.anchorDeps.map((d) => {
                const unguarded = p.unguardedDeps && p.unguardedDeps.some((u) => d.startsWith(u));
                return (
                  <div key={d} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12 }}>
                    <span style={{ color: unguarded ? "var(--bad)" : "var(--ok)", display: "inline-flex" }}><Icon name={unguarded ? "x" : "check"} size={14} /></span>
                    <code className="mono">{d}</code>
                    {unguarded
                      ? <Chip kind="bad" >no anchor guarantees this identifier</Chip>
                      : <span className="muted" style={{ fontSize: 11 }}>resolved by anchor</span>}
                  </div>
                );
              })}
              {p.unguardedDeps && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, color: "var(--bad)", background: "color-mix(in oklch,var(--bad) 10%,transparent)", padding: "9px 11px", borderRadius: 6, marginTop: 4 }}>
                  <Icon name="warn" size={15} />
                  <span>This is why <b>patch {p.id} broke</b>. The context lines reference <span className="mono">{p.unguardedDeps[0]}</span>, which stays minified on most versions — so the hunk can't match. Add an anchor first, then regenerate the patch against renamed output.</span>
                </div>
              )}
            </div>
          </div>

          {/* diff */}
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-h" style={{ padding: "11px 14px" }}>
              <Icon name="code" size={15} /><span className="ttl">Diff</span>
              <span className="mono sub">{p.file}</span>
              <button className="btn sm ghost" style={{ marginLeft: "auto" }}><Icon name="refresh" size={13} /> Regenerate vs current</button>
            </div>
            <div className="codeblock" style={{ borderRadius: 0, border: "none", borderTop: "1px solid var(--line)" }}>
              {D.PATCH_DIFF.map((l, i) => (
                <div key={i} className="ln" style={{ background: l.t === "add" ? "color-mix(in oklch,var(--ok) 13%,transparent)" : "transparent" }}>
                  <span className="gut" style={{ color: l.t === "add" ? "var(--ok)" : "var(--ink-4)" }}>{l.t === "add" ? "+" : " "}</span>
                  <span className="src" dangerouslySetInnerHTML={{ __html: hl(l.n) }} />
                </div>
              ))}
            </div>
          </div>

          {/* test-apply */}
          <div className="card">
            <div className="card-h" style={{ padding: "11px 14px" }}>
              <Icon name="beaker" size={15} /><span className="ttl">Test apply</span>
              <span className="sub">live `git apply` against {version} renamed output</span>
              <button className="btn sm pri" style={{ marginLeft: "auto" }} disabled={testing || !studio.connected || !patchFile} onClick={runTest}
                title={!studio.connected ? "backend offline" : !patchFile ? "no patch file in snapshot (mock data)" : `test-apply on ${version} (builds renamed output, ~60s cold)`}>
                {testing ? <><span className="sdot running pulse" /> Applying…</> : <><Icon name="play" size={13} /> Test on {version}</>}
              </button>
            </div>
            {live && (
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 14px", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
                <Chip kind={live.status === "applied" ? "ok" : live.status === "fuzz" ? "warn" : "bad"} dot>{live.status}</Chip>
                <span className="mono" style={{ color: "var(--ink-3)" }}>{version}</span>
                {live.failedFiles && live.failedFiles.length > 0 && (
                  <span className="mono" style={{ color: "var(--bad)", fontSize: 11.5 }}>rejected: {live.failedFiles.join(", ")}</span>
                )}
                {live.message && (!live.failedFiles || !live.failedFiles.length) && (
                  <span className="muted" style={{ fontSize: 11.5 }}>{live.message}</span>
                )}
              </div>
            )}
            <div className="card-b" style={{ padding: 0 }}>
              <table className="tbl">
                <thead><tr><th>Version</th><th>Hunk 1</th>{p.hunks > 1 && <th>Hunk 2</th>}<th>Result</th></tr></thead>
                <tbody>
                  {D.VERSIONS.map((v) => {
                    const liveSt = results[p.id + "@" + v.id];
                    const st = liveSt ? STATUS_MAP[liveSt.status] || liveSt.status : p.versions[v.id];
                    const loading = testing && v.id === version;
                    const label = ({ apply: ["ok", "clean"], fuzz: ["warn", "fuzz (offset)"], reject: ["bad", "*.rej"], error: ["bad", "error"] } as Record<string, [string, string]>)[st] || ["plain", st || "untested"];
                    return (
                      <tr key={v.id} className={v.id === version ? "sel" : ""}>
                        <td className="mono" style={{ fontSize: 12 }}>{v.id}{v.current && <span> <Chip kind="accent">current</Chip></span>}</td>
                        <td><HunkCell st={st} loading={loading} /></td>
                        {p.hunks > 1 && <td><HunkCell st={st === "reject" ? "reject" : st} loading={loading} /></td>}
                        <td>{loading ? <span className="muted mono" style={{ fontSize: 11 }}>…</span> : st ? <Chip kind={label[0]} dot>{label[1]}</Chip> : <span className="muted mono" style={{ fontSize: 11 }}>untested</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HunkCell({ st, loading }: { st: string; loading: boolean }) {
  if (loading) return <span className="sdot pending pulse" />;
  const map: Record<string, [string, string]> = { apply: ["var(--ok)", "check"], fuzz: ["var(--warn)", "warn"], reject: ["var(--bad)", "x"] };
  const [c, ic] = map[st] || ["var(--ink-4)", "dot"];
  return <span style={{ color: c, display: "inline-flex" }}><Icon name={ic} size={14} /></span>;
}
