"use client";
/* Overview — build pipeline status + headline coverage. */
import React, { useState } from "react";
import { Icon } from "../ui";
import { DATA, type PipelineStep } from "@/lib/data";

export default function OverviewView({ version, setView }: { version: string; setView: (v: string) => void }) {
  const D = DATA;
  const v = D.VERSIONS.find((x) => x.id === version) || D.VERSIONS[D.VERSIONS.length - 1];
  const pctNamed = Math.round((v.namedFns / v.totalFns) * 100);
  const [steps, setSteps] = useState<PipelineStep[]>(D.PIPELINE);
  const [running, setRunning] = useState(false);

  const runStep = (idx: number) => {
    setRunning(true);
    setSteps((s) => s.map((st, i) => (i === idx ? { ...st, status: "running" } : st)));
    setTimeout(() => {
      setSteps((s) => s.map((st, i) => (i === idx ? { ...st, status: "done" } : st)));
      setRunning(false);
    }, 1100);
  };

  const totalSecs = steps.reduce((a, s) => a + s.secs, 0);

  return (
    <div className="view-pad view-enter">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 22 }}>
        <div className="stat">
          <div className="lbl"><Icon name="hash" size={13} /> Total renames</div>
          <div className="num tabular">{v.renames.toLocaleString()}</div>
          <div className="sub">across {v.locations.toLocaleString()} locations</div>
        </div>
        <div className="stat">
          <div className="lbl"><Icon name="check" size={13} /> Functions named</div>
          <div className="num tabular">{pctNamed}<small>%</small></div>
          <div className="sub">{v.namedFns.toLocaleString()} / {v.totalFns.toLocaleString()} functions</div>
        </div>
        <div className="stat">
          <div className="lbl"><Icon name="anchor" size={13} /> Active anchors</div>
          <div className="num tabular">{D.ANCHORS.length}</div>
          <div className="sub">{D.ANCHORS.filter((a) => a.status !== "ok").length} need attention</div>
        </div>
        <div className="stat">
          <div className="lbl"><Icon name="patch" size={13} /> Patches</div>
          <div className="num tabular">{D.PATCHES.length}</div>
          <div className="sub" style={{ color: "var(--bad)" }}>1 broken · 1 fuzzy</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 22 }}>
        <div className="card-h">
          <Icon name="pipeline" /><span className="ttl">Build pipeline</span>
          <span className="sub">{v.id} · {v.format} bundle · {v.wrappers}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip plain"><Icon name="clock" size={12} /> ~{totalSecs}s full build</span>
            <button className="btn sm pri" disabled={running} onClick={() => runStep(5)}><Icon name="play" size={13} /> Run build</button>
          </div>
        </div>
        <div className="card-b">
          <div className="flow">
            {steps.map((s, i) => (
              <React.Fragment key={s.id}>
                <div className={"flow-node " + s.status} onClick={() => !running && runStep(i)} style={{ cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                    <span className={"sdot " + s.status + (s.status === "running" ? " pulse" : "")} />
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{s.label}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{s.cmd.replace("entrypoint.sh ", "$ ")}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 7, lineHeight: 1.35 }}>{s.desc}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 9, fontSize: 10.5 }} className="mono">
                    <span style={{ color: "var(--ink-3)" }}>{s.out}</span>
                    <span style={{ color: "var(--ink-4)" }}>{s.secs}s</span>
                  </div>
                </div>
                {i < steps.length - 1 && <div className="flow-arrow"><Icon name="chevR" size={16} /></div>}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
        <div className="card">
          <div className="card-h"><Icon name="coverage" /><span className="ttl">Coverage by version</span>
            <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setView("coverage")}>Open dashboard <Icon name="arrowR" size={13} /></button>
          </div>
          <div className="card-b">
            <TrendChart />
          </div>
        </div>

        <div className="card">
          <div className="card-h"><Icon name="warn" /><span className="ttl">Needs attention</span></div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <AttnRow kind="bad" title="Patch 004 rejects on 4 versions" sub="references U4() — no anchor guarantees it" cta="Fix" onClick={() => setView("patches")} />
            <AttnRow kind="warn" title="LogoV2 anchor drifts" sub="text 'sandboxed' fails on 2.1.70, fuzzy on 2.1.77" cta="Review" onClick={() => setView("anchors")} />
            <AttnRow kind="warn" title="withRetry.js at 78% named" sub="getRateLimitResetDelayMs still minified — patch 006 fuzzy" cta="Add anchor" onClick={() => setView("anchors")} />
            <AttnRow kind="info" title="2 agent proposals awaiting review" sub="secureStorage U4, auth getClaudeAIOAuthTokens" cta="Review" onClick={() => setView("agents")} />
          </div>
        </div>
      </div>
    </div>
  );
}

function AttnRow({ kind, title, sub, cta, onClick }: { kind: string; title: string; sub: string; cta: string; onClick: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--bg-2)" }}>
      <span className={"sdot " + kind} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{sub}</div>
      </div>
      <button className="btn sm" style={{ marginLeft: "auto" }} onClick={onClick}>{cta}</button>
    </div>
  );
}

function TrendChart() {
  const D = DATA;
  const W = 540, H = 180, pad = 30;
  const vs = D.VERSIONS;
  const max = 30000, min = 20000;
  const x = (i: number) => pad + (i * (W - pad * 2)) / (vs.length - 1);
  const yLoc = (val: number) => H - pad - ((val - min) / (max - min)) * (H - pad * 2);
  const yPct = (val: number) => H - pad - ((val - 95) / (100 - 95)) * (H - pad * 2);
  const locPath = vs.map((v, i) => `${i ? "L" : "M"}${x(i)},${yLoc(v.locations)}`).join(" ");
  const pctPath = vs.map((v, i) => `${i ? "L" : "M"}${x(i)},${yPct(v.stateNamed)}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
        {[0, 0.5, 1].map((g) => (
          <line key={g} x1={pad} x2={W - pad} y1={pad + g * (H - pad * 2)} y2={pad + g * (H - pad * 2)} stroke="var(--line-soft)" strokeWidth="1" />
        ))}
        <path d={locPath} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={pctPath} fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeDasharray="3 4" strokeLinecap="round" strokeLinejoin="round" />
        {vs.map((v, i) => (
          <g key={v.id}>
            <circle cx={x(i)} cy={yLoc(v.locations)} r="3.5" fill="var(--accent)" />
            <circle cx={x(i)} cy={yPct(v.stateNamed)} r="3.5" fill="var(--ok)" />
            <text x={x(i)} y={H - 8} fontSize="9.5" fill="var(--ink-4)" textAnchor="middle" fontFamily="var(--font-mono)">{v.id}</text>
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", gap: 18, fontSize: 11.5, marginTop: 4 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 2.5, background: "var(--accent)", display: "inline-block" }} /> rename locations</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 2.5, background: "var(--ok)", display: "inline-block" }} /> state.js named %</span>
      </div>
    </div>
  );
}
