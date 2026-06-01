/* Shared UI primitives + icon set. */
import React from "react";

export const ICONS: Record<string, string> = {
  anchor: "M12 5a3 3 0 1 0-3-3 M12 5v14 M5 12H3a9 9 0 0 0 9 9 9 9 0 0 0 9-9h-2 M12 8a3 3 0 0 1 0-6",
  target: "M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0 M12 12m-5 0a5 5 0 1 0 10 0 5 5 0 1 0-10 0 M12 12m-1 0a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
  coverage: "M3 3v18h18 M7 16l4-5 3 3 5-7",
  patch: "M3 6h18 M3 12h18 M3 18h18 M8 4v4 M14 10v4 M8 16v4",
  agent: "M12 8V4 M12 4h-1 M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2 M9 14h.01 M15 14h.01 M9 18h6",
  pipeline: "M4 7h6 M14 7h6 M4 12h16 M4 17h6 M14 17h6 M10 5v4 M14 15v4",
  search: "M11 11m-7 0a7 7 0 1 0 14 0 7 7 0 1 0-14 0 M21 21l-4.3-4.3",
  chevR: "M9 6l6 6-6 6", chevD: "M6 9l6 6 6-6", chevL: "M15 6l-6 6 6 6",
  plus: "M12 5v14 M5 12h14", check: "M20 6L9 17l-5-5", x: "M18 6L6 18 M6 6l12 12",
  warn: "M12 9v4 M12 17h.01 M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0",
  code: "M16 18l6-6-6-6 M8 6l-6 6 6 6", file: "M14 3v5h5 M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  play: "M6 4l14 8-14 8z", branch: "M6 3v12 M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 15a9 9 0 0 0 9-6",
  clock: "M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0 M12 7v5l3 2", layers: "M12 2l9 5-9 5-9-5z M3 12l9 5 9-5 M3 17l9 5 9-5",
  terminal: "M4 17l6-6-6-6 M12 19h8", sliders: "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6",
  arrowR: "M5 12h14 M13 5l7 7-7 7", copy: "M9 9h10v10H9z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  ext: "M15 3h6v6 M10 14L21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5",
  cube: "M12 2l9 5v10l-9 5-9-5V7z M12 22V12 M21 7l-9 5-9-5", zap: "M13 2L3 14h9l-1 8 10-12h-9z",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5",
  hash: "M4 9h16 M4 15h16 M10 3L8 21 M16 3l-2 18", filter: "M3 4h18l-7 9v6l-4 2v-8z",
  dot: "M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0", git: "M9 21V9a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3 M12 6V3 M9 21h6",
  beaker: "M9 3h6 M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3 M7 14h10",
  sparkle: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17l-1.9-5.1L4.5 10l5.6-1.4z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2 M5 5h14l3 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z",
  pkg: "M16.5 9.4L7.5 4.2 M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7L12 12l8.7-5 M12 22V12",
};

export function Icon({ name, size, style, cls }: { name: string; size?: number; style?: React.CSSProperties; cls?: string }) {
  const d = ICONS[name] || ICONS.dot;
  return (
    <svg viewBox="0 0 24 24" width={size || 16} height={size || 16} fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      style={style} className={cls} aria-hidden="true">
      {d.split(" M").map((seg, i) => <path key={i} d={(i ? "M" : "") + seg} />)}
    </svg>
  );
}

export function Chip({ kind, children, dot }: { kind?: string; children: React.ReactNode; dot?: boolean }) {
  return <span className={"chip " + (kind || "")}>{dot && <span className="dot" />}{children}</span>;
}

export function StatusChip({ s }: { s: string }) {
  const map: Record<string, [string, string]> = {
    ok: ["ok", "resolved"], done: ["ok", "done"], applied: ["ok", "applied"], apply: ["ok", "clean apply"],
    running: ["warn", "running"], warn: ["warn", "fuzz"], fuzz: ["warn", "fuzz"], validating: ["warn", "validating"], review: ["warn", "in review"],
    pending: ["plain", "pending"], queued: ["plain", "queued"],
    fail: ["bad", "failed"], broken: ["bad", "broken"], reject: ["bad", "reject"],
    proposed: ["info", "proposed"], committed: ["accent", "committed"],
  };
  const [k, label] = map[s] || ["plain", s];
  return <Chip kind={k} dot>{label}</Chip>;
}

// single-pass JS syntax highlighter — never re-scans its own inserted markup
export function hl(line: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const re = /(\/\/[^\n]*|\/\*[^]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(function|return|let|const|var|if|else|for|of|in|new|typeof|catch|try|class|yield|async|await|null|undefined)\b|\b(\d+)\b/g;
  let out = "", last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    if (m[1]) out += `<span class="tok-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-key">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-num">${esc(m[4])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(line.slice(last));
  return out;
}

export function CodeBlock({ src, hits, warnHits, highlightLines }: { src: string; hits?: Record<string, number[]>; warnHits?: Record<string, number[]>; highlightLines?: number[] }) {
  const lines = src.split("\n");
  const hitWords = hits ? Object.keys(hits) : [];
  const warnWords = warnHits ? Object.keys(warnHits) : [];
  return (
    <div className="codeblock">
      {lines.map((ln, i) => {
        let html = hl(ln);
        hitWords.forEach((w) => {
          if ((hits![w] || []).includes(i)) {
            const safe = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            html = html.replace(new RegExp(safe), `<span class="mark">${w}</span>`);
          }
        });
        warnWords.forEach((w) => {
          if ((warnHits![w] || []).includes(i)) {
            const safe = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            html = html.replace(new RegExp(safe), `<span class="mark-warn">${w}</span>`);
          }
        });
        const isHL = highlightLines && highlightLines.includes(i);
        return (
          <div key={i} className={"ln" + (isHL ? " hl" : "")}>
            <span className="gut">{i + 1}</span>
            <span className="src" dangerouslySetInnerHTML={{ __html: html || " " }} />
          </div>
        );
      })}
    </div>
  );
}

export function Bar({ pct, kind }: { pct: number; kind?: string }) {
  return <div className={"bar " + (kind || "")}><i style={{ width: Math.max(2, pct) + "%" }} /></div>;
}

export function fileTint(kind: string): string {
  return ({ core: "var(--accent)", api: "var(--info)", cli: "var(--purple)", ui: "var(--ok)", utils: "var(--ink-3)" } as Record<string, string>)[kind] || "var(--ink-3)";
}
