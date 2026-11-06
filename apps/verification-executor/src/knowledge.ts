import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorPayload, exitCodeFor, runKnowledgeCli } from "./knowledge/cli.js";

export { runKnowledgeCli, KNOWLEDGE_HELP } from "./knowledge/cli.js";

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    const entry = realpathSync.native(process.argv[1]);
    const modulePath = realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? entry.toLowerCase() === modulePath.toLowerCase() : entry === modulePath;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runKnowledgeCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
    process.exitCode = exitCodeFor(error);
  });
}
