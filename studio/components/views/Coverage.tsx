"use client";
/* Coverage dashboard — stats, per-file table, version compare, anchor matrix, gaps. */
import React, { useState } from "react";
import { Icon, Chip, Bar, fileTint } from "../ui";
import { DATA } from "@/lib/data";

export default function CoverageView({ version, setView }: { version: string; setView: (v: string) => void }) {
  const D = DATA;
  const v = D.VERSIONS.find((x) => x.id === version)!;
  const [sortKey, setSortKey] = useState<string>("pct");
  const [cmpA, setCmpA] = useState<string>("2.1.70");
  const [cmpB, setCmpB] = useState<string>(version);

  const files = D.FILES.map((f) => ({ ...f, pct: Math.round((f.named / f.fns) * 100) }));
  const sorted = files.slice().sort((a, b) => {
    if (sortKey === "pct") return a.pct - b.pct;
    if (sortKey === "fns") return b.fns - a.fns;
    if (sortKey === "anchors") return b.anchors - a.anchors;
    return a.path.localeCompare(b.path);
  });
  const gaps = files.filter((f) => f.pct < 90).sort((a, b) => (Number(b.patchCritical) - Number(a.patchCritical)) || (a.pct - b.pct));

  const va = D.VERSIONS.find((x) => x.id === cmpA)!, vb = D.VERSIONS.find((x) => x.id === cmpB)!;

  return (
    <div className="view-pad view-enter">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 20 }}>
        <div className="stat"><div className="lbl">Renames</div><div className="num tabular">{v.renames.toLocaleString()}</div><div className="sub">{v.locations.toLocaleString()} locations</div></div>
        <div className="stat"><div className="lbl">Functions named</div><div className="num tabular">{Math.round((v.namedFns / v.totalFns) * 100)}<small>%</small></div><div className="sub">{v.totalFns - v.namedFns} still minified</div></div>
        <div className="stat"><div className="lbl">state.js</div><div className="num tabular">{v.stateNamed}<small>%</small></div><div className="sub">export_map → 212 renames</div></div>
        <div className="stat"><div className="lbl">Gap files (&lt;90%)</div><div className="num tabular">{gaps.length}</div><div className="sub" style={{ color: "var(--warn)" }}>{gaps.filter((g) => g.patchCritical).length} patch-critical</div></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 18, marginBottom: 18 }}>
        {/* per-file table */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-h"><Icon name="folder" /><span className="ttl">Per-file coverage</span>
            <div style={{ marginLeft: "auto" }} className="seg">
              {[["pct", "% named"], ["fns", "size"], ["anchors", "anchors"], ["path", "path"]].map(([k, l]) => (
                <button key={k} className={sortKey === k ? "on" : ""} onClick={() => setSortKey(k)}>{l}</button>
              ))}
            </div>
          </div>
          <div className="scroll-y" style={{ maxHeight: 340 }}>
            <table className="tbl">
              <thead><tr><th>File</th><th style={{ width: 110 }}>Named</th><th style={{ width: 64 }}>Fns</th><th style={{ width: 64 }}>Anchors</th></tr></thead>
              <tbody>
                {sorted.map((f) => (
                  <tr key={f.path} className="click" onClick={() => setView("anchors")}>
                    <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: fileTint(f.kind) }}><Icon name="file" size={13} /></span>
                      <span className="mono" style={{ fontSize: 11.5 }}>{f.path}</span>
                      {f.patchCritical && <span title="patch-critical"><Icon name="patch" size={12} style={{ color: "var(--ink-4)" }} /></span>}
                    </div></td>
                    <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1 }}><Bar pct={f.pct} kind={f.pct < 80 ? "warn" : f.pct >= 97 ? "ok" : ""} /></div>
                      <span className="mono tabular" style={{ fontSize: 11, width: 30, color: f.pct < 80 ? "var(--warn)" : "var(--ink-2)" }}>{f.pct}%</span>
                    </div></td>
                    <td className="mono tabular muted" style={{ fontSize: 11.5 }}>{f.fns}</td>
                    <td>{f.anchors > 0 ? <Chip kind="accent">{f.anchors}</Chip> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* gap view */}
        <div className="card">
          <div className="card-h"><Icon name="zap" /><span className="ttl">Gap view</span><span className="sub">ranked for next wave</span></div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {gaps.map((f) => (
              <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--bg-2)" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 5, alignItems: "center" }}>
                    <Chip kind={f.pct < 80 ? "bad" : "warn"}>{f.pct}%</Chip>
                    {f.patchCritical && <Chip kind="plain"><Icon name="patch" size={11} /> critical</Chip>}
                    <span className="muted mono" style={{ fontSize: 10.5 }}>{f.fns - f.named} left</span>
                  </div>
                </div>
                <button className="btn sm" onClick={() => setView("anchors")}>Anchor</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* version comparison */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h"><Icon name="git" /><span className="ttl">Version comparison</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <select className="input" style={{ width: 100 }} value={cmpA} onChange={(e) => setCmpA(e.target.value)}>{D.VERSIONS.map((x) => <option key={x.id}>{x.id}</option>)}</select>
            <Icon name="arrowR" size={14} />
            <select className="input" style={{ width: 100 }} value={cmpB} onChange={(e) => setCmpB(e.target.value)}>{D.VERSIONS.map((x) => <option key={x.id}>{x.id}</option>)}</select>
          </div>
        </div>
        <div className="card-b" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
          <CmpStat label="Renames" a={va.renames} b={vb.renames} />
          <CmpStat label="Locations" a={va.locations} b={vb.locations} />
          <CmpStat label="state.js named %" a={va.stateNamed} b={vb.stateNamed} suffix="%" />
        </div>
      </div>

      {/* anchor status matrix */}
      <div className="card">
        <div className="card-h"><Icon name="target" /><span className="ttl">Anchor status matrix</span><span className="sub">break/fix grid across versions</span></div>
        <div className="scroll-y">
          <table className="tbl">
            <thead><tr><th>Anchor</th>{D.VERSIONS.map((v) => <th key={v.id} style={{ textAlign: "center", width: 78 }}>{v.id}</th>)}</tr></thead>
            <tbody>
              {D.ANCHORS.map((a) => (
                <tr key={a.id}>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 7 }}><span className={"sdot " + a.status} /><span className="mono" style={{ fontSize: 11.5 }}>{a.id}</span></div></td>
                  {D.VERSIONS.map((v) => {
                    const st = a.versions[v.id];
                    const col = st === "fail" ? "var(--bad)" : st === "warn" ? "var(--warn)" : "var(--ok)";
                    const ic = st === "fail" ? "x" : st === "warn" ? "warn" : "check";
                    return <td key={v.id} style={{ textAlign: "center" }}><span style={{ color: col, display: "inline-flex" }}><Icon name={ic} size={14} /></span></td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CmpStat({ label, a, b, suffix }: { label: string; a: number; b: number; suffix?: string }) {
  const delta = b - a;
  const pct = a ? Math.round((delta / a) * 100) : 0;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "13px 15px", background: "var(--bg-2)" }}>
      <div className="lbl" style={{ fontSize: 11, color: "var(--ink-3)" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
        <span className="mono tabular muted" style={{ fontSize: 14 }}>{a.toLocaleString()}{suffix}</span>
        <Icon name="arrowR" size={12} />
        <span className="mono tabular" style={{ fontSize: 19, fontWeight: 600 }}>{b.toLocaleString()}{suffix}</span>
      </div>
      <div className="mono" style={{ fontSize: 11.5, marginTop: 6, color: delta >= 0 ? "var(--ok)" : "var(--bad)" }}>
        {delta >= 0 ? "+" : ""}{delta.toLocaleString()}{suffix} {pct ? `(${pct >= 0 ? "+" : ""}${pct}%)` : ""}
      </div>
    </div>
  );
}
