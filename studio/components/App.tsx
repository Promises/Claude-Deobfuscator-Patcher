"use client";
/* Root App — routing, theme/tweaks state, shell composition. */
import React, { useState, useEffect } from "react";
import { Icon, Chip } from "./ui";
import { Sidebar, Topbar, VersionPicker, THEMES } from "./Shell";
import { useStudio } from "@/lib/StudioContext";
import { DATA } from "@/lib/data";
import OverviewView from "./views/Overview";
import AnchorsView from "./views/Anchors";
import CoverageView from "./views/Coverage";
import PatchesView from "./views/Patches";
import AgentsView from "./views/Agents";

const TITLES: Record<string, [string, string]> = {
  overview: ["Overview", "Build pipeline & coverage at a glance"],
  anchors: ["Anchors", ""],
  coverage: ["Coverage", "Rename quality across files & versions"],
  patches: ["Patches", "Author, test & verify patches.d/ against the renamed output"],
  agents: ["Agents", "Author anchors in waves — propose, review, validate, commit"],
};

const ACCENTS = [
  { id: "auto", label: "Theme default", val: null as string | null },
  { id: "blue", label: "Signal", val: "oklch(0.70 0.15 248)" },
  { id: "amber", label: "Phosphor", val: "oklch(0.80 0.14 78)" },
  { id: "green", label: "Mint", val: "oklch(0.74 0.15 156)" },
  { id: "violet", label: "Violet", val: "oklch(0.72 0.16 300)" },
  { id: "cyan", label: "Ice", val: "oklch(0.74 0.13 215)" },
];
const MONOS = [
  { id: "ibm", label: "IBM Plex Mono", val: '"IBM Plex Mono", ui-monospace, monospace' },
  { id: "jet", label: "JetBrains Mono", val: '"JetBrains Mono", ui-monospace, monospace' },
];

function load<T>(k: string, d: T): T {
  if (typeof window === "undefined") return d;
  try { return (JSON.parse(localStorage.getItem("dps_" + k) || "null") as T) ?? d; } catch { return d; }
}
function save(k: string, v: unknown) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem("dps_" + k, JSON.stringify(v)); } catch {}
}

export default function App() {
  const [view, setView] = useState<string>("overview");
  const [version, setVersion] = useState<string>("2.1.89");
  const [theme, setTheme] = useState<string>("carbon");
  const [density, setDensity] = useState<string>("comfortable");
  const [accent, setAccent] = useState<string>("auto");
  const [mono, setMono] = useState<string>("ibm");
  const [verOpen, setVerOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const { connected, snapshotAt } = useStudio();

  // When the live snapshot lands, reconcile the selected version if the
  // persisted one isn't among the real versions the backend reports.
  useEffect(() => {
    if (!DATA.VERSIONS.find((v) => v.id === version)) {
      const cur = DATA.VERSIONS.find((v) => v.current) || DATA.VERSIONS[DATA.VERSIONS.length - 1];
      if (cur) setVersion(cur.id);
    }
  }, [snapshotAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate persisted prefs after mount (avoids SSR/client mismatch).
  useEffect(() => {
    setView(load("view", "overview"));
    setVersion(load("version", "2.1.89"));
    setTheme(load("theme", "carbon"));
    setDensity(load("density", "comfortable"));
    setAccent(load("accent", "auto"));
    setMono(load("mono", "ibm"));
    setHydrated(true);
  }, []);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); save("theme", theme); }, [theme]);
  useEffect(() => { document.documentElement.setAttribute("data-density", density); save("density", density); }, [density]);
  useEffect(() => { if (hydrated) save("view", view); }, [view, hydrated]);
  useEffect(() => { if (hydrated) save("version", version); }, [version, hydrated]);
  useEffect(() => {
    const a = ACCENTS.find((x) => x.id === accent);
    if (a && a.val) document.documentElement.style.setProperty("--accent", a.val);
    else document.documentElement.style.removeProperty("--accent");
    save("accent", accent);
  }, [accent, theme]);
  useEffect(() => {
    const m = MONOS.find((x) => x.id === mono);
    if (m) {
      document.documentElement.style.setProperty("--font-mono", m.val);
      document.documentElement.style.setProperty("--font-code", m.val);
    }
    save("mono", mono);
  }, [mono]);

  const [t, s] = TITLES[view] || TITLES.overview;

  let body: React.ReactNode = null;
  if (view === "overview") body = <OverviewView version={version} setView={setView} />;
  else if (view === "anchors") body = <AnchorsView version={version} />;
  else if (view === "coverage") body = <CoverageView version={version} setView={setView} />;
  else if (view === "patches") body = <PatchesView version={version} />;
  else if (view === "agents") body = <AgentsView version={version} setView={setView} />;

  const scrolls = view === "overview" || view === "coverage";

  return (
    <>
      <Sidebar view={view} setView={setView} version={version} setVerOpen={setVerOpen} />
      <div className="main">
        <Topbar title={t} sub={s} theme={theme} setTheme={setTheme} density={density} setDensity={setDensity} onTweaks={() => setTweaksOpen(true)}
          right={<Chip kind={connected ? "ok" : "plain"} dot>{connected ? "live" : "mock data"}</Chip>} />
        {scrolls ? <div className="view-scroll">{body}</div> : <div style={{ flex: 1, minHeight: 0 }} className="view-enter">{body}</div>}
      </div>
      {verOpen && <VersionPicker version={version} setVersion={setVersion} onClose={() => setVerOpen(false)} />}
      {tweaksOpen && <TweaksDrawer {...{ theme, setTheme, density, setDensity, accent, setAccent, mono, setMono, onClose: () => setTweaksOpen(false) }} />}
    </>
  );
}

function TweaksDrawer({ theme, setTheme, density, setDensity, accent, setAccent, mono, setMono, onClose }: {
  theme: string; setTheme: (t: string) => void; density: string; setDensity: (d: string) => void;
  accent: string; setAccent: (a: string) => void; mono: string; setMono: (m: string) => void; onClose: () => void;
}) {
  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 380 }}>
        <div className="card-h"><Icon name="sliders" /><span className="ttl">Tweaks</span>
          <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="scroll-y" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <div className="kicker" style={{ marginBottom: 9 }}>Look direction</div>
            <div className="seg" style={{ width: "100%" }}>
              {THEMES.map((x) => <button key={x.id} style={{ flex: 1 }} className={theme === x.id ? "on" : ""} onClick={() => setTheme(x.id)}>{x.label}</button>)}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 7 }}>
              {theme === "carbon" ? "Modern dark dashboard — restrained, dense, IDE-like." : theme === "terminal" ? "Phosphor mono — green CRT, amber accents, everything monospace." : "Light technical — easy on the eyes for long sessions."}
            </div>
          </div>

          <div>
            <div className="kicker" style={{ marginBottom: 9 }}>Accent</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {ACCENTS.map((a) => (
                <button key={a.id} onClick={() => setAccent(a.id)} title={a.label}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px 5px 6px", borderRadius: 20, cursor: "pointer", fontSize: 11.5, fontWeight: 500,
                    border: "1px solid " + (accent === a.id ? "var(--accent)" : "var(--line)"), background: accent === a.id ? "var(--panel-2)" : "var(--panel)", color: "var(--ink)" }}>
                  <span style={{ width: 14, height: 14, borderRadius: "50%", background: a.val || "var(--accent)", boxShadow: a.id === "auto" ? "inset 0 0 0 2px var(--bg)" : "none", border: "1px solid var(--line)" }} />
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="kicker" style={{ marginBottom: 9 }}>Monospace family</div>
            <div className="seg" style={{ width: "100%" }}>
              {MONOS.map((m) => <button key={m.id} style={{ flex: 1 }} className={mono === m.id ? "on" : ""} onClick={() => setMono(m.id)}>{m.label.replace(" Mono", "")}</button>)}
            </div>
            <div className="code" style={{ marginTop: 9, fontSize: 12, color: "var(--ink-3)", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "8px 10px" }}>
              function getGlobalConfig() {"{"} ... {"}"}
            </div>
          </div>

          <div>
            <div className="kicker" style={{ marginBottom: 9 }}>Density</div>
            <div className="seg" style={{ width: "100%" }}>
              {[["comfortable", "Comfortable"], ["compact", "Compact"]].map(([k, l]) => (
                <button key={k} style={{ flex: 1 }} className={density === k ? "on" : ""} onClick={() => setDensity(k)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
