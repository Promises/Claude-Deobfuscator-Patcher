/* Child process for the heavy, event-loop-blocking deob work.
   Spawned by pipeline.prepareVersion so the Socket.IO server stays responsive.
   Writes output to the shared on-disk cache; the parent reads it back. */
import { runPrepareInline } from "./pipeline";

const version = process.argv[2];
if (!version) {
  console.error("usage: bun prepare-worker.ts <version>");
  process.exit(2);
}

runPrepareInline(version)
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error(e?.message || String(e));
    process.exit(1);
  });
