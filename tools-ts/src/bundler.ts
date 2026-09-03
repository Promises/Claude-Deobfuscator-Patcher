/**
 * Step 4 for CHUNKED trees (>=2.1.242): BUNDLE the ESM graph instead of
 * concatenating it.
 *
 * WHY NOT reassembler.ts. That tool strips import/export and concatenates every
 * section into one global scope, which is correct for a MONOLITHIC tree — that
 * bundle really did have everything at global scope, and the imports it strips
 * are ones module-reconstruct.ts synthesised in the first place.
 *
 * A chunked tree is the opposite case. Each chunk is a REAL module with its own
 * scope, and upstream's bundler reused names freely across them because it never
 * had to put them in one scope. MEASURED on 2.1.259: renamer.ts reports 10,558
 * duplicate top-level names, and compiling the flat concatenation gives 9,585
 * "X has already been declared" errors — an IDENTICAL count with all side-effect
 * imports stripped and with them left in, which proves the collisions are a
 * property of the concatenation and not of the import graph. No import-stripping
 * regex can fix that; the scopes have to be preserved.
 *
 * Handing the same tree to `bun build --target=bun` takes it to ZERO collisions
 * (87,396 errors -> 1,833), because a bundler renames colliding bindings as it
 * hoists them. So this step delegates scope handling to bun and keeps the graph.
 *
 * 🔴 LAZY LOADING MUST SURVIVE. The app is lazily loaded: the entry chunk reaches
 * `main` through `await import(...)`, so its STATIC closure is only 6 of 1649
 * chunks. Forcing every chunk to evaluate eagerly is not an option — a probe
 * build that did so printed the right version and then CRASHED, because a chunk
 * that is lazy upstream eagerly invoked a native image-processor.node load.
 *
 * MEASURED (2026-09-03) that `bun build --compile` preserves this on its own,
 * so no --splitting flag is needed and step 5 still receives ONE file. The probe
 * was positive-controlled rather than assumed: a two-module program whose lazily
 * imported module prints a side effect at top level, compiled with --compile,
 * prints `entry-start / entry-end` when the dynamic branch is NOT taken and
 * `entry-start / SIDE-EFFECT-RAN / LAZY-OK / entry-end` when it is. The side
 * effect is the observable that would have fired had the import been hoisted to
 * eager evaluation, and it does not fire.
 *
 * This step therefore produces a single ESM file: bun resolves and hoists the
 * whole graph with correct per-module scoping, and leaves dynamic import()
 * boundaries intact for step 5 to compile.
 */

import * as fs from "fs";
import * as path from "path";
// Imported, NOT re-declared. The marker has to be byte-identical to the one
// module-reconstruct.ts writes into the tree or the external rule silently
// stops matching and every unresolved lazy edge becomes a bundle error again.
// This repo already carries forked copies of shared logic (the import-stripper
// exists in both reassembler.ts and renamer.ts); this one stays single.
import { UNRESOLVED_CHUNK_PREFIX } from "./module-reconstruct";

interface Section {
  index: number;
  output_path: string;
  type: "preamble" | "section" | "tail";
}

interface Mapping {
  section_count: number;
  sections: Section[];
}

/**
 * Is this a CHUNKED tree (a real ESM graph), or a monolithic one?
 *
 * Measured from the TREE, never from a version number — build.sh,
 * module-reconstruct.ts and renamer.ts all already dispatch this way, because
 * the Patcher Studio calls these with no version context at all.
 *
 * The discriminator is whether files carry ESM syntax of their own. A monolithic
 * tree reaches step 4 with module-reconstruct.ts's SYNTHESISED imports, which
 * are all RELATIVE ('./x.js') — and so are a chunked tree's, after
 * retargetChunkImports rewrites its /$bunfs specifiers. So the presence of a
 * relative import cannot separate them.
 *
 * What does separate them: a monolithic tree has exactly ONE entry (its preamble
 * runs the whole bundle), and _mapping.json marks it `type: "preamble"` with a
 * matching `type: "tail"`. A chunked tree has NEITHER — extract_chunks.py
 * emit_splitter_compat() emits every chunk as `type: "section"`, because a
 * chunked build has no shared runtime preamble to carve off.
 *
 * MEASURED: the 2.1.238 mapping has 1 preamble + 1 tail among 5439 sections;
 * the 2.1.259 mapping has 0 of each among 1649. That is a structural property of
 * how the tree was produced, not a heuristic threshold.
 */
export function isChunkedTree(mapping: Mapping): boolean {
  return !mapping.sections.some(
    (s) => s.type === "preamble" || s.type === "tail",
  );
}

/**
 * Locate the entry module: the chunk that runs the CLI.
 *
 * Identified by CONTENT, not by index. The entry is the chunk that performs the
 * final startup handoff — it awaits a dynamic import of `main` and emits the
 * `cli_after_main_complete` timing marker. That marker is the same one the
 * monolithic extractor in build.sh uses to find the end of the bundle, so it is
 * a long-lived upstream landmark rather than something invented here.
 *
 * A chunk index would be wrong to hard-code: it is a position in banner-scan
 * order, which is a property of the binary layout and free to change between
 * releases.
 */
export function findEntry(projectDir: string, mapping: Mapping): string {
  const candidates: string[] = [];
  for (const section of mapping.sections) {
    const full = path.join(projectDir, section.output_path);
    if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, "utf-8");
    if (code.includes("cli_after_main_complete")) {
      candidates.push(section.output_path);
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      "No entry module found: no file contains the 'cli_after_main_complete' " +
        "startup marker. The entry chunk could not be identified, and guessing " +
        "one would produce a binary that builds and does nothing.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous entry: ${candidates.length} files contain ` +
        `'cli_after_main_complete' (${candidates.join(", ")}). ` +
        `Refusing to pick one.`,
    );
  }
  return candidates[0];
}

export async function bundleChunked(
  projectDir: string,
  outputPath: string,
): Promise<void> {
  const mapping: Mapping = JSON.parse(
    fs.readFileSync(path.join(projectDir, "_mapping.json"), "utf-8"),
  );

  const entry = findEntry(projectDir, mapping);
  console.log(`  entry: ${entry}`);

  const result = await Bun.build({
    entrypoints: [path.join(projectDir, entry)],
    target: "bun",
    format: "esm",
    // The tree is already minified upstream; re-minifying only costs time and
    // makes a failure harder to read.
    minify: false,
    sourcemap: "none",
    // Dynamic specifiers that module-reconstruct.ts could not resolve are
    // rewritten to this protocol. They are declared EXTERNAL so one unresolved
    // LAZY edge does not fail the whole bundle — the import still throws
    // "Cannot find module 'claudiverse-unresolved-chunk:…'" naming the original
    // chunk, but only on the code path that actually needs it.
    //
    // Scoped to this one made-up protocol on purpose. A blanket external rule,
    // or silently dropping unresolved imports, would also swallow a REAL
    // missing dependency and turn a loud build failure into a runtime surprise.
    external: [UNRESOLVED_CHUNK_PREFIX + "*"],
    // Embedded assets must keep the EXACT filename the code reads back.
    // bun's default is "[name]-[hash].[ext]", which rewrote
    //   loopAutonomousPreamble-07qcyhv4.md
    // into
    //   loopAutonomousPreamble-07qcyhv4-07qcyhv4.md
    // and the readFileSync then failed ENOENT on the un-hashed name. This pass
    // sees the asset imports FIRST, so setting the flag only on the step-5
    // compile is not enough — it has to be set in both places.
    naming: { asset: "[name].[ext]" },
  });

  if (!result.success) {
    // Print every diagnostic, not a count. A bundle failure here is the whole
    // signal for the next iteration, and a summary line loses which module.
    for (const log of result.logs) console.error(String(log));
    throw new Error(
      `bun build failed with ${result.logs.length} diagnostics (see above)`,
    );
  }

  const entryOut = result.outputs.find((o) => o.kind === "entry-point");
  if (!entryOut) {
    throw new Error("bun build produced no entry-point output");
  }

  const code = await entryOut.text();
  fs.writeFileSync(outputPath, code);

  // Asset outputs are SEPARATE artifacts and were previously dropped on the
  // floor. When they are, the bundle still contains
  //   var x = "./loopAutonomousPreamble-07qcyhv4.md"
  // pointing at a file that was never written, and step 5 has nothing to embed
  // — the binary then dies with ENOENT on that relative path. Writing them next
  // to the bundle makes the specifier resolve, so `bun build --compile` picks
  // each one up and embeds it under the same name.
  const outDir = path.dirname(outputPath);
  let assetCount = 0;
  for (const out of result.outputs) {
    if (out.kind === "entry-point") continue;
    const name = path.basename(out.path);
    fs.writeFileSync(
      path.join(outDir, name),
      Buffer.from(await out.arrayBuffer()),
    );
    assetCount++;
  }

  console.log(
    `  Bundled ${mapping.section_count} sections into ${outputPath} ` +
      `(${code.length.toLocaleString()} bytes)` +
      (assetCount > 0 ? `, plus ${assetCount} embedded asset(s)` : ""),
  );
}

function readMapping(projectDir: string): Mapping {
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, "_mapping.json"), "utf-8"),
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  // Probe mode for build.sh: exit 0 if the tree is chunked, 1 if monolithic, so
  // step 4 can dispatch without duplicating the discriminator in shell — one
  // definition of "chunked tree", used by both the dispatcher and the bundler.
  if (args[0] === "--is-chunked") {
    if (args.length < 2) {
      console.log("Usage: bun run src/bundler.ts --is-chunked <project_dir>");
      process.exit(2);
    }
    process.exit(isChunkedTree(readMapping(args[1])) ? 0 : 1);
  }

  if (args.length < 2) {
    console.log("Usage: bun run src/bundler.ts <project_dir> <output.js>");
    console.log("       bun run src/bundler.ts --is-chunked <project_dir>");
    process.exit(1);
  }
  await bundleChunked(args[0], args[1]);
}
