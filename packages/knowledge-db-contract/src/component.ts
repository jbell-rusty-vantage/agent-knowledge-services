import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The component tree: `component/release-spec.json` and ordered `component/migrations/NNNN_name.sql`. */
export const DEFAULT_COMPONENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "component");

export interface ReleaseSpec {
  readonly component: "knowledge_verification";
  readonly component_version: string;
  readonly installer_protocol: "knowledge-verification-sql/v1";
  readonly owned_schemas: readonly string[];
  readonly min_postgres_version: number;
  readonly capability_roles: readonly string[];
  readonly tenant_setting: string;
}

export interface Migration {
  readonly key: string;
  readonly path: string;
  /** Exact bytes applied; CRLF is normalized to LF so a Windows checkout and CI produce one digest. */
  readonly sql: string;
  readonly sha256: string;
}

export interface ComponentManifest {
  readonly component: string;
  readonly component_version: string;
  readonly installer_protocol: string;
  readonly owned_schemas: readonly string[];
  readonly min_postgres_version: number;
  readonly capability_roles: readonly string[];
  readonly ordered_migrations: readonly { key: string; path: string; sha256: string }[];
  /** sha256 over the ordered migration digests and the release spec: the component's identity. */
  readonly component_digest: string;
}

export interface Component {
  readonly root: string;
  readonly spec: ReleaseSpec;
  readonly migrations: readonly Migration[];
  readonly manifest: ComponentManifest;
}

const MIGRATION_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function loadComponent(root: string = DEFAULT_COMPONENT_ROOT): Component {
  const spec = JSON.parse(readFileSync(resolve(root, "release-spec.json"), "utf8")) as ReleaseSpec;
  if (spec.component !== "knowledge_verification" || spec.installer_protocol !== "knowledge-verification-sql/v1") {
    throw new Error("COMPONENT_SPEC_UNSUPPORTED");
  }
  const files = readdirSync(resolve(root, "migrations"))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
  let previous = 0;
  const migrations: Migration[] = files.map((name) => {
    const match = MIGRATION_NAME.exec(name);
    if (!match) throw new Error(`MIGRATION_NAME_INVALID:${name}`);
    const ordinal = Number(match[1]);
    if (ordinal <= previous) throw new Error(`MIGRATION_ORDER_INVALID:${name}`);
    previous = ordinal;
    const sql = readFileSync(resolve(root, "migrations", name), "utf8").replace(/\r\n/g, "\n");
    if (/^\s*(begin|commit)\s*;/im.test(sql)) throw new Error(`MIGRATION_OWN_TRANSACTION:${name}`);
    return { key: name.slice(0, -4), path: `migrations/${name}`, sql, sha256: sha256Hex(sql) };
  });
  if (migrations.length === 0) throw new Error("COMPONENT_EMPTY");
  const ordered = migrations.map(({ key, path, sha256 }) => ({ key, path, sha256 }));
  const component_digest = `sha256:${sha256Hex(
    JSON.stringify({
      component: spec.component,
      component_version: spec.component_version,
      owned_schemas: spec.owned_schemas,
      capability_roles: spec.capability_roles,
      ordered_migrations: ordered,
    }),
  )}`;
  return {
    root,
    spec,
    migrations,
    manifest: {
      component: spec.component,
      component_version: spec.component_version,
      installer_protocol: spec.installer_protocol,
      owned_schemas: spec.owned_schemas,
      min_postgres_version: spec.min_postgres_version,
      capability_roles: spec.capability_roles,
      ordered_migrations: ordered,
      component_digest,
    },
  };
}
