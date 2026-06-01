"use client";
/* Agents — anchor authoring in waves. Queue → proposal → review → validate → commit. */
import React, { useState } from "react";
import { Icon, Chip, StatusChip, Bar, hl } from "../ui";
import { DATA, type AgentQueueItem, type VerStatus } from "@/lib/data";

const STATE_ORDER = [
  { id: "queued", label: "Queued" },
  { id: "proposed", label: "Proposed" },
  { id: "review", label: "In review" },
  { id: "validating", label: "Validating" },
  { id: "committed", label: "Committed" },
];

export default function AgentsView({ version, setView }: { version: string; setView: (v: string) => void }) {
  const D = DATA;
  const [selId, setSelId] = useState<string>("q2");
  const sel = D.AGENT_QUEUE.find((q) => q.id === selId)!;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 408px", height: "100%", minHeight: 0 }}>
      {/* main */}
      <div className="scroll-y" style={{ minHeight: 0 }}>
        <div style={{ padding: "20px 24px 50px" }}>
          {/* waves */}
          <div className="kicker" style={{ marginBottom: 10 }}>Wave progress</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 24 }}>
            {D.WAVES.map((w, i) => {
              const pct = Math.round((w.done / w.total) * 100);
              return (
                <div key={w.id} className="card" style={{ padding: 15 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="chip plain mono">wave {i + 1}</span>
                    <span style={{ fontWeight: 600 }}>{w.name}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 7, margin: "11px 0 8px" }}>
                    <span className="mono tabular" style={{ fontSize: 23, fontWeight: 600 }}>{w.done.toLocaleString()}</span>
                    <span className="muted mono" style={{ fontSize: 13 }}>/ {w.total.toLocaleString()}</span>
                    <span className="mono" style={{ marginLeft: "auto", color: pct >= 70 ? "var(--ok)" : "var(--warn)", fontWeight: 600 }}>{pct}%</span>
                  </div>
                  <Bar pct={pct} kind={pct >= 70 ? "ok" : "warn"} />
                  <div className="muted" style={{ fontSize: 11, marginTop: 9 }}>{w.desc}</div>
                </div>
              );
            })}
          </div>

          {/* pipeline columns */}
          <div className="kicker" style={{ marginBottom: 10 }}>Authoring pipeline</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
            {STATE_ORDER.map((s) => {
              const items = D.AGENT_QUEUE.filter((q) => q.state === s.id);
              return (
                <div key={s.id} style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: "var(--r-lg)", minHeight: 200, display: "flex", flexDirection: "column" }}>
                  <div style={{ padding: "10px 11px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 7 }}>
                    <span className={"sdot " + s.id} /><span style={{ fontWeight: 600, fontSize: 12 }}>{s.label}</span>
                    <span className="nav-badge" style={{ marginLeft: "auto" }}>{items.length}</span>
                  </div>
                  <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 7 }}>
                    {items.map((q) => (
                      <div key={q.id} onClick={() => setSelId(q.id)} className="card"
                        style={{ padding: "9px 10px", cursor: "pointer", background: "var(--panel)", borderColor: selId === q.id ? "var(--accent)" : "var(--line)" }}>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.file.split("/").pop()}</div>
                        {q.target !== "—" && <div className="mono" style={{ fontSize: 11, color: "var(--accent)", marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.target}</div>}
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7 }}>
                          {q.proposals > 0 && <span className="muted mono" style={{ fontSize: 10 }}><Icon name="sparkle" size={10} /> {q.proposals}</span>}
                          {q.confidence > 0 && <span className="mono" style={{ fontSize: 10, marginLeft: "auto", color: q.confidence >= 85 ? "var(--ok)" : "var(--warn)" }}>{q.confidence}%</span>}
                        </div>
                      </div>
                    ))}
                    {items.length === 0 && <div style={{ fontSize: 10.5, color: "var(--ink-4)", padding: 8, textAlign: "center" }}>—</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* review panel */}
      <div style={{ borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-2)" }}>
        <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 9 }}>
          <Icon name="inbox" size={16} /><span style={{ fontWeight: 600 }}>Review proposal</span>
          <StatusChip s={sel.state} />
        </div>
        <div className="scroll-y" style={{ flex: 1, minHeight: 0, padding: 16 }}>
          <ReviewBody q={sel} version={version} setView={setView} />
        </div>
      </div>
    </div>
  );
}

function ReviewBody({ q, version, setView }: { q: AgentQueueItem; version: string; setView: (v: string) => void }) {
  const D = DATA;
  if (q.target === "—") {
    return (
      <div className="empty" style={{ paddingTop: 50 }}>
        <Icon name="agent" />
        <div style={{ fontWeight: 600, color: "var(--ink-2)" }}>{q.file}</div>
        <div style={{ fontSize: 12 }}>{q.note}</div>
        <button className="btn pri" style={{ marginTop: 8 }}><Icon name="sparkle" size={13} /> Dispatch agent</button>
      </div>
    );
  }
  // synth a plausible find for the proposal
  const findStr = ({ "services/api/withRetry.js": "anthropic-ratelimit-unified-reset", "utils/secureStorage/index.js": "claudeAiOauth", "utils/auth.js": "claudeAiOauth", "services/api/client.js": "isClaudeAISubscriber" } as Record<string, string>)[q.file] || "approved";
  const vers = D.VERSIONS.reduce<Record<string, VerStatus>>((o, v) => ((o[v.id] = q.confidence >= 85 ? "ok" : v.id === "2.1.70" ? "warn" : "ok"), o), {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{q.file}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 5 }}>
          <span className="mono" style={{ fontSize: 16, fontWeight: 600, color: "var(--accent)" }}>{q.target}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
          <Chip kind="plain"><Icon name="agent" size={12} /> {q.agent}</Chip>
          <Chip kind={q.confidence >= 85 ? "ok" : "warn"} dot>confidence {q.confidence}%</Chip>
          <Chip kind="info"><Icon name="sparkle" size={11} /> {q.proposals} proposals</Chip>
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: "var(--ink-2)", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 12, lineHeight: 1.55 }}>
        <span className="kicker" style={{ display: "block", marginBottom: 6 }}>Agent rationale</span>
        {q.note}
      </div>

      {/* proposed rule */}
      <div className="card">
        <div className="card-h" style={{ padding: "10px 13px" }}><Icon name="anchor" size={14} /><span className="ttl">Proposed root rule</span></div>
        <div className="codeblock" style={{ borderRadius: 0, border: "none", borderTop: "1px solid var(--line)", fontSize: 11 }}>
          {[`{`, `  "file": "${q.file}",`, `  "find": { "string_literal": "${findStr}" },`, `  "scope": "function",`, `  "rename": "${q.target.split(" ")[0]}"`, `}`].map((l, i) => (
            <div key={i} className="ln"><span className="gut">{i + 1}</span><span className="src" dangerouslySetInnerHTML={{ __html: hl(l) }} /></div>
          ))}
        </div>
      </div>

      {/* validation */}
      <div>
        <div className="kicker" style={{ marginBottom: 7 }}>Auto-validation across versions</div>
        <CrossVersionRow anchor={{ versions: vers, find: { string_literal: findStr } }} />
      </div>

      {/* collision check */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ok)" }}>
        <Icon name="check" size={14} /> No collision — <span className="mono">{q.target.split(" ")[0]}</span> is unused in current rules.
      </div>

      {/* actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className="btn"><Icon name="x" size={13} /> Reject</button>
        <button className="btn" onClick={() => setView("anchors")}><Icon name="code" size={13} /> Edit</button>
        <button className="btn pri" style={{ marginLeft: "auto" }}><Icon name="check" size={13} /> Accept &amp; commit</button>
      </div>
    </div>
  );
}

function CrossVersionRow({ anchor }: { anchor: { versions: Record<string, VerStatus>; find: Record<string, unknown> } }) {
  const D = DATA;
  const ic: Record<string, string> = { ok: "check", warn: "warn", fail: "x" };
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {D.VERSIONS.map((v) => {
        const st = anchor.versions[v.id];
        return (
          <div key={v.id} title={v.id + ": " + st}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)",
              border: "1px solid " + (st === "fail" ? "color-mix(in oklch,var(--bad) 40%,transparent)" : st === "warn" ? "color-mix(in oklch,var(--warn) 40%,transparent)" : "var(--line)"),
              background: st === "fail" ? "color-mix(in oklch,var(--bad) 12%,var(--panel))" : st === "warn" ? "color-mix(in oklch,var(--warn) 12%,var(--panel))" : "var(--panel)",
              color: st === "fail" ? "var(--bad)" : st === "warn" ? "var(--warn)" : "var(--ok)" }}>
            <Icon name={ic[st]} size={12} />{v.id}
          </div>
        );
      })}
    </div>
  );
}
