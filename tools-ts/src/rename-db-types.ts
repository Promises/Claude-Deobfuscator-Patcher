/**
 * Rename database schema.
 *
 * Keyed by source file path (stable across versions).
 * Stores which original names exist per file, how they were discovered,
 * and any collision suppressions or manual overrides.
 */

export interface RenameDB {
  schema_version: 1;
  generated_at: string;

  /** Per source file path */
  files: Record<string, FileRenames>;
}

export interface FileRenames {
  /** Renames discovered for this file, keyed by original name */
  renames: Record<string, RenameEntry>;

  /** Names suppressed due to collisions or ambiguity */
  suppressed?: Record<string, SuppressedEntry>;
}

export interface RenameEntry {
  /** How this rename was discovered */
  kind: "export_map" | "class" | "signature" | "manual";

  /** auto = regenerated each run; manual = preserved across generations */
  source: "auto" | "manual";

  /** How confident we are in this rename */
  confidence: "high" | "medium" | "low";

  /**
   * Structural hint for identifying which minified name maps to this original.
   * Used for disambiguation when multiple candidates exist.
   * Examples:
   *   "has_property:ascii" — the class/function with an 'ascii' property
   *   "has_string:keep_alive" — the function containing this string literal
   *   "param_count:1" — the function with 1 parameter
   */
  match_hint?: string;

  /** Human-readable note */
  note?: string;
}

export interface SuppressedEntry {
  /** Why this name was suppressed */
  reason: string;

  /** The candidate original names that collided */
  candidates?: string[];

  /** If manually resolved, which original name won */
  resolved_as?: string;

  /** Structural hint for picking the right candidate */
  resolve_hint?: string;
}

export interface GenerationReport {
  total_files: number;
  total_renames: number;
  total_suppressed: number;
  by_kind: Record<string, number>;
  collisions: Array<{
    file: string;
    original: string;
    minified_names: string[];
  }>;
}
