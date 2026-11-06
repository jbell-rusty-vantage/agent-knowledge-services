/**
 * WI-05 proof-driver guards (test-only): the fresh-process drivers wipe and write disposable stores, so they refuse any
 * target that is not provably local, and any BKS checkout that is not the expected repository inside this workspace.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Refuse a Neo4j or PostgreSQL URI whose host is not loopback (never Aura, Supabase or another machine). */
export function requireLoopback(name: string, uri: string | undefined): string {
  if (!uri) throw new Error(`WI05_GUARD: ${name} is not set`);
  let host: string;
  try {
    host = new URL(uri.replace(/^(bolt|neo4j)(\+s|\+ssc)?:/, "http:").replace(/^postgres(ql)?:/, "http:")).hostname;
  } catch {
    throw new Error(`WI05_GUARD: ${name} is not a URI`);
  }
  if (!LOOPBACK.has(host)) throw new Error(`WI05_GUARD: ${name} must point at a loopback host, not ${host}`);
  return uri;
}

/** The BellLabs workspace root this checkout sits in (`<root>/platform/<knowledge-services checkout>`). */
export function bellLabsRoot(): string {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
  return realpathSync(resolve(repository, "../.."));
}

/** The BKS checkout: it must exist, be `biotech-knowledge-services` by its package name, and sit inside BellLabs. */
export function requireBksRoot(value: string | undefined): string {
  if (!value) throw new Error("WI05_GUARD: WI05_BKS_ROOT is not set");
  if (!existsSync(value)) throw new Error("WI05_GUARD: WI05_BKS_ROOT does not exist");
  const root = realpathSync(value);
  const inside = relative(bellLabsRoot(), root);
  if (inside.startsWith("..") || resolve(bellLabsRoot(), inside) !== root) {
    throw new Error("WI05_GUARD: WI05_BKS_ROOT is outside the BellLabs workspace");
  }
  const manifest = join(root, "package.json");
  const name = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name : null;
  if (name !== "biotech-knowledge-services") {
    throw new Error("WI05_GUARD: WI05_BKS_ROOT is not the biotech-knowledge-services repository");
  }
  if (!existsSync(join(root, "packages/kg-ops/src/admission/dispatch.ts"))) {
    throw new Error("WI05_GUARD: WI05_BKS_ROOT has no kg-ops dispatch consumer");
  }
  return root;
}
