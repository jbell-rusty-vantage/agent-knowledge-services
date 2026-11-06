import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { infrastructureError } from "./errors.js";

const CONTRACT_PACKAGE = "@aiengineer/database-contract";
const MANIFEST = "manifest.json";

function packageRootOf(entryUrl: string): string | undefined {
  let dir = dirname(fileURLToPath(entryUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
        if (name === CONTRACT_PACKAGE) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function pinnedContractWorkspace(): string | undefined {
  try {
    const root = packageRootOf(import.meta.resolve(CONTRACT_PACKAGE));
    return root ? join(root, "workspace") : undefined;
  } catch {
    return undefined;
  }
}

export interface LocateOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fallbackDir?: string;
}

/**
 * Resolution order: `SCHEMA_WORKSPACE_DIR` → the pinned `@aiengineer/database-contract`
 * package's `workspace/` → an explicit fallback directory. Every candidate must contain
 * `manifest.json`; the first hit wins.
 */
export function resolveWorkspaceDir(options: LocateOptions = {}): string {
  const env = options.env ?? process.env;
  const candidates = [env.SCHEMA_WORKSPACE_DIR?.trim(), pinnedContractWorkspace(), options.fallbackDir]
    .filter((item): item is string => Boolean(item))
    .map((item) => resolve(item));
  const found = candidates.find((dir) => existsSync(join(dir, MANIFEST)));
  if (!found)
    throw infrastructureError("WORKSPACE_MISSING", "no schema workspace with manifest.json found", { candidates });
  return found;
}
