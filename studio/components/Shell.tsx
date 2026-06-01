"use client";
/* App shell: sidebar, topbar, version picker. */
import React from "react";
import { Icon, Chip } from "./ui";
import { DATA } from "@/lib/data";

export interface NavItem {
  id?: string;
  label?: string;
  icon?: string;
  badge?: string;
  warn?: boolean;
  sec?: string;
}

export const NAV: NavItem[] = [
  { sec: "Workspace" },
  { id: "overview", label: "Overview", icon: "pipeline" },
  { sec: "Rename" },
  { id: "anchors", label: "Anchors", icon: "anchor", badge: "11" },
  { id: "coverage", label: "Coverage", icon: "coverage" },
  { sec: "Patch" },
  { id: "patches", label: "Patches", icon: "patch", badge: "1", warn: true },
  { sec: "Automation" },
  { id: "agents", label: "Agents", icon: "agent", badge: "5" },
];

export const THEMES = [
  { id: "carbon", label: "Carbon" },
  { id: "terminal", label: "Terminal" },
  { id: "paper", label: "Paper" },
];

export function Sidebar({ view, setView, version, setVerOpen }: {
  view: string; setView: (v: string) => void; version: string; setVerOpen: (b: boolean) => void;
}) {
  const v = DATA.VERSIONS.find((x) => x.id === version) || DATA.VERSIONS[DATA.VERSIONS.length - 1];
  return (
    <aside className="sb">
      <div className="sb-brand">
        <div className="sb-logo"><Icon name="cube" size={15} /></div>
        <div className="sb-title">Patcher Studio
          <small>claude-deobfuscator</small>
        </div>
      </div>
      <nav className="sb-nav">
        {NAV.map((n, i) =>
          n.sec ? (
            <div key={i} className="sb-sec">{n.sec}</div>
          ) : (
            <div key={n.id} className={"nav-item" + (view === n.id ? " active" : "")} onClick={() => setView(n.id!)}>
              <span className="nav-ico"><Icon name={n.icon!} /></span>
              <span>{n.label}</span>
              {n.badge && <span className={"nav-badge" + (n.warn ? " warn" : "")}>{n.badge}</span>}
            </div>
          )
        )}
      </nav>
      <div className="sb-foot">
        <div className="ver-card" onClick={() => setVerOpen(true)}>
          <div className="lbl">Target version</div>
          <div className="val">
            <span className="sdot done" />{v.id}
            {v.current && <span style={{ marginLeft: "auto" }}><Chip kind="accent">current</Chip></span>}
          </div>
        </div>
      </div>
    </aside>
  );
}

export function Topbar({ title, sub, theme, setTheme, density, setDensity, onTweaks, right }: {
  title: string; sub?: string; theme: string; setTheme: (t: string) => void;
  density: string; setDensity: (d: string) => void; onTweaks: () => void; right?: React.ReactNode;
}) {
  return (
    <div className="topbar">
      <div>
        <div className="tb-title">{title}</div>
      </div>
      {sub && <div className="tb-sub">{sub}</div>}
      <div className="tb-spacer" />
      {right}
      <div className="seg" title="Overall look direction">
        {THEMES.map((t) => (
          <button key={t.id} className={theme === t.id ? "on" : ""} onClick={() => setTheme(t.id)}>{t.label}</button>
        ))}
      </div>
      <button className="btn icon ghost" title="Density" onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}>
        <Icon name="layers" />
      </button>
      <button className="btn icon ghost" title="Tweaks" onClick={onTweaks}>
        <Icon name="sliders" />
      </button>
    </div>
  );
}

export function VersionPicker({ version, setVersion, onClose }: {
  version: string; setVersion: (v: string) => void; onClose: () => void;
}) {
  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <div className="card-h" style={{ borderBottom: "1px solid var(--line)" }}>
          <Icon name="git" /><span className="ttl">Select target version</span>
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="scroll-y" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {DATA.VERSIONS.slice().reverse().map((v) => (
            <div key={v.id} className="card" style={{ padding: 14, cursor: "pointer", borderColor: v.id === version ? "var(--accent)" : "var(--line)" }}
              onClick={() => { setVersion(v.id); onClose(); }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="mono" style={{ fontWeight: 600, fontSize: 15 }}>{v.id}</span>
                {v.current && <Chip kind="accent">current</Chip>}
                <Chip kind="plain">{v.format}</Chip>
                <span style={{ marginLeft: "auto", color: "var(--ink-3)", fontSize: 11.5 }} className="mono">{v.date}</span>
              </div>
              <div style={{ display: "flex", gap: 18, marginTop: 11, fontSize: 12 }}>
                <span><span className="muted">renames </span><b className="mono tabular">{v.renames.toLocaleString()}</b></span>
                <span><span className="muted">locations </span><b className="mono tabular">{v.locations.toLocaleString()}</b></span>
                <span><span className="muted">state.js </span><b className="mono">{v.stateNamed}%</b></span>
                <span style={{ marginLeft: "auto" }}><Chip kind="ok" dot>runtime {v.runtime}</Chip></span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
