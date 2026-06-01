"use client";
/* Live backend connection. Connects to the Bun + Socket.IO server, merges the
   real-data snapshot in over the mock DATA (in place, so every view picks it up
   on the next render), and exposes live anchor preview/validate/save actions.
   Degrades gracefully to mock data when the backend is offline. */
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import { DATA } from "./data";

const WS_URL = process.env.NEXT_PUBLIC_STUDIO_WS || "http://localhost:4101";

export interface ValidationResult {
  token: number; version: string; resolved: boolean; count?: number; error?: string;
}
export interface PreviewResult {
  ok: boolean; count?: number; renames?: { minified: string; original: string }[]; error?: string;
}

interface StudioCtx {
  connected: boolean;
  snapshotAt: string | null;
  preview: (version: string, rules: unknown[]) => Promise<PreviewResult>;
  validate: (versions: string[], rules: unknown[], onResult: (r: ValidationResult) => void) => Promise<void>;
  save: (rules: unknown[], commit: boolean, message?: string) => Promise<{ ok: boolean; sha?: string | null; error?: string }>;
  prepare: (version: string) => Promise<unknown>;
  testPatch: (version: string, patchFile: string) => Promise<{ ok: boolean; status?: string; failedFiles?: string[]; message?: string; error?: string }>;
  getSource: (version: string, file: string, wantResolved: boolean) => Promise<{ ok: boolean; minified?: string | null; resolved?: string | null; error?: string }>;
  analyzeFind: (version: string, file: string, find: unknown, scope?: string, wantResolved?: boolean) => Promise<{ ok: boolean; count?: number; matches?: { line: number; scope: string | null; inRequestedScope: boolean }[]; resolvedMatches?: { line: number; scope: string | null; inRequestedScope: boolean }[]; missing?: boolean; error?: string }>;
  locateWalk: (version: string, target: string, rules: unknown[]) => Promise<{ ok: boolean; preLine?: number; resolvedLine?: number; error?: string }>;
}

const Ctx = createContext<StudioCtx | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const sockRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    // Default transports (polling → websocket upgrade) so it works both
    // directly (local dev) and behind the .test nginx reverse proxy.
    const sock = io(WS_URL, { reconnection: true });
    sockRef.current = sock;
    sock.on("connect", () => setConnected(true));
    sock.on("disconnect", () => setConnected(false));
    sock.on("connect_error", () => setConnected(false));
    sock.on("snapshot", (s: any) => {
      // Merge real data in place over the mock defaults, then force a re-render.
      if (s?.versions?.length) DATA.VERSIONS = s.versions;
      if (s?.anchors?.length) DATA.ANCHORS = s.anchors;
      if (s?.patches?.length) DATA.PATCHES = s.patches;
      if (typeof s?.anchorsRaw === "string") (DATA as any).ANCHORS_RAW = s.anchorsRaw;
      (DATA as any).COVERAGE = s.coverage;
      setSnapshotAt(s.generatedAt || new Date().toISOString());
      setTick((t) => t + 1);
    });
    return () => { sock.close(); sockRef.current = null; };
  }, []);

  const preview = useCallback((version: string, rules: unknown[]) => {
    return new Promise<PreviewResult>((resolve) => {
      const sock = sockRef.current;
      if (!sock) return resolve({ ok: false, error: "offline" });
      sock.timeout(120000).emit("anchor:preview", { version, rules }, (err: unknown, r: PreviewResult) => {
        resolve(err ? { ok: false, error: "timeout" } : r);
      });
    });
  }, []);

  const validate = useCallback((versions: string[], rules: unknown[], onResult: (r: ValidationResult) => void) => {
    return new Promise<void>((resolve) => {
      const sock = sockRef.current;
      if (!sock) { resolve(); return; }
      const handler = (r: ValidationResult) => onResult(r);
      sock.on("validation:result", handler);
      sock.timeout(300000).emit("anchor:validate", { versions, rules }, () => {
        sock.off("validation:result", handler);
        resolve();
      });
    });
  }, []);

  const save = useCallback((rules: unknown[], commit: boolean, message?: string) => {
    return new Promise<{ ok: boolean; sha?: string | null; error?: string }>((resolve) => {
      const sock = sockRef.current;
      if (!sock) return resolve({ ok: false, error: "offline" });
      sock.timeout(30000).emit("anchor:save", { rules, commit, message }, (err: unknown, r: any) => {
        resolve(err ? { ok: false, error: "timeout" } : r);
      });
    });
  }, []);

  const prepare = useCallback((version: string) => {
    return new Promise((resolve) => {
      const sock = sockRef.current;
      if (!sock) return resolve({ ok: false, error: "offline" });
      sock.timeout(120000).emit("version:prepare", { version }, (err: unknown, r: unknown) => resolve(err ? { ok: false } : r));
    });
  }, []);

  const testPatch = useCallback((version: string, patchFile: string) => {
    return new Promise<{ ok: boolean; status?: string; failedFiles?: string[]; message?: string; error?: string }>((resolve) => {
      const sock = sockRef.current;
      if (!sock) return resolve({ ok: false, error: "offline" });
      // Renamed-output build is heavy (~60s cold), so allow a long ack window.
      sock.timeout(600000).emit("patch:test", { version, patchFile }, (err: unknown, r: any) => {
        resolve(err ? { ok: false, error: "timeout" } : r);
      });
    });
  }, []);

  const getSource = useCallback((version: string, file: string, wantResolved: boolean) => {
    return new Promise<{ ok: boolean; minified?: string | null; resolved?: string | null; error?: string }>((resolve) => {
      const sock = sockRef.current;
      if (!sock) return resolve({ ok: false, error: "offline" });
      // resolved view may trigger a (heavy) rename build, so allow a long window.
      sock.timeout(600000).emit("source:get", { version, file, wantResolved }, (err: unknown, r: any) => {
        resolve(err ? { ok: false, error: "timeout" } : r);
      });
    });
  }, []);

  const analyzeFind = useCallback((version: string, file: string, find: unknown, scope?: string, wantResolved?: boolean) => {
    return new Promise<{ ok: boolean; count?: number; matches?: any[]; resolvedMatches?: any[]; missing?: boolean; error?: string }>((resolve) => {
      const sock = sockRef.current;
      if (!sock) return resolve({ ok: false, error: "offline" });
      // resolved analysis may trigger a rename build, so a longer window when wantResolved.
      sock.timeout(wantResolved ? 600000 : 120000).emit("find:analyze", { version, file, find, scope, wantResolved }, (err: unknown, r: any) => {
        resolve(err ? { ok: false, error: "timeout" } : r);
      });
    });
  }, []);

  const locateWalk = useCallback((version: string, target: string, rules: unknown[]) => {
    return new Promise<{ ok: boolean; preLine?: number; resolvedLine?: number; error?: string }>((resolve) => {
      const sock = sockRef.current;
      if (!sock) return resolve({ ok: false, error: "offline" });
      sock.timeout(600000).emit("walk:locate", { version, target, rules }, (err: unknown, r: any) => {
        resolve(err ? { ok: false, error: "timeout" } : r);
      });
    });
  }, []);

  return (
    <Ctx.Provider value={{ connected, snapshotAt, preview, validate, save, prepare, testPatch, getSource, analyzeFind, locateWalk }}>
      {children}
    </Ctx.Provider>
  );
}

export function useStudio(): StudioCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStudio must be used within StudioProvider");
  return c;
}
