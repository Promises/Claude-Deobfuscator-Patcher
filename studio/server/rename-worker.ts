/* Child process for the heavy rename → prettify → scoped-rename build.
   Spawned by pipeline.prepareRenamed so it doesn't block the Socket.IO loop. */
import { runRenameInline } from "./pipeline";

const version = process.argv[2];
if (!version) {
  console.error("usage: bun rename-worker.ts <version>");
  process.exit(2);
}

runRenameInline(version)
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error(e?.message || String(e));
    process.exit(1);
  });
