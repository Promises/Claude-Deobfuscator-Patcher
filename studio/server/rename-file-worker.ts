/* Child process for the per-file on-demand resolved render (rename → prettify →
   scoped renames for ONE file). Spawned by pipeline.prepareRenamedFile so the
   heavy assemble/binder work doesn't block the Socket.IO loop. Writes the result
   into the per-file cache; the parent reads it back. */
import { runRenderResolvedFileInline } from "./pipeline";

const version = process.argv[2];
const file = process.argv[3];
const hash = process.argv[4]; // anchor-resolution hash → cache key (shared with parent)
if (!version || !file) {
  console.error("usage: bun rename-file-worker.ts <version> <file> [hash]");
  process.exit(2);
}

runRenderResolvedFileInline(version, file, hash)
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error(e?.message || String(e));
    process.exit(1);
  });
